import type { IDataObject } from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Pure helpers — no n8n runtime, no I/O, no state, so they can be
// unit-tested directly.
// ────────────────────────────────────────────────────────────────────

/** JSON-RPC error code DataGrout returns for a malformed or refused request. */
export const INVALID_REQUEST = -32600;

/**
 * DataGrout gates transports per server: `interaction_config.enabled_protocols`
 * defaults to `["mcp"]`, and the JSON-RPC endpoint refuses calls until
 * `jsonrpc` is added. The refusal is recognisable, which lets the node enable
 * the protocol itself rather than sending the user to a dashboard toggle.
 */
export function isProtocolDisabled(error: IDataObject | undefined): boolean {
	if (!error) return false;
	const code = error.code;
	const message = String(error.message ?? '').toLowerCase();
	return code === INVALID_REQUEST && message.includes('json-rpc not enabled');
}

/**
 * A long-running DataGrout call detaches to a background task and answers with
 * `{status: "detached", task_ref}`. Returns that reference, else undefined.
 */
export function detachedTaskRef(result: IDataObject): string | undefined {
	const sc = (result.structuredContent as IDataObject) ?? result ?? {};
	if (sc.status === 'detached' && typeof sc.task_ref === 'string') return sc.task_ref;
	return undefined;
}

/**
 * The task record inside a `tasks.wait` reply. A direct tool call returns it at
 * the top of the payload; the perform wrapper nests it under `.result`. Both
 * shapes occur live, so support both.
 */
export function taskRecord(payload: IDataObject | undefined): IDataObject {
	const p = payload ?? {};
	if (typeof p.completed !== 'undefined' || p.task_ref) return p;
	return (p.result as IDataObject) ?? {};
}

/** Unwrap the tool payload from a JSON-RPC `tools.call` result. */
export function toolPayload(result: IDataObject): IDataObject {
	const sc = result.structuredContent;
	if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
		const inner = (sc as IDataObject).result;
		if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner as IDataObject;
		return sc as IDataObject;
	}
	return result;
}

/**
 * Some tools answer with a whole nested tool response under `data` — the
 * computed rows sit in `data.structuredContent.data`, or as a JSON string in
 * `data.content[0].text` (live-verified against prism.refract over JSON-RPC).
 * Dig the useful value out so a workflow gets records, not an envelope.
 */
export function unwrapData(payload: IDataObject): unknown {
	const nested = payload.data;
	if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return payload;
	const inner = nested as IDataObject;

	const structured = inner.structuredContent;
	if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
		const value = (structured as IDataObject).data ?? (structured as IDataObject).result;
		if (value !== undefined) return value;
	}

	const content = inner.content;
	if (Array.isArray(content)) {
		const block = content.find((c) => (c as IDataObject)?.type === 'text') as
			| IDataObject
			| undefined;
		if (typeof block?.text === 'string') {
			try {
				return JSON.parse(block.text);
			} catch {
				return block.text;
			}
		}
	}

	return payload;
}

/**
 * The failure message when a tool payload represents an error, else undefined.
 *
 * DataGrout reports tool-level failures inside a 200 response — an `error`
 * string with a `status_code`. Without this check the node would hand a
 * workflow a null answer marked verified (live-caught 2026-08-27), which is
 * the one outcome this integration must never produce.
 */
export function payloadError(payload: IDataObject | undefined): string | undefined {
	if (!payload) return undefined;

	for (const candidate of [payload, payload.data as IDataObject]) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

		const err = candidate.error;
		if (typeof err === 'string' && err.trim()) return err;
		if (err && typeof err === 'object') {
			const message = (err as IDataObject).message;
			return typeof message === 'string' ? message : JSON.stringify(err);
		}

		const status = candidate.status_code;
		if (typeof status === 'number' && status >= 400) {
			return `DataGrout returned status ${status}`;
		}
	}

	return undefined;
}

/**
 * Shape an Ask result for a workflow: the answer, whether DataGrout could
 * verify it, and the certificate that shows exactly what ran. Everything the
 * planner returned is preserved under `details` so nothing is lost.
 */
export function shapeAnswer(payload: IDataObject): IDataObject {
	const ctc = (payload.ctc as IDataObject) ?? {};
	const confidence = payload.answer_confidence;

	const failed = payloadError(payload) !== undefined;

	const out: IDataObject = {
		answer: payload.result ?? payload.answer ?? null,
		verified: !failed && confidence !== 'unverified',
		details: payload,
	};

	if (typeof payload.hint === 'string' && confidence === 'unverified') out.caveat = payload.hint;
	if (typeof ctc.url === 'string') out.certificateUrl = ctc.url;
	if (typeof ctc.id === 'string') out.certificateId = ctc.id;
	if (typeof payload.skill_handle === 'string') out.skill = payload.skill_handle;

	return out;
}

/**
 * A JSON field arrives as a string when typed into the editor and as an object
 * when supplied by an expression. Empty means "not provided".
 */
export function parseJsonObject(raw: unknown): IDataObject | undefined {
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw === 'object' && !Array.isArray(raw)) return raw as IDataObject;
	if (Array.isArray(raw)) throw new Error('expected a JSON object, got an array');
	let parsed: unknown;
	try {
		parsed = JSON.parse(String(raw));
	} catch {
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- pure module, deliberately free of the n8n runtime so it stays unit-testable; the node converts this into a NodeOperationError with the item index
		throw new Error('not valid JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('expected a JSON object');
	}
	return parsed as IDataObject;
}

/** Accept either a JSON object or a JSON array for a data payload. */
export function parseJsonData(raw: unknown): unknown {
	if (raw === undefined || raw === null || raw === '') return undefined;
	if (typeof raw === 'object') return raw;
	try {
		return JSON.parse(String(raw));
	} catch {
		// eslint-disable-next-line @n8n/community-nodes/require-node-api-error -- pure module, deliberately free of the n8n runtime so it stays unit-testable; the node converts this into a NodeOperationError with the item index
		throw new Error('not valid JSON');
	}
}

/**
 * The event carried by a WebSocket frame, or undefined if the frame is not one
 * of our subscription's events.
 *
 * Three things arrive on the socket: replies to our own calls (an `id`, no
 * `method`), connection lifecycle notifications such as `session.ready`, and
 * subscription events. Only the last carries `params.subscription`, so that
 * field is what separates them — without it the trigger would start a workflow
 * every time the socket connected (live-caught 2026-08-27).
 */
export function subscriptionEvent(
	frame: IDataObject,
	subscriptionId?: string,
): { event: string; data: IDataObject } | undefined {
	if (frame.method !== 'notification') return undefined;

	const params = (frame.params as IDataObject) ?? {};
	const subscription = params.subscription;
	if (typeof subscription !== 'string') return undefined;
	if (subscriptionId && subscription !== subscriptionId) return undefined;

	return {
		event: typeof params.event === 'string' ? params.event : 'event',
		data: (params.data as IDataObject) ?? {},
	};
}

/** The subscription id from a reply to our `subscribe` call, if this is one. */
export function subscribeAck(frame: IDataObject): string | undefined {
	if (frame.id === undefined || frame.method !== undefined) return undefined;
	const result = (frame.result as IDataObject) ?? {};
	return typeof result.subscription === 'string' ? result.subscription : undefined;
}

/**
 * Whether an event slug is one the workflow asked for. An empty selection
 * means every event, which also means a slug added to DataGrout later arrives
 * without the node needing a new release.
 */
export function matchesEvent(event: string, wanted: string[] | undefined): boolean {
	if (!wanted || wanted.length === 0) return true;
	return wanted.includes(event);
}
