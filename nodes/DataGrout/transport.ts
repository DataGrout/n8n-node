import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, sleep } from 'n8n-workflow';

import {
	apiBase,
	apiErrorMessage,
	apiErrorType,
	gatewayOrigin,
	taskLocation,
	waitPreference,
} from './pure';

// ────────────────────────────────────────────────────────────────────
// Client for DataGrout's REST API.
//
// Built on n8n's own `helpers.httpRequestWithAuthentication`, so the node
// carries no runtime dependencies and inherits the instance's proxy and
// TLS configuration.
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_WAIT_MS = 120_000;

const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

/** Whichever n8n context is calling: the node's execute, or the trigger's webhook hooks. */
type Caller = IExecuteFunctions | IHookFunctions;

interface Response {
	status: number;
	body: unknown;
}

interface Connection {
	credential: string;
	origin: string;
	base: string;
}

function credentialFor(authentication: unknown): string {
	return authentication === 'oAuth2' ? 'dataGroutOAuth2Api' : 'dataGroutApi';
}

async function connection(ctx: IExecuteFunctions, itemIndex: number): Promise<Connection> {
	const credential = credentialFor(ctx.getNodeParameter('authentication', itemIndex, 'apiToken'));
	const credentials = await ctx.getCredentials(credential, itemIndex);
	const origin = gatewayOrigin(credentials);
	return { credential, origin, base: apiBase(origin, credentials.serverId) };
}

/** The error to raise for a response the API refused, in the API's own words. */
export function apiError(
	ctx: Caller,
	status: number,
	body: unknown,
	itemIndex?: number,
): NodeApiError {
	const type = apiErrorType(body);
	return new NodeApiError(ctx.getNode(), (body ?? {}) as JsonObject, {
		message: `DataGrout: ${apiErrorMessage(body, status)}`,
		description: type ? `Error type: ${type}` : undefined,
		httpCode: String(status),
		itemIndex,
	});
}

async function request(
	ctx: Caller,
	credential: string,
	options: IHttpRequestOptions,
): Promise<Response> {
	const response = (await ctx.helpers.httpRequestWithAuthentication.call(ctx, credential, {
		...options,
		json: true,
		timeout: REQUEST_TIMEOUT_MS,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	})) as { statusCode: number; body: unknown };

	return { status: response.statusCode, body: response.body };
}

async function send(
	ctx: IExecuteFunctions,
	credential: string,
	options: IHttpRequestOptions,
	itemIndex: number,
): Promise<Response> {
	const response = await request(ctx, credential, options);
	if (response.status >= 400) throw apiError(ctx, response.status, response.body, itemIndex);
	return response;
}

/**
 * One call from the trigger's webhook hooks, returned as status and body
 * rather than thrown: the hooks decide what a 404 means.
 */
export async function hookRequest(
	ctx: IHookFunctions,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
): Promise<Response> {
	const credential = credentialFor(ctx.getNodeParameter('authentication', 'apiToken'));
	const credentials = await ctx.getCredentials(credential);
	const base = apiBase(gatewayOrigin(credentials), credentials.serverId);
	return await request(ctx, credential, { method, url: base + path, body });
}

/**
 * Call the API and return the finished resource.
 *
 * Slow work moves to a background task and the API answers 202. DataGrout is
 * asked to hold the request for part of `waitMs` (`Prefer: wait`); if the work
 * is still running, its task is polled for the rest. Past the deadline the
 * node returns a `running` item naming the task rather than failing, so a
 * workflow can pick the result up later.
 */
export async function call(
	ctx: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	body: IDataObject | undefined,
	itemIndex: number,
	waitMs = DEFAULT_WAIT_MS,
): Promise<IDataObject> {
	const { credential, origin, base } = await connection(ctx, itemIndex);
	const deadline = Date.now() + Math.max(0, waitMs);
	const prefer = waitPreference(waitMs);

	const first = await send(
		ctx,
		credential,
		{ method, url: base + path, body, headers: prefer ? { Prefer: prefer } : undefined },
		itemIndex,
	);
	if (first.status !== 202) return (first.body ?? {}) as IDataObject;

	const accepted = (first.body ?? {}) as IDataObject;
	const location = taskLocation(accepted);
	if (!location) {
		throw new NodeApiError(ctx.getNode(), accepted as JsonObject, {
			message: 'DataGrout: the work moved to the background but no task was given to follow',
			itemIndex,
		});
	}

	while (Date.now() + POLL_INTERVAL_MS <= deadline) {
		await sleep(POLL_INTERVAL_MS);
		const task = (await send(ctx, credential, { method: 'GET', url: origin + location }, itemIndex))
			.body as IDataObject;

		if (task.status === 'completed') return (task.result ?? {}) as IDataObject;
		if (task.status === 'failed' || task.status === 'cancelled') {
			throw new NodeApiError(ctx.getNode(), task as JsonObject, {
				message: `DataGrout: ${apiErrorMessage(task, 422)}`,
				itemIndex,
			});
		}
	}

	return {
		status: 'running',
		task_id: accepted.task_id,
		location: origin + location,
		note:
			'DataGrout is still working on this in the background. Increase "Wait for Result" on ' +
			'this node, or fetch the task from its location later.',
	};
}
