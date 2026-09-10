/**
 * Control-plane socket tests (hermetic — real Unix sockets in /tmp, fake host).
 *
 * Covers: ping, status round-trip, park busy/quiescent/not-live semantics,
 * unknown op, single-instance (live reject + stale-file rebind), client timeout.
 */

import { afterEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { BridgeAlreadyRunningError, type ControlHost, controlRequest, startControlServer } from "./control";
import type { ControlRequest, ControlSubagentInfo, ControlTaskInfo } from "./types";

let counter = 0;
function sockPath(): string {
	// Short path — macOS caps unix socket paths at ~104 bytes.
	return `/tmp/omp-ctl-${process.pid}-${++counter}.sock`;
}

/** Records every dispatched call; park return value is test-controlled. */
class FakeHost implements ControlHost {
	pid = 4242;
	tasks: ControlTaskInfo[] = [];
	subagentList: ControlSubagentInfo[] = [];
	parkResult: { parked: boolean; reason?: string } = { parked: true };
	readonly calls: string[] = [];
	parkedWith?: string;
	steeredWith?: { sessionPath: string; text: string };
	subagentsFor?: string;
	interruptedWith?: string;
	notifiedWith?: { sessionPath: string; cwd: string; kind: string; text: string };

	async status(): Promise<ControlTaskInfo[]> {
		this.calls.push("status");
		return this.tasks;
	}
	async park(sessionPath: string): Promise<{ parked: boolean; reason?: string }> {
		this.calls.push("park");
		this.parkedWith = sessionPath;
		return this.parkResult;
	}
	async steer(sessionPath: string, text: string): Promise<void> {
		this.calls.push("steer");
		this.steeredWith = { sessionPath, text };
	}
	async interrupt(sessionPath: string): Promise<void> {
		this.calls.push("interrupt");
		this.interruptedWith = sessionPath;
	}
	async subagents(sessionPath: string): Promise<ControlSubagentInfo[]> {
		this.calls.push("subagents");
		this.subagentsFor = sessionPath;
		return this.subagentList;
	}
	async notify(event: { sessionPath: string; cwd: string; kind: string; text: string }): Promise<void> {
		this.calls.push("notify");
		this.notifiedWith = event;
	}
}

const servers: Array<{ stop(): Promise<void> }> = [];
const extraPaths: string[] = [];
function track<T extends { stop(): Promise<void> }>(srv: T): T {
	servers.push(srv);
	return srv;
}

afterEach(async () => {
	while (servers.length) await servers.pop()?.stop().catch(() => {});
	while (extraPaths.length) await unlink(extraPaths.pop()!).catch(() => {});
});

test("ping returns ok and the host pid", async () => {
	const p = sockPath();
	const host = new FakeHost();
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "ping" })).toEqual({ ok: true, pid: 4242 });
});

test("status round-trips one task", async () => {
	const p = sockPath();
	const host = new FakeHost();
	const info: ControlTaskInfo = {
		sessionPath: "/s/x.jsonl",
		threadTs: "t1",
		channel: "C1",
		name: "task one",
		turnActive: true,
		subagentsRunning: 2,
	};
	host.tasks = [info];
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "status" })).toEqual({ ok: true, tasks: [info] });
});

test("park: quiescent → parked true, no reason", async () => {
	const p = sockPath();
	const host = new FakeHost();
	host.parkResult = { parked: true };
	track(await startControlServer(p, host));
	const res = await controlRequest(p, { op: "park", sessionPath: "/s/x.jsonl" });
	expect(res).toEqual({ ok: true, parked: true });
	expect(host.parkedWith).toBe("/s/x.jsonl");
});

test("park: busy → parked false with reason", async () => {
	const p = sockPath();
	const host = new FakeHost();
	host.parkResult = { parked: false, reason: "busy: turn active" };
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "park", sessionPath: "/s/x.jsonl" })).toEqual({
		ok: true,
		parked: false,
		reason: "busy: turn active",
	});
});

