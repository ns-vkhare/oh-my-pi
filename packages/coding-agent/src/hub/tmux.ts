/**
 * tmux orchestration for the session hub.
 *
 * The hub uses tmux as a session supervisor, split into a shared backend and
 * per-client views so two `omp hub` runs in the same project no longer mirror
 * each other:
 *
 * - **Backend session** (one per project, see {@link hubTmuxSession}): window 0
 *   runs a headless supervisor (reaps stale windows/views, anchors the session
 *   so it survives with zero live sessions); every live omp conversation is its
 *   own window here. No client ever attaches to the backend directly.
 * - **View sessions** (`omp-view-…`, one per attached client): each is a client's
 *   own hub TUI in window 0. Foregrounding a session `link-window`s the backend
 *   window into the view and selects it there — the same omp process is shared,
 *   but each client's *current window* is independent, so clients navigate to
 *   different sessions without reflecting each other.
 *
 * tmux keeps unselected windows running, so a session the user switched away
 * from keeps generating in the background and resumes when re-selected — the
 * Claude-Code "agent view" model, with tmux as the supervisor.
 *
 * Per-session windows are tagged with the `@omp_session_path` user option so the
 * hub can re-foreground an existing window instead of opening a duplicate, and
 * are spawned with `OMP_HUB` in their environment so the in-session left-arrow
 * gesture ({@link switchViewersHome}) can switch each viewing client back to its
 * own view's hub window.
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";

/** Prefix for every backend hub tmux session name. */
const HUB_SESSION_PREFIX = "omp-hub";
/** Prefix for every per-client view tmux session name (distinct from the backend prefix so `omp hub list` never counts a view as a hub). */
const HUB_VIEW_PREFIX = "omp-view";

/**
 * tmux session name for the backend hub, scoped to the current project directory.
 *
 * A single shared name made two concurrent `omp hub` runs attach to the same
 * tmux session, and tmux mirrors the current window across every client on one
 * session — so the two hubs reflected each other and parallel workflows across
 * projects were impossible. Keying the name on the project dir gives each
 * project its own hub while still letting a re-run in the same project reattach
 * to its existing background hub (the data listing is already project-scoped via
 * `getProjectDir()`, so this aligns the tmux scope with it).
 *
 * The name is the human-readable project basename (so `tmux ls` is legible),
 * with a short hash of the full path appended to disambiguate distinct projects
 * that share a basename. Computed lazily rather than as a module const because
 * the project dir is resolved during CLI startup (`setProjectDir`, e.g. to a
 * git root) after this module loads; the hub window re-derives the same name
 * from the same cwd it is spawned in.
 */
export function hubTmuxSession(): string {
	const dir = getProjectDir();
	const slug = path
		.basename(dir)
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	const hash = Bun.hash(dir).toString(16).slice(-6);
	return slug ? `${HUB_SESSION_PREFIX}-${slug}-${hash}` : `${HUB_SESSION_PREFIX}-${hash}`;
}

/**
 * View-session name base for the current project: the backend name with the
 * backend prefix swapped for the view prefix. A concrete view appends a random
 * suffix (`<base>-<rand>`); `<base>-` is the match key for {@link listHubViews}.
 */
function hubViewBase(): string {
	return `${HUB_VIEW_PREFIX}${hubTmuxSession().slice(HUB_SESSION_PREFIX.length)}`;
}

/** tmux user option (per window) recording which session `.jsonl` a window hosts. */
const SESSION_PATH_OPT = "@omp_session_path";
/** tmux user option (per window) recording the hub's chosen display title (omp's OSC title otherwise renames the window). */
const SESSION_TITLE_OPT = "@omp_session_title";
/** tmux user option (per session) recording the session's own hub window id (backend supervisor window, or a view's TUI window). */
const HUB_WINDOW_OPT = "@omp_hub_window";
/** Env var set on per-session windows so the in-session gesture knows it is hub-managed. Value is the backend session name. */
export const HUB_ENV = "OMP_HUB";
/** Env var marking the backend supervisor process (window 0 of the backend session). */
export const HUB_BACKEND_ENV = "OMP_HUB_BACKEND";
/** Env var marking a per-client view TUI process (window 0 of a view session). */
export const HUB_VIEW_ENV = "OMP_HUB_VIEW";
/**
 * Env var set only on freshly *dispatched* hub session windows (not resumed
 * ones). Signals the new omp process that this session was started blank from
 * the hub, so the agent can prefer an isolated worktree by default.
 */
