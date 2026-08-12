import type { IDataObject } from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Pure helpers — no n8n runtime, no I/O, no state. Kept in their own
// module so they can be unit-tested directly: the task-envelope shape
// and the tool-name resolver below are both subtle enough to have cost
// live debugging cycles.
// ────────────────────────────────────────────────────────────────────

export const MAX_LISTED_TOOLS = 50;
export const MAX_DESCRIPTION_CHARS = 240;

export type ToolSummary = { name: string; description: string };

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
export function taskRecord(structuredContent: IDataObject | undefined): IDataObject {
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

/** Flatten an MCP tool result into a non-empty string. */
export function formatToolResult(result: IDataObject): string {
	const content = result.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => {
				const block = c as { type?: string; text?: string };
				return block?.type === 'text' && typeof block.text === 'string'
					? block.text
					: JSON.stringify(c);
			})
			.join('\n')
			.trim();
		if (text.length) return text;
	}
	const serialized = JSON.stringify(result);
	return serialized && serialized !== 'undefined' ? serialized : '(no result)';
}

/**
 * Prefer the tool's structuredContent — it is real JSON a workflow can map
 * over and an agent can read. Fall back to the flattened text blocks.
 */
export function toOutputJson(result: IDataObject): IDataObject {
	const structured = result.structuredContent;
	if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
		return structured as IDataObject;
	}
	return { result: formatToolResult(result) };
}

export const normalizeToolName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map a requested name onto a real one: exact, then punctuation-insensitive,
 * then an unambiguous partial in EITHER direction. A model may write less
 * qualification than the server lists (`discovery.plan` for
 * `data-grout@1/discovery.plan@1`) or more (`data-grout@1/discovery_perform@1`
 * when the server lists the sanitized `discovery_perform`) — both are seen live.
 * Ambiguous matches resolve to nothing, so the caller sees the list rather than
 * a silently wrong tool being run.
 */
export function resolveToolName(requested: string, available: string[]): string | undefined {
	if (available.includes(requested)) return requested;
	const target = normalizeToolName(requested);
	if (!target) return undefined;
	const exact = available.filter((n) => normalizeToolName(n) === target);
	if (exact.length === 1) return exact[0];
	if (target.length < 4) return undefined;
	const partial = available.filter((n) => {
		const candidate = normalizeToolName(n);
		return candidate.length >= 4 && (candidate.includes(target) || target.includes(candidate));
	});
	return partial.length === 1 ? partial[0] : undefined;
}

/**
 * The catalogue handed back to a model that asked for an unknown tool. Carries
 * descriptions — several DataGrout tools take another tool's fully-qualified
 * name as an argument, which a bare list of names gives no way to discover.
 * Bounded so a large server cannot flood the model's context.
 */
export function describeTools(tools: ToolSummary[]): IDataObject[] {
	return tools.slice(0, MAX_LISTED_TOOLS).map((t) => ({
		name: t.name,
		description:
			t.description.length > MAX_DESCRIPTION_CHARS
				? `${t.description.slice(0, MAX_DESCRIPTION_CHARS)}…`
				: t.description,
	}));
}

/** Read the error text out of an MCP result flagged isError. */
export function errorText(result: IDataObject): string {
	const content = (result.content as IDataObject[]) ?? [];
	return (content.find((c) => c.type === 'text')?.text as string) ?? 'Tool returned an error';
}
