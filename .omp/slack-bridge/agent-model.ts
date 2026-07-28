/**
 * Resolve an omp agent definition's pinned model.
 *
 * omp discovers agents as markdown files with YAML frontmatter, from
 * `<project>/.omp/agents/<name>.md` first, then `~/.omp/agent/agents/<name>.md`
 * (note the `agent` segment — `~/.omp/agents` is not a scan root). The bridge
 * reads only the `model:` key, so `orchestrate` spawns omp on the orchestrator's
 * model instead of omp's default.
 *
 * Zero dependencies by design: the frontmatter parse below is a line scan, not
 * a YAML implementation. Anything it cannot read confidently is "no opinion".
 */

/** The pin `~/.omp/agent/agents/orchestrate.md` ships with; last resort only. */
export const ORCHESTRATE_FALLBACK_MODEL = "anthropic/claude-fable-5";

/** A model spec becomes one argv word, so it must stay short and space-free. */
const MODEL_MAX_LEN = 200;

/**
 * First `model:` pinned by `<agentName>.md`, searching omp's scan roots in
 * precedence order. `undefined` means no file pinned one — the caller decides
 * what that implies.
 */
export async function resolveAgentModel(agentName: string, cwd: string, home: string): Promise<string | undefined> {
	const candidates = [`${cwd}/.omp/agents/${agentName}.md`, `${home}/.omp/agent/agents/${agentName}.md`];
	for (const path of candidates) {
		let body: string;
		try {
			body = await Bun.file(path).text();
		} catch {
			continue; // Missing or unreadable — fall through to the next scan root.
		}
		const model = frontmatterModel(body);
		if (model) return model;
	}
	return undefined;
}

/** Scan the leading `---`-delimited block for a usable `model:` value. */
function frontmatterModel(body: string): string | undefined {
	const lines = body.split("\n");
	// The block must open on line 1; anything else is a plain markdown file.
	if ((lines[0] ?? "").replace(/^\uFEFF/, "").trim() !== "---") return undefined;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (line.trim() === "---") break; // End of frontmatter; body text is not config.
		const match = /^model:\s*(.+)$/.exec(line);
		if (match) return sanitizeModel(match[1] ?? "");
	}
	return undefined;
}

/**
 * Normalize one raw frontmatter value into a model spec, or reject it.
 *
 * Rejection matters: the value ends up as an `omp --model <spec>` argv word, so
 * a malformed file must never smuggle extra words into the spawn.
 */
function sanitizeModel(raw: string): string | undefined {
	// Inline comment first (only after whitespace, so a `#` inside a value survives).
	let value = raw.replace(/\s+#.*$/, "").trim();
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		value = value.slice(1, -1).trim();
	}
	// omp accepts a comma-separated priority list (`model: a/b, c/d`); take the head.
	const first = (value.split(",")[0] ?? "").trim();
	if (!first || first.length > MODEL_MAX_LEN || /\s/.test(first)) return undefined;
	return first;
}