test("park: not-live → parked false, no reason", async () => {
	const p = sockPath();
	const host = new FakeHost();
	host.parkResult = { parked: false };
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "park", sessionPath: "/s/x.jsonl" })).toEqual({ ok: true, parked: false });
});

test("steer and interrupt dispatch to the host", async () => {
	const p = sockPath();
	const host = new FakeHost();
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "steer", sessionPath: "/s/x.jsonl", text: "go" })).toEqual({ ok: true });
	expect(host.steeredWith).toEqual({ sessionPath: "/s/x.jsonl", text: "go" });
	expect(await controlRequest(p, { op: "interrupt", sessionPath: "/s/x.jsonl" })).toEqual({ ok: true });
	expect(host.interruptedWith).toBe("/s/x.jsonl");
});

test("subagents round-trips the host's list", async () => {
	const p = sockPath();
	const host = new FakeHost();
	host.subagentList = [
		{ id: "Scout", agent: "scout", status: "running", task: "map the repo", sessionFile: "/s/scout.jsonl", lastUpdate: 42 },
		{ id: "Writer", agent: "task", status: "completed", lastUpdate: 43 },
	];
	track(await startControlServer(p, host));
	expect(await controlRequest(p, { op: "subagents", sessionPath: "/s/x.jsonl" })).toEqual({
		ok: true,
		subagents: host.subagentList,
	});
	expect(host.subagentsFor).toBe("/s/x.jsonl");
});

test("subagents: a blank sessionPath is refused without reaching the host", async () => {
	const p = sockPath();
	const host = new FakeHost();
	track(await startControlServer(p, host));
	const blank = await controlRequest(p, { op: "subagents", sessionPath: "" });
	expect(blank.ok).toBe(false);
	const missing = await controlRequest(p, { op: "subagents" } as unknown as ControlRequest);
	expect(missing.ok).toBe(false);
	expect(host.calls).not.toContain("subagents");
});

test("unknown op → ok:false", async () => {
	const p = sockPath();
	track(await startControlServer(p, new FakeHost()));
	const res = await controlRequest(p, { op: "bogus" } as unknown as ControlRequest);
	expect(res.ok).toBe(false);
	if (!res.ok) expect(res.error).toContain("unknown op");
});

test("host throw → ok:false, server survives", async () => {
	const p = sockPath();
	const host = new FakeHost();
	host.park = async () => {
		throw new Error("boom");
	};
	track(await startControlServer(p, host));
	const res = await controlRequest(p, { op: "park", sessionPath: "/s/x.jsonl" });
	expect(res).toEqual({ ok: false, error: "boom" });
	// Server still answering after a handler throw.
	expect(await controlRequest(p, { op: "ping" })).toEqual({ ok: true, pid: 4242 });
});

