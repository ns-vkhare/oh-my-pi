/**
 * `omp --watch <sessionPath>` — read-only spectator on a session **another
 * process owns**, typically one the Slack bridge daemon drives headlessly.
 *
 * This process never opens the session: no SessionManager (its `open` rewrites
 * the file), no tools, no agent, no writer. It tails the raw `.jsonl` through
 * {@link AgentTranscriptViewer}'s existing append-only reader and proxies every
 * write-shaped action out over the bridge control socket:
 *
 * - Enter  → `steer`     (the owner's turn picks the text up; it appears via the tail)
 * - Ctrl+X → `interrupt` (aborts the owner's main turn; its subagents survive by design)
 * - Ctrl+T → *take over*: park the bridge task, then hand the terminal to a real
 *            `omp --resume` of the same session
 * - Esc    → quit, no side effects
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { matchesKey, type OverlayHandle, ProcessTerminal, replaceTabs, TUI, truncateToWidth } from "@oh-my-pi/pi-tui";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "chalk";
import {
	type BridgeSubagentInfo,
	bridgeStatus,
	bridgeSubagents,
	interruptBridgeSession,
	type ParkOutcome,
	parkBridgeSession,
	steerBridgeSession,
} from "../hub/bridge-client";
import { selfInvocation } from "../hub/tmux";
import { AgentRegistry } from "../registry/agent-registry";
import { type SubagentTranscript, scanSubagentTranscripts } from "../registry/subagent-transcripts";
import { TRUNCATE_LENGTHS } from "../tools/render-utils";
import { AgentTranscriptViewer } from "./components/agent-transcript-viewer";
import { buildSubagentRows, SubagentPicker, type SubagentPickerRow } from "./components/subagent-picker";
import { theme } from "./theme/theme";

/** How long to wait between park retries while the Slack side finishes its turn. */
const PARK_RETRY_MS = 2000;

/** How often the spectator re-scans the session's subagent transcripts. */
const SUBAGENT_REFRESH_MS = 2000;

/**
 * Fit bridge-delivered text (Slack task name, park refusal reason) into a single
 * header row. Both arrive over the control socket as arbitrary remote strings —
 * `bridgeStatus` validates the wire *shape*, never the content — so a newline
 * would silently cost the frame a row it never accounted for, a tab would drift
 * the columns, and a raw ESC would reach the terminal verbatim. Same contract as
 * the viewer's own `sanitizeErrorLine`; see AGENTS.md "TUI Sanitization".
 */
export function headerCell(text: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " "), TRUNCATE_LENGTHS.TITLE);
}

/** Resolved `--watch` target, or the message to print instead. */
export type WatchTarget = { file: string; name: string } | { error: string };

export type PromoteDecision = { promote: true } | { promote: false; reason: string };

/**
 * Whether a park answer clears the way to resume the session in this terminal.
 * Mirrors `checkSlackBridgeConflict` in `main.ts` so the two ownership paths
 * cannot drift:
 *
 * - `absent` — no daemon exists, so nothing is holding the session. This is
 *   also the only way to reach one orphaned by a dead bridge.
 * - `parked` — the bridge stopped its child for us.
 * - `not-owned` — the bridge answered and does not drive this session.
 * - `busy` — the Slack side is mid-flight; retry with its reason.
 * - `indeterminate` — ownership UNKNOWN. Fails closed and retries: the daemon
 *   may be alive and halfway through parking, and attaching on a guess puts two
 *   agents on one session file.
 */
export function decidePromotion(outcome: ParkOutcome): PromoteDecision {
	switch (outcome.kind) {
		case "absent":
		case "parked":
		case "not-owned":
			return { promote: true };
		case "busy":
			return { promote: false, reason: outcome.reason };
		case "indeterminate":
			return { promote: false, reason: "bridge unresponsive" };
	}
}

/** Whether a take-over attempt ended with the session in this terminal's hands. */
export type OwnershipResult = "promote" | "cancelled";

/** Injected so the retry protocol can be driven without a TUI or a real clock. */
export interface OwnershipDeps {
	/** True once the spectator no longer wants the session. Re-checked after every await. */
	cancelled: () => boolean;
	/** Surface a retry reason between attempts. */
	onWait: (reason: string) => void;
	sleep: (ms: number) => Promise<void>;
}

/**
 * Retry `park` until the session is ours or the user gives up.
 *
 * The ordering here is the whole point. `park` is not a query: when it answers
 * `parked` the bridge has ALREADY stopped its RPC child and told the Slack
 * thread a terminal picked the session up. That cannot be undone, so a landed
 * park is honoured even when Esc arrived while it was in flight — reporting
 * "cancelled" there would leave a stopped session with no owner. Cancellation
 * is only ever reported when nothing was parked.
 */
