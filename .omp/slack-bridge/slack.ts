/**
 * Slack Socket Mode client + minimal Web API wrapper.
 *
 * Zero omp knowledge. Implements the SlackTransport contract from ./types:
 * opens a Socket Mode WebSocket via apps.connections.open, acks every envelope
 * immediately, dedups retried event deliveries, normalizes message.im events
 * and block actions, and reconnects with capped exponential backoff until
 * stop().
 */

import type {
	SlackBlock,
	SlackBlockAction,
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

export interface SlackTransportOptions {
	appToken: string;
	botToken: string;
	apiBaseUrl?: string;
}

/** Bounded insertion-ordered set — drops the oldest key once past `cap`. */
class LruSet {
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

	constructor(options: SlackTransportOptions) {
		this.#appToken = options.appToken;
		this.#botToken = options.botToken;
		this.#apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
	}

	get botUserId(): string {
		return this.#botUserId;
	}

	async start(): Promise<void> {
		this.#stopped = false;
		const auth = await this.#api("auth.test", {}, "bot");
		this.#botUserId = String(auth.user_id ?? "");
		await this.#connect();
	}

	async stop(): Promise<void> {
		this.#stopped = true;
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
		const bytes = new TextEncoder().encode(args.content);
		// 1. Reserve an upload URL. This method takes form-encoded params.
		const reserve = await this.#apiForm(
			"files.getUploadURLExternal",
			{ filename: args.filename, length: String(bytes.byteLength) },
			"bot",
		);
		const uploadUrl = String(reserve.upload_url ?? "");
		const fileId = String(reserve.file_id ?? "");
		// 2. POST the raw bytes to the reserved URL.
		const uploadRes = await fetch(uploadUrl, { method: "POST", body: bytes });
		if (!uploadRes.ok) {
			throw new Error(`slack files upload: HTTP ${uploadRes.status}`);
		}
		// consume the body so the connection can be reused
		await uploadRes.text();
		// 3. Finalize, attaching the snippet to the thread.
		await this.#api(
			"files.completeUploadExternal",
			{
				files: [{ id: fileId, title: args.filename }],
				channel_id: args.channel,
				thread_ts: args.threadTs,
			},
			"bot",
		);
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
			if (this.#ws === ws) this.#ws = null;
			this.#scheduleReconnect();
		});

		return promise;
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
		if (event.type !== "message" || event.channel_type !== "im") return;
		if (event.subtype !== undefined) return; // bot_message, message_changed, …
		if (event.bot_id !== undefined) return;
		if (event.user === this.#botUserId) return;

		const msg: SlackInboundMessage = {
			kind: "message",
			channel: String(event.channel ?? ""),
			user: String(event.user ?? ""),
			text: typeof event.text === "string" ? event.text : "",
			ts: String(event.ts ?? ""),
		};
		const threadTs = event.thread_ts;
		if (typeof threadTs === "string") msg.threadTs = threadTs;
		this.#dispatch(msg);
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
