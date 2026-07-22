import type {
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IDataObject, JsonObject 
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError, OperationalError } from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Minimal MCP client over Streamable HTTP — zero dependencies.
// Handles both application/json and text/event-stream (SSE) responses.
// ────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2025-06-18';

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
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
	body: IDataObject,
	sessionId?: string,
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

async function mcpSession(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<string | undefined> {
	const { sessionId } = await mcpRequest(ctx, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'n8n-nodes-datagrout', version: '1.0.0' },
		},
	});
	// Required notification after initialize
	await mcpRequest(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
	return sessionId;
}

async function mcpListTools(
	ctx: IExecuteFunctions | ILoadOptionsFunctions,
): Promise<IDataObject[]> {
	const sessionId = await mcpSession(ctx);
	const { result } = await mcpRequest(
		ctx,
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
		sessionId,
	);
	return (result.tools as IDataObject[]) ?? [];
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
				description: 'Only these tools will be available. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Excluded Tool Names or IDs',
				name: 'excludeTools',
				type: 'multiOptions',
				typeOptions: { loadOptionsMethod: 'getTools' },
				default: [],
				required: true,
				displayOptions: { show: { toolsToInclude: ['except'] } },
				description: 'All tools except these will be available. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
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
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						default: 60000,
						description: 'Request timeout in milliseconds',
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

				if (operation === 'listTools') {
					const tools = await mcpListTools(this);
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
					const args: IDataObject =
						typeof rawArgs === 'string'
							? (JSON.parse(rawArgs) as IDataObject)
							: (rawArgs as IDataObject);

					const sessionId = await mcpSession(this);
					const { result } = await mcpRequest(
						this,
						{
							jsonrpc: '2.0',
							id: 3,
							method: 'tools/call',
							params: { name: toolName, arguments: args },
						},
						sessionId,
					);

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
