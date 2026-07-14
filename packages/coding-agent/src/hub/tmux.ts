/**
 * tmux orchestration for the session hub.
 *
 * The hub uses tmux as a session supervisor: a single tmux session
 * (`HUB_TMUX_SESSION`) holds the hub TUI in window 0 and every live omp
 * conversation as its own window. tmux keeps unselected windows running, so a
 * session the user switched away from keeps generating in the background and
 * resumes to the foreground when its window is re-selected — the Claude-Code
 * "agent view" model, with tmux as the supervisor.
 *
 * Per-session windows are tagged with the `@omp_session_path` user option so the
 * hub can re-foreground an existing window instead of opening a duplicate, and
 * are spawned with `OMP_HUB` / `OMP_HUB_WINDOW` in their environment so the
 * in-session left-arrow gesture can switch back to the hub window.
 */
import { spawnSync } from "node:child_process";

/** Name of the tmux session that hosts the hub and all per-session windows. */
export const HUB_TMUX_SESSION = "omp-hub";
/** tmux user option (per window) recording which session `.jsonl` a window hosts. */
const SESSION_PATH_OPT = "@omp_session_path";
/** tmux user option (per window) recording the hub's chosen display title (omp's OSC title otherwise renames the window). */
const SESSION_TITLE_OPT = "@omp_session_title";
/** tmux user option (per session) recording the hub window's id. */
const HUB_WINDOW_OPT = "@omp_hub_window";
/** Env var set on per-session windows so the in-session gesture knows it is hub-managed. */
export const HUB_ENV = "OMP_HUB";
/** Env var carrying the hub window id so the in-session gesture can switch back. */
export const HUB_WINDOW_ENV = "OMP_HUB_WINDOW";

/** A live per-session window in the hub tmux session. */
export interface HubWindow {
	windowId: string;
	index: number;
	name: string;
	/** Hub-chosen display title (survives omp's OSC window renames); falls back to `name`. */
	title: string;
	/** Absolute path to the session `.jsonl` this window hosts, when tagged. */
	sessionPath: string | undefined;
	active: boolean;
}

/** True when the current process is running inside any tmux client. */
export function insideTmux(): boolean {
	return Boolean(process.env.TMUX);
}

/** Run `tmux <args>` synchronously; returns trimmed stdout, or null on failure. */
function tmux(args: string[]): string | null {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.status !== 0 || result.error) return null;
	return (result.stdout ?? "").replace(/\n$/, "");
}

/** True when the hub tmux session already exists. */
export function hubSessionExists(): boolean {
	const result = spawnSync("tmux", ["has-session", "-t", HUB_TMUX_SESSION], { stdio: "ignore" });
	return result.status === 0;
}

/**
 * The omp self-invocation prefix (`<bun> <entry>`), reconstructed from the
 * running process so spawned windows use the same binary in dev (`bun
 * src/cli.ts`) and in the bundled install (`bun dist/cli.js`).
 */
export function selfInvocation(): string[] {
	return [process.execPath, Bun.main];
}

