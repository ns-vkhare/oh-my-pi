import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	CURRENT_SESSION_VERSION,
	type SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Contract behind nested subagent lineage: a spawned subagent opens its own
// (new, empty) transcript with the parent's file path AND its registry id, and
// both must land on the synthesized session header — `parentSession` (so a
// consumer can nest the child under its parent) and `agentId` (the spawn-vs-fork
// discriminator a consumer keys on to distinguish a spawned sub-agent from a
// `/fork` child, which carries parentSession but no agentId). Resuming an
// existing transcript must NOT rewrite its recorded header.
describe("SessionManager.open parentSession + agentId", () => {
	it("records parentSession and agentId on a new/empty child transcript header", async () => {
		using tempDir = TempDir.createSync("@omp-parent-session-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const parentFile = path.join(sessionDir, "parent.jsonl");
		const childFile = path.join(sessionDir, "child.jsonl");

		const manager = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
			parentSession: parentFile,
			agentId: "ProbeAgent",
		});

		// In-memory view exposes both immediately (what a live session_start reads).
		expect(manager.getHeader()?.parentSession).toBe(parentFile);
		expect(manager.getHeader()?.agentId).toBe("ProbeAgent");

		// And both are persisted to the header line on disk.
		const entries = await loadEntriesFromFile(childFile);
		const header = entries.find((e): e is SessionHeader => e.type === "session");
		expect(header?.parentSession).toBe(parentFile);
		expect(header?.agentId).toBe("ProbeAgent");
	});

	it("leaves agentId undefined for a fork-shape open (parentSession, no agentId)", async () => {
		using tempDir = TempDir.createSync("@omp-fork-shape-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const parentFile = path.join(sessionDir, "parent.jsonl");
		const childFile = path.join(sessionDir, "fork-child.jsonl");

		// A fork writes parentSession but no agentId — must stay agentId-less so a
		// consumer treats it as an independent session, not a nested sub-agent.
		const manager = await SessionManager.open(childFile, undefined, undefined, {
			initialCwd: tempDir.path(),
			suppressBreadcrumb: true,
			parentSession: parentFile,
		});

		expect(manager.getHeader()?.parentSession).toBe(parentFile);
		expect(manager.getHeader()?.agentId).toBeUndefined();
	});

	it("does not clobber the recorded header when resuming an existing transcript", async () => {
		using tempDir = TempDir.createSync("@omp-parent-session-resume-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		await fs.mkdir(sessionDir, { recursive: true });
		const existingFile = path.join(sessionDir, "existing.jsonl");

		// A pre-existing top-level session (no parent).
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "existing-session",
			timestamp: new Date().toISOString(),
			cwd: tempDir.path(),
		};
		await Bun.write(existingFile, `${JSON.stringify(header)}\n`);

		// Reopening with a parentSession must be ignored — the file already has a
		// header, so its recorded (absent) parentage wins. This is the revive path.
		const manager = await SessionManager.open(existingFile, undefined, undefined, {
			suppressBreadcrumb: true,
			parentSession: path.join(sessionDir, "some-parent.jsonl"),
		});

		expect(manager.getHeader()?.id).toBe("existing-session");
		expect(manager.getHeader()?.parentSession).toBeUndefined();
	});
});
