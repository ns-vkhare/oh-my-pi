/**
 * Hub runtime — entry logic for `omp hub`, dispatched three ways by env marker:
 *
 * - **Backend supervisor** ({@link HUB_BACKEND_ENV}, window 0 of the backend
 *   session): {@link runBackendSupervisor} — headless reap loop, no TUI, anchors
 *   the backend session.
 * - **View TUI** ({@link HUB_VIEW_ENV}, window 0 of a per-client view session):
 *   {@link renderHub} — the {@link HubView} fullscreen, wiring foreground/dispatch
 *   to link backend windows into *this* view.
 * - **Launcher** (bare shell or an unrelated tmux session): ensure the backend
 *   exists, then reuse/create a view session and enter it.
 */
import { statSync } from "node:fs";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../modes/theme/theme";
import { getRecentSessions } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { FileSessionStorage } from "../session/session-storage";
import { resolveSessionWorktree } from "../session/session-worktree";
import { shortenPath } from "../tools/render-utils";
import * as git from "../utils/git";
import { type HubRow, HubView } from "./hub-view";
import {
	currentTmuxWindow,
	detachClient,
	dispatchBackendSession,
	ensureBackendSession,
	ensureBackendSessionWindow,
	enterHubView,
	focusWindowInView,
	HUB_BACKEND_ENV,
	HUB_VIEW_ENV,
	type HubSummary,
	killSession,
	killWindow,
	listHubs,
	listHubViews,
	listSessionWindows,
	viewedWindowIds,
} from "./tmux";

/** How many recent (idle) sessions to surface alongside live ones. */
const IDLE_SESSION_LIMIT = 12;
/** Row refresh cadence while the hub is open (live windows come and go). */
const REFRESH_MS = 2000;
/** A live session idle longer than this is reaped: its window is killed and it
 *  reverts to an idle row. Returning to it respawns a fresh `omp --resume`. */
const STALE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * Last wall-clock time each live window was the active (foregrounded) window,
 * keyed by tmux window id. "Coming back to" a session counts as activity even
 * when the resumed omp writes nothing, so the reaper spares a window the user
 * recently viewed. Reset on hub restart (no live windows survive that anyway).
 */
const lastActiveAt = new Map<string, number>();

/**
 * Kill live session windows idle longer than {@link STALE_SESSION_MS}, measured
 * as the most recent of (a) the session `.jsonl` mtime — the "timeAgo" signal —
 * and (b) the last time some client viewed the window. The killed omp process
 * ends; the session file stays on disk, so the session drops to an idle row and
 * re-foregrounding respawns it fresh via `omp --resume`. A window currently
 * viewed by any client is never reaped (and its activity is refreshed here);
 * freshly-dispatched windows without a session path yet are skipped. Runs in the
 * backend supervisor, which has no attached client of its own — hence viewers
 * come from `list-clients` across every view, not the backend's own current
 * window.
 */
function reapStaleLiveWindows(): void {
	const now = Date.now();
	const windows = listSessionWindows();
	const viewed = viewedWindowIds();
	const liveIds = new Set(windows.map(w => w.windowId));
	for (const id of lastActiveAt.keys()) {
		if (!liveIds.has(id)) lastActiveAt.delete(id);
	}
	for (const window of windows) {
		if (viewed.has(window.windowId)) {
			lastActiveAt.set(window.windowId, now);
			continue;
		}
		if (!window.sessionPath) continue;
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(window.sessionPath).mtimeMs;
		} catch {
			// Session file gone (deleted): reap the orphaned window.
			killWindow(window.windowId);
			lastActiveAt.delete(window.windowId);
			continue;
		}
		const lastActivity = Math.max(mtimeMs, lastActiveAt.get(window.windowId) ?? 0);
		if (now - lastActivity > STALE_SESSION_MS) {
			killWindow(window.windowId);
			lastActiveAt.delete(window.windowId);
		}
	}
}

/**
 * Kill per-client view sessions left unattached longer than {@link STALE_SESSION_MS}.
 * A detached view lingers so a re-run reattaches to it (backward-compatible Esc),
 * but an abandoned one is reaped so views don't accumulate forever. The backend
 * windows a view linked survive — `kill-session` only unlinks them.
 */
function reapStaleViews(): void {
	const now = Date.now();
	for (const view of listHubViews()) {
		if (view.attached) continue;
		if (now - view.activityEpoch * 1000 > STALE_SESSION_MS) killSession(view.session);
	}
}

/**
 * Merge live tmux windows with recent on-disk sessions into hub rows. Live rows
 * (running omp processes) come first, then idle recent sessions that don't
 * already have a live window. Idle rows need a disk scan, so this is async.
 */
async function buildRows(): Promise<HubRow[]> {
	const liveWindows = listSessionWindows();
	const livePaths = new Set(liveWindows.map(w => w.sessionPath).filter((p): p is string => Boolean(p)));
	// "Foreground" is per-view: the backend window this view currently shows.
	const viewCurrentWindow = currentTmuxWindow();
	const liveRows: HubRow[] = liveWindows.map(w => ({
		key: w.sessionPath ?? w.windowId,
		title: w.title || w.name || "session",
		meta: w.windowId === viewCurrentWindow ? "live · foreground" : "live",
		live: true,
		sessionPath: w.sessionPath,
		windowId: w.windowId,
	}));

	let idleRows: HubRow[] = [];
	try {
		const sessionDir = SessionManager.getDefaultSessionDir(getProjectDir());
		const recent = await getRecentSessions(sessionDir, IDLE_SESSION_LIMIT + livePaths.size);
		idleRows = recent
			.filter(s => !livePaths.has(s.path))
			.slice(0, IDLE_SESSION_LIMIT)
			.map(s => ({
				key: s.path,
				title: s.name,
				meta: s.timeAgo,
				live: false,
				sessionPath: s.path,
				windowId: undefined,
			}));
	} catch {
		idleRows = [];
	}
	return [...liveRows, ...idleRows];
}

