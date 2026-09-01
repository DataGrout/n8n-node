import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class DataGroutApi implements ICredentialType {
	name = 'dataGroutApi';

	displayName = 'DataGrout API';

	documentationUrl = 'https://library.datagrout.ai/authentication';

	icon: Icon = { light: 'file:../icons/datagrout.svg', dark: 'file:../icons/datagrout.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'Generate this in your DataGrout dashboard',
		},
		{
			displayName: 'Server ID',
			name: 'serverId',
			type: 'string',
			default: '',
			required: true,
			description: 'Your DataGrout server UUID',
		},
		{
			displayName: 'Gateway Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://gateway.datagrout.ai',
			description: 'Change this only for a self-hosted DataGrout gateway',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: { Authorization: '=Bearer {{$credentials.apiToken}}' },
		},
	};

	// A credential test answers "are these credentials valid?", so it reads and
	// changes nothing. `tools.list` settles both halves of the credential: a bad
	// token is rejected by the gateway's auth plug (401/403), and an unknown
	// Server ID is a 404.
	//
	// A server that has not yet switched on the JSON-RPC transport answers HTTP
	// 200 with a JSON-RPC error in the body, which n8n reads as a pass — rightly,
	// because that is a server setting rather than a bad credential. The node
	// switches the transport on when a workflow actually runs, not when someone
	// clicks Test.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '=/servers/{{$credentials.serverId}}/rpc',
			method: 'POST',
			body: { jsonrpc: '2.0', id: 1, method: 'tools.list', params: {} },
		},
	};
}
