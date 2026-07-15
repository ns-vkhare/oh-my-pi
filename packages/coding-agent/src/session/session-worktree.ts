/**
 * Recover the git worktree a hub session created, so deleting the session can
 * offer to delete its worktree too, and the status line can point its git-backed
 * segments at the worktree the agent actually works in.
 *
 * There is no stored session→worktree link: omp never `chdir`s, so a
 * hub-dispatched session's header `cwd` stays at the project root while the
 * agent creates a worktree nested under the repo (see the "new hub session"
 * system-prompt nudge: `git worktree add .worktrees/<slug> -b <branch>`). We
 * therefore recover the worktree from two signals and verify the winner against
 * `git worktree list` so we never propose the primary checkout or a stale path:
 *
 *   1. the session header `cwd` (covers sessions started in, or `/move`d into, a
 *      linked worktree); and
 *   2. every `git worktree add <path>` the agent ran, parsed from the session's
 *      bash tool calls and resolved against the header cwd.
 *
 * A candidate is returned only when it resolves to a *registered linked
 * worktree* that is not the repo's primary root.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseJsonlLenient } from "@oh-my-pi/pi-utils";
import * as git from "../utils/git";

interface SessionHeaderRecord {
	type?: string;
	cwd?: unknown;
}

interface ToolCallBlock {
	type?: string;
	name?: string;
	arguments?: { command?: unknown };
}

interface MessageRecord {
	type?: string;
	message?: { content?: unknown };
}

/** Shell separators that end a simple command; a worktree path never spans one. */
const COMMAND_SEPARATORS: Record<string, true> = { "&&": true, "||": true, ";": true, "|": true, "&": true };
/** `git worktree add` options that consume the following token as their value (`--track` is boolean here). */
const VALUE_OPTIONS: Record<string, true> = { "-b": true, "-B": true, "--reason": true };

/**
 * Resolve the deletable git worktree associated with the session at
 * `sessionPath`, or `null` when none is found. Absolute, realpath-normalized.
 */
export async function resolveSessionWorktree(sessionPath: string): Promise<string | null> {
	let text: string;
	try {
		text = await Bun.file(sessionPath).text();
	} catch {
		return null;
	}

	const rows = parseJsonlLenient<SessionHeaderRecord & MessageRecord>(text);
	const header = rows.find(r => r?.type === "session");
	const headerCwd = typeof header?.cwd === "string" && header.cwd.length > 0 ? header.cwd : undefined;
	const anchorCwd = headerCwd ?? process.cwd();

	// Candidates, most-specific first: worktree-add targets (newest last so the
	// last-created wins), then the header cwd itself.
	const addTargets = collectWorktreeAddTargets(rows, anchorCwd);
	const candidates = [...addTargets.reverse(), ...(headerCwd ? [path.resolve(headerCwd)] : [])];
	if (candidates.length === 0) return null;

	// Registered worktrees minus the primary root — the only paths we may delete.
	let registered: git.GitWorktreeEntry[];
	let primaryRoot: string | null;
	try {
		[registered, primaryRoot] = await Promise.all([git.worktree.list(anchorCwd), git.repo.primaryRoot(anchorCwd)]);
	} catch {
		return null;
	}
	const primaryReal = primaryRoot ? await realpathOrSelf(primaryRoot) : null;
	const deletable = new Set<string>();
	for (const entry of registered) {
		if (!entry.path) continue;
		const real = await realpathOrSelf(entry.path);
		if (real !== primaryReal) deletable.add(real);
	}
	if (deletable.size === 0) return null;

	const seen = new Set<string>();
	for (const candidate of candidates) {
		const real = await realpathOrSelf(candidate);
		if (seen.has(real)) continue;
		seen.add(real);
		if (deletable.has(real)) return real;
	}
	return null;
}

/** Every `git worktree add` target found in the session's bash commands, resolved to absolute paths. */
function collectWorktreeAddTargets(rows: Array<MessageRecord>, anchorCwd: string): string[] {
	const targets: string[] = [];
	for (const row of rows) {
		if (row?.type !== "message") continue;
		const content = row.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as ToolCallBlock[]) {
			if (block?.type !== "toolCall" || block.name !== "bash") continue;
			const command = block.arguments?.command;
			if (typeof command !== "string") continue;
			for (const raw of parseWorktreeAddPaths(command)) {
				targets.push(resolveAgainst(anchorCwd, raw));
			}
		}
	}
	return targets;
}

/**
 * Parse the `<path>` argument of every `git worktree add` occurrence in a shell
 * command. Tokenizes with quote awareness, finds the `git worktree add`
 * sub-sequence, skips option flags (consuming values for `-b`/`-B`/etc.), and
 * takes the first positional as the path. Returns raw (unexpanded) path tokens.
 */
export function parseWorktreeAddPaths(command: string): string[] {
	const tokens = tokenizeShell(command);
	const paths: string[] = [];
	for (let i = 0; i + 2 < tokens.length; i++) {
		if (tokens[i] !== "git" || tokens[i + 1] !== "worktree" || tokens[i + 2] !== "add") continue;
		let j = i + 3;
		while (j < tokens.length) {
			const tok = tokens[j]!;
			if (COMMAND_SEPARATORS[tok]) break;
			if (tok.startsWith("-")) {
				j += VALUE_OPTIONS[tok] ? 2 : 1;
				continue;
			}
			paths.push(tok);
			break;
		}
	}
	return paths;
}

/** Minimal POSIX-ish tokenizer: splits on whitespace, honoring single/double quotes; separators become standalone tokens. */
function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasToken = false;
	const flush = () => {
		if (hasToken) tokens.push(current);
		current = "";
		hasToken = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasToken = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			current += command[++i]!;
			hasToken = true;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			flush();
			continue;
		}
		// Two-char separators (&&, ||) and single-char ones (;, |, &) split into their own token.
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			flush();
			tokens.push(two);
			i++;
			continue;
		}
		if (ch === ";" || ch === "|" || ch === "&") {
			flush();
			tokens.push(ch);
			continue;
		}
		current += ch;
		hasToken = true;
	}
	flush();
	return tokens;
}

/** Resolve a raw path token (expanding a leading `~`) against `anchorCwd`. */
function resolveAgainst(anchorCwd: string, raw: string): string {
	let p = raw;
	if (p === "~") p = os.homedir();
	else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
	return path.resolve(anchorCwd, p);
}

/** realpath, falling back to the resolved input when the path is gone or errors. */
async function realpathOrSelf(p: string): Promise<string> {
	try {
		return await fs.realpath(p);
	} catch {
		return path.resolve(p);
	}
}
