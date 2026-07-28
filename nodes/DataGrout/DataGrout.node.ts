import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IDataObject,
	JsonObject,
} from 'n8n-workflow';
import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	OperationalError,
	sleep,
} from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Minimal MCP client over Streamable HTTP — zero dependencies.
// Handles both application/json and text/event-stream (SSE) responses.
// KEEP IN SYNC with packages/n8n-nodes-datagrout-mcp (same transport).
// ────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TASK_WAIT_MS = 120_000;

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

function parsePossiblySse(raw: unknown): IDataObject {
	if (typeof raw === 'object' && raw !== null) return raw as IDataObject;
	const text = String(raw);
	// SSE frames: lines starting with "data:"; last data frame carries the JSON-RPC response
	const dataLines = text
		.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).trim())
		.filter(Boolean);
	const payload = dataLines.length ? dataLines[dataLines.length - 1] : text;
	return JSON.parse(payload) as IDataObject;
}

async function mcpRequest(
	ctx: Ctx,
	body: IDataObject,
	sessionId?: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ result: IDataObject; sessionId?: string }> {
	const credentials = await ctx.getCredentials('dataGroutApi');
	const baseUrl = String(credentials.baseUrl ?? 'https://gateway.datagrout.ai').replace(/\/$/, '');
	const response = await ctx.helpers.httpRequest({
		method: 'POST',
		url: `${baseUrl}/servers/${credentials.serverId as string}/mcp`,
		headers: {
			Authorization: `Bearer ${credentials.apiToken as string}`,
			'Content-Type': 'application/json',
			Accept: 'application/json, text/event-stream',
			...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
			'MCP-Protocol-Version': PROTOCOL_VERSION,
		},
		body,
		json: true,
		returnFullResponse: true,
		timeout: timeoutMs,
	});

	const newSessionId =
		((response.headers as IDataObject)?.['mcp-session-id'] as string | undefined) ?? sessionId;

	// Notifications (no id) may return 202 with an empty body
	if (!response.body) return { result: {}, sessionId: newSessionId };

	const parsed = parsePossiblySse(response.body);
	if (parsed.error) {
		const err = parsed.error as IDataObject;
		throw new OperationalError(`MCP error ${err.code as number}: ${err.message as string}`);
	}
	return { result: (parsed.result as IDataObject) ?? {}, sessionId: newSessionId };
}

async function mcpInitialize(ctx: Ctx, timeoutMs: number): Promise<string | undefined> {
	const { sessionId } = await mcpRequest(
		ctx,
		{
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: 'n8n-nodes-datagrout', version: '1.0.0' },
			},
		},
		undefined,
		timeoutMs,
	);
	// Required notification after initialize
	await mcpRequest(
		ctx,
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		sessionId,
		timeoutMs,
	);
	return sessionId;
}

// ── Session cache ────────────────────────────────────────────────────
// One MCP session per credential, reused across executions of this n8n
// process. Without it every tool call pays 3 round-trips (initialize,
// initialized-notification, the call itself) and leaves an abandoned
// session on the gateway. On ANY failure of a request made with a cached
// session, the session is dropped and the call retried ONCE on a fresh
// one — this covers gateway session expiry/restarts without protocol-
// specific error sniffing.

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessionCache = new Map<string, { sessionId: string | undefined; expiresAt: number }>();

async function sessionKey(ctx: Ctx): Promise<string> {
	const credentials = await ctx.getCredentials('dataGroutApi');
	return `${credentials.baseUrl as string}|${credentials.serverId as string}|${(
		credentials.apiToken as string
	).slice(-8)}`;
}

async function withSession<T>(
	ctx: Ctx,
	timeoutMs: number,
	fn: (sessionId: string | undefined) => Promise<T>,
): Promise<T> {
	const key = await sessionKey(ctx);
	const cached = sessionCache.get(key);
	const fresh = !cached || cached.expiresAt < Date.now();

	let sessionId: string | undefined;
	if (fresh) {
		sessionId = await mcpInitialize(ctx, timeoutMs);
		sessionCache.set(key, { sessionId, expiresAt: Date.now() + SESSION_TTL_MS });
	} else {
		sessionId = cached.sessionId;
	}

	try {
		return await fn(sessionId);
	} catch (error) {
		// A request on a REUSED session may have failed because the gateway
		// dropped it — invalidate and retry once on a fresh session. A failure
		// on a fresh session is a real error.
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- rethrown unchanged; the execute() boundary wraps it in NodeApiError/NodeOperationError with the item index
		if (fresh) throw error;
		sessionCache.delete(key);
		const retryId = await mcpInitialize(ctx, timeoutMs);
		sessionCache.set(key, { sessionId: retryId, expiresAt: Date.now() + SESSION_TTL_MS });
		return await fn(retryId);
	}
}

