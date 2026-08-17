import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, OperationalError, sleep } from 'n8n-workflow';

import type { ToolSummary } from './pure';
import {
	MAX_LISTED_TOOLS,
	describeTools,
	detachedTaskRef,
	errorText,
	injectLeanDefaults,
	parsePossiblySse,
	resolveToolName,
	taskRecord,
	toOutputJson,
} from './pure';

// ────────────────────────────────────────────────────────────────────
// Minimal MCP client over Streamable HTTP, built on n8n's own
// `helpers.httpRequest` so the node carries no runtime dependencies.
// ────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TASK_WAIT_MS = 120_000;

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

const CREDENTIAL = 'dataGroutOAuth2Api';

/** The gateway endpoint this credential connects to. */
async function gatewayUrl(ctx: Ctx): Promise<string> {
	const credentials = await ctx.getCredentials(CREDENTIAL);
	return String(credentials.serverUrl ?? 'https://gateway.datagrout.ai/connect').replace(/\/$/, '');
}

async function mcpRequest(
	ctx: Ctx,
	body: IDataObject,
	sessionId?: string,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ result: IDataObject; sessionId?: string }> {
	// Going through httpRequestWithAuthentication is what lets n8n inject the
	// Authorization header and refresh an expired access token. Reading the
	// token ourselves would skip the refresh and start failing with 401.
	const response = await ctx.helpers.httpRequestWithAuthentication.call(ctx, CREDENTIAL, {
		method: 'POST',
		url: await gatewayUrl(ctx),
		headers: {
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
				clientInfo: { name: 'n8n-nodes-datagrout-mcp', version: '1.0.0' },
			},
		},
		undefined,
		timeoutMs,
	);
	await mcpRequest(
		ctx,
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		sessionId,
		timeoutMs,
	);
	return sessionId;
}

// ── Session cache ────────────────────────────────────────────────────
// One MCP session per credential, reused across tool calls in this n8n
// process. Without it every invocation pays 3 round-trips and abandons a
// gateway session. On failure of a request made with a cached session, the
// session is dropped and the call retried ONCE fresh.
const SESSION_TTL_MS = 10 * 60 * 1000;
const sessionCache = new Map<string, { sessionId: string | undefined; expiresAt: number }>();

async function sessionKey(ctx: Ctx): Promise<string> {
	// Everyone shares one endpoint now, so the connected account is what makes a
	// session distinct.
	const credentials = await ctx.getCredentials(CREDENTIAL);
	const url = String(credentials.serverUrl ?? 'https://gateway.datagrout.ai/connect');
	const token = (credentials.oauthTokenData as IDataObject | undefined)?.access_token;
	return `${url}|${typeof token === 'string' ? token.slice(-8) : 'unlinked'}`;
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
		// dropped it — invalidate and retry once fresh. A failure on a fresh
		// session is a real error.
		if (fresh) {
			if (error instanceof NodeOperationError) throw new NodeOperationError(ctx.getNode(), error);
			throw new NodeOperationError(ctx.getNode(), error as Error);
		}
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

		const task = taskRecord(result.structuredContent as IDataObject);

		if (task.completed === true && typeof task.result === 'object' && task.result !== null) {
			const payload = task.result as IDataObject;
			return {
				content: [{ type: 'text', text: JSON.stringify(payload) }],
				structuredContent: payload,
			};
		}
		if (task.status === 'failed' || (task.error && task.completed === true)) {
			return result;
		}
		ref = (task.task_ref as string) ?? ref;
		await sleep(1000);
	}

	// Budget exhausted: hand back a clean, actionable message instead of the
	// raw detach stub (whose server hint may reference tools the caller cannot
	// reach on a filtered server).
	const note =
		'The operation needs more time and is still running in the background. ' +
		'Ask again in a moment — the finished work is reused, so the retry is fast.';
	return {
		content: [{ type: 'text', text: note }],
		structuredContent: { status: 'running', task_ref: ref, note },
	};
}

/** The Arguments field arrives as a JSON string when typed, or an object via expression. */
function parseArguments(ctx: IExecuteFunctions, raw: unknown, itemIndex: number): IDataObject {
	if (raw === undefined || raw === null || raw === '') return {};
	if (typeof raw === 'object') return raw as IDataObject;
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw));
	} catch {
		throw new NodeOperationError(ctx.getNode(), 'Tool Arguments must be valid JSON', { itemIndex });
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new NodeOperationError(ctx.getNode(), 'Tool Arguments must be a JSON object', {
			itemIndex,
		});
	}
	return parsed as IDataObject;
}

