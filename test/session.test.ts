import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
	EVENTS_TOPIC,
	KEEPALIVE_MS,
	RECONNECT_BASE_MS,
	keepaliveFrame,
	startEventSession,
	subscribeFrame,
} from '../nodes/DataGrout/pure.ts';
import type { SessionOptions, SocketEvent, SocketLike } from '../nodes/DataGrout/pure.ts';

// ────────────────────────────────────────────────────────────────────
// Drives the real socket lifecycle through a fake socket, so behaviour
// that only showed up in a long live run — lifecycle-frame filtering,
// stale subscription ids across a reconnect, the keepalive — is pinned
// here instead of being rediscovered in production.
//
// Frame shapes are the ones captured from the live gateway.
// ────────────────────────────────────────────────────────────────────

const OPEN = 1;
const CLOSED = 3;

/**
 * The keepalive interval these tests hand the session. The session's keepalive
 * loop is endless by design, so the injected clock recognises this value and
 * parks that loop rather than letting it spin — a test's `sleep` is shared by
 * the keepalive and the reconnect backoff.
 */
const PARKED_KEEPALIVE = 9_999_999;

class FakeSocket implements SocketLike {
	readyState = 0;
	sent: string[] = [];
	closed = false;
	private listeners = new Map<string, Array<(event: SocketEvent) => void>>();

	addEventListener(type: string, listener: (event: SocketEvent) => void) {
		const existing = this.listeners.get(type) ?? [];
		existing.push(listener);
		this.listeners.set(type, existing);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.closed = true;
		this.readyState = CLOSED;
	}

	private fire(type: string, event: SocketEvent = {}) {
		for (const listener of this.listeners.get(type) ?? []) listener(event);
	}

	/** The server accepted the connection. */
	open() {
		this.readyState = OPEN;
		this.fire('open');
	}

	/** The server pushed a frame. */
	deliver(frame: unknown) {
		this.fire('message', { data: JSON.stringify(frame) });
	}

	/** The server sent something unparseable. */
	deliverRaw(data: string) {
		this.fire('message', { data });
	}

	drop() {
		this.readyState = CLOSED;
		this.fire('close');
	}

	frames(): Array<Record<string, unknown>> {
		return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
	}

	pings(): Array<Record<string, unknown>> {
		return this.frames().filter((f) => f.method === 'ping');
	}
}

/** Yield to the event loop so a scheduled reopen can happen. */
const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
};

type Harness = {
	sockets: FakeSocket[];
	emitted: Array<Record<string, unknown>>;
	logs: { info: string[]; warn: string[]; error: string[] };
	/** Backoff delays the session asked for, excluding the parked keepalive. */
	delays: number[];
	socket: () => FakeSocket;
	close: () => void;
};

function harness(overrides: Partial<SessionOptions> = {}): Harness {
	const sockets: FakeSocket[] = [];
	const emitted: Array<Record<string, unknown>> = [];
	const delays: number[] = [];
	const logs = { info: [] as string[], warn: [] as string[], error: [] as string[] };

	const session = startEventSession({
		topic: EVENTS_TOPIC,
		events: [],
		includeEventName: true,
		reconnect: true,
		keepaliveMs: PARKED_KEEPALIVE,
		openState: OPEN,
		connect: () => {
			const socket = new FakeSocket();
			sockets.push(socket);
			return socket;
		},
		sleep: (ms: number) => {
			// Park the keepalive loop. It never ends, and a promise that never
			// settles holds no handle, so it cannot keep the test process alive.
			if (ms === PARKED_KEEPALIVE) return new Promise<void>(() => {});
			delays.push(ms);
			return new Promise<void>((resolve) => setImmediate(resolve));
		},
		emit: (json) => emitted.push(json as Record<string, unknown>),
		log: {
			info: (m) => logs.info.push(m),
			warn: (m) => logs.warn.push(m),
			error: (m) => logs.error.push(m),
		},
		...overrides,
	});

	return {
		sockets,
		emitted,
		logs,
		delays,
		socket: () => sockets[sockets.length - 1],
		close: session.close,
	};
}

/**
 * A harness whose clock ticks, for the keepalive loop. The loop is endless, so
 * the session is closed from inside the clock after `limit` turns.
 */
function tickingHarness(limit: number) {
	const state = { ticks: 0 };
	let stop: () => void = () => {};
	const h = harness({
		keepaliveMs: 1,
		sleep: () =>
			new Promise<void>((resolve) => {
				setImmediate(() => {
					if (++state.ticks >= limit) stop();
					resolve();
				});
			}),
	});
	stop = h.close;
	return { h, state };
}

