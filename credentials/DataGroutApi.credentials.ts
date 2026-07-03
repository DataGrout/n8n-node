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

	icon: Icon = { light: 'file:../icons/datagrout.svg', dark: 'file:../icons/datagrout.dark.svg' };

	documentationUrl = 'https://library.datagrout.ai/authentication';

	properties: INodeProperties[] = [
		{
			displayName: 'Gateway Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://gateway.datagrout.ai',
			description: 'Base URL of the DataGrout gateway',
		},
		{
			displayName: 'Server ID',
			name: 'serverId',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'e.g. 123e4567-e89b-12d3-a456-426614174000',
			description: 'UUID of the target MCP server (from the gateway URL)',
		},
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Bearer access token created in the DataGrout UI under Settings > Authentication',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.accessToken}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '=/servers/{{$credentials.serverId}}/rpc',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/list',
				params: {},
			},
		},
	};
}