test("single-instance: a live server rejects the second start", async () => {
	const p = sockPath();
	track(await startControlServer(p, new FakeHost()));
	let caught: unknown;
	try {
		await startControlServer(p, new FakeHost());
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(BridgeAlreadyRunningError);
	expect((caught as BridgeAlreadyRunningError).pid).toBe(4242);
});

test("single-instance: a stale socket file is unlinked and rebound", async () => {
	const p = sockPath();
	await Bun.write(p, "stale"); // leftover file, nothing listening
	track(await startControlServer(p, new FakeHost()));
	expect(await controlRequest(p, { op: "ping" })).toEqual({ ok: true, pid: 4242 });
});

test("controlRequest times out when the server never responds", async () => {
	const p = sockPath();
	extraPaths.push(p);
	const silent = Bun.listen<undefined>({
		unix: p,
		socket: { open() {}, data() {} }, // accept, never reply
	});
	try {
		await expect(controlRequest(p, { op: "ping" }, 200)).rejects.toThrow(/timed out/);
	} finally {
		silent.stop(true);
	}
});

test("single-instance: a slow-but-live server is detected, not displaced", async () => {
	// A live listener that answers ping slower than the probe window: must NOT be
	// unlinked/rebound (regression — a busy bridge would otherwise be clobbered).
	const p = sockPath();
	const live = Bun.listen<{ b: string }>({
		unix: p,
		socket: {
			open(s) {
				s.data = { b: "" };
			},
			data(s, chunk) {
				s.data.b += chunk.toString();
				if (s.data.b.includes("\n")) {
					// Real timer (rule exception): the probe under test uses a real
					// setTimeout over live socket I/O; fake timers can't drive it. 800ms
					// comfortably clears the 500ms PING_PROBE_MS window.
					setTimeout(() => {
						try {
							s.write(`${JSON.stringify({ ok: true, pid: 9999 })}\n`);
						} catch {
							// peer gone
						}
					}, 800);
				}
			},
		},
	});
	let caught: unknown;
	try {
		track(await startControlServer(p, new FakeHost()));
	} catch (err) {
		caught = err;
	} finally {
		live.stop(true);
	}
	expect(caught).toBeInstanceOf(BridgeAlreadyRunningError);
});

test("a multibyte char split across chunks reaches the host intact", async () => {
	// Regression: per-chunk toString() mangled a 3-byte char split at a chunk
	// boundary; streaming TextDecoder must hold the partial byte.
	const p = sockPath();
	const host = new FakeHost();
	track(await startControlServer(p, host));
	const req = { op: "notify", sessionPath: "/s.jsonl", cwd: "/c", kind: "turn_end", text: "cost 5€ done" };
	const full = Buffer.from(`${JSON.stringify(req)}\n`, "utf8");
	const euro = full.indexOf(0xe2); // first byte of the 3-byte "€"
	const resp = await new Promise<Record<string, unknown>>((resolve) => {
		let buf = "";
		Bun.connect<undefined>({
			unix: p,
			socket: {
				open(s) {
					s.write(full.subarray(0, euro + 1)); // ends mid-€
					// Real timer (rule exception): a tick gap forces the server to see
					// two distinct `data` events — the split that triggered the bug.
					setTimeout(() => s.write(full.subarray(euro + 1)), 20);
				},
				data(_s, chunk) {
					buf += chunk.toString();
					const nl = buf.indexOf("\n");
					if (nl !== -1) resolve(JSON.parse(buf.slice(0, nl)));
				},
			},
		});
	});
	expect(resp).toEqual({ ok: true });
	expect(host.notifiedWith?.text).toBe("cost 5€ done");
});

test("pipelined requests answer in arrival order", async () => {
	// Regression: `void handleLine` dispatched pipelined requests concurrently, so
	// a fast 2nd request could answer before a slow 1st — positional correlation
	// broken. park is delayed by a fixed microtask chain (deterministic, no wall
	// clock); ping is instant. The per-connection queue must still emit park first.
	const p = sockPath();
	const host = new FakeHost();
	host.park = async () => {
		for (let i = 0; i < 50; i++) await Promise.resolve(); // slower than instant ping
		return { parked: true };
	};
	track(await startControlServer(p, host));
	const order = await new Promise<string[]>((resolve) => {
		const seen: string[] = [];
		let buf = "";
		Bun.connect<undefined>({
			unix: p,
			socket: {
				open(s) {
					s.write(`${JSON.stringify({ op: "park", sessionPath: "/s" })}\n${JSON.stringify({ op: "ping" })}\n`);
				},
				data(_s, chunk) {
					buf += chunk.toString();
					let nl = buf.indexOf("\n");
					while (nl !== -1) {
						const line = buf.slice(0, nl);
						seen.push(line.includes("parked") ? "park" : line.includes("pid") ? "ping" : "?");
						buf = buf.slice(nl + 1);
						nl = buf.indexOf("\n");
						if (seen.length === 2) resolve(seen);
					}
				},
			},
		});
	});
	expect(order).toEqual(["park", "ping"]);
});