// Frames captured from wss://gateway.datagrout.ai on 2026-08-27.
const SESSION_READY = {
	jsonrpc: '2.0',
	method: 'notification',
	params: {
		event: 'session.ready',
		data: { session_id: 'ws_nH_7D6NqvPeoPNFW', subprotocol: 'datagrout-jsonrpc.v1' },
	},
};

const ack = (subscription: string, id = 1) => ({
	jsonrpc: '2.0',
	id,
	result: { topic: 'events', subscription, scoped_topic: 'ws:server-uuid:events' },
});

const event = (subscription: string, name: string, data: Record<string, unknown> = {}) => ({
	jsonrpc: '2.0',
	method: 'notification',
	params: { subscription, event: name, data },
});

const RUN_COMPLETED = {
	run_id: 79566,
	execution_id: null,
	status: 'success',
	tool_name: 'data-grout@1/prism.refract@1',
	source: 'mcp',
	duration_ms: 2291,
};

describe('startEventSession — connecting', () => {
	it('dials once, and subscribes only after the socket opens', () => {
		const h = harness();
		assert.equal(h.sockets.length, 1);
		assert.deepEqual(h.socket().frames(), []);

		h.socket().open();

		assert.deepEqual(h.socket().frames(), [
			{ jsonrpc: '2.0', id: 1, method: 'subscribe', params: { topic: 'events' } },
		]);
		h.close();
	});

	it('subscribes to a custom topic when one is given', () => {
		const h = harness({ topic: 'agents.orchestrate.run_7' });
		h.socket().open();
		assert.deepEqual(h.socket().frames()[0].params, { topic: 'agents.orchestrate.run_7' });
		h.close();
	});

	it('records the subscription id from the ack', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(ack('sub_9Pfi7pPohro'));
		assert.ok(h.logs.info.some((m) => m.includes('sub_9Pfi7pPohro')));
		h.close();
	});
});

describe('startEventSession — what starts a workflow', () => {
	it('does NOT fire on session.ready, which arrives on every connect', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(SESSION_READY);
		assert.deepEqual(h.emitted, []);
		h.close();
	});

	it('does NOT fire on the subscribe reply', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(ack('sub_a'));
		assert.deepEqual(h.emitted, []);
		h.close();
	});

	it('fires on a subscription event, with the event name attached', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(ack('sub_a'));
		h.socket().deliver(event('sub_a', 'run.completed', RUN_COMPLETED));

		assert.equal(h.emitted.length, 1);
		assert.deepEqual(h.emitted[0], { event: 'run.completed', ...RUN_COMPLETED });
		h.close();
	});

	it('omits the event name when asked to', () => {
		const h = harness({ includeEventName: false });
		h.socket().open();
		h.socket().deliver(ack('sub_a'));
		h.socket().deliver(event('sub_a', 'run.completed', RUN_COMPLETED));

		assert.deepEqual(h.emitted[0], RUN_COMPLETED);
		h.close();
	});

	it('fires only for selected events', () => {
		const h = harness({ events: ['task.failed'] });
		h.socket().open();
		h.socket().deliver(ack('sub_a'));
		h.socket().deliver(event('sub_a', 'run.completed', RUN_COMPLETED));
		assert.deepEqual(h.emitted, []);

		h.socket().deliver(event('sub_a', 'task.failed', { task_id: 'task_1' }));
		assert.equal(h.emitted.length, 1);
		assert.equal(h.emitted[0].event, 'task.failed');
		h.close();
	});

	it('fires for every event when nothing is selected', () => {
		const h = harness({ events: [] });
		h.socket().open();
		h.socket().deliver(ack('sub_a'));
		for (const name of ['run.completed', 'task.completed', 'task.failed', 'tool_call.failed']) {
			h.socket().deliver(event('sub_a', name, {}));
		}
		assert.equal(h.emitted.length, 4);
		h.close();
	});

	it('ignores another subscription on the same socket', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(ack('sub_ours'));
		h.socket().deliver(event('sub_someone_else', 'run.completed', RUN_COMPLETED));
		assert.deepEqual(h.emitted, []);
		h.close();
	});

	it('survives an unparseable frame', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliverRaw('<html>502 Bad Gateway</html>');
		h.socket().deliver(ack('sub_a'));
		h.socket().deliver(event('sub_a', 'run.completed', RUN_COMPLETED));
		assert.equal(h.emitted.length, 1);
		h.close();
	});

	it('logs an error reply instead of emitting it', () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver({
			jsonrpc: '2.0',
			id: 1,
			error: { code: -32600, message: 'JSON-RPC not enabled for this server' },
		});
		assert.deepEqual(h.emitted, []);
		assert.ok(h.logs.error[0].includes('JSON-RPC not enabled'));
		h.close();
	});
});

