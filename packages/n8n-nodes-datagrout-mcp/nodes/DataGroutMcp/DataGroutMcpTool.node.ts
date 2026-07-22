import { DynamicStructuredTool } from '@langchain/core/tools';
import { jsonSchemaToZod } from '@n8n/json-schema-to-zod';
import { createRequire } from 'module';
import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	ISupplyDataFunctions,
	SupplyData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, OperationalError } from 'n8n-workflow';
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────
// Minimal MCP client over Streamable HTTP (same protocol implementation
// as @datagrout/n8n-nodes-datagrout, widened to ISupplyDataFunctions).
// ────────────────────────────────────────────────────────────────────

const PROTOCOL_VERSION = '2025-06-18';

type Ctx = IExecuteFunctions | ILoadOptionsFunctions | ISupplyDataFunctions;

function parsePossiblySse(raw: unknown): IDataObject {
	if (typeof raw === 'object' && raw !== null) return raw as IDataObject;
	const text = String(raw);
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
	if (!response.body) return { result: {}, sessionId: newSessionId };

	const parsed = parsePossiblySse(response.body);
	if (parsed.error) {
		const err = parsed.error as IDataObject;
		throw new OperationalError(`MCP error ${err.code as number}: ${err.message as string}`);
	}
	return { result: (parsed.result as IDataObject) ?? {}, sessionId: newSessionId };
}

async function mcpSession(ctx: Ctx): Promise<string | undefined> {
	const { sessionId } = await mcpRequest(ctx, {
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: 'n8n-nodes-datagrout-mcp', version: '1.0.0' },
		},
	});
	await mcpRequest(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
	return sessionId;
}

async function mcpListTools(ctx: Ctx): Promise<IDataObject[]> {
	const sessionId = await mcpSession(ctx);
	const { result } = await mcpRequest(
		ctx,
		{ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
		sessionId,
	);
	return (result.tools as IDataObject[]) ?? [];
}

// ────────────────────────────────────────────────────────────────────
// Tool conversion helpers
// ────────────────────────────────────────────────────────────────────

// Loose signature — the converter's inferred type trips TS "excessively deep".
const convertJsonSchemaToZod = jsonSchemaToZod as unknown as (schema: unknown) => z.ZodTypeAny;

/** Convert an MCP inputSchema (JSON Schema) to a Zod object schema. */
function toZodSchema(inputSchema: unknown): z.ZodTypeAny {
	if (!inputSchema || typeof inputSchema !== 'object') return z.object({});
	try {
		const raw = convertJsonSchemaToZod(inputSchema);
		return raw instanceof z.ZodObject ? raw : z.object({ value: raw });
	} catch {
		return z.object({});
	}
}

/** Make an MCP tool name safe for LLM function names and unique. */
function sanitizeToolName(name: string, used: Set<string>): string {
	let base = name
		.replace(/[^a-zA-Z0-9_-]/g, '_')
		.replace(/_+/g, '_')
		.slice(0, 64);
	if (!base) base = 'tool';
	let candidate = base;
	let n = 1;
	while (used.has(candidate)) {
		const suffix = `_${n++}`;
		candidate = base.slice(0, 64 - suffix.length) + suffix;
	}
	used.add(candidate);
	return candidate;
}

/** Flatten an MCP tool result into a non-empty string for the agent. */
function formatToolResult(result: IDataObject): string {
	const content = result.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => {
				const block = c as { type?: string; text?: string };
				return block?.type === 'text' && typeof block.text === 'string'
					? block.text
					: JSON.stringify(c);
			})
			.join('\n')
			.trim();
		if (text.length) return text;
	}
	const serialized = JSON.stringify(result);
	return serialized && serialized !== 'undefined' ? serialized : '(no result)';
}

/**
 * n8n's agent only expands a supplyData response into SEPARATE agent tools when
 * it is an instance of n8n-core's `StructuredToolkit` class (checked via
 * `instanceof` in getConnectedTools). That class is not importable by community
 * packages, so we resolve it at runtime from the running n8n installation via
 * the main module's require. Falls back to undefined (single-tool behavior)
 * if n8n's internals change.
 */
