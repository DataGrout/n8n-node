import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	detachedTaskRef,
	injectLeanDefaults,
	parsePossiblySse,
	taskRecord,
} from '../packages/n8n-nodes-datagrout/nodes/DataGrout/pure.ts';
import {
	formatToolResult,
	sanitizeToolName,
} from '../packages/n8n-nodes-datagrout-mcp/nodes/DataGroutMcp/pure.ts';

describe('parsePossiblySse', () => {
	it('passes an already-parsed object through', () => {
		const obj = { result: { ok: true } };
		assert.equal(parsePossiblySse(obj), obj);
	});

	it('parses a plain JSON body', () => {
		assert.deepEqual(parsePossiblySse('{"result":{"a":1}}'), { result: { a: 1 } });
	});

	it('parses a single SSE data frame', () => {
		const body = 'event: message\ndata: {"result":{"a":1}}\n\n';
		assert.deepEqual(parsePossiblySse(body), { result: { a: 1 } });
	});

	it('takes the LAST data frame when several are streamed', () => {
		const body = 'data: {"result":{"n":1}}\n\ndata: {"result":{"n":2}}\n\n';
		assert.deepEqual(parsePossiblySse(body), { result: { n: 2 } });
	});

	it('throws on a non-JSON body rather than returning junk', () => {
		assert.throws(() => parsePossiblySse('gateway timeout'));
	});
});

describe('detachedTaskRef', () => {
	it('returns the ref when the call detached', () => {
		const res = { structuredContent: { status: 'detached', task_ref: 'task_abc' } };
		assert.equal(detachedTaskRef(res), 'task_abc');
	});

	it('returns undefined for an inline (non-detached) result', () => {
		assert.equal(detachedTaskRef({ structuredContent: { status: 'ready' } }), undefined);
	});

	it('returns undefined when structuredContent is absent', () => {
		assert.equal(detachedTaskRef({ content: [] }), undefined);
	});

	it('ignores a non-string task_ref', () => {
		const res = { structuredContent: { status: 'detached', task_ref: 42 } };
		assert.equal(detachedTaskRef(res), undefined);
	});
});

// Regression cover for the shape bug found by live-testing 2026-07-23: a direct
// tools/call puts the task record at the TOP of structuredContent, while the
// discovery.perform wrapper nests it under .result.
describe('taskRecord', () => {
	it('reads a top-level task record (direct tools/call)', () => {
		const sc = { completed: true, status: 'completed', result: { executed: true } };
		assert.deepEqual(taskRecord(sc), sc);
	});

	it('reads a nested task record (discovery.perform wrapper)', () => {
		const inner = { completed: false, status: 'working' };
		assert.deepEqual(taskRecord({ result: inner }), inner);
	});

	it('treats a bare task_ref as the record', () => {
		const sc = { task_ref: 'task_abc', status: 'working' };
		assert.deepEqual(taskRecord(sc), sc);
	});

	it('returns an empty object for an unrecognised envelope', () => {
		assert.deepEqual(taskRecord({} as never), {});
	});
});

describe('injectLeanDefaults', () => {
	it('adds lean+head for canonical discovery.plan', () => {
		assert.deepEqual(injectLeanDefaults('data-grout@1/discovery.plan@1', { goal: 'x' }), {
			lean: true,
			head: true,
			goal: 'x',
		});
	});

	it('adds lean+head for the sanitized name servers may list', () => {
		assert.deepEqual(injectLeanDefaults('discovery_plan', {}), { lean: true, head: true });
	});

	it('adds only head for discovery.perform', () => {
		assert.deepEqual(injectLeanDefaults('data-grout@1/discovery.perform@1', {}), { head: true });
	});

	it('never overrides a caller-supplied value', () => {
		assert.deepEqual(injectLeanDefaults('discovery_plan', { head: false }), {
			lean: true,
			head: false,
		});
	});

	it('leaves non-discovery tools untouched', () => {
		const args = { query: 'SELECT Id FROM Opportunity' };
		assert.equal(injectLeanDefaults('salesforce@1/soql@1', args), args);
		assert.equal(injectLeanDefaults('discovery_discover', args), args);
	});
});

describe('sanitizeToolName', () => {
	it('replaces characters an LLM function name cannot carry', () => {
		assert.equal(
			sanitizeToolName('data-grout@1/discovery.plan@1', new Set()),
			'data-grout_1_discovery_plan_1',
		);
	});

	it('de-duplicates within a set', () => {
		const used = new Set<string>();
		assert.equal(sanitizeToolName('search', used), 'search');
		assert.equal(sanitizeToolName('search', used), 'search_1');
		assert.equal(sanitizeToolName('search', used), 'search_2');
	});

	it('falls back to "tool" for an unusable name', () => {
		assert.equal(sanitizeToolName('@@@', new Set()), 'tool');
	});

	it('caps length at 64 characters', () => {
		assert.equal(sanitizeToolName('a'.repeat(120), new Set()).length, 64);
	});
});

describe('formatToolResult', () => {
	it('joins text blocks', () => {
		const res = { content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] };
		assert.equal(formatToolResult(res), 'line one\nline two');
	});

	it('serialises non-text blocks', () => {
		const res = { content: [{ type: 'image', data: 'xyz' }] };
		assert.equal(formatToolResult(res), '{"type":"image","data":"xyz"}');
	});

	it('falls back to the whole result when content is empty', () => {
		assert.equal(formatToolResult({ content: [], ok: true }), '{"content":[],"ok":true}');
	});

	it('never returns an empty string', () => {
		assert.notEqual(formatToolResult({}), '');
	});
});
