/**
 * Unit tests for the pure seams of `omp --watch`.
 *
 * The TUI itself is out of scope: what is worth pinning is the decisions the
 * spectator makes before any rendering happens — which file it will tail,
 * whether a park response clears the way to take the session over, and how
 * bridge-delivered text is fitted into a header row. All three are exported
 * precisely so they can be checked without a terminal.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ParkOutcome } from "@oh-my-pi/pi-coding-agent/hub/bridge-client";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { acquireOwnership, decidePromotion, headerCell, type OwnershipDeps, resolveWatchTarget } from "../watch-mode";

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
		expect(decidePromotion({ kind: "parked" })).toEqual({ promote: true });
	});

	it("promotes when no daemon exists — nothing is holding the session", () => {
		expect(decidePromotion({ kind: "absent" })).toEqual({ promote: true });
	});

	it("promotes when the bridge answers that it does not drive this session", () => {
		expect(decidePromotion({ kind: "not-owned" })).toEqual({ promote: true });
	});

	it("waits, carrying the bridge's reason, when the task refuses to park", () => {
		expect(decidePromotion({ kind: "busy", reason: "turn in flight" })).toEqual({
			promote: false,
			reason: "turn in flight",
		});
	});

	it("FAILS CLOSED on an unanswered park — a live daemon may be mid-park", () => {
		expect(decidePromotion({ kind: "indeterminate" })).toEqual({
			promote: false,
			reason: "bridge unresponsive",
		});
	});

	it("carries the bridge's reason verbatim — fitting it to a row is the renderer's job", () => {
		const decision = decidePromotion({ kind: "busy", reason: "x".repeat(500) });
		expect(decision.promote === false && decision.reason.length).toBe(500);
	});
});

/**
 * `park` is a command, not a query: the bridge stops its RPC child and posts a
 * Slack handoff note *before* answering. The protocol below therefore has to be
 * asymmetric — cancellation may drop a refusal, but never a completed park.
 *
 * Time is injected, so none of this waits on a real clock.
 */
describe("acquireOwnership", () => {
	/** Deps that never cancel and never really sleep. */
	function deps(overrides: Partial<OwnershipDeps> = {}): OwnershipDeps & { waits: string[] } {
		const waits: string[] = [];
		return {
			waits,
			cancelled: () => false,
			onWait: reason => waits.push(reason),
			sleep: async () => {},
			...overrides,
		};
	}

	it("promotes as soon as the bridge parks the task", async () => {
		const d = deps();
		expect(await acquireOwnership(async () => ({ kind: "parked" }), d)).toBe("promote");
		expect(d.waits).toEqual([]);
	});

	it("honours a park that landed while the user was cancelling", async () => {
		// Esc pressed mid-flight: the bridge has already stopped the owner, so
		// reporting "cancelled" would strand a session nobody holds.
		const d = deps({ cancelled: () => true });
		expect(await acquireOwnership(async () => ({ kind: "parked" }), d)).toBe("promote");
	});

	it("reports cancellation when the attempt that raced it parked nothing", async () => {
		const d = deps({ cancelled: () => true });
		expect(await acquireOwnership(async () => ({ kind: "busy", reason: "turn active" }), d)).toBe("cancelled");
		expect(d.waits).toEqual([]);
	});

	it("retries a busy task, surfacing each reason, until it parks", async () => {
		const answers: ParkOutcome[] = [
			{ kind: "busy", reason: "turn active" },
			{ kind: "busy", reason: "2 subagents running" },
			{ kind: "parked" },
		];
		const d = deps();
		expect(await acquireOwnership(async () => answers.shift() ?? { kind: "parked" }, d)).toBe("promote");
		expect(d.waits).toEqual(["turn active", "2 subagents running"]);
	});

	it("keeps retrying an unresponsive bridge instead of attaching on a guess", async () => {
		let attempts = 0;
		const d = deps({
			// Give up after the third attempt so the loop terminates.
			cancelled: () => attempts >= 3,
		});
		const result = await acquireOwnership(async () => {
			attempts++;
			return { kind: "indeterminate" };
		}, d);
		expect(result).toBe("cancelled");
		// Three parks attempted; the third is cancelled the moment it returns, so
		// only the first two ever reach the wait leg.
		expect(attempts).toBe(3);
		expect(d.waits).toEqual(["bridge unresponsive", "bridge unresponsive"]);
	});

	it("promotes without waiting when no daemon is there to hold the session", async () => {
		const d = deps();
		expect(await acquireOwnership(async () => ({ kind: "absent" }), d)).toBe("promote");
		expect(await acquireOwnership(async () => ({ kind: "not-owned" }), d)).toBe("promote");
		expect(d.waits).toEqual([]);
	});
});

/**
 * The bridge hands over arbitrary remote strings: a Slack task name is the head
 * of a user's message, and a park reason is daemon-authored text. `bridgeStatus`
 * validates the wire shape, never the content, and the TUI's own line prep only
 * clamps width — a newline still costs the frame an unaccounted row and a raw
 * ESC still reaches the terminal. So the fitting has to happen here.
 */
describe("headerCell", () => {
	it("collapses newlines so one header line stays one terminal row", () => {
		expect(headerCell("evil\nINJECTED ROW")).toBe("evil INJECTED ROW");
		expect(headerCell("a\r\nb").split("\n")).toHaveLength(1);
	});

	it("replaces tabs, which would otherwise drift the columns", () => {
		expect(headerCell("a\tb")).not.toContain("\t");
	});

	it("strips control sequences instead of writing them to the terminal", () => {
		const fitted = headerCell("x\u001b[2Jy\u0007");
		expect(fitted).toBe("xy");
	});

	it("truncates by display columns, not code units, so wide glyphs still fit", () => {
		expect(visibleWidth(headerCell("あ".repeat(200)))).toBeLessThanOrEqual(60);
		expect(visibleWidth(headerCell("x".repeat(200)))).toBeLessThanOrEqual(60);
	});

	it("leaves ordinary names untouched", () => {
		expect(headerCell("2026-07-27T06-39-07-655Z")).toBe("2026-07-27T06-39-07-655Z");
	});
});
