/**
 * Slack Socket Mode client + minimal Web API wrapper.
 *
 * Zero omp knowledge. Implements the SlackTransport contract from ./types:
 * opens a Socket Mode WebSocket via apps.connections.open, acks every envelope
 * immediately, dedups retried event deliveries, normalizes message.im events
 * and block actions, pings every 30s so a silently dropped peer surfaces as a
 * close, and reconnects with capped exponential backoff until stop().
 */

import type {
	SlackBlock,
	SlackBlockAction,
	SlackFileRef,
	SlackHistoryEntry,
	SlackInbound,
	SlackInboundMessage,
	SlackPostArgs,
	SlackTransport,
} from "./types";

const DEFAULT_API_BASE_URL = "https://slack.com/api";
/** Cap of remembered event_ids for dedup (bounded LRU). */
const DEDUP_CAP = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
/**
 * Client ping cadence. A proxy/NAT that drops the connection without a FIN
 * leaves a socket that looks OPEN forever and delivers nothing; writing to it
 * draws the RST that fires `close`, which is what triggers the reconnect.
 */
const PING_INTERVAL_MS = 30_000;
/** Subtypes that still carry a real user message; everything else is chatter. */
const ACCEPTED_SUBTYPES: Record<string, true> = { file_share: true, thread_broadcast: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export interface SlackTransportOptions {
	appToken: string;
	botToken: string;
	apiBaseUrl?: string;
}

/** Bounded insertion-ordered set — drops the oldest key once past `cap`. */
export class LruSet {
	readonly #cap: number;
	readonly #set = new Set<string>();

	constructor(cap: number) {
		this.#cap = cap;
	}

	/** Returns true if `key` was already present; otherwise records it. */
	seen(key: string): boolean {
		if (this.#set.has(key)) return true;
		this.#set.add(key);
		if (this.#set.size > this.#cap) {
			const oldest = this.#set.values().next().value;
			if (oldest !== undefined) this.#set.delete(oldest);
		}
		return false;
	}
}

/**
 * A Slack message object — live `message.im` event or `conversations.history`
 * row, they share a shape — normalized to the bridge's inbound message, or
 * null when it is not a user message the bridge should act on.
 *
 * Attachments are the reason subtypes are not a blanket reject: depending on
 * the posting client, a DM carrying files arrives either as a plain message
 * with `files[]` or under the `file_share` subtype.
 */
export function normalizeMessage(raw: Record<string, unknown>, botUserId: string): SlackInboundMessage | null {
	if (raw.type !== "message") return null;
	if (raw.subtype !== undefined && ACCEPTED_SUBTYPES[String(raw.subtype)] !== true) return null;
	if (raw.bot_id !== undefined) return null;
	const user = typeof raw.user === "string" ? raw.user : "";
	if (!user || user === botUserId) return null;

	const msg: SlackInboundMessage = {
		kind: "message",
		channel: String(raw.channel ?? ""),
		user,
		text: typeof raw.text === "string" ? raw.text : "",
		ts: String(raw.ts ?? ""),
	};
	if (typeof raw.thread_ts === "string") msg.threadTs = raw.thread_ts;

	const files: SlackFileRef[] = [];
	if (Array.isArray(raw.files)) {
		for (const item of raw.files) {
			if (!isRecord(item)) continue;
			const file: SlackFileRef = {
				id: String(item.id ?? ""),
				name: String(item.name ?? item.title ?? "file"),
				mimetype: String(item.mimetype ?? "application/octet-stream"),
				size: typeof item.size === "number" ? item.size : 0,
			};
			// Externally hosted files (Drive, Box…) have a url_private pointing at
			// the provider — useless to the bot token, so they get no downloadUrl.
			if (item.is_external !== true) {
				const url = item.url_private_download ?? item.url_private;
				if (typeof url === "string") file.downloadUrl = url;
			}
			if (typeof item.permalink === "string") file.permalink = item.permalink;
			files.push(file);
		}
	}
	if (files.length > 0) msg.files = files;

	const links: string[] = [];
	if (Array.isArray(raw.attachments)) {
		for (const item of raw.attachments) {
			if (!isRecord(item)) continue;
			const url = item.from_url ?? item.original_url ?? item.title_link;
			if (typeof url === "string" && !links.includes(url)) links.push(url);
		}
	}
	if (links.length > 0) msg.links = links;

	return msg;
}

export function createSlackTransport(options: SlackTransportOptions): SlackTransport {
	return new SlackTransportImpl(options);
}

class SlackTransportImpl implements SlackTransport {
	readonly #appToken: string;
	readonly #botToken: string;
	readonly #apiBaseUrl: string;

	readonly #listeners = new Set<(inbound: SlackInbound) => void>();
	readonly #seenEvents = new LruSet(DEDUP_CAP);

	#botUserId = "";
	#ws: WebSocket | null = null;
	#stopped = false;
	#reconnectAttempts = 0;
	#pingTimer: Timer | undefined;

	constructor(options: SlackTransportOptions) {
		this.#appToken = options.appToken;
		this.#botToken = options.botToken;
		this.#apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
	}

	get botUserId(): string {
		return this.#botUserId;
	}

	get connected(): boolean {
		return this.#ws?.readyState === WebSocket.OPEN;
	}

	async start(): Promise<void> {
		this.#stopped = false;
		const auth = await this.#api("auth.test", {}, "bot");
		this.#botUserId = String(auth.user_id ?? "");
		await this.#connect();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		this.#stopPing();
		const ws = this.#ws;
		this.#ws = null;
		if (ws) {
			try {
				ws.close();
			} catch {
				// already closing/closed — nothing to do
			}
		}
	}

	/**
	 * Drop the current socket; its `close` handler schedules the reconnect.
	 * Backoff is reset first — this is a deliberate refresh, not a failure.
	 */
	reconnect(): void {
		if (this.#stopped) return;
		const ws = this.#ws;
		this.#ws = null;
		this.#stopPing();
		this.#reconnectAttempts = 0;
		if (ws) {
			try {
				ws.close();
			} catch {
				// already gone — fall through to the immediate reconnect
			}
		}
		this.#scheduleReconnect();
	}

	onInbound(listener: (inbound: SlackInbound) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async postMessage(args: SlackPostArgs): Promise<string> {
		const body: Record<string, unknown> = { channel: args.channel, text: args.text };
		if (args.blocks) body.blocks = args.blocks;
		if (args.threadTs) body.thread_ts = args.threadTs;
		const json = await this.#api("chat.postMessage", body, "bot");
		return String(json.ts ?? "");
	}

	async updateMessage(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
		const body: Record<string, unknown> = { channel: args.channel, ts: args.ts, text: args.text };
		if (args.blocks) body.blocks = args.blocks;
		await this.#api("chat.update", body, "bot");
	}

	async uploadText(args: { channel: string; threadTs: string; filename: string; content: string }): Promise<void> {
		await this.uploadFiles({
			channel: args.channel,
			threadTs: args.threadTs,
			files: [{ filename: args.filename, bytes: new TextEncoder().encode(args.content) }],
		});
	}

	async uploadFiles(args: {
		channel: string;
		threadTs: string;
		files: Array<{ filename: string; bytes: Uint8Array }>;
		comment?: string;
	}): Promise<void> {
		if (args.files.length === 0) return;
		// 1. Reserve one upload URL per file. This method takes form-encoded params.
		const reserved: Array<{ id: string; title: string }> = [];
		for (const file of args.files) {
			const reserve = await this.#apiForm(
				"files.getUploadURLExternal",
				{ filename: file.filename, length: String(file.bytes.byteLength) },
				"bot",
			);
			const uploadUrl = String(reserve.upload_url ?? "");
			const fileId = String(reserve.file_id ?? "");
			// 2. POST the raw bytes to the reserved URL.
			const uploadRes = await fetch(uploadUrl, { method: "POST", body: file.bytes });
			if (!uploadRes.ok) {
				throw new Error(`slack files upload: HTTP ${uploadRes.status}`);
			}
			// consume the body so the connection can be reused
			await uploadRes.text();
			reserved.push({ id: fileId, title: file.filename });
		}
		// 3. Finalize all of them at once: one thread message carrying every file,
		// which is what makes several screenshots render as one answer.
		const body: Record<string, unknown> = {
			files: reserved,
			channel_id: args.channel,
			thread_ts: args.threadTs,
		};
		if (args.comment) body.initial_comment = args.comment;
		await this.#api("files.completeUploadExternal", body, "bot");
	}

	async openDm(userId: string): Promise<string> {
		const json = await this.#api("conversations.open", { users: userId }, "bot");
		const channel = json.channel;
		if (typeof channel === "object" && channel !== null && typeof (channel as { id?: unknown }).id === "string") {
			return (channel as { id: string }).id;
		}
		throw new Error("slack conversations.open: missing channel id");
	}

	async fetchHistory(args: { channel: string; oldestTs: string; limit?: number }): Promise<SlackHistoryEntry[]> {
		const json = await this.#apiForm(
			"conversations.history",
			{ channel: args.channel, oldest: args.oldestTs, limit: String(args.limit ?? 50) },
			"bot",
		);
		const rows = Array.isArray(json.messages) ? json.messages : [];
		const out: SlackHistoryEntry[] = [];
		for (const row of rows) {
			if (!isRecord(row)) continue;
			// history rows carry no channel_type; the caller asked for this channel.
			const message = normalizeMessage({ ...row, channel: args.channel }, this.#botUserId);
			if (!message) continue;
			const replyUsers = Array.isArray(row.reply_users) ? row.reply_users.filter((u): u is string => typeof u === "string") : [];
			out.push({ message, replyCount: typeof row.reply_count === "number" ? row.reply_count : 0, replyUsers });
		}
		return out;
	}

	async downloadFile(url: string): Promise<Uint8Array> {
		const res = await fetch(url, { headers: { Authorization: `Bearer ${this.#botToken}` }, redirect: "follow" });
		if (!res.ok) throw new Error(`slack file download: HTTP ${res.status}`);
		// Missing `files:read` is not an error response — Slack serves the HTML
		// sign-in page with a 200. Any HTML body here means "not authorized".
		if ((res.headers.get("content-type") ?? "").startsWith("text/html")) {
			await res.text();
			throw new Error("slack file download: got a sign-in page — the bot token lacks the files:read scope");
		}
		return new Uint8Array(await res.arrayBuffer());
	}

	// ------------------------------------------------------------------------
	// Web API
	// ------------------------------------------------------------------------

	async #api(method: string, body: Record<string, unknown>, token: "bot" | "app"): Promise<Record<string, unknown>> {
		const res = await fetch(`${this.#apiBaseUrl}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token === "bot" ? this.#botToken : this.#appToken}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
		});
		const json = (await res.json()) as Record<string, unknown>;
		if (json.ok !== true) {
			throw new Error(`slack ${method}: ${String(json.error ?? "unknown_error")}`);
		}
		return json;
	}

	async #apiForm(
		method: string,
		params: Record<string, string>,
		token: "bot" | "app",
	): Promise<Record<string, unknown>> {
		const form = new URLSearchParams(params);
		const res = await fetch(`${this.#apiBaseUrl}/${method}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token === "bot" ? this.#botToken : this.#appToken}`,
				"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
			},
			body: form.toString(),
		});
		const json = (await res.json()) as Record<string, unknown>;
		if (json.ok !== true) {
			throw new Error(`slack ${method}: ${String(json.error ?? "unknown_error")}`);
		}
		return json;
	}

	// ------------------------------------------------------------------------
	// Socket Mode
	// ------------------------------------------------------------------------

	/** Opens the WS and resolves once the socket fires `open`. */
	async #connect(): Promise<void> {
		const opened = await this.#api("apps.connections.open", {}, "app");
		const url = String(opened.url ?? "");
		const ws = new WebSocket(url);
		this.#ws = ws;

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;

		ws.addEventListener("open", () => {
			this.#startPing(ws);
			// Resolve start()/reconnect on socket open. Slack sends a `hello`
			// frame immediately after; we reset backoff when that arrives.
			if (!settled) {
				settled = true;
				resolve();
			}
		});

		ws.addEventListener("message", (ev: MessageEvent) => {
			this.#onMessage(ev.data);
		});

		ws.addEventListener("error", () => {
			if (!settled) {
				settled = true;
				reject(new Error("slack socket mode: websocket error"));
			}
		});

		ws.addEventListener("close", () => {
			if (this.#ws !== ws) return; // superseded socket — its successor owns the state
			this.#ws = null;
			this.#stopPing();
			this.#scheduleReconnect();
		});

		return promise;
	}

	#startPing(ws: WebSocket): void {
		this.#stopPing();
		this.#pingTimer = setInterval(() => {
			if (this.#ws !== ws || ws.readyState !== WebSocket.OPEN) return;
			try {
				ws.ping();
			} catch {
				// write failed — the socket is gone; close fires the reconnect
			}
		}, PING_INTERVAL_MS);
	}

	#stopPing(): void {
		if (this.#pingTimer === undefined) return;
		clearInterval(this.#pingTimer);
		this.#pingTimer = undefined;
	}

	#scheduleReconnect(): void {
		if (this.#stopped) return;
		const attempt = this.#reconnectAttempts++;
		const delay = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
		void (async () => {
			await Bun.sleep(delay);
			if (this.#stopped) return;
			try {
				await this.#connect();
			} catch {
				// #connect wires its own close handler on failure paths; if the
				// initial open rejected before a socket existed, retry here.
				this.#scheduleReconnect();
			}
		})();
	}

	#onMessage(data: unknown): void {
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(typeof data === "string" ? data : String(data)) as Record<string, unknown>;
		} catch {
			return;
		}

		const type = frame.type;

		if (type === "hello") {
			// Successful handshake — reset backoff.
			this.#reconnectAttempts = 0;
			return;
		}

		if (type === "disconnect") {
			// Slack asks us to reconnect (refresh, too many connections…).
			const ws = this.#ws;
			this.#ws = null;
			this.#stopPing();
			if (ws) {
				try {
					ws.close();
				} catch {
					// ignore
				}
			}
			this.#scheduleReconnect();
			return;
		}

		// Every envelope with an id MUST be acked immediately, before async work.
		const envelopeId = frame.envelope_id;
		if (typeof envelopeId === "string") {
			this.#send({ envelope_id: envelopeId });
		}

		const payload = (frame.payload ?? {}) as Record<string, unknown>;

		if (type === "events_api") {
			this.#handleEventsApi(payload);
		} else if (type === "interactive") {
			this.#handleInteractive(payload);
		}
		// Other envelope types: acked above, otherwise ignored.
	}

	#handleEventsApi(payload: Record<string, unknown>): void {
		const eventId = payload.event_id;
		if (typeof eventId === "string" && this.#seenEvents.seen(eventId)) {
			return; // retried delivery
		}
		const event = (payload.event ?? {}) as Record<string, unknown>;
		if (event.channel_type !== "im") return;
		const msg = normalizeMessage(event, this.#botUserId);
		if (msg) this.#dispatch(msg);
	}

	#handleInteractive(payload: Record<string, unknown>): void {
		if (payload.type !== "block_actions") return;
		const actions = payload.actions;
		if (!Array.isArray(actions) || actions.length === 0) return;
		const action = actions[0] as Record<string, unknown>;
		const channel = (payload.channel ?? {}) as Record<string, unknown>;
		const user = (payload.user ?? {}) as Record<string, unknown>;
		const message = (payload.message ?? {}) as Record<string, unknown>;
		const selected = (action.selected_option ?? undefined) as Record<string, unknown> | undefined;
		const value =
			typeof action.value === "string"
				? action.value
				: selected && typeof selected.value === "string"
					? selected.value
					: "";

		const act: SlackBlockAction = {
			kind: "action",
			channel: String(channel.id ?? ""),
			user: String(user.id ?? ""),
			messageTs: String(message.ts ?? ""),
			actionId: String(action.action_id ?? ""),
			value,
		};
		const threadTs = message.thread_ts;
		if (typeof threadTs === "string") act.threadTs = threadTs;
		this.#dispatch(act);
	}

	#dispatch(inbound: SlackInbound): void {
		for (const listener of this.#listeners) {
			try {
				listener(inbound);
			} catch (err) {
				console.error("slack onInbound listener threw:", err);
			}
		}
	}

	#send(frame: Record<string, unknown>): void {
		const ws = this.#ws;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		try {
			ws.send(JSON.stringify(frame));
		} catch (err) {
			console.error("slack socket send failed:", err);
		}
	}
}
