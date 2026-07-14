/**
 * Hub runtime — entry logic for `omp hub`.
 *
 * Outside the hub tmux session (bare shell or a different tmux session) it
 * ensures the hub session exists and attaches/switches to it. Running as the
 * hub window's own process (inside the hub session, on the hub window) it
 * renders the {@link HubView} fullscreen and wires its actions to tmux.
 */
import { statSync } from "node:fs";
import { ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { initTheme } from "../modes/theme/theme";
import { getRecentSessions } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { HubView, type HubRow } from "./hub-view";
import {
	currentTmuxSession,
	currentTmuxWindow,
	detachClient,
	dispatchSession,
	ensureHubSession,
	enterHubSession,
	foregroundSession,
	HUB_TMUX_SESSION,
	hubWindowTarget,
	killWindow,
	listSessionWindows,
	selectWindow,
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
 * and (b) the last time the window was foregrounded. The killed omp process
 * ends; the session file stays on disk, so the session drops to an idle row and
 * re-foregrounding respawns it fresh via `omp --resume`. The active window is
 * never reaped (and its activity is refreshed here); freshly-dispatched windows
 * without a session path yet are skipped.
 */
function reapStaleLiveWindows(): void {
	const now = Date.now();
	const windows = listSessionWindows();
	const liveIds = new Set(windows.map(w => w.windowId));
	for (const id of lastActiveAt.keys()) {
		if (!liveIds.has(id)) lastActiveAt.delete(id);
	}
	for (const window of windows) {
		if (window.active) {
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
 * Merge live tmux windows with recent on-disk sessions into hub rows. Live rows
 * (running omp processes) come first, then idle recent sessions that don't
 * already have a live window. Idle rows need a disk scan, so this is async.
 */
async function buildRows(): Promise<HubRow[]> {
	const liveWindows = listSessionWindows();
	const livePaths = new Set(liveWindows.map(w => w.sessionPath).filter((p): p is string => Boolean(p)));
	const liveRows: HubRow[] = liveWindows.map(w => ({
		key: w.sessionPath ?? w.windowId,
		title: w.title || w.name || "session",
		meta: w.active ? "live · foreground" : "live",
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

/** True when this process is the hub window's own process (render the TUI here). */
function isHubWindowProcess(): boolean {
	if (currentTmuxSession() !== HUB_TMUX_SESSION) return false;
	const window = currentTmuxWindow();
	return window !== null && window === hubWindowTarget();
}

/**
 * Render the hub TUI in the current (hub) window. The hub is the tmux-resident
 * supervisor: Esc *detaches* the client (returns the terminal to the shell) but
 * the hub process keeps running in its window, so its refresh loop — which
 * reaps stale live sessions — runs whether or not anyone is attached. The
 * returned promise resolves only if the UI stops (e.g. the hub window is
 * killed), keeping the process alive meanwhile.
 */
async function renderHub(): Promise<void> {
	await initTheme();
	const ui = new TUI(new ProcessTerminal());
	// Never resolves: the hub lives until tmux kills its window (SIGHUP ends the
	// process). Detach (Esc) leaves it running as the background supervisor.
	const persist = new Promise<void>(() => undefined);
	let latestRows: HubRow[] = [];

	const view = new HubView(
		{
			onForeground: row => {
				if (row.live && row.windowId) {
					selectWindow(row.windowId);
				} else if (row.sessionPath) {
					foregroundSession(row.sessionPath, row.title);
				}
			},
			onDispatch: prompt => dispatchSession(prompt),
			// Detach only: the hub keeps running so background reaping continues.
			onExit: () => detachClient(),
		},
		() => latestRows,
	);

	const refresh = async () => {
		reapStaleLiveWindows();
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

/** Entry for `omp hub`: attach/switch to the hub, or render it when we are the hub window. */
export async function runHub(): Promise<void> {
	if (isHubWindowProcess()) {
		await renderHub();
		return;
	}
	ensureHubSession();
	enterHubSession();
}
