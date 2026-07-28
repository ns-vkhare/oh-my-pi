import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// The six bridge commands, exposed to the router model as tools. Calling one IS
// the routing decision: the bridge never runs anything this worker "says", only
// what it calls. pi's `tool_execution_end` event carries the tool name and the
// result but NOT the arguments, so the fully normalized decision has to travel
// back inside the result text — that is what the `ROUTE ` line is for.

/** Machine-readable channel back to route.sh: exactly one `ROUTE <compact json>` line. */
function route(decision: Record<string, string>) {
	return { content: [{ type: "text" as const, text: `ROUTE ${JSON.stringify(decision)}` }] };
}

/**
 * Trim; an omitted or all-whitespace argument is simply absent. For an optional
 * parameter that means the key is dropped from the decision; for a required one
 * the call is malformed, and the tool answers with plain text instead of a
 * `ROUTE ` line — no decision falls back to the bridge's literal parser, which
 * is always better than a confidently wrong command.
 */
function cleaned(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

const DIR_DESCRIPTION =
	"Repo alias to work in. Must be one of the aliases listed in the message, copied verbatim. Omit it to use the bridge's default repo. Never invent a path.";
const PROMPT_DESCRIPTION =
	"The user's task, restated verbatim minus any leading command word. Never summarize, rewrite, or truncate it — the coding agent sees only this string.";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "run",
		label: "run",
		description:
			"Start a NEW omp coding task in a repo. Use for any request that asks for work to be done — fix, add, investigate, refactor, explain a codebase — when it is a single stream of work.",
		promptSnippet: "Start a new coding task in a repo",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: DIR_DESCRIPTION })),
			prompt: Type.String({ description: PROMPT_DESCRIPTION }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const prompt = cleaned(params.prompt);
			if (!prompt) {
				return { content: [{ type: "text" as const, text: "run requires a non-empty `prompt`: the user's task, restated verbatim. Call run again with it." }] };
			}
			const dir = cleaned(params.dir);
			return route(dir ? { command: "run", dir, prompt } : { command: "run", prompt });
		},
	});

	pi.registerTool({
		name: "orchestrate",
		label: "orchestrate",
		description:
			"Start a NEW omp task that DECOMPOSES the work and fans out parallel subagents. Use when the user says orchestrate, asks to parallelize or fan out, or describes several independent pieces of work. Otherwise prefer run.",
		promptSnippet: "Start a new task that decomposes the work across parallel subagents",
		parameters: Type.Object({
			dir: Type.Optional(Type.String({ description: DIR_DESCRIPTION })),
			prompt: Type.String({ description: PROMPT_DESCRIPTION }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const prompt = cleaned(params.prompt);
			if (!prompt) {
				return {
					content: [{ type: "text" as const, text: "orchestrate requires a non-empty `prompt`: the user's task, restated verbatim. Call orchestrate again with it." }],
				};
			}
			const dir = cleaned(params.dir);
			return route(dir ? { command: "orchestrate", dir, prompt } : { command: "orchestrate", prompt });
		},
	});

	pi.registerTool({
		name: "sessions",
		label: "sessions",
		description:
			"List the existing omp sessions the bridge knows about, newest first. Pass an alias to list only that repo's sessions. Use when the user asks what is running, what sessions exist, or what they were working on.",
		promptSnippet: "List existing omp sessions, optionally for one repo alias",
		parameters: Type.Object({
			alias: Type.Optional(
				Type.String({
					description: "Repo alias to filter the listing by, copied verbatim from the aliases in the message. Omit to list every session.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const alias = cleaned(params.alias);
			return route(alias ? { command: "sessions", alias } : { command: "sessions" });
		},
	});

	pi.registerTool({
		name: "resume",
		label: "resume",
		description:
			"Attach to an existing omp session and continue it. Use when the user refers back to earlier work — resume, continue, go back to, pick up session 2.",
		promptSnippet: "Attach an existing omp session and continue it",
		parameters: Type.Object({
			target: Type.String({
				description:
					"Which session to attach: either the number shown in the last `sessions` listing, or an absolute path to a session .jsonl file. Copy it exactly as the user wrote it.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const target = cleaned(params.target);
			if (!target) {
				return {
					content: [
						{ type: "text" as const, text: "resume requires a non-empty `target`: a session number from the last listing, or an absolute .jsonl path. Call resume again with it." },
					],
				};
			}
			return route({ command: "resume", target });
		},
	});

	pi.registerTool({
		name: "status",
		label: "status",
		description: "Report bridge health: whether the bridge is up, what it is connected to, and how many sessions it is holding. Takes no arguments.",
		promptSnippet: "Report bridge health",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return route({ command: "status" });
		},
	});

	pi.registerTool({
		name: "help",
		label: "help",
		description:
			"Show the bridge's usage. Use when the message is small talk, a greeting, ambiguous, or otherwise not something the bridge can act on. Takes no arguments.",
		promptSnippet: "Show bridge usage for a message that is not actionable",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return route({ command: "help" });
		},
	});
}
