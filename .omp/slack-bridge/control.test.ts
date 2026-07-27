/**
 * Control-plane socket tests (hermetic — real Unix sockets in /tmp, fake host).
 *
 * Covers: ping, status round-trip, park busy/quiescent/not-live semantics,
 * unknown op, single-instance (live reject + stale-file rebind), client timeout.
 */

import { afterEach, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { BridgeAlreadyRunningError, type ControlHost, controlRequest, startControlServer } from "./control";
import type { ControlRequest, ControlTaskInfo } from "./types";

let counter = 0;
function sockPath(): string {
	// Short path — macOS caps unix socket paths at ~104 bytes.
	return `/tmp/omp-ctl-${process.pid}-${++counter}.sock`;
}

/** Records every dispatched call; park return value is test-controlled. */
class FakeHost implements ControlHost {
	pid = 4242;
	tasks: ControlTaskInfo[] = [];
	parkResult: { parked: boolean; reason?: string } = { parked: true };
	readonly calls: string[] = [];
	parkedWith?: string;
	steeredWith?: { sessionPath: string; text: string };
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
