/**
 * Inventory the omp agent definitions the router may pick from.
 *
 * omp discovers agents as markdown files with YAML frontmatter, from
 * `<project>/.omp/agents/*.md` first, then `~/.omp/agent/agents/*.md` (note the
 * `agent` segment — `~/.omp/agents` is not a scan root). The bridge reads only
 * `name:` and `description:`: the name is what `omp --agent <name>` takes, the
 * description is what the routing model reads to choose. Everything else in the
 * file (model, thinking level, tools) is omp's business at spawn time.
 *
 * Zero dependencies by design: the frontmatter parse below is a line scan, not
 * a YAML implementation. Anything it cannot read confidently is skipped, so a
 * malformed file drops out of the inventory instead of poisoning it.
 */

import * as fs from "node:fs/promises";
import type { AgentOption } from "./types";

/**
 * Agent definitions visible from `cwd`, in precedence order: a project file
 * shadows a home file declaring the same `name`. Files missing either key are
 * skipped, and an unreadable scan root contributes nothing rather than throwing
 * — no inventory simply means the router is offered no agents.
 */
export async function listAgentDefinitions(cwd: string, home: string): Promise<AgentOption[]> {
	const byName = new Map<string, AgentOption>();
	// Project root first: the first writer of a name wins, which is the shadowing rule.
	for (const root of [`${cwd}/.omp/agents`, `${home}/.omp/agent/agents`]) {
		for (const option of await readAgentDir(root)) {
			if (!byName.has(option.name)) byName.set(option.name, option);
		}
	}
	// Sorted so the list the router sees (and a test asserts) never depends on
	// directory iteration order.
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every readable `<dir>/*.md` that declares both keys; `[]` when the dir is not there. */
async function readAgentDir(dir: string): Promise<AgentOption[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return []; // Missing or unreadable scan root — not an error, just no agents.
	}
	const options: AgentOption[] = [];
	for (const entry of entries.filter((name) => name.endsWith(".md")).sort()) {
		let body: string;
		try {
			body = await Bun.file(`${dir}/${entry}`).text();
		} catch {
			continue; // A file that vanished or cannot be read is simply not an agent.
		}
		const option = parseAgentOption(body);
		if (option) options.push(option);
	}
	return options;
}

/**
 * `name:` + `description:` from the leading `---`-delimited block, or undefined.
 *
 * Both keys are required: a nameless file has nothing to pass to `omp --agent`,
 * and a description-less one gives the router nothing to choose on, so offering
 * it would be worse than omitting it.
 */
function parseAgentOption(body: string): AgentOption | undefined {
	const lines = body.split("\n");
	// The block must open on line 1; anything else is a plain markdown file.
	if ((lines[0] ?? "").replace(/^\uFEFF/, "").trim() !== "---") return undefined;
	let name: string | undefined;
	let description: string | undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") break; // End of frontmatter; body text is not config.
		const match = /^(name|description):\s*(.+)$/.exec(line);
		if (!match) continue;
		const value = unwrapValue(match[2] ?? "");
		if (value.length === 0) continue;
		// First occurrence wins, mirroring the single-key scan this replaced.
		if (match[1] === "name") name ??= value;
		else description ??= value;
	}
	if (name === undefined || description === undefined) return undefined;
	return { name, description };
}

/**
 * One raw frontmatter value, unquoted.
 *
 * A quoted value is taken whole — a `#` inside quotes belongs to the text, and
 * agent descriptions are long English prose that may well contain one. Only an
 * unquoted value gets a trailing ` # comment` stripped. No length cap: the
 * router needs the whole description to pick between agents.
 */
function unwrapValue(raw: string): string {
	const trimmed = raw.trim();
	const quote = trimmed.startsWith('"') ? '"' : trimmed.startsWith("'") ? "'" : undefined;
	if (quote) {
		const end = trimmed.lastIndexOf(quote);
		if (end > 0) return trimmed.slice(1, end).trim();
	}
	return trimmed.replace(/\s+#.*$/, "").trim();
}
