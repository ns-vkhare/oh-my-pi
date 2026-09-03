/**
 * Front-door intent router: a local model turns free-form Slack text into one
 * RouterDecision.
 *
 * Shells out to `router/route.sh` (the pi harness driving a Shuttle-served
 * model), handing the untrusted message over stdin — never as an argv word —
 * and reading a single compact-JSON decision line from stdout.
 *
 * FAIL-OPEN throughout: a disabled model, a missing script, a non-zero exit, a
 * blown deadline, or unparseable output all resolve `undefined`, which tells
 * the bridge to fall back to the literal first-token parser. The returned
 * RouteMessage therefore never rejects — a dead local model must never swallow
 * a Slack message.
 */

import { truncate } from "./blocks";
import type { BridgeConfig, RouteMessage, RouterContext, RouterDecision, RouterTrace } from "./types";

/** Child stderr echoed on a failed run, truncated so one bad run cannot flood the log. */
const STDERR_LOG_CAP = 512;
/** Sub-lines of `trace.summary` kept — entry.md asks the worker for one step per line, three at most. */
const SUMMARY_MAX_LINES = 3;
/** Per-line budget, so one runaway line cannot stretch the Slack context block. */
const SUMMARY_LINE_MAX = 220;
/**
 * Head room reserved out of the bridge deadline for the worker's own SIGALRM
 * path: omp startup runs inside that alarm, and after it fires `route.sh` still
 * has to jq-harvest the captured event stream. 15s covers both on a loaded box.
 */
const WORKER_GRACE_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The trimmed string, or `undefined` when absent, non-string, or blank. */
function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length > 0 ? text : undefined;
}

/** `{a: "/p", b: "/q"}` → `"a=/p,b=/q"`; insertion order, empty object → `""`. */
export function formatPairs(pairs: Record<string, string>): string {
	return Object.entries(pairs)
		.map(([key, value]) => `${key}=${value}`)
		.join(",");
}

/**
 * `trace` → a clamped RouterTrace, or `undefined` when it carries nothing usable.
 *
 * Written by route.sh from the worker's event stream, but arriving over the same
 * untrusted stdout as the decision, so it is validated like everything else and
 * bounded HERE — the parse boundary — leaving renderers to render. A summary is
 * kept to its first `SUMMARY_MAX_LINES` non-blank lines, each capped; a blank or
 * non-string one is dropped, as is a `turns` that is not a positive integer.
 */
function parseTrace(value: unknown): RouterTrace | undefined {
	if (!isRecord(value)) return undefined;
	const trace: RouterTrace = {};
	const summary = nonEmpty(value.summary);
	if (summary !== undefined) {
		const lines = summary
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0)
			.slice(0, SUMMARY_MAX_LINES)
			.map(line => truncate(line, SUMMARY_LINE_MAX));
		if (lines.length > 0) trace.summary = lines.join("\n");
	}
	const { turns } = value;
	if (typeof turns === "number" && Number.isInteger(turns) && turns > 0) trace.turns = turns;
	return trace.summary === undefined && trace.turns === undefined ? undefined : trace;
}

/**
 * One stdout line → a validated RouterDecision, or `undefined`.
 *
 * The input is a local model's output: fully untrusted. Every variant is
 * rebuilt field by field rather than spread through, so unknown keys are
 * dropped and a partially-valid variant never escapes. `trace` is the one
 * non-command field carried over, and it is cosmetic: a malformed one is
 * dropped without touching the command it came with.
 */
export function parseDecision(line: string): RouterDecision | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;
	const decision = parseCommand(parsed);
	if (decision === undefined) return undefined;
	const trace = parseTrace(parsed.trace);
	return trace === undefined ? decision : { ...decision, trace };
}

/** The command half of `parseDecision`: one variant, rebuilt field by field. */
function parseCommand(parsed: Record<string, unknown>): RouterDecision | undefined {
	const { command } = parsed;
	switch (command) {
		case "run": {
			const prompt = nonEmpty(parsed.prompt);
			if (prompt === undefined) return undefined;
			const dir = nonEmpty(parsed.dir);
			// The agent the router picked. Re-validated against the live inventory by
			// the bridge (`#resolveAgent`); an unlisted one costs the agent, not the run.
			const agent = nonEmpty(parsed.agent);
			const decision: { command: "run"; dir?: string; prompt: string; agent?: string } = { command: "run", prompt };
			if (dir !== undefined) decision.dir = dir;
			if (agent !== undefined) decision.agent = agent;
			return decision;
		}
		case "sessions": {
			const alias = nonEmpty(parsed.alias);
			return alias === undefined ? { command: "sessions" } : { command: "sessions", alias };
		}
		case "resume": {
			const target = nonEmpty(parsed.target);
			return target === undefined ? undefined : { command: "resume", target };
		}
		case "status":
			return { command: "status" };
		case "help":
			return { command: "help" };
		default:
			return undefined;
	}
}