export async function acquireOwnership(
	park: () => Promise<ParkOutcome>,
	deps: OwnershipDeps,
): Promise<OwnershipResult> {
	for (;;) {
		const outcome = await park();
		if (outcome.kind === "parked") return "promote";
		if (deps.cancelled()) return "cancelled";
		const decision = decidePromotion(outcome);
		if (decision.promote) return "promote";
		deps.onWait(decision.reason);
		await deps.sleep(PARK_RETRY_MS);
		if (deps.cancelled()) return "cancelled";
	}
}

/**
 * Validate a `--watch` argument into the absolute file the viewer tails plus a
 * fallback display name. Pure and synchronous: the caller prints `error` and
 * exits without having built any session machinery.
 *
 * The name drops the uuid half of omp's `<ISO>_<uuid>.jsonl` filenames: the
 * header sits on one row beside a fixed banner, and the full basename alone
 * overflows an 80-column terminal.
 */
export function resolveWatchTarget(sessionPath: string): WatchTarget {
	const file = path.resolve(sessionPath);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(file);
	} catch {
		return { error: `No session file at ${file}. Pass the .jsonl path shown by \`omp sessions\`.` };
	}
	if (!stat.isFile()) return { error: `${file} is not a session file.` };
	return { file, name: path.basename(file, ".jsonl").split("_")[0] };
}

/**
 * The Slack task name for `file`, when the bridge knows one. Fail-soft: an
 * absent or wedged bridge just leaves the caller's fallback name in place.
 */
async function bridgeTaskName(file: string): Promise<string | undefined> {
	const tasks = await bridgeStatus();
	return tasks?.find(task => task.sessionPath === file)?.name;
}

/**
 * Mount the spectator UI. Resolves `true` when the user took the session over
 * (the caller must then hand the terminal to `omp --resume`), `false` on quit.
 *
 * The theme is the caller's: `runRootCommand` has already run `initTheme` with
 * the user's settings by the time it dispatches here, and re-initializing would
 * drop their symbol preset and light/dark choices back to defaults.
 */
