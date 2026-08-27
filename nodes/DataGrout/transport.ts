import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError, sleep } from 'n8n-workflow';

import { detachedTaskRef, isProtocolDisabled, taskRecord } from './pure';

// ────────────────────────────────────────────────────────────────────
// DataGrout JSON-RPC 2.0 transport.
//
// Built on n8n's own `helpers.httpRequestWithAuthentication` so the node
// carries no runtime dependencies and inherits the instance's proxy and
// TLS configuration.
// ────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_TASK_WAIT_MS = 120_000;

type Ctx = IExecuteFunctions | ILoadOptionsFunctions;

const TASKS_WAIT = 'data-grout@1/tasks.wait@1';

/** Which credential the node is configured to use. */
async function authContext(ctx: Ctx, itemIndex = 0) {
	const kind =
		((ctx as IExecuteFunctions).getNodeParameter?.('authentication', itemIndex, 'apiToken') as
			| string
			| undefined) ?? 'apiToken';
	const name = kind === 'oAuth2' ? 'dataGroutOAuth2Api' : 'dataGroutApi';
	const credentials = await ctx.getCredentials(name);
	const baseUrl = String(credentials.baseUrl ?? 'https://gateway.datagrout.ai').replace(/\/$/, '');
	return { name, baseUrl, serverId: String(credentials.serverId ?? '') };
}

async function request(
	ctx: Ctx,
	options: IHttpRequestOptions,
	credentialName: string,
): Promise<IDataObject> {
	return (await ctx.helpers.httpRequestWithAuthentication.call(
		ctx,
		credentialName,
		options,
	)) as IDataObject;
}

/**
 * Turn the JSON-RPC transport on for this server. DataGrout ships with only
 * MCP enabled, and this endpoint is idempotent and self-service, so the node
 * can enable what it needs instead of asking the user to find a toggle.
 */
export async function enableJsonRpc(ctx: Ctx, itemIndex = 0): Promise<void> {
	const { name, baseUrl, serverId } = await authContext(ctx, itemIndex);
	await request(
		ctx,
		{
			method: 'POST',
			url: `${baseUrl}/servers/${serverId}/interaction/enable_protocol`,
			body: { protocol: 'jsonrpc' },
			json: true,
			timeout: DEFAULT_TIMEOUT_MS,
		},
		name,
	);
}

let rpcId = 0;

/**
 * One JSON-RPC call. If DataGrout reports the transport is disabled, enable it
 * and retry once — that turns a confusing first-run failure into a no-op.
 */
export async function rpc(
	ctx: Ctx,
	method: string,
	params: IDataObject,
	itemIndex = 0,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<IDataObject> {
	const { name, baseUrl, serverId } = await authContext(ctx, itemIndex);

	if (!serverId) {
		throw new NodeOperationError(
			ctx.getNode(),
			'The DataGrout credential is missing its Server ID',
			{ itemIndex },
		);
	}

	const send = async (): Promise<IDataObject> =>
		await request(
			ctx,
			{
				method: 'POST',
				url: `${baseUrl}/servers/${serverId}/rpc`,
				body: { jsonrpc: '2.0', id: ++rpcId, method, params },
				json: true,
				timeout: timeoutMs,
			},
			name,
		);

	let response = await send();

	if (isProtocolDisabled(response.error as IDataObject)) {
		await enableJsonRpc(ctx, itemIndex);
		response = await send();
	}

	if (response.error) {
		const err = response.error as IDataObject;
		throw new NodeApiError(ctx.getNode(), response as never, {
			message: `DataGrout: ${err.message ?? 'request failed'}`,
			description: typeof err.data === 'string' ? err.data : undefined,
			itemIndex,
		});
	}

	return (response.result as IDataObject) ?? {};
}

/**
 * Call a DataGrout tool and return its payload, collecting the result of a
 * background task if the call detaches. The caller never sees a task
 * reference — a slow request simply takes longer.
 */
export async function callTool(
	ctx: Ctx,
	toolName: string,
	args: IDataObject,
	itemIndex = 0,
	waitMs = DEFAULT_TASK_WAIT_MS,
): Promise<IDataObject> {
	const result = await rpc(ctx, 'tools.call', { name: toolName, arguments: args }, itemIndex);

	if (result.isError) {
		const content = (result.content as IDataObject[]) ?? [];
		const text = (content.find((c) => c.type === 'text')?.text as string) ?? 'Tool failed';
		throw new NodeOperationError(ctx.getNode(), `DataGrout: ${text}`, { itemIndex });
	}

	const taskRef = detachedTaskRef((result.structuredContent as IDataObject) ?? result);
	if (!taskRef || waitMs <= 0) return result;

	return await collect(ctx, taskRef, itemIndex, waitMs);
}

async function collect(
	ctx: Ctx,
	taskRef: string,
	itemIndex: number,
	waitMs: number,
): Promise<IDataObject> {
	const deadline = Date.now() + waitMs;
	let ref = taskRef;

	while (Date.now() < deadline) {
		const waited = await rpc(
			ctx,
			'tools.call',
			{ name: TASKS_WAIT, arguments: { task_ref: ref } },
			itemIndex,
		);
		const task = taskRecord((waited.structuredContent as IDataObject) ?? waited);

		if (task.completed === true && task.result && typeof task.result === 'object') {
			return { structuredContent: task.result as IDataObject };
		}
		if (task.status === 'failed' || (task.error && task.completed === true)) {
			return waited;
		}
		ref = (task.task_ref as string) ?? ref;
		await sleep(1000);
	}

	// Out of budget. Say so plainly rather than returning a task stub the
	// caller has no way to act on.
	return {
		structuredContent: {
			status: 'running',
			note:
				'DataGrout is still working on this in the background. Increase "Wait for Result" ' +
				'on this node, or run it again shortly — finished work is reused, so the retry is fast.',
		},
	};
}

/** Tool names the server exposes, for the credential test and dropdowns. */
export async function listToolNames(ctx: Ctx): Promise<string[]> {
	const result = await rpc(ctx, 'tools.list', {});
	const tools = (result.tools as IDataObject[]) ?? [];
	return tools.map((t) => String(t.name ?? '')).filter(Boolean);
}
