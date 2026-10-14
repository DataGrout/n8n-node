/*
 * Unit tests. These never ship: `files: ["dist"]` publishes only build output,
 * and tsconfig compiles `nodes/` and `credentials/` only. The n8n Cloud rules
 * below govern the node's shipped runtime, so they do not apply to this file.
 */
/* eslint-disable @n8n/community-nodes/no-restricted-imports */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	apiBase,
	apiErrorMessage,
	apiErrorType,
	apiPath,
	gatewayOrigin,
	matchesEvent,
	parseJsonData,
	parseJsonObject,
	rowsOf,
	subscribeAck,
	subscriptionEvent,
	taskLocation,
	waitPreference,
} from '../nodes/DataGrout/pure.ts';

// DataGrout servers ship with only MCP enabled; the node detects the refusal
// and turns JSON-RPC on itself, so this predicate gates the whole first-run
// experience.
describe('parseJsonObject', () => {
	it('parses a typed JSON string', () => {
		assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
	});

	it('passes an expression-supplied object through', () => {
		const o = { a: 1 };
		assert.equal(parseJsonObject(o), o);
	});

	it('treats empty as not provided', () => {
		assert.equal(parseJsonObject(''), undefined);
		assert.equal(parseJsonObject(undefined), undefined);
		assert.equal(parseJsonObject(null), undefined);
	});

	it('rejects an array and explains why', () => {
		assert.throws(() => parseJsonObject([1, 2]), /array/);
	});

	it('rejects malformed JSON with a readable message', () => {
		assert.throws(() => parseJsonObject('{oops'), /not valid JSON/);
	});
});

describe('parseJsonData', () => {
	it('accepts an array of records', () => {
		assert.deepEqual(parseJsonData('[{"a":1}]'), [{ a: 1 }]);
	});

	it('accepts an object', () => {
		assert.deepEqual(parseJsonData('{"a":1}'), { a: 1 });
	});

	it('treats empty as not provided', () => {
		assert.equal(parseJsonData(''), undefined);
	});

	it('rejects malformed JSON', () => {
		assert.throws(() => parseJsonData('nope'), /not valid JSON/);
	});
});

// The exact envelope prism.refract returned over JSON-RPC, live-captured
// 2026-08-27: the computed rows arrive as a JSON string inside a nested tool
// response, which a workflow must never be handed raw.
describe('subscriptionEvent', () => {
	it('emits a subscription event', () => {
		const frame = {
			jsonrpc: '2.0',
			method: 'notification',
			params: {
				subscription: 'sub_abc',
				event: 'run.completed',
				data: { run_id: 'run_1', status: 'ok' },
			},
		};
		assert.deepEqual(subscriptionEvent(frame), {
			event: 'run.completed',
			data: { run_id: 'run_1', status: 'ok' },
		});
	});

	it('ignores session.ready, which carries no subscription', () => {
		const frame = {
			jsonrpc: '2.0',
			method: 'notification',
			params: { event: 'session.ready', data: { session_id: 'ws_1' } },
		};
		assert.equal(subscriptionEvent(frame), undefined);
	});

	it('ignores a reply to our own call', () => {
		assert.equal(subscriptionEvent({ id: 1, jsonrpc: '2.0', result: {} }), undefined);
	});

	it('ignores another subscription on the same socket', () => {
		const frame = {
			method: 'notification',
			params: { subscription: 'sub_other', event: 'x', data: {} },
		};
		assert.equal(subscriptionEvent(frame, 'sub_ours'), undefined);
	});

	it('accepts a matching subscription id', () => {
		const frame = {
			method: 'notification',
			params: { subscription: 'sub_ours', event: 'x', data: { a: 1 } },
		};
		assert.deepEqual(subscriptionEvent(frame, 'sub_ours'), { event: 'x', data: { a: 1 } });
	});

	it('names an unnamed event rather than emitting undefined', () => {
		const frame = { method: 'notification', params: { subscription: 's', data: {} } };
		assert.equal(subscriptionEvent(frame)?.event, 'event');
	});
});

