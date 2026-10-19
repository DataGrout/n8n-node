import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { apiPath, matchesEvent, secretMatches, webhookEvent } from '../DataGrout/pure';
import { apiError, hookRequest } from '../DataGrout/transport';

// ────────────────────────────────────────────────────────────────────
// Starts a workflow when DataGrout pushes an event.
//
// Activating the workflow registers a webhook subscription on the user's
// DataGrout server, pointing at the URL n8n gives this node; DataGrout
// POSTs each event there, and deactivating removes the subscription.
// DataGrout returns a secret once, at registration, and presents it on
// every delivery, so a request without it never starts the workflow.
// ────────────────────────────────────────────────────────────────────

const SECRET_HEADER = 'x-datagrout-webhook-secret';

/** Drop the subscription this node remembers holding. */
function forget(registration: IDataObject): void {
	delete registration.webhookId;
	delete registration.webhookSecret;
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
			alias: ['DataGrout', 'trigger', 'events', 'webhook'],
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
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
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
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const registration = this.getWorkflowStaticData('node');
				const id = registration.webhookId;
				if (typeof id !== 'string' || !id) return false;

				const { status, body } = await hookRequest(this, 'GET', apiPath('webhooks', id));
				if (status === 404) {
					forget(registration);
					return false;
				}
				if (status >= 400) throw apiError(this, status, body);

				if ((body as IDataObject).url === this.getNodeWebhookUrl('default')) return true;

				// Registered for another URL. In the editor that is the production
				// subscription of an active workflow, which must stay; otherwise n8n's
				// own URL changed, and the old subscription would only collect failures.
				if (this.getMode() !== 'manual') {
					await hookRequest(this, 'DELETE', apiPath('webhooks', id)).catch(() => undefined);
					forget(registration);
				}
				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const url = this.getNodeWebhookUrl('default');
				if (!url) {
					throw new NodeOperationError(
						this.getNode(),
						'n8n gave this node no webhook URL to register',
					);
				}
				const events = this.getNodeParameter('events', []) as string[];

				const { status, body } = await hookRequest(this, 'POST', apiPath('webhooks'), {
					url,
					events,
					source: 'n8n',
				});
				if (status >= 400) throw apiError(this, status, body);

				const created = (body ?? {}) as IDataObject;
				if (
					typeof created.id !== 'string' ||
					!created.id ||
					typeof created.secret !== 'string' ||
					!created.secret
				) {
					throw new NodeApiError(this.getNode(), created as JsonObject, {
						message: 'DataGrout: the webhook was registered but no id and secret came back',
					});
				}

				const registration = this.getWorkflowStaticData('node');
				registration.webhookId = created.id;
				registration.webhookSecret = created.secret;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const registration = this.getWorkflowStaticData('node');
				const id = registration.webhookId;
				if (typeof id === 'string' && id) {
					try {
						const { status, body } = await hookRequest(this, 'DELETE', apiPath('webhooks', id));
						if (status >= 400 && status !== 404) throw apiError(this, status, body);
					} catch (error) {
						// Kept, so the next deactivation can try again.
						this.logger.warn(
							`[DataGrout Trigger] could not remove webhook ${id}: ${(error as Error).message}`,
						);
						return false;
					}
				}
				forget(registration);
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const stored = this.getWorkflowStaticData('node').webhookSecret;
		if (!secretMatches(this.getHeaderData()[SECRET_HEADER], stored)) {
			this.getResponseObject().status(401).end();
			return { noWebhookResponse: true };
		}

		const received = webhookEvent(this.getBodyData());
		if (!received) {
			this.logger.warn('[DataGrout Trigger] ignored a delivery that carried no event');
			return {};
		}

		const wanted = this.getNodeParameter('events', []) as string[];
		if (!matchesEvent(received.event, wanted)) return {};

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const includeEventName = (options.includeEventName as boolean) ?? true;
		const item = includeEventName ? { event: received.event, ...received.data } : received.data;

		return { workflowData: [this.helpers.returnJsonArray([item])] };
	}
}
