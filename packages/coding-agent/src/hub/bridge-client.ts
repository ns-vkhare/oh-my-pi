/**
 * Client for the Slack bridge control socket (`~/.omp/slack-bridge/bridge.sock`).
 *
 * The bridge daemon owns headless Slack-driven omp sessions and answers a JSONL
 * request/response protocol over a Unix socket (one JSON object per line,
 * exactly one response per request). Everything here is fail-soft: the bridge is
 * optional, so an absent socket, a refused connection, a slow daemon, or a
 * malformed reply all resolve to `null` and never throw. Callers treat `null` as
 * "no bridge" — never as "no tasks".
 */
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";

/** Live Slack-owned task as reported by the bridge's `status` op. */
export interface BridgeTaskInfo {
	/** Absent until the bridge's RPC child reports its session file. */
	sessionPath?: string;
	threadTs: string;
	channel: string;
	name: string;
	turnActive: boolean;
	subagentsRunning: number;
}

export interface BridgeSubagentInfo {
	id: string;
	agent: string;
	status: string;
	task?: string;
	sessionFile?: string;
	lastUpdate: number;
}

/** Requests this client issues (subset of the bridge's ControlRequest union). */
type ControlRequest =
	| { op: "status" }
	| { op: "park"; sessionPath: string }
	| { op: "steer"; sessionPath: string; text: string }
	| { op: "interrupt"; sessionPath: string }
	| { op: "subagents"; sessionPath: string };

/**
 * Untrusted parse of the bridge's ControlResponse union — the wire shape is
 * validated per-op at the call sites below rather than trusted from JSON.
 */
interface ControlResponse {
	ok?: boolean;
	error?: string;
	tasks?: unknown;
	parked?: boolean;
	reason?: string;
	subagents?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), ".omp", "slack-bridge", "bridge.sock");

/**
 * Park deadline. Must clear the daemon's own worst case end to end — its
 * bounded subagent query plus `rpc.stop()`'s SIGTERM→SIGKILL grace — or a park
 * that is merely slow reports `indeterminate` and the caller refuses to attach
 * to a session that did in fact get released.
 */
const PARK_TIMEOUT_MS = 10_000;

/**
 * Why a control request produced no usable answer. The distinction is
 * load-bearing for ownership decisions: `absent` means no daemon exists to hold
 * anything, while `indeterminate` means one may well be alive and mid-park —
 * collapsing the two makes every caller fail *open* onto a session that is
 * still owned. Display-only callers may still treat both as "no bridge".
 */
type ControlFailure = "absent" | "indeterminate";

type ControlOutcome = { ok: ControlResponse } | { failed: ControlFailure };

/**
 * One-shot JSONL round trip: connect, write the request, read the first line,
 * close. Never throws. A refused connection or missing socket resolves
 * `absent`; a timeout, an early close, or an unparseable line resolves
 * `indeterminate` — the daemon may have received and acted on the request.
 *
 * ponytail: one connection per call — pooling only if hub polling ever matters.
 */
async function controlRequest(req: ControlRequest, timeoutMs: number, sockPath: string): Promise<ControlOutcome> {
	const { promise, resolve } = Promise.withResolvers<{ line: string } | { failed: ControlFailure }>();
	let settled = false;
	const settle = (result: { line: string } | { failed: ControlFailure }): void => {
		if (settled) return;
		settled = true;
		resolve(result);
	};

	let socket: Bun.Socket<undefined> | undefined;
	let buffer = "";
	const timer = setTimeout(() => settle({ failed: "indeterminate" }), timeoutMs);

	Bun.connect<undefined>({
		unix: sockPath,
		socket: {
			open(sock) {
				sock.write(`${JSON.stringify(req)}\n`);
			},
			data(_sock, chunk) {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline !== -1) settle({ line: buffer.slice(0, newline) });
			},
			// Closed after the connection was established but before a full line:
			// the daemon existed, so its handler may have run.
			close() {
				settle({ failed: "indeterminate" });
			},
			error(_sock, err) {
				logger.debug("Slack bridge control socket error", { op: req.op, sockPath, error: err.message });
				settle({ failed: "indeterminate" });
			},
		},
	}).then(
		sock => {
			socket = sock;
			// Timed out (or errored) while connecting: drop the late connection.
			if (settled) sock.end();
		},
		(err: Error) => {
			// Connect itself failed (no socket file, refused): nothing is listening.
			logger.debug("Slack bridge unreachable", { op: req.op, sockPath, error: err.message });
			settle({ failed: "absent" });
		},
	);

	const result = await promise;
	clearTimeout(timer);
	socket?.end();

	if ("failed" in result) {
		logger.debug("Slack bridge control request got no response", {
			op: req.op,
			sockPath,
			timeoutMs,
			why: result.failed,
		});
		return result;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.line);
	} catch {
		logger.debug("Slack bridge control response was not JSON", { op: req.op, sockPath, line: result.line });
		return { failed: "indeterminate" };
	}
	if (!isRecord(parsed)) {
		logger.debug("Slack bridge control response was not an object", { op: req.op, sockPath, line: result.line });
		return { failed: "indeterminate" };
	}
	return { ok: parsed as ControlResponse };
}

