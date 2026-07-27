/**
 * Hermetic tests for the Slack transport against a local mock Slack API +
 * Socket Mode WebSocket server (Bun.serve). No network, no real Slack.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSlackTransport } from "./slack";
import type { SlackInbound } from "./types";

interface MockServer {
	baseUrl: string;
	stop(): void;
	/** Bodies received per Web API method (parsed JSON or form params). */
	readonly requests: Record<string, unknown[]>;
	/** Envelope acks received back over the WS ({envelope_id}). */
	readonly acks: string[];
	/** Push an envelope frame to the connected socket. */
	pushEnvelope(frame: Record<string, unknown>): void;
	/** Resolves once a socket has connected and hello was sent. */
	waitForSocket(): Promise<void>;
}

function startMockServer(): MockServer {
	const requests: Record<string, unknown[]> = {};
	const acks: string[] = [];
	let liveSocket: import("bun").ServerWebSocket<unknown> | null = null;
	let socketConnected = Promise.withResolvers<void>();

	const record = (method: string, body: unknown): void => {
		(requests[method] ??= []).push(body);
	};

	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req, srv): Promise<Response | undefined> {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				if (srv.upgrade(req)) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			const method = url.pathname.slice(1);
			const ct = req.headers.get("content-type") ?? "";
			let body: unknown;
			if (ct.includes("application/json")) {
				body = await req.json();
			} else {
				const text = await req.text();
				body = Object.fromEntries(new URLSearchParams(text));
			}
			record(method, body);

			if (method === "auth.test") {
				return Response.json({ ok: true, user_id: "UBOT" });
			}
			if (method === "apps.connections.open") {
				return Response.json({ ok: true, url: `ws://127.0.0.1:${server.port}/ws` });
			}
			if (method === "chat.postMessage") {
				const b = body as Record<string, unknown>;
				if (b.text === "__fail__") {
					return Response.json({ ok: false, error: "invalid_blocks" });
				}
				return Response.json({ ok: true, ts: "111.222" });
			}
			if (method === "chat.update") {
				return Response.json({ ok: true });
			}
			return Response.json({ ok: false, error: "unknown_method" });
		},
		websocket: {
			open(ws) {
				liveSocket = ws;
				ws.send(JSON.stringify({ type: "hello" }));
				socketConnected.resolve();
			},
			message(_ws, raw) {
				try {
					const frame = JSON.parse(String(raw)) as Record<string, unknown>;
					if (typeof frame.envelope_id === "string") acks.push(frame.envelope_id);
				} catch {
					// ignore
				}
			},
			close() {
				liveSocket = null;
			},
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}`,
		stop() {
			server.stop(true);
		},
		requests,
		acks,
		pushEnvelope(frame) {
			liveSocket?.send(JSON.stringify(frame));
		},
		waitForSocket() {
			return socketConnected.promise;
		},
	};
}

/** Poll until `pred()` is truthy or the deadline elapses. */
async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (pred()) return;
		await Bun.sleep(10);
	}
	throw new Error("waitUntil timed out");
}

let mock: MockServer;

beforeEach(() => {
	mock = startMockServer();
});

afterEach(() => {
	mock.stop();
});

test("start() connects, consumes auth.test, sets botUserId, receives hello", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	await t.start();
	await mock.waitForSocket();

	expect(t.botUserId).toBe("UBOT");
	expect(mock.requests["auth.test"]?.length).toBe(1);
	expect(mock.requests["apps.connections.open"]?.length).toBe(1);
	await t.stop();
});

test("events_api envelope is acked and dispatched as a normalized message", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	const received: SlackInbound[] = [];
	t.onInbound((i) => received.push(i));
	await t.start();
	await mock.waitForSocket();

	mock.pushEnvelope({
		type: "events_api",
		envelope_id: "env-1",
		payload: {
			event_id: "Ev1",
			event: {
				type: "message",
				channel_type: "im",
				channel: "D123",
				user: "UALICE",
				text: "hello there",
				ts: "999.001",
			},
		},
	});

	await waitUntil(() => received.length === 1);
	await waitUntil(() => mock.acks.includes("env-1"));

	const msg = received[0];
	expect(msg).toEqual({
		kind: "message",
		channel: "D123",
		user: "UALICE",
		text: "hello there",
		ts: "999.001",
	});
	await t.stop();
});

test("duplicate event_id dispatches only once", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	const received: SlackInbound[] = [];
	t.onInbound((i) => received.push(i));
	await t.start();
	await mock.waitForSocket();

	const envelope = {
		type: "events_api",
		envelope_id: "env-dup",
		payload: {
			event_id: "EvDup",
			event: { type: "message", channel_type: "im", channel: "D1", user: "UALICE", text: "hi", ts: "1.0" },
		},
	};
	mock.pushEnvelope({ ...envelope, envelope_id: "env-dup-a" });
	mock.pushEnvelope({ ...envelope, envelope_id: "env-dup-b" });

	await waitUntil(() => mock.acks.includes("env-dup-a") && mock.acks.includes("env-dup-b"));
	// Give any erroneous second dispatch a chance to land.
	await Bun.sleep(50);
	expect(received.length).toBe(1);
	await t.stop();
});

test("bot-authored and subtype messages are ignored", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	const received: SlackInbound[] = [];
	t.onInbound((i) => received.push(i));
	await t.start();
	await mock.waitForSocket();

	// From the bot itself.
	mock.pushEnvelope({
		type: "events_api",
		envelope_id: "env-bot",
		payload: {
			event_id: "EvBot",
			event: { type: "message", channel_type: "im", channel: "D1", user: "UBOT", text: "self", ts: "2.0" },
		},
	});
	// Subtype (e.g. message_changed).
	mock.pushEnvelope({
		type: "events_api",
		envelope_id: "env-sub",
		payload: {
			event_id: "EvSub",
			event: {
				type: "message",
				subtype: "message_changed",
				channel_type: "im",
				channel: "D1",
				user: "UALICE",
				text: "edited",
				ts: "3.0",
			},
		},
	});

	await waitUntil(() => mock.acks.includes("env-bot") && mock.acks.includes("env-sub"));
	await Bun.sleep(50);
	expect(received.length).toBe(0);
	await t.stop();
});

test("a file_share DM dispatches with normalized file refs and unfurled links", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	const received: SlackInbound[] = [];
	t.onInbound((i) => received.push(i));
	await t.start();
	await mock.waitForSocket();

	mock.pushEnvelope({
		type: "events_api",
		envelope_id: "env-file",
		payload: {
			event_id: "EvFile",
			event: {
				type: "message",
				subtype: "file_share",
				channel_type: "im",
				channel: "D1",
				user: "UALICE",
				text: "run omp read this",
				ts: "4.0",
				files: [
					{ id: "F1", name: "resume.pdf", mimetype: "application/pdf", size: 42, url_private_download: "https://files.slack.test/F1", permalink: "https://slack.test/F1" },
					{ id: "F2", name: "loop.docx", mimetype: "application/vnd.doc", size: 0, is_external: true, url_private: "https://drive.test/F2", permalink: "https://slack.test/F2" },
				],
				attachments: [{ from_url: "https://docs.google.com/document/d/abc/edit" }],
			},
		},
	});

	await waitUntil(() => received.length > 0);
	const msg = received[0];
	expect(msg?.kind).toBe("message");
	if (msg?.kind !== "message") throw new Error("expected a message");
	expect(msg.text).toBe("run omp read this");
	expect(msg.files).toEqual([
		{ id: "F1", name: "resume.pdf", mimetype: "application/pdf", size: 42, downloadUrl: "https://files.slack.test/F1", permalink: "https://slack.test/F1" },
		// Externally hosted: no downloadUrl, because the bot token cannot fetch it.
		{ id: "F2", name: "loop.docx", mimetype: "application/vnd.doc", size: 0, permalink: "https://slack.test/F2" },
	]);
	expect(msg.links).toEqual(["https://docs.google.com/document/d/abc/edit"]);
	await t.stop();
});

test("block_actions envelope normalizes to a SlackBlockAction", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	const received: SlackInbound[] = [];
	t.onInbound((i) => received.push(i));
	await t.start();
	await mock.waitForSocket();

	mock.pushEnvelope({
		type: "interactive",
		envelope_id: "env-act",
		payload: {
			type: "block_actions",
			channel: { id: "D9" },
			user: { id: "UBOB" },
			message: { ts: "555.001", thread_ts: "500.000" },
			actions: [{ action_id: "ui:req42", value: "Yes, proceed" }],
		},
	});

	await waitUntil(() => received.length === 1);
	await waitUntil(() => mock.acks.includes("env-act"));

	expect(received[0]).toEqual({
		kind: "action",
		channel: "D9",
		user: "UBOB",
		messageTs: "555.001",
		threadTs: "500.000",
		actionId: "ui:req42",
		value: "Yes, proceed",
	});
	await t.stop();
});

test("postMessage sends thread_ts and returns ts; ok:false throws with the error code", async () => {
	const t = createSlackTransport({ appToken: "xapp-1", botToken: "xoxb-1", apiBaseUrl: mock.baseUrl });
	await t.start();
	await mock.waitForSocket();

	const ts = await t.postMessage({ channel: "D1", text: "hi", threadTs: "100.001" });
	expect(ts).toBe("111.222");
	const sent = mock.requests["chat.postMessage"]?.[0] as Record<string, unknown>;
	expect(sent.thread_ts).toBe("100.001");
	expect(sent.channel).toBe("D1");

	await expect(t.postMessage({ channel: "D1", text: "__fail__" })).rejects.toThrow(
		"slack chat.postMessage: invalid_blocks",
	);
	await t.stop();
});
