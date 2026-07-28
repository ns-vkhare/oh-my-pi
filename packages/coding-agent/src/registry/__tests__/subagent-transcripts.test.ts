import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SubagentTranscript, scanSubagentTranscripts } from "../subagent-transcripts";

const BETA_CONTENT = '{"role":"user","content":"beta"}\n';

let tempRoot: string;
let sessionFile: string;
let scanRoot: string;
let found: SubagentTranscript[];

function byId(id: string): SubagentTranscript {
	const entry = found.find(candidate => candidate.id === id);
	if (!entry) throw new Error(`no scanned transcript with id ${id}`);
	return entry;
}

beforeAll(async () => {
	tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-scan-"));
	sessionFile = path.join(tempRoot, "session.jsonl");
	scanRoot = path.join(tempRoot, "session");
	await Bun.write(sessionFile, "{}\n");
	await fs.mkdir(path.join(scanRoot, "Alpha"), { recursive: true });
	await fs.mkdir(path.join(scanRoot, "Ghost.jsonl"), { recursive: true });
	await Bun.write(path.join(scanRoot, "Alpha.jsonl"), "{}\n");
	await Bun.write(path.join(scanRoot, "__advisor.jsonl"), "{}\n");
	await Bun.write(path.join(scanRoot, "Stale.bak.jsonl"), "{}\n");
	await Bun.write(path.join(scanRoot, "notes.txt"), "not a transcript");
	await Bun.write(path.join(scanRoot, "Alpha", "Beta.jsonl"), BETA_CONTENT);
	await Bun.write(path.join(scanRoot, "Alpha", "__advisor.review.jsonl"), "{}\n");
	found = await scanSubagentTranscripts(sessionFile);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("scanSubagentTranscripts", () => {
	it("walks nested subagent transcripts depth-first, parents before children", () => {
		const subs = found.filter(entry => entry.kind === "sub");
		expect(subs.map(entry => entry.id)).toEqual(["Alpha", "Beta"]);
		expect(subs[0]).toMatchObject({
			displayName: "Alpha",
			parentId: "Main",
			depth: 1,
			sessionFile: path.join(scanRoot, "Alpha.jsonl"),
		});
		expect(subs[1]).toMatchObject({
			displayName: "Beta",
			parentId: "Alpha",
			depth: 2,
			sessionFile: path.join(scanRoot, "Alpha", "Beta.jsonl"),
		});
		expect(found.indexOf(subs[0]!)).toBeLessThan(found.indexOf(subs[1]!));
	});

	it("names the default advisor by its owner and a slugged advisor by its slug", () => {
		expect(byId("Main/advisor")).toMatchObject({
			displayName: "advisor",
			kind: "advisor",
			parentId: "Main",
			depth: 1,
			sessionFile: path.join(scanRoot, "__advisor.jsonl"),
		});
		expect(byId("Alpha/advisor:review")).toMatchObject({
			displayName: "advisor:review",
			kind: "advisor",
			parentId: "Alpha",
			depth: 2,
			sessionFile: path.join(scanRoot, "Alpha", "__advisor.review.jsonl"),
		});
	});

	it("ignores .bak transcripts, directories named like transcripts, and non-jsonl files", () => {
		expect(found.map(entry => entry.id).sort()).toEqual(["Alpha", "Alpha/advisor:review", "Beta", "Main/advisor"]);
	});

	it("reports the on-disk size and mtime of each transcript", () => {
		const beta = byId("Beta");
		expect(beta.size).toBe(Buffer.byteLength(BETA_CONTENT));
		expect(beta.mtimeMs).toBeGreaterThan(0);
	});

	it("yields nothing for a missing directory, a nullish path, or a non-jsonl path", async () => {
		expect(await scanSubagentTranscripts(path.join(tempRoot, "never-written.jsonl"))).toEqual([]);
		expect(await scanSubagentTranscripts(null)).toEqual([]);
		expect(await scanSubagentTranscripts(undefined)).toEqual([]);
		expect(await scanSubagentTranscripts(scanRoot)).toEqual([]);
	});

	it("propagates a non-ENOENT directory error instead of reporting no subagents", async () => {
		const denied = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
		vi.spyOn(fs, "readdir").mockRejectedValue(denied);
		await expect(scanSubagentTranscripts(sessionFile)).rejects.toThrow("permission denied");
	});

	it("keeps the transcripts it could read when a nested directory is unreadable", async () => {
		const readdir = fs.readdir;
		const denied = Object.assign(new Error("EACCES: permission denied, scandir"), { code: "EACCES" });
		vi.spyOn(fs, "readdir").mockImplementation((async (dir: string, options: unknown) => {
			if (dir === path.join(scanRoot, "Alpha")) throw denied;
			return readdir(dir, options as never);
		}) as never);
		const partial = await scanSubagentTranscripts(sessionFile);
		expect(partial.map(entry => entry.id).sort()).toEqual(["Alpha", "Main/advisor"]);
	});

	it("treats an ENOENT directory error as an empty level", async () => {
		const gone = Object.assign(new Error("ENOENT: no such file or directory, scandir"), { code: "ENOENT" });
		vi.spyOn(fs, "readdir").mockRejectedValue(gone);
		expect(await scanSubagentTranscripts(sessionFile)).toEqual([]);
	});
});
