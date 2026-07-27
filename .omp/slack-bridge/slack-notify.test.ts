/**
 * Hermetic tests for the slack-notify extension's pure logic.
 *
 * The socket path is passed explicitly to the exported helpers (no env / no
 * global override), so each test points sendNotify/notify at its own temp
 * socket served by an in-test JSONL collector.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "bun";
import { buildNotifyPayload, notify, sendNotify, shouldNotify } from "./slack-notify.extension";
import type { NotifyRequest } from "./slack-notify.extension";

/** A unix-socket server that collects newline-delimited JSON requests. */
interface Collector {
	path: string;
	received: NotifyRequest[];
	/** Resolves once at least `n` lines have arrived. */
	waitFor(n: number): Promise<void>;
	stop(): void;
}

function startCollector(): Collector {
	const dir = mkdtempSync(join(tmpdir(), "slack-notify-"));
	const path = join(dir, "bridge.sock");
	const received: NotifyRequest[] = [];
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	const flush = () => {
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i]!;
			if (received.length >= w.n) {
				w.resolve();
				waiters.splice(i, 1);
			}
		}
	};
	let buf = "";
	const server = Bun.listen({
		unix: path,
		socket: {
			data(_sock: Socket<undefined>, chunk: Buffer) {
				buf += chunk.toString();
				let nl: number;
				while ((nl = buf.indexOf("\n")) >= 0) {
					const line = buf.slice(0, nl);
					buf = buf.slice(nl + 1);
					if (line.trim()) received.push(JSON.parse(line) as NotifyRequest);
				}
				flush();
			},
			open() {},
			close() {},
			error() {},
		},
	});
	return {
		path,
		received,
		waitFor(n: number) {
			if (received.length >= n) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ n, resolve });
			return promise;
		},
		stop() {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

let collector: Collector | undefined;
afterEach(() => {
	collector?.stop();
	collector = undefined;
});

describe("buildNotifyPayload", () => {
	test("turn_end embeds session name and head of last text", () => {
		const payload = buildNotifyPayload({
			sessionPath: "/s/a.jsonl",
			cwd: "/repo",
			name: "fix auth",
			kind: "turn_end",
			lastText: "Done: patched the login flow.",
		});
		expect(payload).toEqual({
			op: "notify",
			sessionPath: "/s/a.jsonl",
			cwd: "/repo",
			kind: "turn_end",
			text: "✅ fix auth: turn finished — Done: patched the login flow.",
		});
	});

	test("turn_end falls back to cwd basename when unnamed", () => {
		const payload = buildNotifyPayload({ sessionPath: "/s/a.jsonl", cwd: "/home/me/repo", kind: "turn_end" });
		expect(payload.text).toBe("✅ repo: turn finished");
	});

	test("turn_end truncates long assistant text to 200 chars of body", () => {
		const long = "x".repeat(500);
		const payload = buildNotifyPayload({ sessionPath: "/s/a.jsonl", cwd: "/r", name: "n", kind: "turn_end", lastText: long });
		const body = payload.text.split("— ")[1]!;
		expect(body.length).toBe(200);
	});

	test("ask_pending embeds the question head", () => {
		const payload = buildNotifyPayload({
			sessionPath: "/s/a.jsonl",
			cwd: "/repo",
			name: "n",
			kind: "ask_pending",
			question: "Which database should I use?",
		});
		expect(payload.kind).toBe("ask_pending");
		expect(payload.text).toBe("❓ waiting on input: Which database should I use?");
	});
});

describe("sendNotify", () => {
	test("delivers one JSONL line to a live socket", async () => {
		collector = startCollector();
		const payload = buildNotifyPayload({ sessionPath: "/s/a.jsonl", cwd: "/r", name: "n", kind: "turn_end", lastText: "ok" });
		const ok = await sendNotify(collector.path, payload);
		expect(ok).toBe(true);
		await collector.waitFor(1);
		expect(collector.received).toEqual([payload]);
	});

	test("silent no-op (resolves false) when the socket is absent", async () => {
		const missing = join(mkdtempSync(join(tmpdir(), "slack-notify-none-")), "bridge.sock");
		const payload = buildNotifyPayload({ sessionPath: "/s/a.jsonl", cwd: "/r", kind: "turn_end" });
		const ok = await sendNotify(missing, payload);
		expect(ok).toBe(false);
	});
});

describe("notify debounce", () => {
	test("suppresses a second notify within the window, allows it after", async () => {
		collector = startCollector();
		const path = "/uniq/debounce-a.jsonl";
		const base = 1_000_000;
		const first = await notify(collector.path, { sessionPath: path, cwd: "/r", kind: "turn_end", lastText: "1" }, base);
		const second = await notify(collector.path, { sessionPath: path, cwd: "/r", kind: "turn_end", lastText: "2" }, base + 5_000);
		const third = await notify(collector.path, { sessionPath: path, cwd: "/r", kind: "turn_end", lastText: "3" }, base + 40_000);
		expect(first).toBe(true);
		expect(second).toBe(false);
		expect(third).toBe(true);
		await collector.waitFor(2);
		expect(collector.received.map(r => r.text.endsWith("1") || r.text.endsWith("3"))).toEqual([true, true]);
	});

	test("different kinds debounce independently", () => {
		const path = "/uniq/debounce-b.jsonl";
		const base = 2_000_000;
		expect(shouldNotify(path, "turn_end", base)).toBe(true);
		expect(shouldNotify(path, "ask_pending", base)).toBe(true);
		expect(shouldNotify(path, "turn_end", base + 1_000)).toBe(false);
	});
});
