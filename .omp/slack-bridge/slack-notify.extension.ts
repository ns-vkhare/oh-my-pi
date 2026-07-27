/**
 * omp extension: notify the Slack bridge when a TERMINAL session needs
 * attention (turn finished / agent is asking a question).
 *
 * Installed to `~/.omp/agent/extensions/slack-notify.ts`, so it loads in EVERY
 * omp session. It MUST therefore be fail-soft and near-zero-cost: when the
 * bridge is down every notify is a swallowed no-op and the session never
 * blocks. The pure logic (buildNotifyPayload / sendNotify / notify) is exported
 * for tests; the default export is the extension factory omp invokes.
 *
 * Zero-dep by design: this file is type-checked standalone by the bridge's
 * tsconfig, so it must NOT import "@oh-my-pi/pi-coding-agent" (not a dep). The
 * real omp runtime passes the full ExtensionAPI; we model only what we touch.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { ControlRequest } from "./types";

/** The `notify` variant of the frozen control-socket contract. */
export type NotifyRequest = Extract<ControlRequest, { op: "notify" }>;
export type NotifyKind = NotifyRequest["kind"];

/** Everything needed to compose a notification, extracted from the omp event. */
export interface NotifyInput {
	sessionPath: string;
	cwd: string;
	/** Session name; falls back to the cwd basename when absent. */
	name?: string;
	kind: NotifyKind;
	/** turn_end: last assistant text. */
	lastText?: string;
	/** ask_pending: the first pending question. */
	question?: string;
}

// ponytail: hardcoded install location — the bridge owns this exact path and
// there is only ever one per user. No config knob until a second one exists.
const SOCK_PATH = path.join(os.homedir(), ".omp", "slack-bridge", "bridge.sock");

/** Connect timeout for the fire-and-forget write. */
const CONNECT_TIMEOUT_MS = 500;
/** At most one notify per session per kind within this window. */
const DEBOUNCE_MS = 30_000;
/** Head length for embedded assistant text / question. */
const HEAD_CHARS = 200;

/** Collapse whitespace, trim, and cap at HEAD_CHARS for embedding in a message. */
function head(s: string | undefined): string {
	const norm = (s ?? "").replace(/\s+/g, " ").trim();
	return norm.length <= HEAD_CHARS ? norm : norm.slice(0, HEAD_CHARS);
}

/** Pure: build the JSONL request body for a notification. */
export function buildNotifyPayload(input: NotifyInput): NotifyRequest {
	const label = input.name?.trim() || path.basename(input.cwd) || input.cwd || "session";
	let text: string;
	if (input.kind === "ask_pending") {
		text = `❓ waiting on input: ${head(input.question)}`;
	} else {
		const tail = head(input.lastText);
		text = tail ? `✅ ${label}: turn finished — ${tail}` : `✅ ${label}: turn finished`;
	}
	return { op: "notify", sessionPath: input.sessionPath, cwd: input.cwd, kind: input.kind, text };
}

/**
 * Fire-and-forget one JSONL request to the bridge control socket. Resolves
 * `true` once the line is written, `false` on any failure (socket absent, refused,
 * timeout). NEVER throws — bridge down is a silent no-op.
 */
export function sendNotify(sockPath: string, payload: NotifyRequest): Promise<boolean> {
	const line = `${JSON.stringify(payload)}\n`;
	const { promise, resolve } = Promise.withResolvers<boolean>();
	let settled = false;
	const done = (v: boolean) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		resolve(v);
	};
	const timer = setTimeout(() => done(false), CONNECT_TIMEOUT_MS);
	Bun.connect({
		unix: sockPath,
		socket: {
			open(sock) {
				sock.write(line);
				sock.end();
				done(true);
			},
			data() {},
			error() {
				done(false);
			},
			close() {},
		},
	}).catch(() => done(false));
	return promise;
}

// ponytail: debounce records the timestamp on the check itself, so a notify
// that later fails to send (bridge down) still consumes the window. Acceptable:
// the next window simply retries, and it keeps the map append-free.
const lastSent = new Map<string, number>();

/** Whether a notify for this (session, kind) is allowed now; records if so. */
export function shouldNotify(sessionPath: string, kind: NotifyKind, now: number = Date.now()): boolean {
	const key = `${sessionPath}\u0000${kind}`;
	const prev = lastSent.get(key);
	if (prev !== undefined && now - prev < DEBOUNCE_MS) return false;
	lastSent.set(key, now);
	return true;
}

