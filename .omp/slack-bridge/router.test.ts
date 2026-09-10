/**
 * Front-door router tests (hermetic — no pi, no Shuttle, no network).
 *
 * parseDecision/formatRepos are pure. createRouter runs against real `/bin/sh`
 * stub scripts in per-test temp dirs, so every fail-open path (disabled model,
 * missing script, non-zero exit, blown deadline) is exercised for real.
 * Those paths log to stderr by design; that output is expected.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRouter, formatPairs, parseDecision, summarizeAgentDescription } from "./router";
import type { BridgeConfig, RouterContext } from "./types";

const MISSING_SCRIPT = "/nonexistent/omp-router/route.sh";
const MODEL = "shuttle/gemma-4-26b";

/** Records the argv it was handed, then answers with a valid decision. */
const RECORDING_STUB = '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' "$@" >> "__ARGV__"\necho \'{"command":"help"}\'\n';

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		slackAppToken: "xapp-1",
		slackBotToken: "xoxb-1",
		allowedUsers: ["UALICE"],
		ompBin: "omp",
		repos: {},
		defaultRepo: undefined,
		maxTasks: 4,
		idleTtlMin: 30,
		sessionNamePrefix: "slack:",
		catchupWindowMin: 0,
		routerModel: MODEL,
		routerTimeoutMs: 5000,
		routerScript: MISSING_SCRIPT,
		stateDir: "/tmp/omp-router-test-state",
		...overrides,
	};
}

const CTX: RouterContext = { repos: { omp: "/src/omp" } };

/** Temp dirs holding stub scripts; removed in afterAll. */
const stubDirs: string[] = [];

/** Writes an executable `route.sh` stub into a fresh temp dir; `__ARGV__` → the argv log path. */
async function makeStub(body: string): Promise<{ script: string; argv: string }> {
	const dir = await mkdtemp(join(tmpdir(), "omp-router-test-"));
	stubDirs.push(dir);
	const script = join(dir, "route.sh");
	const argv = join(dir, "argv.txt");
	await Bun.write(script, body.replaceAll("__ARGV__", argv));
	await Bun.spawn(["chmod", "+x", script]).exited;
	return { script, argv };
}

afterAll(async () => {
	while (stubDirs.length > 0) await rm(stubDirs.pop()!, { recursive: true, force: true });
});