/** Longest agent line offered to the router; entry.md carries the real routing rules. */
const AGENT_DESCRIPTION_MAX = 200;

/**
 * First sentence of an agent's frontmatter description, whitespace-collapsed
 * and capped at {@link AGENT_DESCRIPTION_MAX}. A sentence ends at `. ` or `.`
 * followed by end of text; parenthesised asides and em-dash clauses inside it
 * survive, so "Runs X (judges configured in ~/foo.json) over a diff." stays whole.
 */
export function summarizeAgentDescription(description: string): string {
	const flat = description.replace(/\s+/g, " ").trim();
	const end = flat.search(/\.(?:\s|$)/);
	const sentence = end === -1 ? flat : flat.slice(0, end + 1);
	if (sentence.length <= AGENT_DESCRIPTION_MAX) return sentence;
	const cut = sentence.lastIndexOf(" ", AGENT_DESCRIPTION_MAX - 1);
	return `${sentence.slice(0, cut > 0 ? cut : AGENT_DESCRIPTION_MAX)}…`;
}

export function createRouter(config: BridgeConfig): RouteMessage {
	return async (text: string, ctx: RouterContext): Promise<RouterDecision | undefined> => {
		// Read per call: an empty model means "router off" — no child at all.
		const model = config.routerModel.trim();
		if (model.length === 0) return undefined;

		try {
			const args = [config.routerScript, "--model", model, "--repos", formatPairs(ctx.repos)];
			const defaultRepo = nonEmpty(ctx.defaultRepo);
			if (defaultRepo !== undefined) args.push("--default-repo", defaultRepo);
			// The agents installed on this box, one `name: description` per line.
			// Descriptions are the agents' own frontmatter prose, written for the
			// task tool's frontier models: 300+ chars each. The router is a 26B local
			// model with entry.md's own per-shape rules, so it gets the first
			// sentence only, whitespace-collapsed and capped — enough to recognise
			// the agent, not enough to bury the message under the inventory.
			const agents = (ctx.agents ?? [])
				.map(agent => `${agent.name}: ${summarizeAgentDescription(agent.description)}`)
				.join("\n");
			if (agents.length > 0) args.push("--agents", agents);
			// Names and types only, and already collapsed to one line by the caller:
			// argv is safe here (no shell between us and the script) and it keeps the
			// inventory out of the message the model must restate verbatim.
			const attachments = nonEmpty(ctx.attachments);
			if (attachments !== undefined) args.push("--attachments", attachments);
			// Persist the routing transcript in omp's own session tree — the bridge
			// points this at a `router/` dir inside the repo's session dir.
			const sessionDir = nonEmpty(ctx.sessionDir);
			if (sessionDir !== undefined) args.push("--session-dir", sessionDir);
			// The worker's alarm must fire BEFORE the bridge's deadline: `route.sh`
			// harvests a decision a killed worker already emitted (the tool call IS the
			// decision; the summary turn after it is cosmetic), whereas `child.kill()`
			// below throws that stdout away. Equal deadlines meant the bridge always won
			// the race, so an over-thinking local model that had already routed still
			// fell through to the literal parser and posted help. The floor keeps a
			// deadline at or under the grace from becoming a non-positive `--timeout`.
			args.push("--timeout", String(Math.max(5, Math.floor((config.routerTimeoutMs - WORKER_GRACE_MS) / 1000))));

			// cwd is what cc-callbacks records as the audited run's project_root, so
			// the routing turn is attributed to the repo, not the bridge's install dir.
			const child = Bun.spawn(args, { cwd: nonEmpty(ctx.cwd), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			// The message is untrusted user text: it travels over stdin, never argv.
			child.stdin.write(text);
			child.stdin.end();

			const deadline = Promise.withResolvers<"timeout">();
			const timer = setTimeout(() => deadline.resolve("timeout"), config.routerTimeoutMs);
			try {
				// Drain both pipes while waiting — a chatty run must not deadlock on a full stderr buffer.
				const finished = Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				const outcome = await Promise.race([finished, deadline.promise]);
				if (outcome === "timeout") {
					try {
						child.kill();
					} catch {
						// child may already be gone
					}
					console.error(`bridge: router timed out after ${config.routerTimeoutMs}ms`);
					return undefined;
				}

				const [stdout, stderr, code] = outcome;
				if (code !== 0) {
					const tail = stderr.trim().slice(0, STDERR_LOG_CAP);
					console.error(`bridge: router exited ${code}${tail.length > 0 ? `: ${tail}` : ""}`);
					return undefined;
				}

				const line = stdout
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.length > 0)
					.at(-1);
				return line === undefined ? undefined : parseDecision(line);
			} finally {
				clearTimeout(timer);
			}
		} catch (err) {
			// Missing script, EACCES, a broken pipe — all ordinary fail-open.
			console.error(`bridge: router failed: ${String(err)}`);
			return undefined;
		}
	};
}