/**
 * Live Slack-owned tasks, or `null` when the bridge produced no usable answer.
 * A display path: an absent daemon and a wedged one look the same in a row list,
 * so both collapse to `null` here.
 * @param timeoutMs Give up after this long (default 250ms — this runs on UI paths).
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function bridgeStatus(timeoutMs = 250, sockPath = DEFAULT_SOCKET_PATH): Promise<BridgeTaskInfo[] | null> {
	const outcome = await controlRequest({ op: "status" }, timeoutMs, sockPath);
	if (!("ok" in outcome)) return null;
	const res = outcome.ok;
	if (!res.ok || !Array.isArray(res.tasks)) {
		if (res.error) logger.debug("Slack bridge status failed", { error: res.error });
		return null;
	}
	const tasks: BridgeTaskInfo[] = [];
	for (const entry of res.tasks) {
		if (
			!isRecord(entry) ||
			typeof entry.threadTs !== "string" ||
			typeof entry.channel !== "string" ||
			typeof entry.name !== "string" ||
			typeof entry.turnActive !== "boolean" ||
			typeof entry.subagentsRunning !== "number" ||
			!Number.isFinite(entry.subagentsRunning) ||
			(entry.sessionPath !== undefined && typeof entry.sessionPath !== "string")
		) {
			continue;
		}
		const task: BridgeTaskInfo = {
			threadTs: entry.threadTs,
			channel: entry.channel,
			name: entry.name,
			turnActive: entry.turnActive,
			subagentsRunning: entry.subagentsRunning,
		};
		if (typeof entry.sessionPath === "string") task.sessionPath = entry.sessionPath;
		tasks.push(task);
	}
	if (tasks.length !== res.tasks.length) {
		logger.debug("Slack bridge status dropped malformed tasks", { dropped: res.tasks.length - tasks.length });
	}
	return tasks;
}

export async function bridgeSubagents(
	sessionPath: string,
	timeoutMs = 500,
	sockPath = DEFAULT_SOCKET_PATH,
): Promise<BridgeSubagentInfo[] | null> {
	const outcome = await controlRequest({ op: "subagents", sessionPath }, timeoutMs, sockPath);
	if (!("ok" in outcome)) return null;
	const res = outcome.ok;
	if (!res.ok || !Array.isArray(res.subagents)) {
		logger.debug("Slack bridge subagents failed", { sessionPath, error: res.error });
		return null;
	}
	const infos: BridgeSubagentInfo[] = [];
	for (const entry of res.subagents) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		const info: BridgeSubagentInfo = {
			id: entry.id,
			agent: typeof entry.agent === "string" ? entry.agent : "",
			status: typeof entry.status === "string" ? entry.status : "unknown",
			lastUpdate: typeof entry.lastUpdate === "number" && Number.isFinite(entry.lastUpdate) ? entry.lastUpdate : 0,
		};
		if (typeof entry.task === "string" && entry.task.length > 0) info.task = entry.task;
		if (typeof entry.sessionFile === "string" && entry.sessionFile.length > 0) info.sessionFile = entry.sessionFile;
		infos.push(info);
	}
	return infos;
}

/**
 * The answer to "may this terminal take ownership of `sessionPath`?".
 *
 * Deliberately five states, not a boolean: three of them clear the way, and the
 * two that do not are for opposite reasons. `indeterminate` is the one that
 * used to hide inside `null` — the daemon may be alive and halfway through
 * parking, so attaching on it races a live owner onto one session file.
 */