async function mcpListTools(ctx: Ctx, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<IDataObject[]> {
	return await withSession(ctx, timeoutMs, async (sessionId) => {
		const { result } = await mcpRequest(
			ctx,
			{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
			sessionId,
			timeoutMs,
		);
		return (result.tools as IDataObject[]) ?? [];
	});
}

// ── DataGrout idioms ─────────────────────────────────────────────────

// Long-running DataGrout calls DETACH to a background task and return
// {status: "detached", task_ref: "..."} — the caller is expected to collect
// via tasks.wait. Handling that here means workflows/agents just get the
// final result, with the async dance invisible.
function detachedTaskRef(result: IDataObject): string | undefined {
	const sc = (result.structuredContent as IDataObject) ?? {};
	if (sc.status === 'detached' && typeof sc.task_ref === 'string') return sc.task_ref;
	return undefined;
}

async function collectDetached(
	ctx: Ctx,
	sessionId: string | undefined,
	taskRef: string,
	budgetMs: number,
	timeoutMs: number,
): Promise<IDataObject | undefined> {
	const deadline = Date.now() + budgetMs;
	let ref = taskRef;

	while (Date.now() < deadline) {
		const { result } = await mcpRequest(
			ctx,
			{
				jsonrpc: '2.0',
				id: 4,
				method: 'tools/call',
				params: { name: 'data-grout@1/tasks.wait@1', arguments: { task_ref: ref } },
			},
			sessionId,
			timeoutMs,
		);

		const sc = (result.structuredContent as IDataObject) ?? {};
		// Direct tools/call returns the task record at the TOP of structuredContent
		// (live-verified 2026-07-23); the discovery.perform wrapper nests it under
		// .result. Support both.
		const task =
			typeof sc.completed !== 'undefined' || sc.task_ref
				? sc
				: ((sc.result as IDataObject) ?? {});

		if (task.completed === true && typeof task.result === 'object' && task.result !== null) {
			// task.result is the finished tool PAYLOAD (already unwrapped) —
			// re-wrap as an MCP-shaped result so downstream handling matches
			// the inline path.
			const payload = task.result as IDataObject;
			return {
				content: [{ type: 'text', text: JSON.stringify(payload) }],
				structuredContent: payload,
			};
		}
		if (task.status === 'failed' || (task.error && task.completed === true)) {
			return result; // surface the failure envelope as-is
		}
		ref = (task.task_ref as string) ?? ref;
		await sleep(1000); // tasks.wait long-polls server-side; brief gap between attempts
	}

	// Budget exhausted: return a clean, actionable result instead of the raw
	// detach stub (whose server hint tells the caller to invoke tasks.wait —
	// advice a workflow or filtered agent may not be able to follow).
	const note =
		`The operation is still running in the background (task ${ref}). ` +
		'Increase "Wait for Background Tasks (Ms)" on this node to allow more time, ' +
		'or re-run shortly — finished work is reused.';
	return {
		content: [{ type: 'text', text: note }],
		structuredContent: { status: 'running', task_ref: ref, note },
	};
}

// discovery.plan / discovery.perform accept lean/head response-shaping
// params that protect the caller's context window from oversized payloads.
// Injected only for those tools and only when the caller didn't set them.
function injectLeanDefaults(toolName: string, args: IDataObject): IDataObject {
	// Servers may list tools under their canonical name
	// (data-grout@1/discovery.plan@1) or a sanitized form (discovery_plan) —
	// match both (live-observed 2026-07-24: the tools/list of an
	// intelligent-interface server returns sanitized names).
	if (/(^|\/)discovery[._](plan|guide)(@\d+)?$/.test(toolName)) {
		return { lean: true, head: true, ...args };
	}
	if (/(^|\/)discovery[._]perform(@\d+)?$/.test(toolName)) {
		return { head: true, ...args };
	}
	return args;
}

// ────────────────────────────────────────────────────────────────────

export class DataGrout implements INodeType {
	methods = {
		loadOptions: {
			async getTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const tools = await mcpListTools(this);
				return tools.map((tool) => ({
					name: (tool.name as string) ?? '',
					value: (tool.name as string) ?? '',
					description: (tool.description as string) ?? '',
				}));
			},
		},
	};

	description: INodeTypeDescription = {
		displayName: 'DataGrout',
		name: 'dataGrout',
		icon: { light: 'file:datagrout.svg', dark: 'file:datagrout.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description:
			'Connect to a DataGrout MCP server: list its tools and execute them. ' +
			'Use List Tools to discover tool names and input schemas, then Execute Tool ' +
			'with the tool name and JSON arguments.',
		defaults: { name: 'DataGrout' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'dataGroutApi', required: true }],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Execute Tool',
						value: 'executeTool',
						action: 'Execute a tool',
						description: 'Runs a named MCP tool with JSON arguments and returns its result',
					},
					{
						name: 'List Tools',
						value: 'listTools',
						action: 'List available tools',
						description:
							'Returns each tool name, description, and input schema (respects the tool filter)',
					},
				],
				default: 'listTools',
			},

			// ── Tool filter: All / Selected / All Except (mirrors built-in MCP Client Tool) ──
			{
				displayName: 'Tools to Include',
				name: 'toolsToInclude',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'All',
						value: 'all',
						description: 'Expose every tool on this DataGrout server',
					},
					{
						name: 'All Except',
						value: 'except',
						description: 'Expose every tool except those chosen below',
					},
					{
						name: 'Selected',
						value: 'selected',
						description: 'Expose only the tools chosen below',
					},
				],
				default: 'all',
				description:
					'When this node is used as an AI Agent tool, this is the permission boundary for what the agent can call',
			},
			{
				displayName: 'Tool Names or IDs',
				name: 'includeTools',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTools' },
				default: [],
				required: true,
				displayOptions: { show: { toolsToInclude: ['selected'] } },
				description:
					'Only these tools will be available. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Excluded Tool Names or IDs',
				name: 'excludeTools',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTools' },
				default: [],
				required: true,
				displayOptions: { show: { toolsToInclude: ['except'] } },
				description:
					'All tools except these will be available. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},

			// ── Execute Tool parameters ──
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { operation: ['executeTool'] } },
				description: 'The MCP tool to execute (use List Tools to discover names)',
			},
			{
				displayName: 'Tool Arguments (JSON)',
				name: 'toolArguments',
				type: 'json',
				default: '{}',
				displayOptions: { show: { operation: ['executeTool'] } },
				description: 'Arguments matching the tool input schema, as a JSON object',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Lean Responses',
						name: 'leanResponses',
						type: 'boolean',
						default: true,
						description:
							'Whether to request compact, preview-shaped responses from DataGrout discovery tools (lean/head) so large result sets return a preview plus a server-side cache reference instead of every row',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 60000,
						description: 'Request timeout in milliseconds',
					},
					{
						displayName: 'Wait for Background Tasks (Ms)',
						name: 'waitForTasks',
						type: 'number',
						default: 120000,
						description:
							'Long-running DataGrout calls detach to a background task; the node collects the finished result automatically for up to this long. Set to 0 to return the task reference immediately instead.',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		// Filter helper — enforced on BOTH listing and execution
		const isToolAllowed = (toolName: string, i: number): boolean => {
			const mode = this.getNodeParameter('toolsToInclude', i, 'all') as string;
			if (mode === 'all') return true;
			if (mode === 'selected') {
				const include = this.getNodeParameter('includeTools', i, []) as string[];
				return include.includes(toolName);
			}
			const exclude = this.getNodeParameter('excludeTools', i, []) as string[];
			return !exclude.includes(toolName);
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const options = this.getNodeParameter('options', i, {}) as IDataObject;
				const timeoutMs = (options.timeout as number) ?? DEFAULT_TIMEOUT_MS;

				if (operation === 'listTools') {
					const tools = await mcpListTools(this, timeoutMs);
					const filtered = tools.filter((t) => isToolAllowed(t.name as string, i));
					for (const tool of filtered) {
						returnData.push({ json: tool, pairedItem: { item: i } });
					}
				}

				if (operation === 'executeTool') {
					const toolName = this.getNodeParameter('toolName', i) as string;
					if (!isToolAllowed(toolName, i)) {
						throw new NodeOperationError(
							this.getNode(),
							`Tool "${toolName}" is not permitted by this node's tool filter`,
							{ itemIndex: i },
						);
					}
					const rawArgs = this.getNodeParameter('toolArguments', i, '{}');
					let args: IDataObject;
					try {
						args =
							typeof rawArgs === 'string'
								? (JSON.parse(rawArgs) as IDataObject)
								: (rawArgs as IDataObject);
					} catch {
						throw new NodeOperationError(
							this.getNode(),
							'Tool Arguments is not valid JSON — provide a JSON object matching the tool input schema',
							{ itemIndex: i },
						);
					}
					if ((options.leanResponses as boolean) ?? true) {
						args = injectLeanDefaults(toolName, args);
					}

					const waitBudget = (options.waitForTasks as number) ?? DEFAULT_TASK_WAIT_MS;

					const result = await withSession(this, timeoutMs, async (sessionId) => {
						const { result: callResult } = await mcpRequest(
							this,
							{
								jsonrpc: '2.0',
								id: 3,
								method: 'tools/call',
								params: { name: toolName, arguments: args },
							},
							sessionId,
							timeoutMs,
						);

						// Transparent background-task collection: long calls detach;
						// poll tasks.wait until the finished result is available.
						const taskRef = detachedTaskRef(callResult);
						if (taskRef && waitBudget > 0) {
							const collected = await collectDetached(
								this,
								sessionId,
								taskRef,
								waitBudget,
								timeoutMs,
							);
							if (collected) return collected;
						}
						return callResult;
					});

					// MCP error convention inside a successful response
					if (result.isError) {
						const content = (result.content as IDataObject[]) ?? [];
						const message =
							(content.find((c) => c.type === 'text')?.text as string) ??
							'Tool returned an error';
						throw new NodeOperationError(this.getNode(), message, { itemIndex: i });
					}

					returnData.push({ json: result, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				if (error instanceof NodeOperationError) {
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				}
				throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
