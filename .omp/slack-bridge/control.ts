/**
 * Control plane: a Unix-domain socket at `<stateDir>/bridge.sock` speaking
 * JSONL (one ControlRequest per line, exactly one ControlResponse per line).
 *
 * Doubles as the single-instance lock: a starting bridge that gets a valid
 * `ping` pong from the socket throws BridgeAlreadyRunningError; a socket file
 * that refuses connections is unlinked as stale and rebound.
 *
 * Consumed by omp core (bridge-client) and the slack-notify extension via
 * {@link controlRequest}; served by the bridge daemon via {@link startControlServer}.
 */

import * as fs from "node:fs/promises";
import type { ControlRequest, ControlResponse, ControlSubagentInfo, ControlTaskInfo } from "./types";

/** Timeout for the startup ping probe (single-instance detection). */
const PING_PROBE_MS = 500;

/** Host surface bridge.ts injects — the daemon-side implementation of each op. */
export interface ControlHost {
	pid: number;
	status(): Promise<ControlTaskInfo[]>;
	park(sessionPath: string): Promise<{ parked: boolean; reason?: string }>;
	steer(sessionPath: string, text: string): Promise<void>;
	interrupt(sessionPath: string): Promise<void>;
	subagents(sessionPath: string): Promise<ControlSubagentInfo[]>;
	notify(event: { sessionPath: string; cwd: string; kind: string; text: string }): Promise<void>;
}

