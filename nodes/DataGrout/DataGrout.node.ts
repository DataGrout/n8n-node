import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';
import { dataGroutProperties } from './shared/descriptions';
import { dataGroutRpcRequest } from './shared/transport';
import { getTools } from './listSearch/getTools';

function parseJsonParam(
	this: IExecuteFunctions,
	value: unknown,
	paramName: string,
	itemIndex: number,
): IDataObject {
	if (value === undefined || value === null || value === '') return {};
	if (typeof value === 'object') return value as IDataObject;
	try {
		return JSON.parse(value as string) as IDataObject;
	} catch {
		throw new NodeOperationError(this.getNode(), `Parameter "${paramName}" must be valid JSON`, {
			itemIndex,
		});
	}
}

export class DataGrout implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DataGrout',
		name: 'dataGrout',
		icon: { light: 'file:../../icons/datagrout.svg', dark: 'file:../../icons/datagrout.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Interact with a DataGrout remote MCP server',
		defaults: { name: 'DataGrout' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'dataGroutApi', required: true }],
		properties: dataGroutProperties,
	};

	methods = {
		listSearch: {
			getTools,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;

				let method = '';
				let params: IDataObject = {};

				if (resource === 'tool' && operation === 'listTools') {
					method = 'tools/list';
				} else if (resource === 'tool' && operation === 'callTool') {
					method = 'tools/call';
					const name = this.getNodeParameter('toolName', i, '', {
						extractValue: true,
					}) as string;
					const args = parseJsonParam.call(
						this,
						this.getNodeParameter('arguments', i, '{}'),
						'Arguments',
						i,
					);
					params = { name, arguments: args };
				} else if (resource === 'resource' && operation === 'listResources') {
					method = 'resources/list';
				} else if (resource === 'resource' && operation === 'readResource') {
					method = 'resources/read';
					params = { uri: this.getNodeParameter('uri', i) as string };
				} else if (resource === 'prompt' && operation === 'listPrompts') {
					method = 'prompts/list';
				} else if (resource === 'prompt' && operation === 'getPrompt') {
					method = 'prompts/get';
					const args = parseJsonParam.call(
						this,
						this.getNodeParameter('arguments', i, '{}'),
						'Arguments',
						i,
					);
					params = { name: this.getNodeParameter('promptName', i) as string, arguments: args };
				} else if (resource === 'advanced' && operation === 'rawJsonRpc') {
					method = this.getNodeParameter('method', i) as string;
					params = parseJsonParam.call(
						this,
						this.getNodeParameter('params', i, '{}'),
						'Params',
						i,
					);
				} else {
					throw new NodeOperationError(
						this.getNode(),
						`Unsupported resource/operation: ${resource}/${operation}`,
						{ itemIndex: i },
					);
				}

				const result = await dataGroutRpcRequest.call(this, method, params, i);
				returnData.push({ json: result, pairedItem: { item: i } });
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
