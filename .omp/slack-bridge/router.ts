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

import type { BridgeConfig, RouteMessage, RouterContext, RouterDecision } from "./types";

/** Child stderr echoed on a failed run, truncated so one bad run cannot flood the log. */
const STDERR_LOG_CAP = 512;

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
export function formatRepos(repos: Record<string, string>): string {
	return Object.entries(repos)
		.map(([alias, path]) => `${alias}=${path}`)
		.join(",");
}

/**
 * One stdout line → a validated RouterDecision, or `undefined`.
 *
 * The input is a local model's output: fully untrusted. Every variant is
 * rebuilt field by field rather than spread through, so unknown keys are
 * dropped and a partially-valid variant never escapes.
 */
export function parseDecision(line: string): RouterDecision | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!isRecord(parsed)) return undefined;

	const { command } = parsed;
	switch (command) {
		case "run":
		case "orchestrate": {
			const prompt = nonEmpty(parsed.prompt);
			if (prompt === undefined) return undefined;
			const dir = nonEmpty(parsed.dir);
			const args: { dir?: string; prompt: string } = dir === undefined ? { prompt } : { dir, prompt };
			return command === "run" ? { command: "run", ...args } : { command: "orchestrate", ...args };
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

export function createRouter(config: BridgeConfig): RouteMessage {
	return async (text: string, ctx: RouterContext): Promise<RouterDecision | undefined> => {
		// Read per call: an empty model means "router off" — no child at all.
		const model = config.routerModel.trim();
		if (model.length === 0) return undefined;

		try {
			const args = [config.routerScript, "--model", model, "--repos", formatRepos(ctx.repos)];
			const defaultRepo = nonEmpty(ctx.defaultRepo);
			if (defaultRepo !== undefined) args.push("--default-repo", defaultRepo);
			args.push("--timeout", String(Math.ceil(config.routerTimeoutMs / 1000)));

			const child = Bun.spawn(args, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
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
