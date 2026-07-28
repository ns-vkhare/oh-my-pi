/**
 * Hermetic `resolveAgentModel` tests — real fixture files under a temp dir, so
 * the developer's actual `~/.omp/agent/agents` never decides an assertion.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentModel } from "./agent-model";

const ROOT = mkdtempSync(join(tmpdir(), "omp-agent-model-test-"));
const PROJECT = join(ROOT, "project");
const HOME = join(ROOT, "home");

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

/** Write an agent definition into one of omp's two scan roots. */
function writeAgent(root: "project" | "user", name: string, body: string): Promise<number> {
	// The user root carries an `agent` segment — `~/.omp/agents` is not scanned.
	const dir = root === "project" ? join(PROJECT, ".omp/agents") : join(HOME, ".omp/agent/agents");
	return Bun.write(join(dir, `${name}.md`), body);
}

/** The shape omp writes: a frontmatter block, then the agent's prose. */
function agentFile(...frontmatter: string[]): string {
	return ["---", ...frontmatter, "---", "", "Do the thing.", ""].join("\n");
}

describe("resolveAgentModel", () => {
	test("reads model: from the project agent definition", async () => {
		await writeAgent("project", "alpha", agentFile("name: alpha", "model: anthropic/claude-fable-5", "thinkingLevel: high"));
		expect(await resolveAgentModel("alpha", PROJECT, HOME)).toBe("anthropic/claude-fable-5");
	});

	test("the project definition wins over the user one", async () => {
		await writeAgent("project", "beta", agentFile("model: project/wins"));
		await writeAgent("user", "beta", agentFile("model: user/loses"));
		expect(await resolveAgentModel("beta", PROJECT, HOME)).toBe("project/wins");
	});

	test("falls through to ~/.omp/agent/agents when the project defines nothing", async () => {
		await writeAgent("user", "gamma", agentFile("model: user/only"));
		expect(await resolveAgentModel("gamma", PROJECT, HOME)).toBe("user/only");
	});

	test("undefined when neither scan root defines the agent", async () => {
		expect(await resolveAgentModel("nobody", PROJECT, HOME)).toBeUndefined();
	});

	test("undefined when the frontmatter pins no model", async () => {
		await writeAgent("project", "delta", agentFile("name: delta", "description: pins nothing"));
		expect(await resolveAgentModel("delta", PROJECT, HOME)).toBeUndefined();
	});

	test("a comma-separated priority list yields its first entry", async () => {
		await writeAgent("project", "epsilon", agentFile("model: first/one, second/two"));
		expect(await resolveAgentModel("epsilon", PROJECT, HOME)).toBe("first/one");
	});

	test("surrounding quotes and an inline comment are stripped", async () => {
		await writeAgent("project", "zeta", agentFile('model: "anthropic/claude-fable-5"  # the orchestrator pin'));
		expect(await resolveAgentModel("zeta", PROJECT, HOME)).toBe("anthropic/claude-fable-5");
	});

	test("a value with embedded whitespace is rejected rather than reaching argv", async () => {
		await writeAgent("project", "eta", agentFile("model: anthropic/claude fable 5"));
		expect(await resolveAgentModel("eta", PROJECT, HOME)).toBeUndefined();
	});
});
