/*
 * Unit tests. These never ship: `files: ["dist"]` publishes only build output,
 * and tsconfig compiles `nodes/` and `credentials/` only. The n8n Cloud rules
 * below govern the node's shipped runtime, so they do not apply to this file.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { prepareEventSocket } from '../nodes/DataGrout/pure.ts';
import type { ActivationOptions } from '../nodes/DataGrout/pure.ts';

// ────────────────────────────────────────────────────────────────────
// What the trigger does before it dials: which server it resolves, what
// it changes on that server, and which token reaches the socket.
// ────────────────────────────────────────────────────────────────────

const SERVER = '5c3e9f10-7b2a-4d8e-9a61-2f0c4b7d8e31';

interface Request {
	method: string;
	url: string;
	body?: unknown;
}

function activation(opts: {
	credentials: Array<Record<string, unknown>>;
	respond?: (request: Request) => unknown;
}) {
	const requests: Request[] = [];
	const logged: string[] = [];
	let reads = 0;
	const read = async () => opts.credentials[Math.min(reads++, opts.credentials.length - 1)];

	const options = async (): Promise<ActivationOptions> => ({
		credentials: await read(),
		request: async (method, url, body) => {
			const request = { method, url, body };
			requests.push(request);
			return (opts.respond?.(request) ?? {}) as Record<string, unknown>;
		},
		readCredentials: read,
		log: { info: (m) => logged.push(m), warn: (m) => logged.push(m) },
	});

	return { run: async () => prepareEventSocket(await options()), requests, logged };
}

describe('prepareEventSocket', () => {
	it('switches on only the WebSocket transport', async () => {
		const { run, requests } = activation({ credentials: [{ apiToken: 'tok_example', serverId: SERVER }] });

		await run();

		assert.deepEqual(requests, [
			{
				method: 'POST',
				url: `https://gateway.datagrout.ai/servers/${SERVER}/interaction/enable_protocol`,
				body: { protocol: 'ws' },
			},
		]);
	});

	it('dials the credential’s own server and base URL with its token', async () => {
		const { run, requests } = activation({
			credentials: [{ apiToken: 'tok_example', serverId: SERVER, baseUrl: 'https://gw.example.com/' }],
		});

		const target = await run();

		assert.equal(requests.some((r) => r.method === 'GET'), false);
		assert.deepEqual(target, { url: `wss://gw.example.com/servers/${SERVER}/ws`, token: 'tok_example' });
	});

	it('asks the gateway which server an OAuth2 credential belongs to', async () => {
		const { run, requests } = activation({
			credentials: [
				{ serverUrl: 'https://gateway.datagrout.ai/connect', oauthTokenData: { access_token: 'stale' } },
				{ serverUrl: 'https://gateway.datagrout.ai/connect', oauthTokenData: { access_token: 'fresh' } },
			],
			respond: (r) => (r.method === 'GET' ? { id: SERVER, name: 'Example' } : {}),
		});

		const target = await run();

		assert.deepEqual(requests[0], { method: 'GET', url: 'https://gateway.datagrout.ai/api/v1/server', body: undefined });
		assert.equal(target.url, `wss://gateway.datagrout.ai/servers/${SERVER}/ws`);
		// The lookup may have refreshed the token; the socket gets the current one.
		assert.equal(target.token, 'fresh');
	});

	it('fails with a reason when the server cannot be found', async () => {
		const { run } = activation({
			credentials: [{ oauthTokenData: { access_token: 'tok' } }],
			respond: (r) => {
				if (r.method === 'GET') throw new Error('401 Unauthorized');
				return {};
			},
		});

		await assert.rejects(run(), /Could not find which DataGrout server.*401 Unauthorized/);
	});

	it('goes on to dial when the transport could not be switched on, and says so', async () => {
		const { run, logged } = activation({
			credentials: [{ apiToken: 'tok_example', serverId: SERVER }],
			respond: (r) => {
				if (r.method === 'POST') throw new Error('403 Forbidden');
				return {};
			},
		});

		const target = await run();

		assert.equal(target.token, 'tok_example');
		assert.ok(logged.some((m) => m.includes('could not enable the WebSocket transport: 403 Forbidden')));
	});

	it('refuses a credential with no token', async () => {
		const { run } = activation({ credentials: [{ serverId: SERVER }] });

		await assert.rejects(run(), /has no token/);
	});
});
