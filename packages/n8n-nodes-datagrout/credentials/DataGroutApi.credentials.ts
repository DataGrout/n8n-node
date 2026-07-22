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
			description: 'Generate this token in your DataGrout dashboard',
		},
		{
			displayName: 'Server ID',
			name: 'serverId',
			type: 'string',
			default: '',
			required: true,
			description: 'The UUID of your DataGrout server (from gateway.datagrout.ai/servers/{uuid})',
		},
		{
			displayName: 'Gateway Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://gateway.datagrout.ai',
			description: 'Base URL of the DataGrout gateway (use the staging host for testing)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiToken}}',
			},
		},
	};

	// Credential test: a minimal MCP initialize round-trip.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}/servers/{{$credentials.serverId}}',
			url: '/mcp',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
			},
			body: {
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'n8n-datagrout-credential-test', version: '1.0.0' },
				},
			},
		},
	};
}