describe('startEventSession — reconnecting', () => {
	it('reopens a dropped connection after a delay', async () => {
		const h = harness();
		h.socket().drop();
		await flush();

		assert.equal(h.sockets.length, 2, 'a new socket should have been dialled');
		assert.equal(h.delays[0], RECONNECT_BASE_MS);
		h.close();
	});

	it('backs off further on repeated failures, then resets after a success', async () => {
		const h = harness();

		for (let i = 0; i < 3; i++) {
			h.socket().drop();
			await flush();
		}
		assert.deepEqual(h.delays.slice(0, 3), [1_000, 2_000, 4_000]);

		h.socket().open();
		h.socket().drop();
		await flush();
		assert.equal(h.delays[3], 1_000, 'a successful connection should reset the backoff');
		h.close();
	});

	// The regression this file exists for. The server issues a fresh
	// subscription id per connection; keeping the old one silently dropped every
	// event from the new subscription.
	it('does not carry a stale subscription id across a reconnect', async () => {
		const h = harness();
		h.socket().open();
		h.socket().deliver(ack('sub_first'));
		h.socket().deliver(event('sub_first', 'run.completed', RUN_COMPLETED));
		assert.equal(h.emitted.length, 1);

		h.socket().drop();
		await flush();
		assert.equal(h.sockets.length, 2);
		h.socket().open();

		// An event on the new subscription, arriving before its ack was seen. With
		// a stale id held over this was dropped — and dropped forever if the ack
		// never arrived at all.
		h.socket().deliver(event('sub_second', 'run.completed', RUN_COMPLETED));
		assert.equal(h.emitted.length, 2, 'event on the new connection should be emitted');

		// Once the new ack lands, the retired id must no longer be honoured.
		h.socket().deliver(ack('sub_second', 2));
		h.socket().deliver(event('sub_first', 'run.completed', RUN_COMPLETED));
		assert.equal(h.emitted.length, 2, 'the retired subscription must not emit');

		h.socket().deliver(event('sub_second', 'run.completed', RUN_COMPLETED));
		assert.equal(h.emitted.length, 3);
		h.close();
	});

	it('re-subscribes on every new connection', async () => {
		const h = harness();
		h.socket().open();
		h.socket().drop();
		await flush();
		h.socket().open();

		assert.deepEqual(h.socket().frames(), [
			{ jsonrpc: '2.0', id: 2, method: 'subscribe', params: { topic: 'events' } },
		]);
		h.close();
	});

	it('does not reopen when reconnect is off', async () => {
		const h = harness({ reconnect: false });
		h.socket().drop();
		await flush();
		assert.equal(h.sockets.length, 1);
		h.close();
	});
});

describe('startEventSession — keepalive', () => {
	it('sends an id-less ping, so the server must not reply', () => {
		const frame = JSON.parse(keepaliveFrame()) as Record<string, unknown>;
		assert.equal(frame.method, 'ping');
		assert.equal(frame.jsonrpc, '2.0');
		assert.ok(!('id' in frame), 'a keepalive carrying an id would provoke a reply frame');
	});

	it('pings an open socket, repeatedly', async () => {
		const { h, state } = tickingHarness(3);
		h.socket().open();

		while (state.ticks < 3) await flush();
		await flush();

		assert.ok(h.socket().pings().length >= 2, `expected repeated pings after ${state.ticks} ticks`);
	});

	it('does not ping a socket that is not open', async () => {
		const { h, state } = tickingHarness(3);
		// Never opened, so readyState stays CONNECTING.

		while (state.ticks < 3) await flush();
		await flush();

		assert.deepEqual(h.socket().pings(), []);
	});

	it('is spaced well inside the gateway 60s idle timeout', () => {
		// Two pings must fit in the window, or one lost frame closes a live
		// connection.
		assert.ok(KEEPALIVE_MS * 2 < 60_000, `${KEEPALIVE_MS}ms is too long for a 60s timeout`);
	});
});

describe('startEventSession — shutting down', () => {
	it('closes the socket and stops reconnecting', async () => {
		const h = harness();
		h.socket().open();
		h.close();

		assert.equal(h.socket().closed, true);

		h.socket().drop();
		await flush();
		assert.equal(h.sockets.length, 1, 'must not redial after close');
	});

	it('tolerates a socket that is already gone', () => {
		const h = harness();
		h.socket().close();
		assert.doesNotThrow(() => h.close());
	});
});

describe('subscribeFrame', () => {
	it('is a JSON-RPC request carrying the topic', () => {
		const frame = JSON.parse(subscribeFrame(7, 'events')) as Record<string, unknown>;
		assert.deepEqual(frame, {
			jsonrpc: '2.0',
			id: 7,
			method: 'subscribe',
			params: { topic: 'events' },
		});
	});
});
