import type { Icon, ICredentialType, INodeProperties } from 'n8n-workflow';

/**
 * OAuth 2.1 against the DataGrout gateway.
 *
 * Every field here is hidden, so the credential UI shows nothing but "Connect my
 * account". That is possible because the gateway issues clients through Dynamic
 * Client Registration (RFC 7591) — there is no client ID or secret to paste —
 * and because it now serves every account from one global endpoint, so there is
 * no per-user URL or server ID to fill in either.
 *
 * n8n does the rest itself when a credential extending `oAuth2Api` sets
 * `useDynamicClientRegistration` with a `serverUrl`: it reads the
 * protected-resource metadata, follows it to the authorization server,
 * registers a client, and picks the grant from what the server advertises.
 *
 * n8n also refreshes the access token, but only for requests made through
 * `httpRequestWithAuthentication` — which is why the node routes calls through
 * it rather than setting an Authorization header by hand.
 */
export class DataGroutOAuth2Api implements ICredentialType {
	name = 'dataGroutOAuth2Api';

	extends = ['oAuth2Api'];

	displayName = 'DataGrout OAuth2 API';

	documentationUrl = 'https://library.datagrout.ai/authentication';

	icon: Icon = { light: 'file:../icons/datagrout.svg', dark: 'file:../icons/datagrout.dark.svg' };

	properties: INodeProperties[] = [
		{
			displayName: 'Gateway URL',
			name: 'serverUrl',
			type: 'hidden',
			default: 'https://gateway.datagrout.ai/connect',
		},
		{
			displayName: 'Use Dynamic Client Registration',
			name: 'useDynamicClientRegistration',
			type: 'hidden',
			default: true,
		},
		{
			displayName: 'Grant Type',
			name: 'grantType',
			type: 'hidden',
			default: 'pkce',
		},
	];
}