// ── Tool-name resolution ─────────────────────────────────────────────
// A model supplies the tool name as free text, so it may guess a name that
// does not exist, or write a readable form of one that does. Resolving
// against the server's real list keeps bad names from ever reaching the
// gateway, and lets an unmatched name return the catalogue instead of an
// error the model cannot act on.

const toolListCache = new Map<string, { tools: ToolSummary[]; expiresAt: number }>();

const TOOL_LIST_TTL_MS = 5 * 60 * 1000;

async function cachedTools(ctx: Ctx): Promise<ToolSummary[]> {
	const key = await sessionKey(ctx);
	const cached = toolListCache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.tools;
	const tools = (await mcpListTools(ctx))
		.map((t) => ({
			name: (t.name as string) ?? '',
			description: (t.description as string) ?? '',
		}))
		.filter((t) => Boolean(t.name));
	toolListCache.set(key, { tools, expiresAt: Date.now() + TOOL_LIST_TTL_MS });
	return tools;
}

// ────────────────────────────────────────────────────────────────────

export class DataGroutMcpTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DataGrout MCP',
		name: 'dataGroutMcpTool',
		icon: { light: 'file:datagrout.svg', dark: 'file:datagrout.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle:
			'={{$parameter["operation"] === "listTools" ? "List Tools" : ($parameter["toolSelection"] === "single" ? $parameter["tool"] : "Execute Tool")}}',
		description: 'List and call the tools on a DataGrout MCP server',
		defaults: { name: 'DataGrout MCP' },
		usableAsTool: true,
		codex: {
			categories: ['AI'],
			alias: ['MCP', 'Model Context Protocol', 'DataGrout'],
			resources: {
				primaryDocumentation: [{ url: 'https://library.datagrout.ai/' }],
			},
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'dataGroutOAuth2Api', required: true }],
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
						description: 'Call a tool on the DataGrout server',
						action: 'Execute a tool',
					},
					{
						name: 'List Tools',
						value: 'listTools',
						description: 'List every tool the DataGrout server exposes, with its input schema',
						action: 'List tools',
					},
				],
				default: 'executeTool',
			},
			{
				displayName: 'Tools to Allow',
				name: 'toolSelection',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'All',
						value: 'all',
						description: 'Any tool on the server can be called',
					},
					{
						name: 'Selected',
						value: 'selected',
						description: 'Only the tools chosen below can be called',
					},
					{
						name: 'Single Tool',
						value: 'single',
						description: 'Pin this node to exactly one tool you choose',
					},
				],
				default: 'all',
				description:
					'The permission boundary for this node. With All or Selected, the model supplies the tool name at call time; with Single Tool you pick it yourself.',
			},
			{
				displayName: 'Allowed Tool Names or IDs',
				name: 'includeTools',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTools' },
				default: [],
				required: true,
				displayOptions: { show: { toolSelection: ['selected'] } },
				description:
					'Only these tools can be called; anything else is refused. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Tool Name or ID',
				name: 'tool',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTools' },
				default: '',
				required: true,
				displayOptions: { show: { toolSelection: ['single'], operation: ['executeTool'] } },
				description:
					'The one tool this node calls. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Tool Arguments',
				name: 'toolArguments',
				type: 'json',
				default: '{}',
				displayOptions: { show: { toolSelection: ['single'], operation: ['executeTool'] } },
				description:
					'Arguments for the tool, as a JSON object matching its input schema',
			},
			// All / Selected are the model-driven modes: these two default to
			// $fromAI() so an agent can reach every allowed tool with no extra
			// setup. n8n collects the tool schema by scanning stored parameter
			// values for $fromAI() calls, so the defaults are what wire it up.
			{
				displayName: 'Tool Name',
				name: 'modelToolName',
				type: 'string',
				default:
					"={{ $fromAI('tool_name', 'Name of the DataGrout tool to call. If you do not know the available names, call with an empty string and the response will list them.', 'string') }}",
				required: true,
				displayOptions: { show: { toolSelection: ['all', 'selected'], operation: ['executeTool'] } },
				description:
					'The tool to call. Left as-is, the model chooses it at call time — an unknown name returns the list of available tools rather than failing, so it can correct itself.',
			},
			{
				displayName: 'Tool Arguments',
				name: 'modelToolArguments',
				type: 'json',
				default:
					"={{ $fromAI('tool_arguments', 'A JSON object of arguments matching the chosen tool input schema', 'json') }}",
				displayOptions: { show: { toolSelection: ['all', 'selected'], operation: ['executeTool'] } },
				description:
					'Arguments for the tool. Left as-is, the model fills these in at call time.',
			},
		],
	};

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

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		// `isToolExecution()` is NOT usable here: n8n's ExecuteContext hardcodes it
		// to `false`, and a usableAsTool node runs execute() through exactly that
		// context (only SupplyDataContext ever returns true). The All and Selected
		// modes are the model-driven ones by definition, so use the mode itself to
		// decide: hand failures back as data there so the model can read them and
		// retry, and throw in Single Tool mode where a workflow expects a failure.
		const softFail = (this.getNodeParameter('toolSelection', 0, 'all') as string) !== 'single';

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i, 'executeTool') as string;
				const selection = this.getNodeParameter('toolSelection', i, 'all') as string;
				const allowList =
					selection === 'selected'
						? (this.getNodeParameter('includeTools', i, []) as string[])
						: [];

				// Discovery: hands an agent every allowed tool name + input schema in
				// one call, so one Execute Tool node can then reach any of them.
				if (operation === 'listTools') {
					const pinned =
						selection === 'single' ? (this.getNodeParameter('tool', i, '') as string) : '';
					for (const t of await mcpListTools(this)) {
						const name = (t.name as string) ?? '';
						if (selection === 'selected' && !allowList.includes(name)) continue;
						if (selection === 'single' && name !== pinned) continue;
						returnData.push({
							json: { name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} },
							pairedItem: { item: i },
						});
					}
					continue;
				}

				const requested = (
					selection === 'single'
						? (this.getNodeParameter('tool', i) as string)
						: String(this.getNodeParameter('modelToolName', i, '') ?? '')
				).trim();

				let toolName = requested;

				// In the model-driven modes the name is free text, so resolve it
				// against what the server actually exposes (bounded by the allow-list,
				// which is the permission boundary). An unresolved name never reaches
				// the gateway — the model gets the catalogue back and can retry.
				if (selection !== 'single') {
					const available = await cachedTools(this);
					const permitted =
						selection === 'selected'
							? available.filter((t) => allowList.includes(t.name))
							: available;
					const resolved = requested
						? resolveToolName(
								requested,
								permitted.map((t) => t.name),
							)
						: undefined;

					if (!resolved) {
						const json: IDataObject = {
							error: requested
								? `The tool "${requested}" is not available on this node. Call one of the tools in availableTools, using its name exactly.`
								: 'No tool name was provided. Call one of the tools in availableTools, using its name exactly.',
							availableTools: describeTools(permitted),
						};
						if (permitted.length > MAX_LISTED_TOOLS) {
							json.note = `Showing ${MAX_LISTED_TOOLS} of ${permitted.length} tools.`;
						}
						returnData.push({ json, pairedItem: { item: i } });
						continue;
					}
					toolName = resolved;
				} else if (!toolName) {
					throw new NodeOperationError(this.getNode(), 'No tool was selected', { itemIndex: i });
				}
				const callArgs = injectLeanDefaults(
					toolName,
					parseArguments(
						this,
						selection === 'single'
							? this.getNodeParameter('toolArguments', i, '{}')
							: this.getNodeParameter('modelToolArguments', i, '{}'),
						i,
					),
				);

				const result = await withSession(this, DEFAULT_TIMEOUT_MS, async (sessionId) => {
					const { result: callResult } = await mcpRequest(
						this,
						{
							jsonrpc: '2.0',
							id: 3,
							method: 'tools/call',
							params: { name: toolName, arguments: callArgs },
						},
						sessionId,
						DEFAULT_TIMEOUT_MS,
					);

					// Transparent background-task collection: long DataGrout calls
					// detach; poll tasks.wait so the caller receives the finished
					// result instead of a task stub it must manage.
					const taskRef = detachedTaskRef(callResult);
					if (taskRef) {
						const collected = await collectDetached(
							this,
							sessionId,
							taskRef,
							DEFAULT_TASK_WAIT_MS,
							DEFAULT_TIMEOUT_MS,
						);
						if (collected) return collected;
					}
					return callResult;
				});

				if (result.isError) {
					throw new NodeOperationError(this.getNode(), errorText(result), { itemIndex: i });
				}

				returnData.push({ json: toOutputJson(result), pairedItem: { item: i } });
			} catch (error) {
				if (softFail || this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