describe('subscribeAck', () => {
	it('reads the subscription id out of the ack', () => {
		const frame = {
			id: 1,
			jsonrpc: '2.0',
			result: { topic: 't', subscription: 'sub_abc', scoped_topic: 'ws:x:t' },
		};
		assert.equal(subscribeAck(frame), 'sub_abc');
	});

	it('is not confused by a notification', () => {
		assert.equal(subscribeAck({ method: 'notification', params: {} }), undefined);
	});

	it('returns undefined when the reply carries no subscription', () => {
		assert.equal(subscribeAck({ id: 2, result: { ok: true } }), undefined);
	});
});

// The four slugs DataGrout publishes to ws:<server>:events, verified against
// DataGrout.WsEvents.events/0.
describe('matchesEvent', () => {
	it('passes every event when nothing is selected', () => {
		assert.equal(matchesEvent('run.completed', []), true);
		assert.equal(matchesEvent('anything.new', []), true);
	});

	it('passes every event when the selection is absent', () => {
		assert.equal(matchesEvent('run.completed', undefined), true);
	});

	it('passes a selected event', () => {
		assert.equal(matchesEvent('task.failed', ['run.completed', 'task.failed']), true);
	});

	it('rejects an event that was not selected', () => {
		assert.equal(matchesEvent('run.completed', ['task.failed']), false);
	});

	it('does not match on a prefix', () => {
		assert.equal(matchesEvent('task.completed', ['task']), false);
	});
});

// Shapes taken from DataGrout's loop guard in mcp_server.ex. Two of the three
// interventions are not flagged as errors, so they would otherwise be handed to
// a workflow as the answer. The read-tier one below is the exact payload a live
// run produced on 2026-09-01.

// ── The REST API client's helpers ────────────────────────────────────────

describe('apiPath', () => {
	it('joins segments under the API', () => {
		assert.equal(apiPath('memories', 'warehouses', 'facts'), '/memories/warehouses/facts');
	});

	// A memory name or skill id is typed by a user; it must not be able to reach
	// a different endpoint.
	it('encodes each segment so a name cannot change the path', () => {
		assert.equal(apiPath('memories', '../tasks/x', 'facts'), '/memories/..%2Ftasks%2Fx/facts');
		assert.equal(apiPath('skills', 'a b?c', 'runs'), '/skills/a%20b%3Fc/runs');
	});
});

describe('waitPreference', () => {
	it('asks DataGrout to hold the request, in whole seconds', () => {
		assert.equal(waitPreference(12_500), 'wait=13');
	});

	it('never asks for longer than DataGrout will hold a request', () => {
		assert.equal(waitPreference(120_000), 'wait=30');
	});

	it('asks for nothing when the node should not wait', () => {
		assert.equal(waitPreference(0), undefined);
		assert.equal(waitPreference(-1), undefined);
	});
});

describe('taskLocation', () => {
	it('accepts a task path in either form', () => {
		assert.equal(
			taskLocation({ location: '/api/v1/servers/5c3e9f10/tasks/task_abc' }),
			'/api/v1/servers/5c3e9f10/tasks/task_abc',
		);
		assert.equal(taskLocation({ location: '/api/v1/tasks/task_abc' }), '/api/v1/tasks/task_abc');
	});

	// It is joined to the gateway's base URL; anything else could carry the
	// credential to another host or endpoint.
	it('refuses anything that is not a task path on the API', () => {
		assert.equal(taskLocation({ location: 'https://elsewhere.example.com/tasks/x' }), undefined);
		assert.equal(taskLocation({ location: '//elsewhere.example.com/api/v1/tasks/x' }), undefined);
		assert.equal(taskLocation({ location: '/api/v1/tasks/x/../../answers' }), undefined);
		assert.equal(taskLocation({ location: '/oauth/token' }), undefined);
		assert.equal(taskLocation({}), undefined);
	});
});