type ToolkitCtor = new (tools: unknown[]) => unknown;
function getStructuredToolkit(): ToolkitCtor | undefined {
	const entry = require.main?.filename ?? process.argv[1];
	if (!entry) return undefined;
	const rootReq = createRequire(entry);
	const pick = (core: { StructuredToolkit?: ToolkitCtor }) =>
		typeof core.StructuredToolkit === 'function' ? core.StructuredToolkit : undefined;
	// pnpm can host MULTIPLE n8n-core instances (different peer hashes). The
	// `instanceof StructuredToolkit` check we must satisfy lives inside
	// @n8n/n8n-nodes-langchain (getConnectedTools), so resolve n8n-core the way
	// THAT package does — resolving from bin/n8n can yield a different class.
	try {
		const pkgJson = rootReq.resolve('@n8n/n8n-nodes-langchain/package.json');
		const toolkit = pick(createRequire(pkgJson)('n8n-core'));
		if (toolkit) return toolkit;
	} catch {}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const fs = require('fs') as typeof import('fs');
		const link = rootReq
			.resolve('n8n-workflow')
			.replace(/n8n-workflow.*$/, '') // a node_modules root n8n can see
			.concat('@n8n/n8n-nodes-langchain');
		const real = fs.realpathSync(link);
		const toolkit = pick(createRequire(`${real}/index.js`)('n8n-core'));
		if (toolkit) return toolkit;
	} catch {}
	try {
		return pick(rootReq('n8n-core'));
	} catch {
		return undefined;
	}
}

// ────────────────────────────────────────────────────────────────────

export class DataGroutMcpTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DataGrout MCP',
		name: 'dataGroutMcpTool',
		icon: { light: 'file:datagrout.svg', dark: 'file:datagrout.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{"Tools: " + $parameter["toolsToInclude"]}}',
		description:
			"Give an AI Agent access to every tool on a DataGrout MCP server — each server tool appears as a separate agent tool",
		defaults: { name: 'DataGrout MCP' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Model Context Protocol', 'Tools'] },
			alias: ['MCP', 'Model Context Protocol', 'DataGrout'],
			resources: {
				primaryDocumentation: [{ url: 'https://library.datagrout.ai/' }],
			},
		},
		inputs: [],
		outputs: [{ type: NodeConnectionTypes.AiTool, displayName: 'Tools' }],
		credentials: [{ name: 'dataGroutApi', required: true }],
		properties: [
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
					'The permission boundary for what the connected AI Agent is allowed to call',
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

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const mode = this.getNodeParameter('toolsToInclude', itemIndex, 'all') as string;
		const includeTools = this.getNodeParameter('includeTools', itemIndex, []) as string[];
		const excludeTools = this.getNodeParameter('excludeTools', itemIndex, []) as string[];

		const allTools = await mcpListTools(this);
		const selected = allTools.filter((t) => {
			const name = t.name as string;
			if (mode === 'selected') return includeTools.includes(name);
			if (mode === 'except') return !excludeTools.includes(name);
			return true;
		});

		const used = new Set<string>();
		const tools = selected.map((mcpTool) => {
			const realName = mcpTool.name as string;
			const safeName = sanitizeToolName(realName, used);
			return new DynamicStructuredTool({
				name: safeName,
				description: (mcpTool.description as string) ?? realName,
				schema: toZodSchema(mcpTool.inputSchema),
				metadata: { isFromToolkit: true },
				func: async (args: Record<string, unknown>) => {
					const sessionId = await mcpSession(this);
					const { result } = await mcpRequest(
						this,
						{
							jsonrpc: '2.0',
							id: 3,
							method: 'tools/call',
							params: { name: realName, arguments: (args ?? {}) as IDataObject },
						},
						sessionId,
					);
					if (result.isError) {
						const content = (result.content as IDataObject[]) ?? [];
						const message =
							(content.find((c) => c.type === 'text')?.text as string) ??
							'Tool returned an error';
						throw new NodeOperationError(this.getNode(), message, { itemIndex });
					}
					return formatToolResult(result);
				},
			});
		});

		const StructuredToolkit = getStructuredToolkit();
		this.logger.info(
			`[DataGrout MCP] tools listed=${allTools.length} exposed=${tools.length} toolkit=${
				StructuredToolkit ? 'resolved' : 'UNRESOLVED (fallback)'
			}`,
		);
		if (StructuredToolkit) {
			// Expands into one agent tool per MCP tool (the Atlassian-MCP experience).
			return { response: new StructuredToolkit(tools) };
		}
		// Fallback if n8n-core is unreachable: n8n treats the array as-is.
		return { response: tools };
	}

	/** Makes the node's "Execute step" button work: lists the exposed tools. */
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const mode = this.getNodeParameter('toolsToInclude', 0, 'all') as string;
		const includeTools = this.getNodeParameter('includeTools', 0, []) as string[];
		const excludeTools = this.getNodeParameter('excludeTools', 0, []) as string[];

		const allTools = await mcpListTools(this);
		const selected = allTools.filter((t) => {
			const name = t.name as string;
			if (mode === 'selected') return includeTools.includes(name);
			if (mode === 'except') return !excludeTools.includes(name);
			return true;
		});

		return [
			selected.map((t) => ({
				json: {
					name: t.name,
					description: t.description ?? '',
					inputSchema: t.inputSchema ?? {},
				},
				pairedItem: { item: 0 },
			})),
		];
	}
}
