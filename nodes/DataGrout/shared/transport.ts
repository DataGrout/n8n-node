import {
	NodeApiError,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type ILoadOptionsFunctions,
	type JsonObject,
} from 'n8n-workflow';

interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: IDataObject;
	error?: JsonRpcError;
}

/**
 * Send a single JSON-RPC 2.0 request to the DataGrout stateless /rpc endpoint
 * using the dataGroutApi credential for auth. Returns the `result` object or
 * throws a NodeApiError describing the JSON-RPC or transport failure.
 */
export async function dataGroutRpcRequest(
	this: IExecuteFunctions | ILoadOptionsFunctions,
	method: string,
	params: IDataObject = {},
	itemIndex = 0,
): Promise<IDataObject> {
	const credentials = await this.getCredentials('dataGroutApi');
	const baseUrl = (credentials.baseUrl as string).replace(/\/$/, '');
	const serverId = credentials.serverId as string;

	const options: IHttpRequestOptions = {
		method: 'POST',
		url: `${baseUrl}/servers/${serverId}/rpc`,
		headers: { 'Content-Type': 'application/json' },
		body: {
			jsonrpc: '2.0',
			id: 1,
			method,
			params,
		},
		json: true,
	};

	let response: JsonRpcResponse;
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'dataGroutApi',
			options,
		)) as JsonRpcResponse;
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
	}

	if (response.error) {
		throw new NodeApiError(this.getNode(), response.error as unknown as JsonObject, {
			message: `DataGrout MCP error ${response.error.code}`,
			description: response.error.message,
			itemIndex,
		});
	}

	return response.result ?? {};
}
