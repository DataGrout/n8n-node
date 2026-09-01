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
/**
 * The message for a DataGrout loop-guard intervention, else undefined.
 *
 * DataGrout guards against repeated identical calls: an identical read issued
 * several times with nothing changing in between, or a write repeated with the
 * same arguments, is answered with an explanation rather than run again.
 *
 * Two of those replies are not marked as errors, so without this check they
 * reach a workflow as though they were the answer — a downstream node expecting
 * rows receives `{loop_detected: true, …}` instead (live-caught 2026-09-01).
 * Nothing ran, so the honest outcome is a failure that says what happened.
 */
export function interventionNotice(payload: IDataObject | undefined): string | undefined {
	if (!payload || payload.loop_detected !== true) return undefined;

	const count = payload.execution_count;
	const times = typeof count === 'number' ? `${count} times` : 'more than once';

	// These read as the tail of the node's own "DataGrout: " prefix, so they do
	// not repeat the product name.
	if (payload.action === 'confirm_or_change_args') {
		return (
			`this action was already called ${times} in this session with identical ` +
			'arguments, so it was not repeated and the earlier result still stands. Change the ' +
			'arguments if it genuinely needs to happen again.'
		);
	}

	return (
		`this identical call ran ${times} with nothing changing in between, so the loop ` +
		'guard stopped it and no new result was produced. Vary the input, or raise the ' +
		"loop-guard thresholds in this server's interaction settings."
	);
}