describe('apiErrorMessage', () => {
	it("reads the API's own error", () => {
		const body = { error: { code: 409, type: 'loop_detected', message: 'This identical call ran 4 times.' } };
		assert.equal(apiErrorMessage(body, 409), 'This identical call ran 4 times.');
	});

	it("reads the gateway's authentication error", () => {
		assert.equal(apiErrorMessage({ error: { code: 401, message: 'Authentication required' } }, 401), 'Authentication required');
	});

	it("reads the rate limiter's flatter shape", () => {
		const body = { error: 'rate_limited', message: 'Too many requests. Limit: 100 per 60s.' };
		assert.equal(apiErrorMessage(body, 429), 'Too many requests. Limit: 100 per 60s.');
	});

	it('falls back to the status when there is nothing readable', () => {
		assert.equal(apiErrorMessage(undefined, 502), 'DataGrout returned HTTP 502');
		assert.equal(apiErrorMessage('<html>'.repeat(100), 502), 'DataGrout returned HTTP 502');
	});

	it('uses a short plain-text body from a proxy', () => {
		assert.equal(apiErrorMessage('Bad Gateway', 502), 'Bad Gateway');
	});
});

describe('apiErrorType', () => {
	it('reads the stable type', () => {
		assert.equal(apiErrorType({ error: { type: 'insufficient_credits' } }), 'insufficient_credits');
		assert.equal(apiErrorType({ error: 'rate_limited' }), 'rate_limited');
		assert.equal(apiErrorType({}), undefined);
	});
});

describe('rowsOf', () => {
	it('makes one item per record', () => {
		assert.deepEqual(rowsOf([{ city: 'North', total: 7 }, { city: 'South', total: 5 }]), [
			{ city: 'North', total: 7 },
			{ city: 'South', total: 5 },
		]);
	});

	it('wraps values that are not records', () => {
		assert.deepEqual(rowsOf([1, 2]), [{ result: 1 }, { result: 2 }]);
		assert.deepEqual(rowsOf(42), [{ result: 42 }]);
	});

	it('keeps a single record as one item', () => {
		assert.deepEqual(rowsOf({ total: 42 }), [{ total: 42 }]);
	});
});

describe('gatewayOrigin', () => {
	it("reads the token credential's base URL", () => {
		assert.equal(gatewayOrigin({ baseUrl: 'https://gateway.datagrout.ai/' }), 'https://gateway.datagrout.ai');
	});

	it("reads the OAuth2 credential's /connect URL", () => {
		assert.equal(gatewayOrigin({ serverUrl: 'https://gateway.datagrout.ai/connect' }), 'https://gateway.datagrout.ai');
	});

	it('defaults to the hosted gateway', () => {
		assert.equal(gatewayOrigin({}), 'https://gateway.datagrout.ai');
		assert.equal(gatewayOrigin({ baseUrl: 'not a url' }), 'https://gateway.datagrout.ai');
	});
});

describe('apiBase', () => {
	it('names the server when the credential has one', () => {
		assert.equal(
			apiBase('https://gateway.datagrout.ai', '5c3e9f10-7b2a-4d8e-9a61-2f0c4b7d8e31'),
			'https://gateway.datagrout.ai/api/v1/servers/5c3e9f10-7b2a-4d8e-9a61-2f0c4b7d8e31',
		);
	});

	// An OAuth token already names its server; the gateway resolves it.
	it('uses the server-less form when it does not', () => {
		assert.equal(apiBase('https://gateway.datagrout.ai', undefined), 'https://gateway.datagrout.ai/api/v1');
		assert.equal(apiBase('https://gateway.datagrout.ai', '  '), 'https://gateway.datagrout.ai/api/v1');
	});

	it('encodes the id', () => {
		assert.equal(apiBase('https://g.example.com', 'a/b'), 'https://g.example.com/api/v1/servers/a%2Fb');
	});
});
