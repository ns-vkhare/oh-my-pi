/**
 * Contract tests for the Slack bridge control-socket client.
 *
 * The bridge is optional infrastructure, so the client's promise is narrow but
 * absolute: a well-formed reply is parsed, and *every* other outcome (no socket
 * file, a daemon that never answers, a garbage line) resolves to `null` without
 * throwing. Each case runs against a real Unix-socket JSONL server started
 * in-process — no module mocking, no dependency on a live bridge.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type BridgeTaskInfo, bridgeStatus, parkBridgeSession } from "../bridge-client";

let sockDir: string;
const servers: Bun.UnixSocketListener<undefined>[] = [];

/**
 * Bind a JSONL control server that answers each request line with `reply(req)`.
 * `reply` returning undefined means "accept, never answer" (hang simulation).
 */
function startServer(name: string, reply: (req: { op: string }) => unknown): string {
	const unix = path.join(sockDir, `${name}.sock`);
	servers.push(
		Bun.listen<undefined>({
			unix,
			socket: {
				data(socket, chunk) {
					for (const line of chunk.toString().split("\n")) {
						if (!line.trim()) continue;
						const response = reply(JSON.parse(line) as { op: string });
						if (response === undefined) continue;
						socket.write(typeof response === "string" ? `${response}\n` : `${JSON.stringify(response)}\n`);
					}
				},
			},
		}),
	);
	return unix;
}

beforeAll(async () => {
	// Short tmp path: Unix socket paths are capped near 104 bytes on darwin.
	sockDir = await fs.mkdtemp(path.join(os.tmpdir(), "ompbc-"));
});

afterAll(async () => {
	for (const server of servers) server.stop(true);
	await fs.rm(sockDir, { recursive: true, force: true });
});

describe("bridgeStatus", () => {
	it("parses the live task list", async () => {
		const task: BridgeTaskInfo = {
			sessionPath: "/home/u/.omp/agent/sessions/proj/a.jsonl",
			threadTs: "1712.0001",
			channel: "D123",
			name: "slack:fix-login",
			turnActive: true,
			subagentsRunning: 2,
		};
		// Mid-startup task: the bridge has no session file for it yet.
		const pending: BridgeTaskInfo = {
			threadTs: "1712.0002",
			channel: "D123",
			name: "slack:new-task",
			turnActive: false,
			subagentsRunning: 0,
		};
		const sock = startServer("status-ok", () => ({ ok: true, tasks: [task, pending] }));

		const tasks = await bridgeStatus(2000, sock);

		expect(tasks).toEqual([task, pending]);
		expect(tasks?.[1]?.sessionPath).toBeUndefined();
	});

	it("returns null when the bridge answers with an error", async () => {
		const sock = startServer("status-err", () => ({ ok: false, error: "registry unavailable" }));
		expect(await bridgeStatus(2000, sock)).toBeNull();
	});

	it("returns null on a garbage response line", async () => {
		const sock = startServer("status-garbage", () => "not json {");
		expect(await bridgeStatus(2000, sock)).toBeNull();
	});
});

describe("parkBridgeSession", () => {
	it("reports a busy Slack session with its reason", async () => {
		const sock = startServer("park-busy", () => ({ ok: true, parked: false, reason: "turn in progress" }));
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ parked: false, reason: "turn in progress" });
	});

	it("reports a successful park without a reason", async () => {
		const sock = startServer("park-ok", () => ({ ok: true, parked: true }));
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ parked: true });
	});

	it("sends the session path the caller asked to park", async () => {
		let seen: unknown;
		const sock = startServer("park-echo", req => {
			seen = req;
			return { ok: true, parked: true };
		});

		await parkBridgeSession("/s/echo.jsonl", 2000, sock);

		expect(seen).toEqual({ op: "park", sessionPath: "/s/echo.jsonl" });
	});
});

describe("unreachable bridge", () => {
	it("returns null when the socket file does not exist", async () => {
		const missing = path.join(sockDir, "absent.sock");
		expect(await bridgeStatus(2000, missing)).toBeNull();
		expect(await parkBridgeSession("/s/a.jsonl", 2000, missing)).toBeNull();
	});

	it("returns null within the timeout when the daemon accepts but never replies", async () => {
		const sock = startServer("silent", () => undefined);
		const started = Bun.nanoseconds();

		expect(await bridgeStatus(50, sock)).toBeNull();

		// Bounded by the caller's timeout, not by the socket staying open.
		expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(2000);
	});
});
