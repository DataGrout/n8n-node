/*
 * Unit tests. These never ship: `files: ["dist"]` publishes only build output,
 * and tsconfig compiles `nodes/` and `credentials/` only. The n8n Cloud rules
 * below govern the node's shipped runtime, so they do not apply to this file.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { secretMatches, webhookEvent } from '../nodes/DataGrout/pure.ts';

// ────────────────────────────────────────────────────────────────────
// What the trigger does with a delivery from DataGrout: which requests
// it lets in, and what a workflow sees of each event.
// ────────────────────────────────────────────────────────────────────

// The envelope DataGrout's dispatcher POSTs, with `data` carrying exactly the
// fields the WebSocket stream used to.
describe('webhookEvent', () => {
	it('reads the event name and its fields out of the envelope', () => {
		const body = {
			event: 'run.completed',
			server_id: '5c3e9f10-7b2a-4d8e-9a61-2f0c4b7d8e31',
			timestamp: '2026-10-16T09:30:00Z',
			data: {
				run_id: 4127,
				execution_id: 'exec_1a2b3c',
				status: 'success',
				tool_name: 'discovery.plan',
				source: 'mcp',
				duration_ms: 4210,
			},
		};

		assert.deepEqual(webhookEvent(body), {
			event: 'run.completed',
			data: {
				run_id: 4127,
				execution_id: 'exec_1a2b3c',
				status: 'success',
				tool_name: 'discovery.plan',
				source: 'mcp',
				duration_ms: 4210,
			},
		});
	});

	it('gives an event that carries nothing an empty record', () => {
		assert.deepEqual(webhookEvent({ event: 'task.failed' }), { event: 'task.failed', data: {} });
		assert.deepEqual(webhookEvent({ event: 'task.failed', data: [1, 2] }), {
			event: 'task.failed',
			data: {},
		});
	});

	it('ignores a body that is not an event envelope', () => {
		assert.equal(webhookEvent({}), undefined);
		assert.equal(webhookEvent({ event: '', data: {} }), undefined);
		assert.equal(webhookEvent({ event: 42, data: {} }), undefined);
		assert.equal(webhookEvent('run.completed'), undefined);
		assert.equal(webhookEvent(undefined), undefined);
	});
});

// The secret DataGrout returned once, at registration, and presents on every
// delivery; anything else is answered 401 and never starts the workflow.
describe('secretMatches', () => {
	it('accepts the secret given at registration', () => {
		assert.equal(secretMatches('whsec_1a2b3c', 'whsec_1a2b3c'), true);
	});

	it('rejects a different, empty or missing header', () => {
		assert.equal(secretMatches('whsec_other', 'whsec_1a2b3c'), false);
		assert.equal(secretMatches('', 'whsec_1a2b3c'), false);
		assert.equal(secretMatches(undefined, 'whsec_1a2b3c'), false);
	});

	it('rejects a header sent more than once', () => {
		assert.equal(secretMatches(['whsec_1a2b3c', 'whsec_1a2b3c'], 'whsec_1a2b3c'), false);
	});

	it('lets nothing through while no secret is stored', () => {
		assert.equal(secretMatches('', ''), false);
		assert.equal(secretMatches('whsec_1a2b3c', undefined), false);
	});
});