describe("parseDecision", () => {
	test("accepts every command in the contract", () => {
		expect(parseDecision('{"command":"run","prompt":"fix the bug"}')).toEqual({ command: "run", prompt: "fix the bug" });
		expect(parseDecision('{"command":"run","dir":"omp","prompt":"fix"}')).toEqual({
			command: "run",
			dir: "omp",
			prompt: "fix",
		});
		expect(parseDecision('{"command":"run","dir":"omp","prompt":"plan the migration","agent":"planner"}')).toEqual({
			command: "run",
			dir: "omp",
			prompt: "plan the migration",
			agent: "planner",
		});
		expect(parseDecision('{"command":"sessions"}')).toEqual({ command: "sessions" });
		expect(parseDecision('{"command":"sessions","alias":"omp"}')).toEqual({ command: "sessions", alias: "omp" });
		expect(parseDecision('{"command":"resume","target":"2"}')).toEqual({ command: "resume", target: "2" });
		expect(parseDecision('{"command":"status"}')).toEqual({ command: "status" });
		expect(parseDecision('{"command":"help"}')).toEqual({ command: "help" });
	});

	test("keys outside the contract are dropped, never passed through", () => {
		expect(parseDecision('{"command":"status","evil":1}')).toEqual({ command: "status" });
		expect(parseDecision('{"command":"resume","target":"2","cwd":"/etc"}')).toEqual({ command: "resume", target: "2" });
		expect(parseDecision('{"command":"sessions","prompt":"rm -rf /"}')).toEqual({ command: "sessions" });
		// `model` was the old spelling of "who runs this"; a worker still emitting it
		// must not smuggle a model spec past the bridge, which no longer passes one.
		expect(parseDecision('{"command":"run","prompt":"fix it","model":"openai/gpt-5"}')).toEqual({ command: "run", prompt: "fix it" });
	});

	test("rejects malformed, unknown, or incomplete output", () => {
		expect(parseDecision("not json")).toBeUndefined();
		expect(parseDecision("")).toBeUndefined();
		expect(parseDecision('["command","status"]')).toBeUndefined();
		expect(parseDecision("null")).toBeUndefined();
		expect(parseDecision('{"command":"deploy"}')).toBeUndefined();
		expect(parseDecision('{"prompt":"no command at all"}')).toBeUndefined();
		expect(parseDecision('{"command":42}')).toBeUndefined();
		expect(parseDecision('{"command":"run"}')).toBeUndefined();
		expect(parseDecision('{"command":"run","prompt":"   "}')).toBeUndefined();
		expect(parseDecision('{"command":"run","prompt":7}')).toBeUndefined();
		// `orchestrate` is no longer a command: it is a `run` with `agent: orchestrate`.
		// Rejecting it here sends the bridge to its literal parser, which still knows the word.
		expect(parseDecision('{"command":"orchestrate","dir":"omp","prompt":"ship it"}')).toBeUndefined();
		expect(parseDecision('{"command":"resume"}')).toBeUndefined();
		expect(parseDecision('{"command":"resume","target":" "}')).toBeUndefined();
	});

	test("blank optional fields are dropped, kept values are trimmed", () => {
		expect(parseDecision('{"command":"run","dir":"  ","prompt":"go"}')).toEqual({ command: "run", prompt: "go" });
		expect(parseDecision('{"command":"run","dir":7,"prompt":"go"}')).toEqual({ command: "run", prompt: "go" });
		expect(parseDecision('{"command":"sessions","alias":""}')).toEqual({ command: "sessions" });
		expect(parseDecision('{"command":"run","dir":" omp ","prompt":"  fix it  "}')).toEqual({
			command: "run",
			dir: "omp",
			prompt: "fix it",
		});
		expect(parseDecision('{"command":"resume","target":" 3 "}')).toEqual({ command: "resume", target: "3" });
	});

	// `trace` is what Slack shows under the breadcrumb, so its bounds are the
	// contract: three lines at most, each trimmed and capped.
	test("a trace is kept clamped to three trimmed lines plus a turn count", () => {
		expect(
			parseDecision(
				'{"command":"run","prompt":"go","trace":{"turns":2,"summary":"  read it as a fix request  \\n\\ncalled run in omp\\nomitted agent\\nfourth line dropped"}}',
			),
		).toEqual({
			command: "run",
			prompt: "go",
			trace: { summary: "read it as a fix request\ncalled run in omp\nomitted agent", turns: 2 },
		});
		const long = parseDecision(`{"command":"help","trace":{"summary":"${"x".repeat(400)}"}}`);
		expect(long).toEqual({ command: "help", trace: { summary: `${"x".repeat(219)}…` } });
	});

	test("an unusable trace is dropped without costing the command", () => {
		expect(parseDecision('{"command":"help","trace":{"summary":"   ","turns":0}}')).toEqual({ command: "help" });
		expect(parseDecision('{"command":"help","trace":{"summary":42,"turns":"two"}}')).toEqual({ command: "help" });
		expect(parseDecision('{"command":"help","trace":{"turns":1.5}}')).toEqual({ command: "help" });
		expect(parseDecision('{"command":"help","trace":"nonsense"}')).toEqual({ command: "help" });
		expect(parseDecision('{"command":"help","trace":{"evil":"x"}}')).toEqual({ command: "help" });
		// A turn count with no summary still stands on its own.
		expect(parseDecision('{"command":"status","trace":{"turns":1}}')).toEqual({ command: "status", trace: { turns: 1 } });
	});
});

describe("formatPairs", () => {
	test("joins key=value pairs in insertion order", () => {
		expect(formatPairs({ a: "/p", b: "/q" })).toBe("a=/p,b=/q");
	});

	test("an empty map yields an empty string", () => {
		expect(formatPairs({})).toBe("");
	});
});

