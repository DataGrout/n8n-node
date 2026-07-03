import type {
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';
import { dataGroutRpcRequest } from '../shared/transport';

interface McpTool {
	name: string;
	description?: string;
}

export async function getTools(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const result = await dataGroutRpcRequest.call(this, 'tools/list', {});
	const tools = (result.tools as McpTool[] | undefined) ?? [];

	const results: INodeListSearchItems[] = tools
		.filter((tool) =>
			filter ? tool.name.toLowerCase().includes(filter.toLowerCase()) : true,
		)
		.map((tool) => ({
			name: tool.name,
			value: tool.name,
			description: tool.description,
		}));

	return { results };
}
