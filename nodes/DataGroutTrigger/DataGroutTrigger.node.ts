import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import {
	EVENTS_TOPIC,
	SUBPROTOCOL,
	exampleEvent,
	startEventSession,
} from '../DataGrout/pure';

// ────────────────────────────────────────────────────────────────────
// Starts a workflow when DataGrout pushes an event.
//
// DataGrout multiplexes JSON-RPC 2.0 over a single WebSocket, so one
// connection carries every subscription and the server pushes without
// the workflow polling for anything. Node's built-in WebSocket is used,
// keeping the package free of runtime dependencies.
//
// The socket lifecycle itself lives in ../DataGrout/wsSession, which
// takes its dependencies as arguments so the tests can drive it without
// a network or the n8n runtime. What remains here is the adapter:
// read parameters, supply a real socket, hand n8n its two callbacks.
// ────────────────────────────────────────────────────────────────────

type Credentials = {
	apiToken?: string;
	serverId?: string;
	baseUrl?: string;
	oauthTokenData?: { access_token?: string };
};

function bearer(credentials: Credentials): string | undefined {
	return credentials.oauthTokenData?.access_token ?? credentials.apiToken;
}

// A trigger starts workflows and is never called by an agent. The property's
// type only accepts `true`, so it is omitted rather than set to false.
// eslint-disable-next-line @n8n/community-nodes/node-usable-as-tool
export class DataGroutTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'DataGrout Trigger',
		name: 'dataGroutTrigger',
		icon: { light: 'file:datagrout.svg', dark: 'file:datagrout.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{ $parameter["events"].length ? "on: " + $parameter["events"].join(", ") : "on: any event" }}',
		description: 'Start a workflow when a DataGrout run or background task finishes or fails',
		defaults: { name: 'DataGrout Trigger' },
		codex: {
			categories: ['AI', 'Data & Storage'],
			alias: ['DataGrout', 'trigger', 'events'],
			resources: { primaryDocumentation: [{ url: 'https://library.datagrout.ai/' }] },
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'dataGroutApi',
				required: true,
				displayOptions: { show: { authentication: ['apiToken'] } },
			},
			{
				name: 'dataGroutOAuth2Api',
				required: true,
				displayOptions: { show: { authentication: ['oAuth2'] } },
			},
		],
		properties: [
			{
				displayName: 'Authentication',
				name: 'authentication',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'API Token', value: 'apiToken' },
					{ name: 'OAuth2', value: 'oAuth2' },
				],
				default: 'apiToken',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: [],
				description:
					'Which events start the workflow. Leave empty to receive every event DataGrout publishes for this server.',
				options: [
					{
						name: 'Run Completed',
						value: 'run.completed',
						description:
							'A run reached a terminal status. The status travels with the event, so failed, timed-out and cancelled runs arrive here too.',
					},
					{
						name: 'Task Completed',
						value: 'task.completed',
						description:
							'A background task finished. Its cache_ref comes with the event, so a following node can fetch the result.',
					},
					{
						name: 'Task Failed',
						value: 'task.failed',
						description:
							'A background task failed. Nothing else reports this — whoever started the task stopped waiting long before.',
					},
					{
						name: 'Tool Call Failed',
						value: 'tool_call.failed',
						description: 'A tool call errored inside a run, which may still go on to recover',
					},
				],
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Include Event Name',
						name: 'includeEventName',
						type: 'boolean',
						default: true,
						description: 'Whether to add the event name to each item as "event"',
					},
					{
						displayName: 'Reconnect Automatically',
						name: 'reconnect',
						type: 'boolean',
						default: true,
						description:
							'Whether to reopen the connection if it drops, with a backing-off delay',
					},
					{
						displayName: 'Topic',
						name: 'topic',
						type: 'string',
						default: EVENTS_TOPIC,
						description:
							'The stream to listen on. The default carries every lifecycle event for this server. Change it only to follow a single orchestration run, which publishes to a topic of its own.',
					},
				],
			},
		],
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		// Node's global WebSocket is what keeps this dependency-free; it is
		// available from Node 22. Fail with something actionable rather than a
		// ReferenceError deep in a listener.
		if (typeof WebSocket === 'undefined') {
			throw new NodeOperationError(
				this.getNode(),
				'This trigger needs a WebSocket, which requires n8n running on Node 22 or newer',
			);
		}

		const authentication = this.getNodeParameter('authentication', 'apiToken') as string;
		const credentialName = authentication === 'oAuth2' ? 'dataGroutOAuth2Api' : 'dataGroutApi';
		const credentials = (await this.getCredentials(credentialName)) as Credentials;

		const wanted = this.getNodeParameter('events', []) as string[];
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const includeEventName = (options.includeEventName as boolean) ?? true;
		const reconnect = (options.reconnect as boolean) ?? true;
		const topic = String(options.topic ?? EVENTS_TOPIC).trim() || EVENTS_TOPIC;

		const token = bearer(credentials);
		if (!token) {
			throw new NodeOperationError(this.getNode(), 'The DataGrout credential has no token');
		}

		const baseUrl = String(credentials.baseUrl ?? 'https://gateway.datagrout.ai').replace(
			/\/$/,
			'',
		);
		const serverId = String(credentials.serverId ?? '');
		if (!serverId) {
			throw new NodeOperationError(
				this.getNode(),
				'The DataGrout credential is missing its Server ID',
			);
		}

		// DataGrout gates transports per server, so make sure the WebSocket
		// transport is on before dialling. Idempotent, and it keeps setup out of
		// the dashboard.
		for (const protocol of ['ws', 'jsonrpc']) {
			try {
				await this.helpers.httpRequestWithAuthentication.call(this, credentialName, {
					method: 'POST',
					url: `${baseUrl}/servers/${serverId}/interaction/enable_protocol`,
					body: { protocol },
					json: true,
				});
			} catch (error) {
				this.logger.warn(
					`[DataGrout Trigger] could not enable "${protocol}": ${(error as Error).message}`,
				);
			}
		}

		const wsUrl = `${baseUrl.replace(/^http/, 'ws')}/servers/${serverId}/ws`;

		const session = startEventSession({
			topic,
			events: wanted,
			includeEventName,
			reconnect,
			sleep,
			log: this.logger,
			emit: (json) => this.emit([this.helpers.returnJsonArray([json])]),
			// `headers` is an undici extension to the WHATWG constructor; it is how
			// the bearer token reaches the upgrade request, which the standard API
			// gives no way to do.
			connect: () =>
				new WebSocket(wsUrl, {
					headers: { Authorization: `Bearer ${token}` },
					protocols: [SUBPROTOCOL],
				} as unknown as string[]),
			openState: WebSocket.OPEN,
		});

		const closeFunction = async () => session.close();

		// "Test step" in the editor: emit an example carrying the real fields of
		// whichever event was selected, so downstream nodes can be wired against
		// the actual shape without waiting for one to happen.
		const manualTriggerFunction = async () => {
			this.emit([this.helpers.returnJsonArray([exampleEvent(wanted[0])])]);
		};

		return { closeFunction, manualTriggerFunction };
	}
}
