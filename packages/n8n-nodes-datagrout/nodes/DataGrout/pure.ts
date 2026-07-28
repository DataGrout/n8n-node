import type { IDataObject } from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Pure helpers — no n8n runtime, no I/O, no state. Kept in their own
// module so they can be unit-tested directly (the task-record shape
// below cost a live debugging cycle to get right).
// KEEP IN SYNC with packages/n8n-nodes-datagrout-mcp/nodes/DataGroutMcp/pure.ts
// ────────────────────────────────────────────────────────────────────

/**
 * Parse an MCP response body that may arrive as JSON or as an SSE stream.
 * SSE frames are `data:`-prefixed lines; the LAST data frame carries the
 * JSON-RPC response.
 */
export function parsePossiblySse(raw: unknown): IDataObject {
	if (typeof raw === 'object' && raw !== null) return raw as IDataObject;
	const text = String(raw);
	const dataLines = text
		.split('\n')
		.filter((l) => l.startsWith('data:'))
		.map((l) => l.slice(5).trim())
		.filter(Boolean);
	const payload = dataLines.length ? dataLines[dataLines.length - 1] : text;
	return JSON.parse(payload) as IDataObject;
}

/**
 * The task reference when a DataGrout call DETACHED to a background task,
 * else undefined.
 */
export function detachedTaskRef(result: IDataObject): string | undefined {
	const sc = (result.structuredContent as IDataObject) ?? {};
	if (sc.status === 'detached' && typeof sc.task_ref === 'string') return sc.task_ref;
	return undefined;
}

/**
 * The task record inside a `tasks.wait` response. A direct `tools/call`
 * returns it at the TOP of structuredContent; the discovery.perform wrapper
 * nests it under `.result` (both live-verified 2026-07-23).
 */
export function taskRecord(structuredContent: IDataObject): IDataObject {
	const sc = structuredContent ?? {};
	if (typeof sc.completed !== 'undefined' || sc.task_ref) return sc;
	return (sc.result as IDataObject) ?? {};
}

/**
 * Add DataGrout's response-shaping defaults for discovery tools, so large
 * result sets return a preview plus a server-side reference instead of every
 * row. Caller-supplied values always win. Matches canonical tool names
 * (`data-grout@1/discovery.plan@1`) and the sanitized form some servers list
 * (`discovery_plan`).
 */
export function injectLeanDefaults(toolName: string, args: IDataObject): IDataObject {
	if (/(^|\/)discovery[._](plan|guide)(@\d+)?$/.test(toolName)) {
		return { lean: true, head: true, ...args };
	}
	if (/(^|\/)discovery[._]perform(@\d+)?$/.test(toolName)) {
		return { head: true, ...args };
	}
	return args;
}