/** Thrown by {@link startControlServer} when a live bridge already owns the socket. */
export class BridgeAlreadyRunningError extends Error {
	readonly pid: number;
	constructor(pid: number) {
		super(`bridge already running (pid ${pid})`);
		this.name = "BridgeAlreadyRunningError";
		this.pid = pid;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Dispatch one parsed request to the host, mapping throws/unknown ops to `{ok:false}`. */
async function dispatch(host: ControlHost, raw: unknown): Promise<ControlResponse> {
	if (!isRecord(raw) || typeof raw.op !== "string") return { ok: false, error: "malformed request" };
	try {
		switch (raw.op) {
			case "ping":
				return { ok: true, pid: host.pid };
			case "status":
				return { ok: true, tasks: await host.status() };
			case "park": {
				if (typeof raw.sessionPath !== "string") return { ok: false, error: "park: sessionPath required" };
				const result = await host.park(raw.sessionPath);
				return result.reason === undefined
					? { ok: true, parked: result.parked }
					: { ok: true, parked: result.parked, reason: result.reason };
			}
			case "steer": {
				if (typeof raw.sessionPath !== "string" || typeof raw.text !== "string") {
					return { ok: false, error: "steer: sessionPath and text required" };
				}
				await host.steer(raw.sessionPath, raw.text);
				return { ok: true };
			}
			case "interrupt": {
				if (typeof raw.sessionPath !== "string") return { ok: false, error: "interrupt: sessionPath required" };
				await host.interrupt(raw.sessionPath);
				return { ok: true };
			}
			case "subagents": {
				if (typeof raw.sessionPath !== "string" || raw.sessionPath.length === 0) {
					return { ok: false, error: "subagents: sessionPath required" };
				}
				return { ok: true, subagents: await host.subagents(raw.sessionPath) };
			}
			case "notify": {
				if (
					typeof raw.sessionPath !== "string" ||
					typeof raw.cwd !== "string" ||
					typeof raw.kind !== "string" ||
					typeof raw.text !== "string"
				) {
					return { ok: false, error: "notify: sessionPath, cwd, kind, text required" };
				}
				await host.notify({ sessionPath: raw.sessionPath, cwd: raw.cwd, kind: raw.kind, text: raw.text });
				return { ok: true };
			}
			default:
				return { ok: false, error: `unknown op: ${raw.op}` };
		}
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Per-connection JSONL accumulation state. */
interface ConnState {
	buffer: string;
	decoder: TextDecoder;
	/** Serializes dispatch so pipelined requests answer in arrival order. */
	queue: Promise<void>;
}

/**
 * Bind the control socket and serve requests. Rejects with
 * BridgeAlreadyRunningError if a live bridge answers `ping` on `sockPath`.
 */
export async function startControlServer(sockPath: string, host: ControlHost): Promise<{ stop(): Promise<void> }> {
	await assertSingleInstance(sockPath);

	const handleLine = async (socket: Bun.Socket<ConnState>, line: string): Promise<void> => {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let response: ControlResponse;
		try {
			response = await dispatch(host, JSON.parse(trimmed));
		} catch (err) {
			response = { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		try {
			socket.write(`${JSON.stringify(response)}\n`);
		} catch {
			// peer went away mid-response — never crash the server
		}
	};

	const server = Bun.listen<ConnState>({
		unix: sockPath,
		socket: {
			open(socket) {
				socket.data = { buffer: "", decoder: new TextDecoder(), queue: Promise.resolve() };
			},
			data(socket, chunk) {
				// Streaming decode holds a multibyte char split across chunks.
				socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true });
				let nl = socket.data.buffer.indexOf("\n");
				while (nl !== -1) {
					const line = socket.data.buffer.slice(0, nl);
					socket.data.buffer = socket.data.buffer.slice(nl + 1);
					// Chain onto the per-connection queue: one response per request,
					// emitted in arrival order even when the host resolves out of order.
					socket.data.queue = socket.data.queue.then(() => handleLine(socket, line));
					nl = socket.data.buffer.indexOf("\n");
				}
			},
		},
	});

	return {
		async stop() {
			server.stop(true);
			try {
				await fs.unlink(sockPath);
			} catch {
				// socket file already gone — nothing to do
			}
		},
	};
}

/**
 * One-shot client: connect, write one request line, read one response line, close.
 * Rejects on connect failure, malformed response, early close, or timeout.
 */
export function controlRequest(sockPath: string, req: ControlRequest, timeoutMs = 2000): Promise<ControlResponse> {
	const { promise, resolve, reject } = Promise.withResolvers<ControlResponse>();
	let buffer = "";
	const decoder = new TextDecoder();
	let settled = false;
	let sock: Bun.Socket<undefined> | undefined;

	const finish = (fn: () => void): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		try {
			sock?.end();
		} catch {
			// already closed
		}
		fn();
	};

	const timer = setTimeout(() => {
		finish(() => reject(new Error(`control request timed out after ${timeoutMs}ms`)));
	}, timeoutMs);

	Bun.connect<undefined>({
		unix: sockPath,
		socket: {
			open(socket) {
				try {
					socket.write(`${JSON.stringify(req)}\n`);
				} catch (err) {
					finish(() => reject(err instanceof Error ? err : new Error(String(err))));
				}
			},
			data(_socket, chunk) {
				buffer += decoder.decode(chunk, { stream: true });
				const nl = buffer.indexOf("\n");
				if (nl === -1) return;
				const line = buffer.slice(0, nl);
				try {
					finish(() => resolve(JSON.parse(line) as ControlResponse));
				} catch (err) {
					finish(() => reject(err instanceof Error ? err : new Error(String(err))));
				}
			},
			close() {
				finish(() => reject(new Error("control socket closed before response")));
			},
			error(_socket, err) {
				finish(() => reject(err instanceof Error ? err : new Error(String(err))));
			},
		},
	})
		.then((socket) => {
			// The timeout may have already fired before connect resolved; close the
			// now-orphaned socket instead of leaking it.
			if (settled) {
				try {
					socket.end();
				} catch {
					// already closed
				}
				return;
			}
			sock = socket;
		})
		.catch((err) => {
			finish(() => reject(err instanceof Error ? err : new Error(String(err))));
		});

	return promise;
}

/**
 * Single-instance guard. A valid `ping` pong → BridgeAlreadyRunningError.
 * Any failure (connection refused, timeout, garbage) → treat the socket file as
 * stale, unlink it, and let the caller bind fresh.
 */
async function assertSingleInstance(sockPath: string): Promise<void> {
	let response: ControlResponse;
	try {
		response = await controlRequest(sockPath, { op: "ping" }, PING_PROBE_MS);
	} catch (err) {
		// A connect failure (err.code set: ENOENT/ECONNREFUSED/…) means nothing is
		// listening → the socket file is stale/absent, safe to unlink and rebind.
		// A timeout or early close (plain Error, no code) means something IS
		// listening but slow/foreign — never displace it.
		if (err !== null && typeof err === "object" && "code" in err && typeof err.code === "string") {
			await fs.unlink(sockPath).catch(() => {});
			return;
		}
		throw new BridgeAlreadyRunningError(0);
	}
	if (response.ok && "pid" in response) throw new BridgeAlreadyRunningError(response.pid);
	// Connected and answered, but not our ping contract → occupied; refuse to clobber.
	throw new BridgeAlreadyRunningError(0);
}
