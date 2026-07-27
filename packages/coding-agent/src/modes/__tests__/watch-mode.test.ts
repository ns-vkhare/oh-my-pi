/**
 * Unit tests for the pure seams of `omp --watch`.
 *
 * The TUI itself is out of scope: what is worth pinning is the two decisions the
 * spectator makes before any rendering happens — which file it will tail, and
 * whether a park response clears the way to take the session over. Both are
 * exported precisely so they can be checked without a terminal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { decidePromotion, resolveWatchTarget } from "../watch-mode";

let dir: string;
let sessionFile: string;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompwatch-"));
	sessionFile = path.join(dir, "2026-07-27T00-00-00_abcd.jsonl");
	await fs.writeFile(sessionFile, '{"type":"message"}\n');
});

afterAll(async () => {
	await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveWatchTarget", () => {
	it("resolves an existing session file to an absolute path, dropping the uuid half of the name", () => {
		const target = resolveWatchTarget(sessionFile);
		expect(target).toEqual({ file: sessionFile, name: "2026-07-27T00-00-00" });
	});

	it("resolves a relative path against the process cwd", () => {
		const relative = path.relative(process.cwd(), sessionFile);
		expect(resolveWatchTarget(relative)).toEqual({ file: sessionFile, name: "2026-07-27T00-00-00" });
	});

	it("reports a friendly error for a missing file instead of throwing", () => {
		const target = resolveWatchTarget(path.join(dir, "nope.jsonl"));
		expect(target).toHaveProperty("error");
		expect("error" in target && target.error).toContain("No session file at");
	});

	it("rejects a directory", () => {
		const target = resolveWatchTarget(dir);
		expect("error" in target && target.error).toContain("is not a session file");
	});
});

describe("decidePromotion", () => {
	it("promotes when the bridge parked the task", () => {
		expect(decidePromotion({ parked: true })).toEqual({ promote: true });
	});

	it("promotes when the bridge is unreachable — nothing owns the session", () => {
		expect(decidePromotion(null)).toEqual({ promote: true });
	});

	it("waits, carrying the bridge's reason, when the task refuses to park", () => {
		expect(decidePromotion({ parked: false, reason: "turn in flight" })).toEqual({
			promote: false,
			reason: "turn in flight",
		});
	});

	it("promotes on a reasonless refusal — the bridge does not own this session", () => {
		expect(decidePromotion({ parked: false })).toEqual({ promote: true });
	});

	it("truncates an over-long reason so the header stays one row", () => {
		const decision = decidePromotion({ parked: false, reason: "x".repeat(500) });
		expect(decision.promote).toBe(false);
		expect(decision.promote === false && decision.reason.length).toBe(60);
	});
});
