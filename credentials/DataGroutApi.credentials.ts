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

	// Proves the token and the server, and turns on the JSON-RPC transport this
	// node uses (DataGrout servers ship with only MCP enabled). The call is
	// idempotent, so testing the credential twice is harmless.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '=/servers/{{$credentials.serverId}}/interaction/enable_protocol',
			method: 'POST',
			body: { protocol: 'jsonrpc' },
		},
	};
}
