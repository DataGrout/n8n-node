import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	ITriggerFunctions,
	ITriggerResponse,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError, sleep } from 'n8n-workflow';

import { subscribeAck, subscriptionEvent } from '../DataGrout/pure';

// ────────────────────────────────────────────────────────────────────
// Starts a workflow when DataGrout pushes an event.
//
// DataGrout multiplexes JSON-RPC 2.0 over a single WebSocket, so one
// connection carries every subscription and the server pushes without
// the workflow polling for anything. Node's built-in WebSocket is used,
// keeping the package free of runtime dependencies.
// ────────────────────────────────────────────────────────────────────

const SUBPROTOCOL = 'datagrout-jsonrpc.v1';
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

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
		subtitle: '={{"on: " + $parameter["topic"]}}',
		description: 'Start a workflow when DataGrout reports progress on a run',
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
				displayName: 'Topic',
				name: 'topic',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'orchestrate.run_abc123',
				description:
					'The stream of events to listen to. DataGrout publishes a run\'s progress to a topic named after that run; pass your own topic when you start the run to choose the name.',
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

		const topic = String(this.getNodeParameter('topic', '') ?? '').trim();
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const includeEventName = (options.includeEventName as boolean) ?? true;
		const reconnect = (options.reconnect as boolean) ?? true;

		if (!topic) {
			throw new NodeOperationError(this.getNode(), 'Topic is empty');
		}

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

		let socket: WebSocket | undefined;
		let closing = false;
		let attempt = 0;
		let rpcId = 0;
		let subscriptionId: string | undefined;

		const reopenAfter = async (delay: number) => {
			await sleep(delay);
			if (!closing) open();
		};

		const open = () => {
			if (closing) return;

			// `headers` is an undici extension to the WHATWG constructor; it is how
			// the bearer token reaches the upgrade request, which the standard API
			// gives no way to do.
			socket = new WebSocket(wsUrl, {
				headers: { Authorization: `Bearer ${token}` },
				protocols: [SUBPROTOCOL],
			} as unknown as string[]);

			socket.addEventListener('open', () => {
				attempt = 0;
				this.logger.info(`[DataGrout Trigger] connected, subscribing to "${topic}"`);
				socket?.send(
					JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'subscribe', params: { topic } }),
				);
			});

			socket.addEventListener('message', (message: MessageEvent) => {
				let frame: IDataObject;
				try {
					frame = JSON.parse(String(message.data)) as IDataObject;
				} catch {
					return;
				}

				if (frame.error && frame.id !== undefined) {
					const err = frame.error as IDataObject;
					this.logger.error(`[DataGrout Trigger] subscribe refused: ${err.message}`);
					return;
				}

				const ack = subscribeAck(frame);
				if (ack) {
					subscriptionId = ack;
					this.logger.info(`[DataGrout Trigger] subscribed to "${topic}" (${ack})`);
					return;
				}

				// Ignores replies and connection lifecycle frames, so the workflow
				// does not fire merely because the socket connected.
				const carried = subscriptionEvent(frame, subscriptionId);
				if (!carried) return;

				const json: IDataObject = includeEventName
					? { event: carried.event, ...carried.data }
					: { ...carried.data };
				this.emit([this.helpers.returnJsonArray([json])]);
			});

			socket.addEventListener('close', () => {
				if (closing || !reconnect) return;
				const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt++, RECONNECT_MAX_MS);
				this.logger.warn(`[DataGrout Trigger] connection closed, retrying in ${delay}ms`);
				void reopenAfter(delay);
			});

			socket.addEventListener('error', () => {
				// `close` always follows, which owns the retry.
				this.logger.warn('[DataGrout Trigger] connection error');
			});
		};

		open();

		const closeFunction = async () => {
			closing = true;
			try {
				socket?.close();
			} catch {
				// already gone
			}
		};

		// "Test step" in the editor: emit a shaped example so the user can wire
		// downstream nodes without waiting for a real event.
		const manualTriggerFunction = async () => {
			this.emit([
				this.helpers.returnJsonArray([
					{
						event: 'example',
						topic,
						note: 'Example event. Real events arrive on this topic once DataGrout publishes to it.',
					},
				]),
			]);
		};

		return { closeFunction, manualTriggerFunction };
	}
}
