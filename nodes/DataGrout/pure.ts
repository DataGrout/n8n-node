import type { IDataObject } from 'n8n-workflow';

// ────────────────────────────────────────────────────────────────────
// Pure helpers — no n8n runtime, no I/O, no state, so they can be
// unit-tested directly.
// ────────────────────────────────────────────────────────────────────

// ── REST API ─────────────────────────────────────────────────────────

export const DEFAULT_GATEWAY = 'https://gateway.datagrout.ai';

/**
 * The gateway's origin from either credential: the token credential stores a
 * base URL, the OAuth2 credential the `/connect` URL it authorises against.
 */
export function gatewayOrigin(credentials: IDataObject): string {
	for (const candidate of [credentials.baseUrl, credentials.serverUrl]) {
		if (typeof candidate !== 'string' || !candidate.trim()) continue;
		try {
			return new URL(candidate.trim()).origin;
		} catch {
			// not a URL; try the next
		}
	}
	return DEFAULT_GATEWAY;
}

/**
 * Where the API lives for a credential. An access token belongs to one server,
 * which the path names. An OAuth token already names the server it was
 * granted, so its requests use the server-less form and the gateway resolves
 * the server from the token.
 */
export function apiBase(origin: string, serverId: unknown): string {
	const id = typeof serverId === 'string' ? serverId.trim() : '';
	return id ? `${origin}/api/v1/servers/${encodeURIComponent(id)}` : `${origin}/api/v1`;
}

/** DataGrout holds a request for at most this long when asked to wait. */
export const MAX_SERVER_WAIT_SECONDS = 30;

/**
 * A path under the server's REST API, with each segment encoded — a memory name
 * or skill id typed by a user must not be able to reach a different endpoint.
 */
export function apiPath(...segments: string[]): string {
	return segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
}

/**
 * The `Prefer: wait=N` value (RFC 7240) asking DataGrout to hold a request until
 * slow work finishes, or undefined when the caller does not want to wait.
 */
export function waitPreference(waitMs: number): string | undefined {
	if (!(waitMs > 0)) return undefined;
	return `wait=${Math.min(MAX_SERVER_WAIT_SECONDS, Math.ceil(waitMs / 1000))}`;
}

/**
 * Where to poll background work, from a `202 Accepted` body. Only a path on the
 * API is accepted: it is joined to the gateway's own base URL, so a value that
 * pointed anywhere else could carry the credential with it.
 */
export function taskLocation(body: unknown): string | undefined {
	const location = (body as IDataObject | undefined)?.location;
	if (typeof location !== 'string') return undefined;
	return /^\/api\/v1\/(servers\/[^/]+\/)?tasks\/[^/]+$/.test(location) ? location : undefined;
}

/**
 * The message to show for an error response. The API's own errors carry
 * `{error: {message}}`; the gateway's rate limiter and authentication use a
 * flatter shape, and a proxy in between may send plain text.
 */
export function apiErrorMessage(body: unknown, status: number): string {
	if (body && typeof body === 'object') {
		const b = body as IDataObject;
		const error = b.error;
		if (error && typeof error === 'object') {
			const message = (error as IDataObject).message;
			if (typeof message === 'string' && message) return message;
		}
		if (typeof b.message === 'string' && b.message) return b.message;
		if (typeof error === 'string' && error) return error;
	}
	if (typeof body === 'string' && body.trim() && body.length <= 300) return body.trim();
	return `DataGrout returned HTTP ${status}`;
}

/** The stable error type, for continueOnFail output a workflow can branch on. */
export function apiErrorType(body: unknown): string | undefined {
	const error = (body as IDataObject | undefined)?.error;
	if (error && typeof error === 'object') {
		const type = (error as IDataObject).type;
		if (typeof type === 'string') return type;
	}
	return typeof error === 'string' ? error : undefined;
}

/**
 * A transform's result as workflow items: one per row when it is a list of
 * records, otherwise a single item.
 */
export function rowsOf(result: unknown): IDataObject[] {
	const asItem = (value: unknown): IDataObject =>
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as IDataObject)
			: ({ result: value } as IDataObject);

	return Array.isArray(result) ? result.map(asItem) : [asItem(result)];
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

// ── Trigger ──────────────────────────────────────────────────────────

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
 * The event a webhook delivery carries, or undefined when the body is not
 * DataGrout's event envelope. The envelope's own `server_id` and `timestamp`
 * stay out of the workflow item: the subscription is to one server, and n8n
 * stamps each execution itself.
 */
export function webhookEvent(body: unknown): { event: string; data: IDataObject } | undefined {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
	const envelope = body as IDataObject;
	if (typeof envelope.event !== 'string' || !envelope.event) return undefined;
	const data = envelope.data;
	return {
		event: envelope.event,
		data: data && typeof data === 'object' && !Array.isArray(data) ? (data as IDataObject) : {},
	};
}

/**
 * Whether a delivery presents the secret DataGrout issued when the webhook was
 * registered. A header that arrived more than once is an array, and fails.
 */
export function secretMatches(presented: unknown, stored: unknown): boolean {
	if (typeof stored !== 'string' || !stored) return false;
	return typeof presented === 'string' && presented === stored;
}
