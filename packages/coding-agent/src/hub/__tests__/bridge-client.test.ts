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
import {
	type BridgeSubagentInfo,
	type BridgeTaskInfo,
	bridgeStatus,
	bridgeSubagents,
	parkBridgeSession,
} from "../bridge-client";

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

	it("drops malformed entries from an otherwise valid array", async () => {
		const keeper: BridgeTaskInfo = {
			sessionPath: "/home/u/.omp/agent/sessions/proj/keep.jsonl",
			threadTs: "1712.0003",
			channel: "D999",
			name: "slack:keeper",
			turnActive: false,
			subagentsRunning: 0,
		};
		const sock = startServer("status-mixed", () => ({
			ok: true,
			tasks: [
				null,
				keeper,
				"not a task",
				{ threadTs: "1712.0004", channel: "D999", name: "slack:no-turn-flag", subagentsRunning: 0 },
			],
		}));

		const tasks = await bridgeStatus(2000, sock);

		expect(tasks).toEqual([keeper]);
		expect(() => tasks?.map(task => task.sessionPath)).not.toThrow();
	});

	it("returns an empty list when every task entry is malformed", async () => {
		const sock = startServer("status-allbad", () => ({ ok: true, tasks: [null, 7, { threadTs: 5 }] }));
		expect(await bridgeStatus(2000, sock)).toEqual([]);
	});

	it("returns null when the task payload is not an array", async () => {
		const sock = startServer("status-notarray", () => ({ ok: true, tasks: { threadTs: "1712.0005" } }));
		expect(await bridgeStatus(2000, sock)).toBeNull();
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
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "busy", reason: "turn in progress" });
	});

	it("reports a successful park", async () => {
		const sock = startServer("park-ok", () => ({ ok: true, parked: true }));
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "parked" });
	});

	it("reports a reasonless refusal as a session the bridge does not drive", async () => {
		const sock = startServer("park-unowned", () => ({ ok: true, parked: false }));
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "not-owned" });
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

/**
 * The distinction the ownership paths depend on: a daemon that is *gone* frees
 * the session, a daemon that merely failed to answer does not. Collapsing them
 * is how `omp --resume` used to attach on top of a live Slack task.
 */
describe("parkBridgeSession failure modes", () => {
	it("reports `absent` when the socket file does not exist", async () => {
		const missing = path.join(sockDir, "absent.sock");
		expect(await parkBridgeSession("/s/a.jsonl", 2000, missing)).toEqual({ kind: "absent" });
	});

	it("reports `indeterminate` when a live daemon never answers", async () => {
		const sock = startServer("park-silent", () => undefined);
		expect(await parkBridgeSession("/s/a.jsonl", 50, sock)).toEqual({ kind: "indeterminate" });
	});

	it("reports `indeterminate` on a garbage response line", async () => {
		const sock = startServer("park-garbage", () => "not json at all");
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "indeterminate" });
	});

	it("reports `indeterminate` when the daemon answers with an error", async () => {
		const sock = startServer("park-error", () => ({ ok: false, error: "boom" }));
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "indeterminate" });
	});

	it("reports `indeterminate` when the daemon answers a bare JSON primitive", async () => {
		const sock = startServer("park-primitive", () => null);
		expect(await parkBridgeSession("/s/a.jsonl", 2000, sock)).toEqual({ kind: "indeterminate" });
	});
});

describe("bridgeSubagents", () => {
	it("parses the subagent list and echoes the requested session path", async () => {
		const subagents: BridgeSubagentInfo[] = [
			{
				id: "Scout",
				agent: "scout",
				status: "running",
				task: "map the repo",
				sessionFile: "/s/a/Scout.jsonl",
				lastUpdate: 1712000000000,
			},
			{ id: "Writer", agent: "task", status: "completed", lastUpdate: 1712000000001 },
		];
		let seen: unknown;
		const sock = startServer("subs-ok", req => {
			seen = req;
			return { ok: true, subagents };
		});

		expect(await bridgeSubagents("/s/a.jsonl", 2000, sock)).toEqual(subagents);
		expect(seen).toEqual({ op: "subagents", sessionPath: "/s/a.jsonl" });
	});

	it("drops malformed entries from an otherwise valid array", async () => {
		const sock = startServer("subs-mixed", () => ({
			ok: true,
			subagents: [
				{ id: "Keeper", agent: 7, status: null, task: "", sessionFile: "/s/k.jsonl", lastUpdate: Number.NaN },
				{ agent: "task", status: "running", lastUpdate: 1 },
				null,
				"junk",
				42,
			],
		}));

		expect(await bridgeSubagents("/s/a.jsonl", 2000, sock)).toEqual([
			{ id: "Keeper", agent: "", status: "unknown", sessionFile: "/s/k.jsonl", lastUpdate: 0 },
		]);
	});

	it("returns null when the bridge refuses the op", async () => {
		const sock = startServer("subs-err", () => ({ ok: false, error: "session not live under the bridge" }));
		expect(await bridgeSubagents("/s/a.jsonl", 2000, sock)).toBeNull();
	});

	it("returns null when the payload is not an array", async () => {
		const sock = startServer("subs-notarray", () => ({ ok: true, subagents: { id: "Scout" } }));
		expect(await bridgeSubagents("/s/a.jsonl", 2000, sock)).toBeNull();
	});

	// `null` is valid JSON but not a response: the never-throw contract must hold
	// for it exactly as it does for an unparseable line.
	it("returns null when the bridge answers a bare JSON primitive", async () => {
		const sock = startServer("subs-primitive", () => null);
		expect(await bridgeSubagents("/s/a.jsonl", 2000, sock)).toBeNull();
	});

	it("returns null when no socket exists", async () => {
		expect(await bridgeSubagents("/s/a.jsonl", 2000, path.join(sockDir, "absent.sock"))).toBeNull();
	});
});

describe("unreachable bridge", () => {
	it("returns null from bridgeStatus when the socket file does not exist", async () => {
		const missing = path.join(sockDir, "absent.sock");
		expect(await bridgeStatus(2000, missing)).toBeNull();
	});

	it("returns null within the timeout when the daemon accepts but never replies", async () => {
		const sock = startServer("silent", () => undefined);
		const started = Bun.nanoseconds();

		expect(await bridgeStatus(50, sock)).toBeNull();

		// Bounded by the caller's timeout, not by the socket staying open.
		expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(2000);
	});
});