/** POSIX single-quote escape so an arbitrary string survives a tmux shell command. */
function shq(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Build a shell command string from argv, single-quoted. */
function shellCommand(argv: string[]): string {
	return argv.map(shq).join(" ");
}

/**
 * Ensure the hub tmux session exists with the hub TUI in its first window.
 * Idempotent: a no-op when the session is already up. The hub window is created
 * detached so the caller can attach or switch to it. Records the hub window id
 * in a session option so per-session windows can target it for the back gesture.
 */
export function ensureHubSession(): void {
	if (hubSessionExists()) return;
	const hubCmd = shellCommand([...selfInvocation(), "hub"]);
	// `new-session -d` creates the session detached with one window running the
	// hub. `-n hub` names it; the shell command keeps the window alive as the hub.
	tmux(["new-session", "-d", "-s", HUB_TMUX_SESSION, "-n", "hub", hubCmd]);
	// The tmux status bar's folder + branch segments duplicate omp's own
	// statusline (every session window is an omp process, cwd/branch and all).
	// Strip just those modules from status-left for this session, keeping the
	// session label and every status-right metric (CPU / RAM / load / host).
	// Only known folder/branch modules are removed; an unrecognized status-left
	// is left untouched (set to itself), so no theme is broken.
	const globalStatusLeft = tmux(["show-options", "-gv", "status-left"]);
	if (globalStatusLeft) {
		const redundant = [
			/#\{E:@catppuccin_status_directory\}/g,
			/#\{E:@catppuccin_status_gitmux\}/g,
			/#\{E:@catppuccin_status_git\}/g,
			/#\{E:@catppuccin_status_path\}/g,
		];
		let hubStatusLeft = globalStatusLeft;
		for (const re of redundant) hubStatusLeft = hubStatusLeft.replace(re, "");
		tmux(["set-option", "-t", HUB_TMUX_SESSION, "status-left", hubStatusLeft]);
	}
	const hubWindowId = tmux(["display-message", "-p", "-t", `${HUB_TMUX_SESSION}:hub`, "#{window_id}"]);
	if (hubWindowId) {
		tmux(["set-option", "-t", HUB_TMUX_SESSION, HUB_WINDOW_OPT, hubWindowId]);
	}
}

/** The hub window id recorded on the hub session, or the conventional target. */
export function hubWindowTarget(): string {
	const id = tmux(["show-option", "-v", "-t", HUB_TMUX_SESSION, HUB_WINDOW_OPT]);
	return id && id.length > 0 ? id : `${HUB_TMUX_SESSION}:hub`;
}

/**
 * Attach the terminal to the hub session (from a bare shell) or switch the
 * current tmux client to it (when already inside tmux). Attaching blocks until
 * the client detaches; switching returns immediately.
 */
export function enterHubSession(): void {
	if (insideTmux()) {
		tmux(["switch-client", "-t", HUB_TMUX_SESSION]);
		return;
	}
	// attach-session must inherit the real terminal; run it as a foreground child.
	spawnSync("tmux", ["attach-session", "-t", HUB_TMUX_SESSION], { stdio: "inherit" });
}

/** List the per-session windows in the hub (excludes the hub window itself). */
export function listSessionWindows(): HubWindow[] {
	const fmt = [
		"#{window_id}",
		"#{window_index}",
		"#{window_name}",
		`#{${SESSION_TITLE_OPT}}`,
		`#{${SESSION_PATH_OPT}}`,
		"#{window_active}",
	].join("\t");
	const out = tmux(["list-windows", "-t", HUB_TMUX_SESSION, "-F", fmt]);
	if (!out) return [];
	const hubTarget = hubWindowTarget();
	const windows: HubWindow[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [windowId, index, name, title, sessionPath, active] = line.split("\t");
		if (!windowId) continue;
		// Skip the hub window itself (matched by id or, as a fallback, by name).
		if (windowId === hubTarget || name === "hub") continue;
		windows.push({
			windowId,
			index: Number(index) || 0,
			name: name ?? "",
			title: title && title.length > 0 ? title : name || "session",
			sessionPath: sessionPath && sessionPath.length > 0 ? sessionPath : undefined,
			active: active === "1",
		});
	}
	return windows;
}

/** The window currently hosting `sessionPath`, if one exists. */
export function findWindowForSession(sessionPath: string): HubWindow | undefined {
	return listSessionWindows().find(w => w.sessionPath === sessionPath);
}

/** Environment assignments (as `-e KEY=VALUE` args) for a spawned session window. */
function sessionWindowEnv(): string[] {
	return ["-e", `${HUB_ENV}=${HUB_TMUX_SESSION}`, "-e", `${HUB_WINDOW_ENV}=${hubWindowTarget()}`];
}

/**
 * Foreground the session at `sessionPath`: select its existing window, or open a
 * new window running `omp --resume <path>` tagged so it is reused next time.
 * `name` labels the tmux window. Returns the target window id.
 */
export function foregroundSession(sessionPath: string, name: string): string | null {
	const existing = findWindowForSession(sessionPath);
	if (existing) {
		tmux(["select-window", "-t", existing.windowId]);
		return existing.windowId;
	}
	const argv = [...selfInvocation(), "--resume", sessionPath];
	const windowId = tmux([
		"new-window",
		"-t",
		HUB_TMUX_SESSION,
		"-n",
		tmuxSafeName(name),
		"-P",
		"-F",
		"#{window_id}",
		...sessionWindowEnv(),
		shellCommand(argv),
	]);
	if (windowId) {
		// `-w` scopes the option to the window; without it tmux sets it at session
		// scope, where every window would inherit the same value.
		tmux(["set-option", "-w", "-t", windowId, SESSION_PATH_OPT, sessionPath]);
		tmux(["set-option", "-w", "-t", windowId, SESSION_TITLE_OPT, name]);
	}
	return windowId;
}

/**
 * Dispatch a brand-new session: open a window running `omp` seeded with
 * `prompt`. The session `.jsonl` does not exist yet, so the window is tagged
 * only with a name; it is reconciled to a session path on a later hub refresh
 * (the window's own omp process owns the new session). Returns the window id.
 */
export function dispatchSession(prompt: string): string | null {
	const argv = prompt.trim().length > 0 ? [...selfInvocation(), prompt] : [...selfInvocation()];
	const windowId = tmux([
		"new-window",
		"-t",
		HUB_TMUX_SESSION,
		"-n",
		tmuxSafeName(prompt || "new session"),
		"-P",
		"-F",
		"#{window_id}",
		...sessionWindowEnv(),
		shellCommand(argv),
	]);
	if (windowId) {
		tmux(["set-option", "-w", "-t", windowId, SESSION_TITLE_OPT, tmuxSafeName(prompt || "new session")]);
	}
	return windowId;
}

/** Select a tmux window in the hub session (foreground it for the attached client). */
export function selectWindow(target: string): void {
	tmux(["select-window", "-t", target]);
}

/** Kill a per-session window, terminating its omp process (the session file remains on disk). */
export function killWindow(windowId: string): void {
	tmux(["kill-window", "-t", windowId]);
}

/** Detach the current tmux client, returning the terminal to the shell. */
export function detachClient(): void {
	tmux(["detach-client"]);
}

/** Name of the tmux session the current process runs in, or null when not in tmux. */
export function currentTmuxSession(): string | null {
	if (!insideTmux()) return null;
	return tmux(["display-message", "-p", "#{session_name}"]);
}

/** Window id of the current process's tmux window, or null when not in tmux. */
export function currentTmuxWindow(): string | null {
	if (!insideTmux()) return null;
	return tmux(["display-message", "-p", "#{window_id}"]);
}

/** A short, tmux-safe window name (single line, capped, no separators). */
function tmuxSafeName(raw: string): string {
	const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/[:.]/g, "-").trim();
	const capped = cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned;
	return capped.length > 0 ? capped : "session";
}
