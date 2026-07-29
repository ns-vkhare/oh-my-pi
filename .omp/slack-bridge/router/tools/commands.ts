// The six bridge commands, exposed to the router model as tools. Calling one IS
// the routing decision: the bridge never runs anything this worker "says", only
// what it calls. The harness's `tool_execution_end` event carries the tool name
// and the result but NOT the arguments, so the fully normalized decision has to
// travel back inside the result text — that is what the `ROUTE ` line is for.
//
// Loaded by `omp --extension`. Two deliberate constraints:
//   * `parameters` are plain JSON Schema, not zod/typebox. omp passes a non-zod
//     schema straight through as the tool's wire schema, so the worker needs no
//     npm dependency and the deployed copy (~/.omp/slack-bridge) resolves nothing.
//   * the `pi` handle is described by a local structural interface, same as
//     `slack-notify.extension.ts`, so this file typechecks with no types package.

/** The slice of omp's ExtensionAPI this extension uses. */
interface RouterPi {
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		promptSnippet?: string;
		parameters: Record<string, unknown>;
		execute(
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: (update: unknown) => void,
			ctx?: unknown,
		): Promise<{ content: Array<{ type: "text"; text: string }> }>;
	}): void;
}

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
const MODEL_DESCRIPTION =
	"Model role (or exact spec) from the `Model roles:` line in the message, copied verbatim. Pass it ONLY when the user asks for a different model or names a role; omit it to use their default. Never invent one.";

/** JSON Schema for the two task commands: same arguments, same validation. */
const TASK_PARAMETERS: Record<string, unknown> = {
	type: "object",
	properties: {
		dir: { type: "string", description: DIR_DESCRIPTION },
		prompt: { type: "string", description: PROMPT_DESCRIPTION },
		model: { type: "string", description: MODEL_DESCRIPTION },
	},
	required: ["prompt"],
	additionalProperties: false,
};

const NO_PARAMETERS: Record<string, unknown> = { type: "object", properties: {}, additionalProperties: false };

/** `run` and `orchestrate` differ only in the command they emit. */
function taskDecision(command: "run" | "orchestrate", params: Record<string, unknown>) {
	const prompt = cleaned(params.prompt);
	if (!prompt) {
		// Plain text, not a `ROUTE ` line: no decision, so the bridge's literal parser wins.
		return { content: [{ type: "text" as const, text: `${command} requires a non-empty \`prompt\`: the user's task, restated verbatim. Call ${command} again with it.` }] };
	}
	const decision: Record<string, string> = { command, prompt };
	const dir = cleaned(params.dir);
	if (dir) decision.dir = dir;
	const model = cleaned(params.model);
	if (model) decision.model = model;
	return route(decision);
}

export default function (pi: RouterPi) {
	pi.registerTool({
		name: "run",
		label: "run",
		description:
			"Start a NEW omp coding task in a repo. Use for any request that asks for work to be done — fix, add, investigate, refactor, explain a codebase — when it is a single stream of work.",
		promptSnippet: "Start a new coding task in a repo",
		parameters: TASK_PARAMETERS,
		async execute(_toolCallId, params) {
			return taskDecision("run", params);
		},
	});

	pi.registerTool({
		name: "orchestrate",
		label: "orchestrate",
		description:
			"Start a NEW omp task that DECOMPOSES the work and fans out parallel subagents. Use when the user says orchestrate, asks to parallelize or fan out, or describes several independent pieces of work. Otherwise prefer run.",
		promptSnippet: "Start a new task that decomposes the work across parallel subagents",
		parameters: TASK_PARAMETERS,
		async execute(_toolCallId, params) {
			return taskDecision("orchestrate", params);
		},
	});

	pi.registerTool({
		name: "sessions",
		label: "sessions",
		description:
			"List the existing omp sessions the bridge knows about, newest first. Pass an alias to list only that repo's sessions. Use when the user asks what is running, what sessions exist, or what they were working on.",
		promptSnippet: "List existing omp sessions, optionally for one repo alias",
		parameters: {
			type: "object",
			properties: {
				alias: {
					type: "string",
					description: "Repo alias to filter the listing by, copied verbatim from the aliases in the message. Omit to list every session.",
				},
			},
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
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
		parameters: {
			type: "object",
			properties: {
				target: {
					type: "string",
					description:
						"Which session to attach: either the number shown in the last `sessions` listing, or an absolute path to a session .jsonl file. Copy it exactly as the user wrote it.",
				},
			},
			required: ["target"],
			additionalProperties: false,
		},
		async execute(_toolCallId, params) {
			const target = cleaned(params.target);
			if (!target) {
				return {
					content: [
						{
							type: "text" as const,
							text: "resume requires a non-empty `target`: a session number from the last listing, or an absolute .jsonl path. Call resume again with it.",
						},
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
		parameters: NO_PARAMETERS,
		async execute() {
			return route({ command: "status" });
		},
	});

	pi.registerTool({
		name: "help",
		label: "help",
		description:
			"Show the bridge's usage. Use when the message is small talk, a greeting, ambiguous, or otherwise not something the bridge can act on. Takes no arguments.",
		promptSnippet: "Show bridge usage for a message that is not actionable",
		parameters: NO_PARAMETERS,
		async execute() {
			return route({ command: "help" });
		},
	});
}
