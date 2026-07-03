import type { INodeProperties } from 'n8n-workflow';

const resource: INodeProperties = {
	displayName: 'Resource',
	name: 'resource',
	type: 'options',
	noDataExpression: true,
	options: [
		{ name: 'Tool', value: 'tool' },
		{ name: 'Resource', value: 'resource' },
		{ name: 'Prompt', value: 'prompt' },
		{ name: 'Advanced', value: 'advanced' },
	],
	default: 'tool',
};

const toolOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['tool'] } },
	options: [
		{
			name: 'List Tools',
			value: 'listTools',
			action: 'List tools',
			description: 'List the tools the MCP server exposes',
		},
		{
			name: 'Call Tool',
			value: 'callTool',
			action: 'Call a tool',
			description: 'Invoke a tool on the MCP server',
		},
	],
	default: 'listTools',
};

const resourceOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['resource'] } },
	options: [
		{
			name: 'List Resources',
			value: 'listResources',
			action: 'List resources',
			description: 'List the resources the MCP server exposes',
		},
		{
			name: 'Read Resource',
			value: 'readResource',
			action: 'Read a resource',
			description: 'Read a resource by URI',
		},
	],
	default: 'listResources',
};

const promptOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['prompt'] } },
	options: [
		{
			name: 'List Prompts',
			value: 'listPrompts',
			action: 'List prompts',
			description: 'List the prompts the MCP server exposes',
		},
		{
			name: 'Get Prompt',
			value: 'getPrompt',
			action: 'Get a prompt',
			description: 'Get a prompt by name',
		},
	],
	default: 'listPrompts',
};

const advancedOperations: INodeProperties = {
	displayName: 'Operation',
	name: 'operation',
	type: 'options',
	noDataExpression: true,
	displayOptions: { show: { resource: ['advanced'] } },
	options: [
		{
			name: 'Raw JSON-RPC',
			value: 'rawJsonRpc',
			action: 'Send a raw JSON RPC request',
			description: 'Send an arbitrary JSON-RPC method and params to the server',
		},
	],
	default: 'rawJsonRpc',
};

const callToolFields: INodeProperties[] = [
	{
		displayName: 'Tool',
		name: 'toolName',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		displayOptions: { show: { resource: ['tool'], operation: ['callTool'] } },
		description: 'The tool to call. Use List Tools first to discover available tools.',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'getTools', searchable: true },
			},
			{
				displayName: 'By Name',
				name: 'name',
				type: 'string',
				placeholder: 'e.g. search_documents',
			},
		],
	},
	{
		displayName: 'Arguments',
		name: 'arguments',
		type: 'json',
		default: '{}',
		displayOptions: { show: { resource: ['tool'], operation: ['callTool'] } },
		description: 'Arguments for the tool as a JSON object, matching the tool input schema',
	},
];

const readResourceFields: INodeProperties[] = [
	{
		displayName: 'Resource URI',
		name: 'uri',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['resource'], operation: ['readResource'] } },
		description: 'URI of the resource to read',
	},
];

const getPromptFields: INodeProperties[] = [
	{
		displayName: 'Prompt Name',
		name: 'promptName',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['prompt'], operation: ['getPrompt'] } },
		description: 'Name of the prompt to get',
	},
	{
		displayName: 'Arguments',
		name: 'arguments',
		type: 'json',
		default: '{}',
		displayOptions: { show: { resource: ['prompt'], operation: ['getPrompt'] } },
		description: 'Arguments for the prompt as a JSON object',
	},
];

const rawJsonRpcFields: INodeProperties[] = [
	{
		displayName: 'Method',
		name: 'method',
		type: 'string',
		default: '',
		required: true,
		displayOptions: { show: { resource: ['advanced'], operation: ['rawJsonRpc'] } },
		placeholder: 'e.g. tools/list',
		description: 'The JSON-RPC method to call',
	},
	{
		displayName: 'Params',
		name: 'params',
		type: 'json',
		default: '{}',
		displayOptions: { show: { resource: ['advanced'], operation: ['rawJsonRpc'] } },
		description: 'The JSON-RPC params as a JSON object',
	},
];

export const dataGroutProperties: INodeProperties[] = [
	resource,
	toolOperations,
	resourceOperations,
	promptOperations,
	advancedOperations,
	...callToolFields,
	...readResourceFields,
	...getPromptFields,
	...rawJsonRpcFields,
];
