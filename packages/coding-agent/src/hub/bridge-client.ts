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

/** Requests this client issues (subset of the bridge's ControlRequest union). */
type ControlRequest =
	| { op: "status" }
	| { op: "park"; sessionPath: string }
	| { op: "steer"; sessionPath: string; text: string }
	| { op: "interrupt"; sessionPath: string };

/**
 * Untrusted parse of the bridge's ControlResponse union — the wire shape is
 * validated per-op at the call sites below rather than trusted from JSON.
 */
interface ControlResponse {
	ok?: boolean;
	error?: string;
	tasks?: BridgeTaskInfo[];
	parked?: boolean;
	reason?: string;
}

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), ".omp", "slack-bridge", "bridge.sock");

/**
 * One-shot JSONL round trip: connect, write the request, read the first line,
 * close. Resolves `null` on any failure (connect, timeout, close-before-reply,
 * unparseable line).
 *
 * ponytail: one connection per call — pooling only if hub polling ever matters.
 */
async function controlRequest(
	req: ControlRequest,
	timeoutMs: number,
	sockPath: string,
): Promise<ControlResponse | null> {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	let settled = false;
	const settle = (line: string | null): void => {
		if (settled) return;
		settled = true;
		resolve(line);
	};

	let socket: Bun.Socket<undefined> | undefined;
	let buffer = "";
	const timer = setTimeout(() => settle(null), timeoutMs);

	Bun.connect<undefined>({
		unix: sockPath,
		socket: {
			open(sock) {
				sock.write(`${JSON.stringify(req)}\n`);
			},
			data(_sock, chunk) {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline !== -1) settle(buffer.slice(0, newline));
			},
			close() {
				settle(null);
			},
			error(_sock, err) {
				logger.debug("Slack bridge control socket error", { op: req.op, sockPath, error: err.message });
				settle(null);
			},
		},
	}).then(
		sock => {
			socket = sock;
			// Timed out (or errored) while connecting: drop the late connection.
			if (settled) sock.end();
		},
		(err: Error) => {
			logger.debug("Slack bridge unreachable", { op: req.op, sockPath, error: err.message });
			settle(null);
		},
	);

	const line = await promise;
	clearTimeout(timer);
	socket?.end();

	if (line === null) {
		logger.debug("Slack bridge control request got no response", { op: req.op, sockPath, timeoutMs });
		return null;
	}
	try {
		return JSON.parse(line) as ControlResponse;
	} catch {
		logger.debug("Slack bridge control response was not JSON", { op: req.op, sockPath, line });
		return null;
	}
}

/**
 * Live Slack-owned tasks, or `null` when the bridge is unreachable.
 * @param timeoutMs Give up after this long (default 250ms — this runs on UI paths).
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function bridgeStatus(timeoutMs = 250, sockPath = DEFAULT_SOCKET_PATH): Promise<BridgeTaskInfo[] | null> {
	const res = await controlRequest({ op: "status" }, timeoutMs, sockPath);
	if (!res?.ok || !Array.isArray(res.tasks)) {
		if (res?.error) logger.debug("Slack bridge status failed", { error: res.error });
		return null;
	}
	return res.tasks;
}

/**
 * Ask the bridge to release the task owning `sessionPath` so a terminal can
 * attach to it. `{ parked: false, reason }` means the Slack side is busy;
 * `{ parked: false }` with no reason means the session simply is not
 * bridge-owned. `null` means the bridge is unreachable — proceed as usual.
 * @param timeoutMs Give up after this long (default 2000ms — parking stops an RPC child).
 * @param sockPath Override the control socket (tests / non-default state dirs).
 */
export async function parkBridgeSession(
	sessionPath: string,
	timeoutMs = 2000,
	sockPath = DEFAULT_SOCKET_PATH,
): Promise<{ parked: boolean; reason?: string } | null> {
	const res = await controlRequest({ op: "park", sessionPath }, timeoutMs, sockPath);
	if (!res?.ok || typeof res.parked !== "boolean") {
		if (res?.error) logger.debug("Slack bridge park failed", { sessionPath, error: res.error });
		return null;
	}
	return typeof res.reason === "string" ? { parked: res.parked, reason: res.reason } : { parked: res.parked };
}

/**
 * Collapse an ack-only response (`{ ok: true }`) to a tri-state: `true` when
 * the bridge accepted the op, `false` when it answered but refused (unknown
 * session, task already closed), `null` when it is unreachable.
 */
function ack(res: ControlResponse | null, op: string, sessionPath: string): boolean | null {
	if (!res) return null;
	if (!res.ok) {
		logger.debug("Slack bridge op refused", { op, sessionPath, error: res.error });
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