export type ParkOutcome =
	/** No socket, or the connection was refused: no daemon exists to hold anything. */
	| { kind: "absent" }
	/** Timed out, closed early, or answered with garbage. Ownership is UNKNOWN — fail closed. */
	| { kind: "indeterminate" }
	/** The bridge stopped its RPC child; the session is now free. Irreversible. */
	| { kind: "parked" }
	/** The bridge answered and does not drive this session. */
	| { kind: "not-owned" }
	/** The Slack side is mid-flight and refused, with its reason. */
	| { kind: "busy"; reason: string };

/**
 * Ask the bridge to release the task owning `sessionPath` so a terminal can
 * attach to it. Parking stops the bridge's RPC child, posts a handoff note to
 * the Slack thread, and drops the task from its live set — so a `parked` answer
 * is a side effect that already happened, never a query result to discard.
 *
 * @param timeoutMs Give up after this long. The default clears the daemon's own
 *   worst case: a bounded subagent query plus `stop()`'s SIGTERM→SIGKILL grace.
 *   Below that, a slow-but-healthy park reads as `indeterminate`.
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function parkBridgeSession(
	sessionPath: string,
	timeoutMs = PARK_TIMEOUT_MS,
	sockPath = DEFAULT_SOCKET_PATH,
): Promise<ParkOutcome> {
	const outcome = await controlRequest({ op: "park", sessionPath }, timeoutMs, sockPath);
	if (!("ok" in outcome)) return { kind: outcome.failed };
	const res = outcome.ok;
	if (!res.ok || typeof res.parked !== "boolean") {
		// The daemon is up but this request did not land cleanly; it may still
		// have acted, so this is not "nothing owns the session".
		logger.debug("Slack bridge park failed", { sessionPath, error: res.error });
		return { kind: "indeterminate" };
	}
	if (res.parked) return { kind: "parked" };
	return typeof res.reason === "string" && res.reason.length > 0
		? { kind: "busy", reason: res.reason }
		: { kind: "not-owned" };
}

/**
 * Collapse an ack-only response (`{ ok: true }`) to a tri-state: `true` when
 * the bridge accepted the op, `false` when it answered but refused (unknown
 * session, task already closed), `null` when it gave no usable answer.
 */
function ack(outcome: ControlOutcome, op: string, sessionPath: string): boolean | null {
	if (!("ok" in outcome)) return null;
	if (!outcome.ok.ok) {
		logger.debug("Slack bridge op refused", { op, sessionPath, error: outcome.ok.error });
		return false;
	}
	return true;
}

/**
 * Deliver `text` to the bridge-owned session at `sessionPath` — steering the
 * turn in flight, or prompting the task when it is idle. Used by the `--watch`
 * spectator, whose editor proxies input to the owning process.
 * @param timeoutMs Give up after this long (default 2000ms — the bridge relays into an RPC child).
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function steerBridgeSession(
	sessionPath: string,
	text: string,
	timeoutMs = 2000,
	sockPath = DEFAULT_SOCKET_PATH,
): Promise<boolean | null> {
	return ack(await controlRequest({ op: "steer", sessionPath, text }, timeoutMs, sockPath), "steer", sessionPath);
}

/**
 * Abort the main turn of the bridge-owned session at `sessionPath`. Subagents
 * it spawned keep running — that is the bridge's design, not an omission here.
 * @param timeoutMs Give up after this long (default 2000ms — the bridge relays into an RPC child).
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function interruptBridgeSession(
	sessionPath: string,
	timeoutMs = 2000,
	sockPath = DEFAULT_SOCKET_PATH,
): Promise<boolean | null> {
	return ack(await controlRequest({ op: "interrupt", sessionPath }, timeoutMs, sockPath), "interrupt", sessionPath);
}