export function payloadError(payload: IDataObject | undefined): string | undefined {
	if (!payload) return undefined;

	for (const candidate of [payload, payload.data as IDataObject]) {
		if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;

		const intervention = interventionNotice(candidate);
		if (intervention) return intervention;

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

/**
 * The fields a given event carries, for the editor's "Test step" button. Real
 * values so downstream nodes can be wired against the true shape — `run_id` is
 * the integer DataGrout's own `runs.get` accepts, with `execution_id` beside it.
 */
export function exampleEvent(event = 'run.completed'): IDataObject {
	const examples: Record<string, IDataObject> = {
		'run.completed': {
			run_id: 79566,
			execution_id: 'exec_1a2b3c',
			status: 'success',
			tool_name: 'discovery.plan',
			source: 'mcp',
			duration_ms: 4210,
		},
		'task.completed': {
			task_id: 'task_1a2b3c',
			tool_name: 'prism.refract',
			cache_ref: 'cache_9f8e7d',
			status: 'completed',
		},
		'task.failed': {
			task_id: 'task_1a2b3c',
			tool_name: 'prism.refract',
			error: 'upstream timed out',
			status: 'failed',
		},
		'tool_call.failed': {
			run_id: 79566,
			execution_id: 'exec_1a2b3c',
			tool_name: 'logic.query',
			error: 'namespace not found',
		},
	};
	return { event, ...(examples[event] ?? examples['run.completed']) };
}

// ────────────────────────────────────────────────────────────────────
// The trigger's socket lifecycle, with every dependency injected.
//
// This is the part with the interesting behaviour — subscribing,
// filtering, reconnecting, keeping the connection alive — so it lives
// here, free of the n8n runtime and of the global WebSocket, where the
// tests can drive it directly. The trigger node is then a thin adapter
// that reads parameters and supplies a real socket.
//
// It shares this file with the helpers above rather than importing them
// from a sibling: shipped source is compiled with node10 resolution, so
// it cannot carry `.ts` import extensions, and without them Node cannot
// load the module under `--experimental-strip-types` in the tests.
// ────────────────────────────────────────────────────────────────────

export const SUBPROTOCOL = 'datagrout-jsonrpc.v1';

/**
 * DataGrout publishes every server-scoped lifecycle event to one well-known
 * topic, with the event name in the envelope. Subscribing once and filtering
 * beats guessing a topic per event category.
 */
export const EVENTS_TOPIC = 'events';
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 30_000;

/**
 * The gateway closes an idle socket after 60s, and a subscriber waiting for
 * events is idle by definition — without a keepalive the connection dropped
 * and re-subscribed every minute, losing anything published during the gap.
 * 25s leaves room for one to go missing.
 */
export const KEEPALIVE_MS = 25_000;

/** `WebSocket.OPEN`, named so this module need not reference the global. */
export const OPEN = 1;

/**
 * The subset of the WebSocket API this session uses. `data` is optional so a
 * real `WebSocket` satisfies it: its listeners are typed against `Event`, which
 * carries no payload, while a message event does.
 */
export interface SocketEvent {
	data?: unknown;
}

export interface SocketLike {
	addEventListener(type: string, listener: (event: SocketEvent) => void): void;
	send(data: string): void;
	close(): void;
	readonly readyState: number;
}

export interface SessionLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface SessionOptions {
	/** Topic to subscribe to once connected. */
	topic: string;
	/** Event slugs to accept; empty means every event. */
	events: string[];
	/** Whether to add the event name to each emitted item. */
	includeEventName: boolean;
	/** Whether to reopen a dropped connection. */
	reconnect: boolean;
	/** Dial a new socket. Called once per connection attempt. */
	connect: () => SocketLike;
	sleep: (ms: number) => Promise<void>;
	emit: (json: IDataObject) => void;
	log: SessionLogger;
	/** Overridable so tests need not wait 25 seconds. */
	keepaliveMs?: number;
	/** Overridable so tests need not depend on the global WebSocket. */
	openState?: number;
}

export interface Session {
	/** Stop reconnecting and close the current socket. */
	close: () => void;
}

/** A JSON-RPC subscribe request. */
export function subscribeFrame(id: number, topic: string): string {
	return JSON.stringify({ jsonrpc: '2.0', id, method: 'subscribe', params: { topic } });
}

/**
 * The keepalive frame. A JSON-RPC *notification* — a request with no `id` —
 * because the spec forbids a reply to one, so this resets the server's idle
 * timer without provoking a frame or a log line at either end.
 */
export function keepaliveFrame(): string {
	return JSON.stringify({ jsonrpc: '2.0', method: 'ping' });
}

export function startEventSession(options: SessionOptions): Session {
	const {
		topic,
		events,
		includeEventName,
		reconnect,
		connect,
		sleep,
		emit,
		log,
		keepaliveMs = KEEPALIVE_MS,
		openState = OPEN,
	} = options;

	let socket: SocketLike | undefined;
	let closing = false;
	let attempt = 0;
	let rpcId = 0;
	let subscriptionId: string | undefined;

	const open = () => {
		if (closing) return;

		socket = connect();

		socket.addEventListener('open', () => {
			attempt = 0;
			// The server issues a fresh subscription id per connection, so the
			// previous one must not outlive its socket: holding a stale id would
			// filter out every event from the new subscription, and permanently so
			// if the new ack were ever missed.
			subscriptionId = undefined;
			log.info(`[DataGrout Trigger] connected, subscribing to "${topic}"`);
			socket?.send(subscribeFrame(++rpcId, topic));
		});

		socket.addEventListener('message', (event: SocketEvent) => {
			let frame: IDataObject;
			try {
				frame = JSON.parse(String(event.data)) as IDataObject;
			} catch {
				return;
			}

			if (frame.error && frame.id !== undefined) {
				const err = frame.error as IDataObject;
				log.error(`[DataGrout Trigger] DataGrout refused a call: ${err.message}`);
				return;
			}

			const ack = subscribeAck(frame);
			if (ack) {
				subscriptionId = ack;
				log.info(`[DataGrout Trigger] subscribed to "${topic}" (${ack})`);
				return;
			}

			// Ignores replies and connection lifecycle frames, so the workflow does
			// not fire merely because the socket connected.
			const carried = subscriptionEvent(frame, subscriptionId);
			if (!carried) return;
			if (!matchesEvent(carried.event, events)) return;

			emit(includeEventName ? { event: carried.event, ...carried.data } : { ...carried.data });
		});

		socket.addEventListener('close', () => {
			if (closing || !reconnect) return;
			const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt++, RECONNECT_MAX_MS);
			log.warn(`[DataGrout Trigger] connection closed, retrying in ${delay}ms`);
			void reopenAfter(delay);
		});

		socket.addEventListener('error', () => {
			// `close` always follows, and owns the retry.
			log.warn('[DataGrout Trigger] connection error');
		});
	};

	const reopenAfter = async (delay: number) => {
		await sleep(delay);
		if (!closing) open();
	};

	// One loop for the life of the session rather than a timer per connection:
	// it reads whichever socket is current.
	const keepalive = async () => {
		while (!closing) {
			await sleep(keepaliveMs);
			if (closing) return;
			if (socket?.readyState !== openState) continue;
			try {
				socket.send(keepaliveFrame());
			} catch {
				// The close listener owns reconnection.
			}
		}
	};

	open();
	void keepalive();

	return {
		close: () => {
			closing = true;
			try {
				socket?.close();
			} catch {
				// already gone
			}
		},
	};
}