/**
 * Render the hub TUI as a per-client view (window 0 of a view session). Esc
 * *detaches* the client (returns the terminal to the shell) but this view
 * process keeps running unattached, so a later `omp hub` reattaches to it (its
 * selected session is preserved). Foreground/dispatch link the shared backend
 * window into *this* view and select it there, so concurrent clients navigate
 * independently. Reaping is the backend supervisor's job, not the view's. The
 * returned promise resolves only if the UI stops (e.g. the view is killed).
 */
async function renderHub(): Promise<void> {
	await initTheme();
	const ui = new TUI(new ProcessTerminal());
	// Never resolves: the view lives until tmux kills its session/window.
	const persist = new Promise<void>(() => undefined);
	let latestRows: HubRow[] = [];

	const view = new HubView(
		{
			onForeground: row => {
				const windowId =
					row.live && row.windowId
						? row.windowId
						: row.sessionPath
							? ensureBackendSessionWindow(row.sessionPath, row.title)
							: null;
				if (windowId) focusWindowInView(windowId);
			},
			onDispatch: (prompt, imagePaths) => {
				const windowId = dispatchBackendSession(prompt, imagePaths);
				if (windowId) focusWindowInView(windowId);
				return windowId;
			},
			// Delete a session: kill its live window (if any), recover its worktree
			// BEFORE unlinking the file (resolution reads the .jsonl), then remove the
			// session + artifacts. Returns the worktree path when one is safely removable.
			onDelete: async row => {
				if (row.live && row.windowId) killWindow(row.windowId);
				let worktree: string | null = null;
				if (row.sessionPath) {
					worktree = await resolveSessionWorktree(row.sessionPath);
					await new FileSessionStorage().deleteSessionWithArtifacts(row.sessionPath);
				}
				latestRows = await buildRows();
				return worktree;
			},
			onDeleteWorktree: async worktreePath => {
				await git.worktree.remove(getProjectDir(), worktreePath, { force: true });
				latestRows = await buildRows();
			},
			// Detach only: the view keeps running unattached for later reattach.
			onExit: () => detachClient(),
			requestRender: () => ui.requestRender(),
		},
		() => latestRows,
	);

	const refresh = async () => {
		latestRows = await buildRows();
		view.refresh();
		ui.requestRender();
	};
	await refresh();

	setInterval(() => void refresh(), REFRESH_MS);
	ui.showOverlay(view, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	ui.setFocus(view);
	ui.start();
	return persist;
}

/**
 * The backend supervisor (window 0 of the backend session): a headless reap
 * loop with no TUI. Reaps stale live windows and abandoned view sessions on a
 * cadence, and — as window 0 of a never-attached session — anchors the backend
 * so it survives with zero live sessions. Never resolves.
 */
function runBackendSupervisor(): Promise<void> {
	const tick = () => {
		reapStaleLiveWindows();
		reapStaleViews();
	};
	tick();
	setInterval(tick, REFRESH_MS);
	return new Promise<void>(() => undefined);
}

/**
 * Entry for `omp hub`. Env markers select the role: backend supervisor, view
 * TUI, or launcher (ensure the backend exists, then reuse/create a view and
 * enter it).
 */
export async function runHub(): Promise<void> {
	if (process.env[HUB_BACKEND_ENV]) {
		await runBackendSupervisor();
		return;
	}
	if (process.env[HUB_VIEW_ENV]) {
		await renderHub();
		return;
	}
	ensureBackendSession();
	enterHubView();
}

/** Compact relative time for a hub's last-activity epoch (seconds). */
function formatActivityAgo(epochSeconds: number): string {
	if (!epochSeconds) return "-";
	const diffMs = Date.now() - epochSeconds * 1000;
	const mins = Math.floor(diffMs / 60_000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(diffMs / 3_600_000);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(diffMs / 86_400_000);
	return `${days}d ago`;
}

/**
 * `omp hub list` — print every active hub tmux session (one per project) to
 * stdout: which project it supervises, how many live omp sessions it holds,
 * whether a client is attached, and how recently it was active. The hub for the
 * current project is marked with `*`.
 */
export async function runHubList(): Promise<void> {
	const hubs = listHubs();
	if (hubs.length === 0) {
		process.stdout.write("No active omp hubs.\n");
		return;
	}
	const rows = hubs.map((h: HubSummary) => ({
		mark: h.current ? "*" : " ",
		session: h.session,
		project: h.project ? shortenPath(h.project) : "-",
		sessions: String(h.sessions),
		attached: h.attached ? "attached" : "detached",
		activity: formatActivityAgo(h.activityEpoch),
	}));
	const headers = {
		mark: " ",
		session: "SESSION",
		project: "PROJECT",
		sessions: "SESSIONS",
		attached: "STATE",
		activity: "ACTIVITY",
	};
	const cols = ["session", "project", "sessions", "attached", "activity"] as const;
	const width = (key: (typeof cols)[number]) => Math.max(headers[key].length, ...rows.map(r => r[key].length));
	const widths = Object.fromEntries(cols.map(k => [k, width(k)])) as Record<(typeof cols)[number], number>;
	const line = (r: { mark: string } & Record<(typeof cols)[number], string>) =>
		`${r.mark} ${cols.map(k => r[k].padEnd(widths[k])).join("  ")}`.trimEnd();
	process.stdout.write(`${line(headers)}\n`);
	for (const r of rows) process.stdout.write(`${line(r)}\n`);
}
