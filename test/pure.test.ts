import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	MAX_DESCRIPTION_CHARS,
	MAX_LISTED_TOOLS,
	describeTools,
	detachedTaskRef,
	errorText,
	formatToolResult,
	injectLeanDefaults,
	normalizeToolName,
	parsePossiblySse,
	resolveToolName,
	taskRecord,
	toOutputJson,
} from '../nodes/DataGroutMcp/pure.ts';

describe('parsePossiblySse', () => {
	it('passes an already-parsed object through', () => {
		const obj = { result: { ok: true } };
		assert.equal(parsePossiblySse(obj), obj);
	});

	it('parses a plain JSON body', () => {
		assert.deepEqual(parsePossiblySse('{"result":{"a":1}}'), { result: { a: 1 } });
	});

	it('parses a single SSE data frame', () => {
		assert.deepEqual(parsePossiblySse('event: message\ndata: {"result":{"a":1}}\n\n'), {
			result: { a: 1 },
		});
	});

	it('takes the LAST data frame when several are streamed', () => {
		const body = 'data: {"result":{"n":1}}\n\ndata: {"result":{"n":2}}\n\n';
		assert.deepEqual(parsePossiblySse(body), { result: { n: 2 } });
	});

	it('throws on a non-JSON body rather than returning junk', () => {
		assert.throws(() => parsePossiblySse('502 Bad Gateway'));
	});
});

describe('detachedTaskRef', () => {
	it('returns the ref when the call detached', () => {
		assert.equal(
			detachedTaskRef({ structuredContent: { status: 'detached', task_ref: 'task_abc' } }),
			'task_abc',
		);
	});

	it('returns undefined for an inline (non-detached) result', () => {
		assert.equal(detachedTaskRef({ structuredContent: { status: 'ready' } }), undefined);
	});

	it('returns undefined when structuredContent is absent', () => {
		assert.equal(detachedTaskRef({ content: [] }), undefined);
	});

	it('ignores a non-string task_ref', () => {
		assert.equal(
			detachedTaskRef({ structuredContent: { status: 'detached', task_ref: 42 } }),
			undefined,
		);
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

	it('returns an empty object for an unrecognised or missing envelope', () => {
		assert.deepEqual(taskRecord({}), {});
		assert.deepEqual(taskRecord(undefined), {});
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

	it('adds lean+head for the sanitized name some servers list', () => {
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

// The resolver is what stands between a model's free-text guess and the
// gateway. Its contract: resolve confidently, or resolve to nothing so the
// caller gets the catalogue back — never silently run a different tool.
describe('resolveToolName', () => {
	const available = [
		'data-grout@1/discovery.plan@1',
		'data-grout@1/discovery.perform@1',
		'atlassian-jira@1/searchjiraissuesusingjql@1',
		'salesforce@1/soql@1',
	];

	it('returns an exact match unchanged', () => {
		assert.equal(resolveToolName('salesforce@1/soql@1', available), 'salesforce@1/soql@1');
	});

	it('resolves a less-qualified name the model wrote', () => {
		assert.equal(resolveToolName('discovery.plan', available), 'data-grout@1/discovery.plan@1');
		assert.equal(resolveToolName('discovery_plan', available), 'data-grout@1/discovery.plan@1');
	});

	it('resolves a MORE-qualified name against a sanitized listing', () => {
		assert.equal(
			resolveToolName('data-grout@1/discovery_perform@1', ['discovery_perform']),
			'discovery_perform',
		);
	});

	it('is punctuation- and case-insensitive', () => {
		assert.equal(resolveToolName('SOQL', ['salesforce@1/soql@1']), 'salesforce@1/soql@1');
	});

	it('refuses an ambiguous partial rather than guessing', () => {
		// "discovery" matches both plan and perform → caller gets the catalogue
		assert.equal(resolveToolName('discovery', available), undefined);
	});

	it('refuses very short fragments that would over-match', () => {
		assert.equal(resolveToolName('so', available), undefined);
	});

	it('returns undefined for an empty or punctuation-only request', () => {
		assert.equal(resolveToolName('', available), undefined);
		assert.equal(resolveToolName('@@@', available), undefined);
	});

	it('returns undefined when nothing resembles the request', () => {
		assert.equal(resolveToolName('quickbooks_invoices', available), undefined);
	});

	it('prefers the exact normalized match over a partial one', () => {
		// 'search' exists exactly AND is a substring of the jira tool name
		const list = ['search', 'atlassian-jira@1/searchjiraissuesusingjql@1'];
		assert.equal(resolveToolName('search', list), 'search');
	});
});

describe('describeTools', () => {
	it('truncates long descriptions', () => {
		const long = 'x'.repeat(MAX_DESCRIPTION_CHARS + 50);
		const [only] = describeTools([{ name: 'a', description: long }]);
		assert.equal((only.description as string).length, MAX_DESCRIPTION_CHARS + 1); // + ellipsis
		assert.ok((only.description as string).endsWith('…'));
	});

	it('leaves short descriptions intact', () => {
		const [only] = describeTools([{ name: 'a', description: 'short' }]);
		assert.equal(only.description, 'short');
	});

	it('caps the catalogue so a large server cannot flood the model', () => {
		const many = Array.from({ length: MAX_LISTED_TOOLS + 25 }, (_, i) => ({
			name: `tool_${i}`,
			description: '',
		}));
		assert.equal(describeTools(many).length, MAX_LISTED_TOOLS);
	});
});

describe('toOutputJson', () => {
	it('prefers structuredContent so workflows can map real fields', () => {
		const sc = { total: 3, rows: [1, 2, 3] };
		assert.deepEqual(toOutputJson({ structuredContent: sc, content: [] }), sc);
	});

	it('falls back to flattened text when there is no structuredContent', () => {
		const res = { content: [{ type: 'text', text: 'hello' }] };
		assert.deepEqual(toOutputJson(res), { result: 'hello' });
	});

	it('does not treat an array structuredContent as node JSON', () => {
		const res = { structuredContent: [1, 2], content: [{ type: 'text', text: 'hi' }] };
		assert.deepEqual(toOutputJson(res), { result: 'hi' });
	});
});

describe('formatToolResult', () => {
	it('joins text blocks', () => {
		const res = {
			content: [
				{ type: 'text', text: 'line one' },
				{ type: 'text', text: 'line two' },
			],
		};
		assert.equal(formatToolResult(res), 'line one\nline two');
	});

	it('serialises non-text blocks', () => {
		assert.equal(
			formatToolResult({ content: [{ type: 'image', data: 'xyz' }] }),
			'{"type":"image","data":"xyz"}',
		);
	});

	it('falls back to the whole result when content is empty', () => {
		assert.equal(formatToolResult({ content: [], ok: true }), '{"content":[],"ok":true}');
	});

	it('never returns an empty string', () => {
		assert.notEqual(formatToolResult({}), '');
	});
});

describe('errorText', () => {
	it('reads the first text block', () => {
		const res = { isError: true, content: [{ type: 'text', text: 'boom' }] };
		assert.equal(errorText(res), 'boom');
	});

	it('has a fallback when no text block is present', () => {
		assert.equal(errorText({ isError: true, content: [] }), 'Tool returned an error');
		assert.equal(errorText({ isError: true }), 'Tool returned an error');
	});
});

describe('normalizeToolName', () => {
	it('strips punctuation and case', () => {
		assert.equal(normalizeToolName('data-grout@1/Discovery.Plan@1'), 'datagrout1discoveryplan1');
	});
});
