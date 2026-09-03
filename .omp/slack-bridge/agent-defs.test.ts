/**
 * Hermetic `listAgentDefinitions` tests — real fixture files under a temp dir,
 * so the developer's actual `~/.omp/agent/agents` never decides an assertion.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentDefinitions } from "./agent-defs";

const ROOT = mkdtempSync(join(tmpdir(), "omp-agent-defs-test-"));
const PROJECT = join(ROOT, "project");
const HOME = join(ROOT, "home");

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** Write an agent definition into one of omp's two scan roots. */
function writeAgent(root: "project" | "user", file: string, body: string): Promise<number> {
	// The user root carries an `agent` segment — `~/.omp/agents` is not scanned.
	const dir = root === "project" ? join(PROJECT, ".omp/agents") : join(HOME, ".omp/agent/agents");
	return Bun.write(join(dir, `${file}.md`), body);
}

/** The shape omp writes: a frontmatter block, then the agent's prose. */
function agentFile(...frontmatter: string[]): string {
	return ["---", ...frontmatter, "---", "", "Do the thing.", ""].join("\n");
}

describe("listAgentDefinitions", () => {
	test("a project definition shadows the home one declaring the same name", async () => {
		await writeAgent("user", "planner", agentFile("name: planner", "description: home planner"));
		await writeAgent("project", "planner", agentFile("name: planner", "description: project planner"));
		await writeAgent("user", "scout", agentFile("name: scout", "description: home scout"));

		expect(await listAgentDefinitions(PROJECT, HOME)).toEqual([
			{ name: "planner", description: "project planner" },
			{ name: "scout", description: "home scout" },
		]);
	});

	test("a definition without a description is left out — the router has nothing to pick on", async () => {
		await writeAgent("user", "mute", agentFile("name: mute", "model: anthropic/claude-fable-5"));

		const names = (await listAgentDefinitions(PROJECT, HOME)).map((a) => a.name);
		expect(names).not.toContain("mute");
	});

	test("a quoted description keeps its text, including a `#` that is not a comment", async () => {
		await writeAgent("user", "quoted", agentFile("name: quoted", `description: "review the diff # not a comment"`));

		const found = (await listAgentDefinitions(PROJECT, HOME)).find((a) => a.name === "quoted");
		expect(found?.description).toBe("review the diff # not a comment");
	});

	test("an unquoted description drops its trailing inline comment", async () => {
		await writeAgent("user", "commented", agentFile("name: commented", "description: mechanical edits only  # keep it dumb"));

		const found = (await listAgentDefinitions(PROJECT, HOME)).find((a) => a.name === "commented");
		expect(found?.description).toBe("mechanical edits only");
	});

	test("a long description survives whole — the router reads it to choose", async () => {
		const long = `${"decide between agents ".repeat(20).trim()}.`;
		await writeAgent("user", "verbose", agentFile("name: verbose", `description: ${long}`));

		const found = (await listAgentDefinitions(PROJECT, HOME)).find((a) => a.name === "verbose");
		expect(found?.description).toBe(long);
	});

	test("scan roots that do not exist yield an empty list rather than throwing", async () => {
		expect(await listAgentDefinitions(join(ROOT, "no-such-project"), join(ROOT, "no-such-home"))).toEqual([]);
	});
});
