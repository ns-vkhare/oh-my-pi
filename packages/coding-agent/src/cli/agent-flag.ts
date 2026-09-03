/**
 * `--agent <name>`: run the top-level session as a discovered task agent.
 *
 * The task tool composes a subagent session from an {@link AgentDefinition}
 * in-process (`task/executor.ts`). This module applies the same definition to a
 * CLI-started session so a host can say `omp --mode rpc --agent planner` and get
 * the agent's model, thinking level, tools, spawn policy, autoloaded skills, and
 * prompt body — the Slack bridge's route-by-agent path depends on it.
 *
 * Precedence: explicit CLI flags (`--model`, `--thinking`, `--tools`,
 * `--no-tools`) win over the agent's values. The agent body is appended to the
 * system prompt ahead of `--append-system-prompt`, so a host's own guidance
 * still comes last. Output schemas are not applied: a top-level session has no
 * caller to yield a structured result to.
 */

import type { Settings } from "../config/settings";
import { buildSkillPromptMessage } from "../extensibility/skills";
import type { CreateAgentSessionOptions } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../session/messages";
import { discoverAgents, getAgent } from "../task/discovery";
import type { AgentDefinition } from "../task/types";
import type { Args } from "./args";
import { CliUsageError } from "./usage-error";

/** Look up `name` among the agents discoverable from `cwd`; unknown names list the known set. */
export async function resolveCliAgent(name: string, cwd: string): Promise<AgentDefinition> {
	const wanted = name.trim();
	const { agents } = await discoverAgents(cwd);
	const agent = getAgent(agents, wanted);
	if (agent) return agent;
	const known = agents
		.map(a => a.name)
		.sort()
		.join(", ");
	throw new CliUsageError(`Unknown agent "${wanted}". Known agents: ${known}`);
}

/** Fill the CLI flags the user left unset from the agent definition. */
export function applyAgentToArgs(parsed: Args, agent: AgentDefinition): void {
	if (parsed.model === undefined && agent.model && agent.model.length > 0) {
		parsed.model = agent.model.join(",");
	}
	if (parsed.thinking === undefined && agent.thinkingLevel !== undefined) {
		parsed.thinking = agent.thinkingLevel;
	}
	if (parsed.tools === undefined && parsed.noTools !== true && agent.tools) {
		// `yield` is the subagent-only hidden tool; a top-level session has no caller to yield to.
		parsed.tools = agent.tools.filter(tool => tool !== "yield");
	}
}

/**
 * Apply the parts of the definition that live on the session options rather
 * than on CLI flags: prompt body, spawn policy, read summarization.
 */
export function applyAgentToSessionOptions(
	options: CreateAgentSessionOptions,
	agent: AgentDefinition,
	settings: Settings,
): void {
	const body = agent.systemPrompt.trim();
	const appended = options.appendSystemPrompt?.trim();
	options.appendSystemPrompt = [body, appended].filter(Boolean).join("\n\n");
	// Same rule as the task executor: an agent without `spawns` cannot spawn.
	options.spawns = agent.spawns === undefined ? "" : agent.spawns === "*" ? "*" : agent.spawns.join(",");
	if (agent.readSummarize === false) {
		settings.override("read.summarize.enabled", false);
	}
}

/**
 * Inject the agent's `autoloadSkills` as hidden skill messages, the same
 * mechanic the task executor and `/skill:<name>` use. Returns the names that
 * matched no loaded skill so the caller can warn.
 */
export async function autoloadAgentSkills(session: AgentSession, agent: AgentDefinition): Promise<string[]> {
	const missing: string[] = [];
	for (const name of agent.autoloadSkills ?? []) {
		const skill = session.skills.find(candidate => candidate.name === name);
		if (!skill) {
			missing.push(name);
			continue;
		}
		const { message } = await buildSkillPromptMessage(skill, "", "autoload");
		await session.sendCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: message,
				display: false,
				details: { name: skill.name, path: skill.filePath },
			},
			{ triggerTurn: false },
		);
	}
	return missing;
}