/**
 * Debounce, build, and send in one call. Resolves `true` only when a line was
 * actually written; `false` when suppressed by debounce or the send failed.
 */
export async function notify(sockPath: string, input: NotifyInput, now: number = Date.now()): Promise<boolean> {
	if (!input.sessionPath) return false;
	if (!shouldNotify(input.sessionPath, input.kind, now)) return false;
	return sendNotify(sockPath, buildNotifyPayload(input));
}

// ---------------------------------------------------------------------------
// Extension factory + defensive event extraction.
// ---------------------------------------------------------------------------

/** Minimal structural view of the omp session manager (read-only getters). */
interface SessionManagerLike {
	getSessionFile?(): string | undefined;
	getSessionName?(): string | undefined;
}
/** Minimal structural view of the handler context. */
interface SessionCtxLike {
	cwd?: string;
	sessionManager?: SessionManagerLike;
}
/** Loosely-typed agent_end event: fields beyond what we read may be absent. */
interface AgentEndLike {
	messages?: unknown;
}
/** Loosely-typed tool_call event. */
interface ToolCallLike {
	toolName?: string;
	input?: unknown;
}
/** Minimal structural view of the ExtensionAPI surface this file uses. */
interface NotifyPi {
	setLabel(label: string): void;
	on(event: "agent_end", handler: (event: AgentEndLike, ctx: SessionCtxLike) => unknown): void;
	on(event: "tool_call", handler: (event: ToolCallLike, ctx: SessionCtxLike) => unknown): void;
}

interface SessionInfo {
	sessionPath: string;
	cwd: string;
	name?: string;
}

function sessionInfo(ctx: SessionCtxLike | undefined): SessionInfo {
	const sm = ctx?.sessionManager;
	let sessionPath = "";
	let name: string | undefined;
	try {
		sessionPath = sm?.getSessionFile?.() ?? "";
	} catch {
		/* read-only getter should never throw; stay silent if it does */
	}
	try {
		name = sm?.getSessionName?.() ?? undefined;
	} catch {
		/* ignore */
	}
	return { sessionPath, cwd: ctx?.cwd ?? "", name };
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		const b = block as { type?: unknown; text?: unknown } | undefined;
		if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
	}
	return parts.join("");
}

/** Last assistant message's text from an agent_end event (defensive). */
export function lastAssistantText(event: AgentEndLike | undefined): string {
	const messages = event?.messages;
	if (!Array.isArray(messages)) return "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: unknown; content?: unknown } | undefined;
		if (!m || m.role !== "assistant") continue;
		const text = extractText(m.content).trim();
		if (text) return text;
	}
	return "";
}

/** First pending question from an `ask` tool_call event (defensive). */
export function firstQuestion(event: ToolCallLike | undefined): string {
	const input = event?.input as { questions?: unknown; question?: unknown } | undefined;
	if (!input) return "";
	const qs = input.questions;
	if (Array.isArray(qs) && qs.length > 0) {
		const q0 = qs[0] as { question?: unknown } | undefined;
		if (q0 && typeof q0.question === "string") return q0.question;
	}
	if (typeof input.question === "string") return input.question;
	return "";
}

const extension = (pi: NotifyPi): void => {
	// Bridge-owned RPC session: the bridge already observes these events over the
	// RPC stream, so a second notify would be a duplicate. Register nothing.
	if (process.env.OMP_SLACK_BRIDGE === "1") return;

	pi.setLabel("Slack notify");

	pi.on("agent_end", (event, ctx) => {
		const info = sessionInfo(ctx);
		if (!info.sessionPath) return;
		void notify(SOCK_PATH, {
			sessionPath: info.sessionPath,
			cwd: info.cwd,
			name: info.name,
			kind: "turn_end",
			lastText: lastAssistantText(event),
		}).catch(() => {});
	});

	pi.on("tool_call", (event, ctx) => {
		if (event?.toolName !== "ask") return;
		const info = sessionInfo(ctx);
		if (!info.sessionPath) return;
		void notify(SOCK_PATH, {
			sessionPath: info.sessionPath,
			cwd: info.cwd,
			name: info.name,
			kind: "ask_pending",
			question: firstQuestion(event),
		}).catch(() => {});
	});
};

export default extension;