export const HUB_NEW_SESSION_ENV = "OMP_HUB_NEW_SESSION";

/** A live per-session window in the backend hub tmux session. */
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

/** A per-client view session for the current project's backend. */
export interface HubView {
	/** tmux session name (e.g. `omp-view-my-project-e49ce6-1a2b3c4d`). */
	session: string;
	/** Whether a tmux client is currently attached to this view. */
	attached: boolean;
	/** tmux session activity time (epoch seconds), or 0 if unknown. */
	activityEpoch: number;
}

/** A hub tmux session on the local tmux server (one per project). */
export interface HubSummary {
	/** tmux session name (e.g. `omp-hub-my-project-e49ce6`). */
	session: string;
	/** Project directory the hub supervises (the hub window's cwd), or "" if unknown. */
	project: string;
	/** Number of live omp session windows (excludes the hub window itself). */
	sessions: number;
	/** Whether a tmux client is currently attached to this hub. */
	attached: boolean;
	/** tmux session activity time (epoch seconds), or 0 if unknown. */
	activityEpoch: number;
	/** True when this hub is the one for the current project directory. */
	current: boolean;
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

/** True when the backend hub tmux session already exists. */
export function hubSessionExists(): boolean {
	const result = spawnSync("tmux", ["has-session", "-t", hubTmuxSession()], { stdio: "ignore" });
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
 * The backend hub's supervisor window id (recorded on the session), or the
 * conventional `<session>:hub` target as a fallback.
 */
function backendHubWindowId(): string {
	const id = tmux(["show-option", "-v", "-t", hubTmuxSession(), HUB_WINDOW_OPT]);
	return id && id.length > 0 ? id : `${hubTmuxSession()}:hub`;
}

/**
 * The tmux status bar's folder + branch segments duplicate omp's own statusline
 * (every session window is an omp process, cwd/branch and all). Strip just those
 * modules from status-left for `session`, keeping the session label and every
 * status-right metric (CPU / RAM / load / host). Only known folder/branch
 * modules are removed; an unrecognized status-left is left untouched, so no
 * theme is broken.
 */
function stripHubStatusLeft(session: string): void {
	const globalStatusLeft = tmux(["show-options", "-gv", "status-left"]);
	if (!globalStatusLeft) return;
	const redundant = [
		/#\{E:@catppuccin_status_directory\}/g,
		/#\{E:@catppuccin_status_gitmux\}/g,
		/#\{E:@catppuccin_status_git\}/g,
		/#\{E:@catppuccin_status_path\}/g,
	];
	let hubStatusLeft = globalStatusLeft;
	for (const re of redundant) hubStatusLeft = hubStatusLeft.replace(re, "");
	tmux(["set-option", "-t", session, "status-left", hubStatusLeft]);
}

/**
 * Ensure the backend hub session exists with its supervisor in window 0.
 * Idempotent: a no-op when the session is already up. Window 0 runs `omp hub`
 * marked with {@link HUB_BACKEND_ENV}, which routes it to the headless
 * supervisor (reaping + anchor). No client attaches here — clients get their
 * own view sessions ({@link enterHubView}). Records the supervisor window id in
 * a session option so `list`/skip logic can identify it.
 */
export function ensureBackendSession(): void {
	if (hubSessionExists()) return;
	const session = hubTmuxSession();
	const supervisorCmd = shellCommand([...selfInvocation(), "hub"]);
	tmux(["new-session", "-d", "-s", session, "-n", "hub", "-e", `${HUB_BACKEND_ENV}=1`, supervisorCmd]);
	const hubWindowId = tmux(["display-message", "-p", "-t", `${session}:hub`, "#{window_id}"]);
	if (hubWindowId) tmux(["set-option", "-t", session, HUB_WINDOW_OPT, hubWindowId]);
}

/** Every per-client view session for the current project's backend. */
export function listHubViews(): HubView[] {
	const fmt = ["#{session_name}", "#{session_attached}", "#{session_activity}"].join("\t");
	const out = tmux(["list-sessions", "-F", fmt]);
	if (!out) return [];
	const base = `${hubViewBase()}-`;
	const views: HubView[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [name, attached, activity] = line.split("\t");
		if (!name?.startsWith(base)) continue;
		views.push({ session: name, attached: attached === "1", activityEpoch: Number(activity) || 0 });
	}
	return views;
}

/** Create a fresh per-client view session running its own hub TUI in window 0. Returns its session name. */
function createHubView(): string {
	const session = `${hubViewBase()}-${crypto.randomUUID().slice(0, 8)}`;
	const viewCmd = shellCommand([...selfInvocation(), "hub"]);
	tmux(["new-session", "-d", "-s", session, "-n", "hub", "-e", `${HUB_VIEW_ENV}=1`, viewCmd]);
	stripHubStatusLeft(session);
	const hubWindowId = tmux(["display-message", "-p", "-t", `${session}:hub`, "#{window_id}"]);
	if (hubWindowId) tmux(["set-option", "-t", session, HUB_WINDOW_OPT, hubWindowId]);
	return session;
}

/**
 * Enter a per-client hub view: reuse an unattached view for this project if one
 * exists (backward-compatible detach → reattach), else create a fresh one, then
 * attach the terminal to it (from a bare shell) or switch the current tmux
 * client to it (when already inside tmux). Attaching blocks until the client
 * detaches; switching returns immediately.
 */
export function enterHubView(): void {
	const reusable = listHubViews().find(v => !v.attached);
	const session = reusable?.session ?? createHubView();
	if (insideTmux()) {
		tmux(["switch-client", "-t", session]);
		return;
	}
	// attach-session must inherit the real terminal; run it as a foreground child.
	spawnSync("tmux", ["attach-session", "-t", session], { stdio: "inherit" });
}

/** List the live per-session windows in the backend hub (excludes the supervisor window). */
export function listSessionWindows(): HubWindow[] {
	const fmt = [
		"#{window_id}",
		"#{window_index}",
		"#{window_name}",
		`#{${SESSION_TITLE_OPT}}`,
		`#{${SESSION_PATH_OPT}}`,
		"#{window_active}",
	].join("\t");
	const out = tmux(["list-windows", "-t", hubTmuxSession(), "-F", fmt]);
	if (!out) return [];
	const hubTarget = backendHubWindowId();
	const windows: HubWindow[] = [];
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [windowId, index, name, title, sessionPath, active] = line.split("\t");
		if (!windowId) continue;
		// Skip the supervisor window itself (matched by id or, as a fallback, by name).
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

/** The backend window currently hosting `sessionPath`, if one exists. */
export function findWindowForSession(sessionPath: string): HubWindow | undefined {
	return listSessionWindows().find(w => w.sessionPath === sessionPath);
}

/**
 * Enumerate every backend hub tmux session on the local tmux server (one per
 * project).
 *
 * A single `list-panes -a` call yields all panes across all sessions; sessions
 * whose name carries the {@link HUB_SESSION_PREFIX} are hubs (view sessions use
 * a distinct prefix and are excluded). Per hub the project dir is the cwd of its
 * lowest-indexed window (the supervisor window, created first), the live-session
 * count excludes that window, and attach state / activity come from the
 * session-level fields tmux exposes in the pane context. Returns [] when no
 * tmux server is running.
 */
export function listHubs(): HubSummary[] {
	const fmt = [
		"#{session_name}",
		"#{session_windows}",
		"#{session_attached}",
		"#{session_activity}",
		"#{window_index}",
		"#{pane_current_path}",
	].join("\t");
	const out = tmux(["list-panes", "-a", "-F", fmt]);
	if (!out) return [];
	return parseHubPanes(out, hubTmuxSession());
}

/**
 * Parse the tab-separated `list-panes -a` output into per-hub summaries. Pure
 * (no tmux) so it is unit-testable. Rows are grouped by session; only sessions
 * whose name is exactly the backend prefix segment (`omp-hub-…`, not the
 * `omp-view-…` views) count, the project dir is taken from the lowest-indexed
 * window (the supervisor window), the live-session count excludes that window,
 * and hubs are sorted most-recently-active first. `currentSession` is flagged so
 * callers can mark the current project's hub.
 */
export function parseHubPanes(out: string, currentSession: string): HubSummary[] {
	const prefix = `${HUB_SESSION_PREFIX}-`;
	// Accumulate per session; keep the pane cwd from the lowest window index.
	const bySession = new Map<string, { summary: HubSummary; hubWindowIndex: number }>();
	for (const line of out.split("\n")) {
		if (!line) continue;
		const [name, windows, attached, activity, windowIndex, panePath] = line.split("\t");
		if (!name?.startsWith(prefix)) continue;
		const idx = Number(windowIndex);
		const entry = bySession.get(name);
		if (!entry) {
			bySession.set(name, {
				hubWindowIndex: Number.isFinite(idx) ? idx : 0,
				summary: {
					session: name,
					project: panePath ?? "",
					sessions: Math.max(0, (Number(windows) || 1) - 1),
					attached: attached === "1",
					activityEpoch: Number(activity) || 0,
					current: name === currentSession,
				},
			});
		} else if (Number.isFinite(idx) && idx < entry.hubWindowIndex) {
			entry.hubWindowIndex = idx;
			entry.summary.project = panePath ?? "";
		}
	}
	return [...bySession.values()].map(e => e.summary).sort((a, b) => b.activityEpoch - a.activityEpoch);
}

/** Environment assignments (as `-e KEY=VALUE` args) for a spawned backend session window.
 * `newSession` marks a freshly dispatched (blank) session vs. a resumed one. */
function sessionWindowEnv(newSession = false): string[] {
	const env = ["-e", `${HUB_ENV}=${hubTmuxSession()}`];
	if (newSession) env.push("-e", `${HUB_NEW_SESSION_ENV}=1`);
	return env;
}

/**
 * Ensure a backend window running `omp --resume <sessionPath>` exists, without
 * foregrounding it (the caller links it into a view via {@link focusWindowInView}).
 * Reuses the existing window when the session is already live. `name` labels the
 * tmux window. Returns the backend window id.
 */
export function ensureBackendSessionWindow(sessionPath: string, name: string): string | null {
	const existing = findWindowForSession(sessionPath);
	if (existing) return existing.windowId;
	const argv = [...selfInvocation(), "--resume", sessionPath];
	const windowId = tmux([
		"new-window",
		"-d",
		"-t",
		hubTmuxSession(),
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
 * Dispatch a brand-new session in the backend: open a window running `omp`
 * seeded with `prompt` and any `imagePaths` (passed as `@file` args so the new
 * process attaches them exactly like `omp @img.png "prompt"`), without
 * foregrounding it (the caller links it into a view via {@link focusWindowInView}).
 * The session `.jsonl` does not exist yet, so the window is tagged only with a
 * provisional name; the window's own omp process back-fills `@omp_session_path`
 * (and the real title) via {@link tagHubWindow} once it creates the session,
 * letting the hub dedup the live window against its on-disk session. Returns the
 * backend window id.
 */
export function dispatchBackendSession(prompt: string, imagePaths: readonly string[] = []): string | null {
	const fileArgs = imagePaths.map(p => `@${p}`);
	const trimmed = prompt.trim();
	const argv = [...selfInvocation(), ...fileArgs, ...(trimmed.length > 0 ? [trimmed] : [])];
	const windowId = tmux([
		"new-window",
		"-d",
		"-t",
		hubTmuxSession(),
		"-n",
		tmuxSafeName(prompt || "new session"),
		"-P",
		"-F",
		"#{window_id}",
		...sessionWindowEnv(true),
		shellCommand(argv),
	]);
	if (windowId) {
		tmux(["set-option", "-w", "-t", windowId, SESSION_TITLE_OPT, tmuxSafeName(prompt || "new session")]);
	}
	return windowId;
}

/**
 * Foreground a backend window in the *current* view: link it into this view
 * session (if not already linked — a duplicate `link-window` creates a second
 * entry for the same window), then select it. Only the calling client's view is
 * affected, so concurrent clients keep independent current windows. No-op
 * outside a tmux client.
 */
export function focusWindowInView(windowId: string): void {
	const view = currentTmuxSession();
	if (!view) return;
	const present = (tmux(["list-windows", "-t", view, "-F", "#{window_id}"]) ?? "").split("\n");
	if (!present.includes(windowId)) {
		tmux(["link-window", "-d", "-s", windowId, "-t", `${view}:`]);
	}
	tmux(["select-window", "-t", `${view}:${windowId}`]);
}

/**
 * The in-session left-arrow back gesture: send every client currently viewing
 * *this* omp window back to its own view's hub window. Because a backend window
 * can be linked into several views at once, this resolves viewers via
 * `list-clients` and switches each to the hub window recorded on *its* view
 * session — so client A returning to its hub never moves client B. Run from the
 * omp process inside the linked window. No-op outside tmux.
 */
export function switchViewersHome(): void {
	const win = currentTmuxWindow();
	if (!win) return;
	const clients = tmux(["list-clients", "-F", "#{client_name}\t#{client_session}\t#{window_id}"]);
	if (!clients) return;
	for (const line of clients.split("\n")) {
		if (!line) continue;
		const [client, session, windowId] = line.split("\t");
		if (windowId !== win) continue;
		const home = tmux(["show-option", "-qv", "-t", session, HUB_WINDOW_OPT]);
		if (home) tmux(["switch-client", "-c", client, "-t", `${session}:${home}`]);
	}
}

/** Kill a backend per-session window, terminating its omp process (the session file remains on disk). */
export function killWindow(windowId: string): void {
	tmux(["kill-window", "-t", windowId]);
}

/** Kill a tmux session (used by the supervisor to reap stale, unattached views). */
export function killSession(session: string): void {
	tmux(["kill-session", "-t", session]);
}

/** The set of window ids currently displayed by some attached client (any session). */
export function viewedWindowIds(): Set<string> {
	const out = tmux(["list-clients", "-F", "#{window_id}"]);
	if (!out) return new Set();
	return new Set(out.split("\n").filter(Boolean));
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

/**
 * Tag the current process's own backend window with the session path (and, when
 * known, the display title) it now hosts.
 *
 * A freshly *dispatched* window is opened before its session `.jsonl` exists,
 * so {@link dispatchBackendSession} can only tag it with a provisional name —
 * never `@omp_session_path`. Without the path, the hub's row builder cannot
 * dedup the live window against its own on-disk session, so the session shows up
 * twice (once live under the capped dispatch prompt, once idle under its real
 * title). The in-session omp process closes that gap by calling this once it
 * knows its session file, and again whenever the session is renamed. No-op
 * outside a hub-managed window. `title` control chars are flattened so the
 * tab-separated `list-windows` read-back stays parseable; length is left to the
 * hub to cap.
 */
export function tagHubWindow(sessionPath: string, title?: string): void {
	if (!insideTmux() || !process.env[HUB_ENV]) return;
	const windowId = currentTmuxWindow();
	if (!windowId) return;
	tmux(["set-option", "-w", "-t", windowId, SESSION_PATH_OPT, sessionPath]);
	const cleanTitle = title?.replace(/[\r\n\t]+/g, " ").trim();
	if (cleanTitle) {
		tmux(["set-option", "-w", "-t", windowId, SESSION_TITLE_OPT, cleanTitle]);
	}
}

/** A short, tmux-safe window name (single line, capped, no separators). */
function tmuxSafeName(raw: string): string {
	const cleaned = raw
		.replace(/[\r\n\t]+/g, " ")
		.replace(/[:.]/g, "-")
		.trim();
	const capped = cleaned.length > 24 ? cleaned.slice(0, 24) : cleaned;
	return capped.length > 0 ? capped : "session";
}
