import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	INVALID_REQUEST,
	detachedTaskRef,
	isProtocolDisabled,
	parseJsonData,
	parseJsonObject,
	payloadError,
	shapeAnswer,
	taskRecord,
	toolPayload,
	unwrapData,
} from '../nodes/DataGrout/pure.ts';

// DataGrout servers ship with only MCP enabled; the node detects the refusal
// and turns JSON-RPC on itself, so this predicate gates the whole first-run
// experience.
describe('isProtocolDisabled', () => {
	it('recognises the transport-disabled refusal', () => {
		assert.equal(
			isProtocolDisabled({ code: INVALID_REQUEST, message: 'JSON-RPC not enabled for this server' }),
			true,
		);
	});

	it('is case-insensitive on the message', () => {
		assert.equal(
			isProtocolDisabled({ code: INVALID_REQUEST, message: 'json-rpc NOT ENABLED for this server' }),
			true,
		);
	});

	it('does not fire on other invalid-request errors', () => {
		assert.equal(isProtocolDisabled({ code: INVALID_REQUEST, message: 'Invalid params' }), false);
	});

	it('does not fire on a different code with a similar message', () => {
		assert.equal(isProtocolDisabled({ code: -32000, message: 'JSON-RPC not enabled' }), false);
	});

	it('handles a missing error', () => {
		assert.equal(isProtocolDisabled(undefined), false);
	});
});

describe('detachedTaskRef', () => {
	it('finds the reference when work detached', () => {
		assert.equal(detachedTaskRef({ status: 'detached', task_ref: 'task_abc' }), 'task_abc');
	});

	it('looks inside structuredContent too', () => {
		assert.equal(
			detachedTaskRef({ structuredContent: { status: 'detached', task_ref: 'task_xyz' } }),
			'task_xyz',
		);
	});

	it('returns undefined for a completed call', () => {
		assert.equal(detachedTaskRef({ status: 'ready' }), undefined);
	});

	it('ignores a non-string reference', () => {
		assert.equal(detachedTaskRef({ status: 'detached', task_ref: 7 }), undefined);
	});
});

// Two envelope shapes occur live: a direct tool call puts the record at the
// top, the perform wrapper nests it under .result.
describe('taskRecord', () => {
	it('reads a top-level record', () => {
		const p = { completed: true, status: 'completed', result: { answer: 1 } };
		assert.deepEqual(taskRecord(p), p);
	});

	it('reads a nested record', () => {
		const inner = { completed: false, status: 'working' };
		assert.deepEqual(taskRecord({ result: inner }), inner);
	});

	it('treats a bare reference as the record', () => {
		const p = { task_ref: 'task_abc' };
		assert.deepEqual(taskRecord(p), p);
	});

	it('copes with nothing', () => {
		assert.deepEqual(taskRecord(undefined), {});
		assert.deepEqual(taskRecord({}), {});
	});
});

describe('toolPayload', () => {
	it('unwraps the doubly-wrapped result', () => {
		const inner = { answer: 'yes', executed: true };
		assert.deepEqual(toolPayload({ structuredContent: { result: inner } }), inner);
	});

	it('falls back to structuredContent when there is no inner result', () => {
		const sc = { status: 'ready', plan: {} };
		assert.deepEqual(toolPayload({ structuredContent: sc }), sc);
	});

	it('passes a bare result through', () => {
		const bare = { rows: [1, 2] };
		assert.deepEqual(toolPayload(bare), bare);
	});
});

describe('shapeAnswer', () => {
	it('surfaces the answer, verification and certificate', () => {
		const shaped = shapeAnswer({
			result: [{ account: 'Acme' }],
			answer_confidence: 'verified',
			ctc: { id: 'ctc_abc', url: 'https://ctc.datagrout.ai/certs/ctc_abc' },
			skill_handle: 'vs_abc',
		});
		assert.deepEqual(shaped.answer, [{ account: 'Acme' }]);
		assert.equal(shaped.verified, true);
		assert.equal(shaped.certificateUrl, 'https://ctc.datagrout.ai/certs/ctc_abc');
		assert.equal(shaped.certificateId, 'ctc_abc');
		assert.equal(shaped.skill, 'vs_abc');
	});

	it('marks an unverified answer and carries the caveat', () => {
		const shaped = shapeAnswer({
			result: [],
			answer_confidence: 'unverified',
			hint: 'Could not confirm the Jira leg ran',
		});
		assert.equal(shaped.verified, false);
		assert.equal(shaped.caveat, 'Could not confirm the Jira leg ran');
	});

	it('never loses the original payload', () => {
		const payload = { result: 1, extra: 'kept' };
		assert.deepEqual(shapeAnswer(payload).details, payload);
	});

	it('treats an absent confidence as verified', () => {
		assert.equal(shapeAnswer({ result: 1 }).verified, true);
	});
});

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
describe('unwrapData', () => {
	const rows = [
		{ region: 'south', total_amount: 25 },
		{ region: 'north', total_amount: 15 },
	];

	it('parses rows out of a nested text content block', () => {
		const payload = {
			_dg: { tool: 'data-grout@1/prism.refract@1' },
			data: {
				content: [{ type: 'text', text: JSON.stringify(rows), annotations: {} }],
				status_code: 200,
			},
			status_code: 200,
		};
		assert.deepEqual(unwrapData(payload), rows);
	});

	it('prefers a nested structuredContent value when present', () => {
		const payload = { data: { structuredContent: { data: rows }, content: [] } };
		assert.deepEqual(unwrapData(payload), rows);
	});

	it('accepts a nested result key too', () => {
		const payload = { data: { structuredContent: { result: rows } } };
		assert.deepEqual(unwrapData(payload), rows);
	});

	it('returns non-JSON text as text rather than throwing', () => {
		const payload = { data: { content: [{ type: 'text', text: 'no rows found' }] } };
		assert.equal(unwrapData(payload), 'no rows found');
	});

	it('leaves a payload without a nested response untouched', () => {
		const payload = { count: 2, facts: [] };
		assert.equal(unwrapData(payload), payload);
	});

	it('ignores a non-object data field', () => {
		const payload = { data: 'plain' };
		assert.equal(unwrapData(payload), payload);
	});
});

// DataGrout reports tool failures inside a 200 response. Live-caught: an Ask
// whose plan 400'd came back as a null answer marked verified — the exact
// confidently-wrong outcome this integration exists to avoid.
describe('payloadError', () => {
	it('finds a top-level error string', () => {
		assert.equal(payloadError({ error: 'No payload provided', status_code: 400 }), 'No payload provided');
	});

	it('finds an error nested under data', () => {
		assert.equal(payloadError({ data: { error: 'Bad request', status_code: 400 } }), 'Bad request');
	});

	it('reads an error object message', () => {
		assert.equal(payloadError({ error: { message: 'boom' } }), 'boom');
	});

	it('falls back to a bad status code alone', () => {
		assert.equal(payloadError({ status_code: 503 }), 'DataGrout returned status 503');
	});

	it('is silent on success', () => {
		assert.equal(payloadError({ status_code: 200, data: { status_code: 200 } }), undefined);
		assert.equal(payloadError({ count: 2, facts: [] }), undefined);
		assert.equal(payloadError(undefined), undefined);
	});

	it('ignores an empty error string', () => {
		assert.equal(payloadError({ error: '   ' }), undefined);
	});
});

describe('shapeAnswer never marks a failure verified', () => {
	it('reports verified false when the payload carries an error', () => {
		const shaped = shapeAnswer({ error: 'No payload provided', status_code: 400 });
		assert.equal(shaped.verified, false);
		assert.equal(shaped.answer, null);
	});
});