describe("summarizeAgentDescription", () => {
	test("keeps the first sentence whole, including dots inside paths and parentheses", () => {
		expect(
			summarizeAgentDescription(
				"Runs the review (judges in ~/.nomad-extensions/verify-reviewers.json) over a diff. Then adjudicates every finding.",
			),
		).toBe("Runs the review (judges in ~/.nomad-extensions/verify-reviewers.json) over a diff.");
	});

	test("caps a run-on first sentence at a word boundary with an ellipsis", () => {
		const long = `${"word ".repeat(60).trim()}.`;
		const summary = summarizeAgentDescription(long);
		expect(summary.length).toBeLessThanOrEqual(201);
		expect(summary.endsWith("…")).toBe(true);
		expect(summary).not.toMatch(/wor…$/); // never cut inside a word
	});
});

describe("createRouter", () => {
	test("an empty routerModel resolves undefined without spawning", async () => {
		await expect(createRouter(makeConfig({ routerModel: "" }))("hello", CTX)).resolves.toBeUndefined();

		// A real stub this time: an untouched argv log proves no child ever ran.
		const stub = await makeStub(RECORDING_STUB);
		const route = createRouter(makeConfig({ routerModel: "   ", routerScript: stub.script }));
		await expect(route("hello", CTX)).resolves.toBeUndefined();
		expect(await Bun.file(stub.argv).exists()).toBe(false);
	});

	test("a missing router script fails open", async () => {
		await expect(createRouter(makeConfig())("hello", CTX)).resolves.toBeUndefined();
	});

	test("a decision line from the script is parsed and returned", async () => {
		const { script } = await makeStub("#!/bin/sh\ncat >/dev/null\necho '{\"command\":\"status\"}'\n");
		const route = createRouter(makeConfig({ routerScript: script }));
		expect(await route("what is running?", CTX)).toEqual({ command: "status" });
	});

	test("a non-zero exit fails open", async () => {
		const { script } = await makeStub("#!/bin/sh\ncat >/dev/null\nexit 1\n");
		const route = createRouter(makeConfig({ routerScript: script }));
		await expect(route("hello", CTX)).resolves.toBeUndefined();
	});

	test("a script that outruns the deadline is killed and fails open", async () => {
		// `exec` so the sleep replaces the shell and kill() reaches it directly.
		const { script } = await makeStub("#!/bin/sh\ncat >/dev/null\nexec sleep 5\n");
		const route = createRouter(makeConfig({ routerScript: script, routerTimeoutMs: 150 }));
		const started = Date.now();
		await expect(route("hello", CTX)).resolves.toBeUndefined();
		// Without the deadline this would have blocked for the stub's full 5s.
		expect(Date.now() - started).toBeLessThan(4000);
	});

	test("the worker's own deadline lands under the bridge's, so a killed run can still be harvested", async () => {
		const stub = await makeStub(RECORDING_STUB);
		const route = createRouter(makeConfig({ routerScript: stub.script, routerTimeoutMs: 150_000 }));
		expect(await route("hi", CTX)).toEqual({ command: "help" });

		const argv = (await Bun.file(stub.argv).text()).trim().split("\n");
		// 150s bridge deadline − 15s grace: route.sh's alarm fires first, so its jq
		// harvest of an already-emitted decision runs instead of being killed away.
		expect(argv.at(-2)).toBe("--timeout");
		expect(Number(argv.at(-1))).toBe(135);
	});

	test("--default-repo is passed only when the context sets one", async () => {
		const withDefault = await makeStub(RECORDING_STUB);
		const routeA = createRouter(makeConfig({ routerScript: withDefault.script }));
		expect(await routeA("hi", { repos: { omp: "/src/omp" }, defaultRepo: "omp" })).toEqual({ command: "help" });
		// Exact argv: order is pinned, and the message text never appears as a word.
		expect((await Bun.file(withDefault.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"omp=/src/omp",
			"--default-repo",
			"omp",
			"--timeout",
			"5",
		]);

		const without = await makeStub(RECORDING_STUB);
		const routeB = createRouter(makeConfig({ routerScript: without.script }));
		expect(await routeB("hi", { repos: { omp: "/src/omp" } })).toEqual({ command: "help" });
		expect((await Bun.file(without.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"omp=/src/omp",
			"--timeout",
			"5",
		]);
	});

	test("--attachments is passed only when the context carries an inventory", async () => {
		const withFiles = await makeStub(RECORDING_STUB);
		const routeA = createRouter(makeConfig({ routerScript: withFiles.script }));
		expect(await routeA("what is wrong here", { repos: { omp: "/src/omp" }, attachments: "shot.png (image/png)" })).toEqual({
			command: "help",
		});
		expect((await Bun.file(withFiles.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"omp=/src/omp",
			"--attachments",
			"shot.png (image/png)",
			"--timeout",
			"5",
		]);

		// A blank inventory is the same as none: no empty flag value reaches the script.
		const blank = await makeStub(RECORDING_STUB);
		const routeB = createRouter(makeConfig({ routerScript: blank.script }));
		expect(await routeB("hi", { repos: { omp: "/src/omp" }, attachments: "  " })).toEqual({ command: "help" });
		expect((await Bun.file(blank.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"omp=/src/omp",
			"--timeout",
			"5",
		]);
	});

	test("--agents carries one `name: description` line per agent, and is omitted when there are none", async () => {
		// `[%s]` brackets each argv value, so an embedded newline inside ONE value is
		// visibly distinct from a second value — that is the whole contract here.
		const withAgents = await makeStub(
			'#!/bin/sh\ncat >/dev/null\nprintf \'[%s]\\n\' "$@" >> "__ARGV__"\necho \'{"command":"run","dir":"omp","prompt":"plan the migration","agent":"planner"}\'\n',
		);
		const routeA = createRouter(makeConfig({ routerScript: withAgents.script }));
		expect(
			await routeA("plan this out", {
				repos: { omp: "/src/omp" },
				agents: [
					// A real frontmatter description spans lines and is indented; it must
					// still arrive as one line, or the `name: description` shape breaks.
					{ name: "planner", description: "Plans work:\n  breaks a request\tinto   phases." },
					{ name: "scout", description: "  Read-only codebase research.  " },
				],
			}),
		).toEqual({ command: "run", dir: "omp", prompt: "plan the migration", agent: "planner" });
		expect(await Bun.file(withAgents.argv).text()).toBe(
			`[--model]\n[${MODEL}]\n[--repos]\n[omp=/src/omp]\n[--agents]\n[planner: Plans work: breaks a request into phases.\nscout: Read-only codebase research.]\n[--timeout]\n[5]\n`,
		);

		// No agents on this box: the flag is omitted entirely rather than sent empty.
		const empty = await makeStub(RECORDING_STUB);
		const routeB = createRouter(makeConfig({ routerScript: empty.script }));
		expect(await routeB("hi", { repos: { omp: "/src/omp" }, agents: [] })).toEqual({ command: "help" });
		expect((await Bun.file(empty.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"omp=/src/omp",
			"--timeout",
			"5",
		]);
	});

	test("--session-dir is passed when the context sets one, omitted when it does not", async () => {
		const persisted = await makeStub(RECORDING_STUB);
		const routeA = createRouter(makeConfig({ routerScript: persisted.script }));
		expect(await routeA("what is running?", { repos: {}, sessionDir: "/home/tester/.omp/agent/sessions/-src-omp/router" })).toEqual({
			command: "help",
		});
		expect((await Bun.file(persisted.argv).text()).trim().split("\n")).toEqual([
			"--model",
			MODEL,
			"--repos",
			"",
			"--session-dir",
			"/home/tester/.omp/agent/sessions/-src-omp/router",
			"--timeout",
			"5",
		]);

		const ephemeral = await makeStub(RECORDING_STUB);
		const routeB = createRouter(makeConfig({ routerScript: ephemeral.script }));
		expect(await routeB("hi", { repos: {} })).toEqual({ command: "help" });
		expect(await Bun.file(ephemeral.argv).text()).not.toContain("--session-dir");
	});
});