function spectate(file: string, name: string): Promise<boolean> {
	const ui = new TUI(new ProcessTerminal());
	const { promise, resolve } = Promise.withResolvers<boolean>();

	/** Transient feedback row under the header (steer failures, park waits). */
	let status = "";
	/** True while the take-over loop is retrying `park`. Esc cancels it. */
	let waiting = false;
	let finished = false;

	const setStatus = (text: string): void => {
		status = text;
		ui.requestRender();
	};

	const mainTarget = { id: name, sessionFile: file };
	let target = mainTarget;
	let scanned: SubagentTranscript[] = [];
	let rows: SubagentPickerRow[] = buildSubagentRows({ main: mainTarget, scanned, live: null, now: Date.now() });
	let picker: SubagentPicker | undefined;
	let pickerHandle: OverlayHandle | undefined;
	let refreshTimer: NodeJS.Timeout | undefined;
	let refreshing = false;
	let refreshQueued = false;

	const runRefresh = async (): Promise<void> => {
		try {
			scanned = await scanSubagentTranscripts(file);
		} catch (err) {
			logger.debug("spectate: subagent scan failed", { err: String(err) });
		}
		let live: BridgeSubagentInfo[] | null = null;
		if (pickerHandle) {
			try {
				live = await bridgeSubagents(file);
			} catch (err) {
				logger.debug("spectate: bridge subagent query failed", { err: String(err) });
			}
		}
		if (finished) return;
		rows = buildSubagentRows({ main: mainTarget, scanned, live, now: Date.now() });
		if (pickerHandle) picker?.setRows(rows, target.sessionFile);
		ui.requestRender();
	};

	const refreshSubagents = async (): Promise<void> => {
		if (refreshing) {
			refreshQueued = true;
			return;
		}
		refreshing = true;
		try {
			do {
				refreshQueued = false;
				await runRefresh();
			} while (refreshQueued && !finished);
		} finally {
			refreshing = false;
		}
	};

	const closePicker = (): void => {
		if (!pickerHandle) return;
		pickerHandle.hide();
		pickerHandle = undefined;
		ui.requestRender();
	};

	const pickTarget = (row: SubagentPickerRow): void => {
		target = row.sessionFile === file ? mainTarget : { id: row.id, sessionFile: row.sessionFile };
		viewer.refreshNow();
		closePicker();
	};

	const openPicker = (): void => {
		if (pickerHandle) return;
		if (picker) {
			picker.setRows(rows, target.sessionFile);
		} else {
			picker = new SubagentPicker({
				rows,
				selected: target.sessionFile,
				onPick: pickTarget,
				onCancel: closePicker,
				requestRender: () => ui.requestRender(),
			});
		}
		pickerHandle = ui.showOverlay(picker, { anchor: "center", width: "70%", maxHeight: "70%", fullscreen: true });
		void refreshSubagents();
	};

	const viewer = new AgentTranscriptViewer({
		agentId: name,
		// This process owns no agents; the spectate override supplies the file.
		registry: new AgentRegistry(),
		ui,
		cwd: process.cwd(),
		expandKeys: ["ctrl+o"],
		// No hub to toggle closed from here.
		hubKeys: [],
		requestRender: () => ui.requestRender(),
		onClose: () => finish(false),
		onHubClose: () => finish(false),
		spectate: {
			sessionFile: () => target.sessionFile,
			header: () => {
				const onMain = target.sessionFile === file;
				const title = onMain
					? theme.bold(headerCell(name))
					: `${theme.bold(headerCell(name))} ${theme.fg("dim", "▸")} ${theme.bold(headerCell(target.id))}`;
				const count = scanned.length > 0 ? ` · ${headerCell(`${scanned.length} subagents`)}` : "";
				const hints = onMain
					? `alt+a: subagents · Enter: steer · Ctrl+T: take over · Ctrl+X: interrupt · Esc: quit${count}`
					: "alt+a: subagents · Enter: steer Main · Ctrl+T: take over · Ctrl+X: interrupt · Esc: back to Main";
				const lines = [
					`${title}  ${theme.fg("warning", "SPECTATING")} ${theme.fg("dim", "— owned by Slack")}`,
					theme.fg("dim", hints),
				];
				if (status) lines.push(status);
				return lines;
			},
			hint: "empty input → j/k:scroll  g/G:top/bottom  ctrl+o:expand",
			onSubmit: text => void steer(text),
			onKey: data => {
				if (matchesKey(data, "alt+a")) {
					openPicker();
					return true;
				}
				if (matchesKey(data, "ctrl+t")) {
					void takeOver();
					return true;
				}
				if (matchesKey(data, "ctrl+x")) {
					void interrupt();
					return true;
				}
				if (matchesKey(data, "escape")) {
					if (waiting) {
						waiting = false;
						setStatus(theme.fg("dim", "take over cancelled"));
						return true;
					}
					if (target !== mainTarget) {
						target = mainTarget;
						viewer.refreshNow();
						ui.requestRender();
						return true;
					}
				}
				return false;
			},
		},
	});

	const finish = (promoted: boolean): void => {
		if (finished) return;
		finished = true;
		waiting = false;
		clearInterval(refreshTimer);
		refreshTimer = undefined;
		closePicker();
		viewer.dispose();
		ui.stop();
		resolve(promoted);
	};

	const steer = async (text: string): Promise<void> => {
		setStatus(theme.fg("dim", "steering…"));
		const sent = await steerBridgeSession(file, text);
		if (finished) return;
		if (sent === null) {
			setStatus(theme.fg("error", "bridge unreachable — session may be free; Ctrl+T to take over"));
		} else if (sent) {
			setStatus("");
		} else {
			setStatus(theme.fg("error", "bridge refused the steer — the task may have ended"));
		}
	};

	const interrupt = async (): Promise<void> => {
		setStatus(theme.fg("dim", "interrupting…"));
		const sent = await interruptBridgeSession(file);
		if (finished) return;
		if (sent === null) {
			setStatus(theme.fg("error", "bridge unreachable — session may be free; Ctrl+T to take over"));
		} else if (sent) {
			setStatus(theme.fg("warning", "interrupt sent (running subagents keep going)"));
		} else {
			setStatus(theme.fg("error", "bridge refused the interrupt — the task may have ended"));
		}
	};

	const takeOver = async (): Promise<void> => {
		if (waiting) return;
		waiting = true;
		setStatus(theme.fg("dim", "taking over…"));
		const result = await acquireOwnership(() => parkBridgeSession(file), {
			cancelled: () => finished || !waiting,
			onWait: reason => setStatus(theme.fg("warning", `waiting: ${headerCell(reason)} — Esc to cancel`)),
			// ponytail: a plain sleep, not a cancellable timer — `cancelled` is
			// re-checked the moment it returns, so Esc costs at most one interval.
			sleep: ms => Bun.sleep(ms),
		});
		if (result === "promote") finish(true);
	};

	ui.showOverlay(viewer, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	ui.setFocus(viewer);
	refreshTimer = setInterval(() => void refreshSubagents(), SUBAGENT_REFRESH_MS);
	refreshTimer.unref?.();
	void refreshSubagents();
	ui.start();
	return promise;
}

/**
 * Entry for `omp --watch <sessionPath>`. Exits the process: on take-over it
 * replaces itself with a real `omp --resume` of the same session, so the
 * spectator never becomes a second owner.
 */
export async function runWatchMode(sessionPath: string): Promise<void> {
	const target = resolveWatchTarget(sessionPath);
	if ("error" in target) {
		process.stderr.write(`${chalk.red(`Error: ${target.error}`)}\n`);
		process.exit(1);
	}

	const name = (await bridgeTaskName(target.file)) ?? target.name;
	if (!(await spectate(target.file, name))) return;

	// ponytail: spawn + exit, not an in-process re-exec — resuming needs the full
	// startup path (settings, tools, session manager) this mode deliberately skips.
	const child = Bun.spawnSync({
		cmd: [...selfInvocation(), "--resume", target.file],
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(child.exitCode ?? 0);
}
