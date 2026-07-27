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
import { matchesKey, ProcessTerminal, TUI } from "@oh-my-pi/pi-tui";
import chalk from "chalk";
import { bridgeStatus, interruptBridgeSession, parkBridgeSession, steerBridgeSession } from "../hub/bridge-client";
import { selfInvocation } from "../hub/tmux";
import { AgentRegistry } from "../registry/agent-registry";
import { AgentTranscriptViewer } from "./components/agent-transcript-viewer";
import { theme } from "./theme/theme";

/** How long to wait between park retries while the Slack side finishes its turn. */
const PARK_RETRY_MS = 2000;

/** A bridge `reason` is untrusted text on a one-row header line. */
const MAX_REASON_CHARS = 60;

/** Resolved `--watch` target, or the message to print instead. */
export type WatchTarget = { file: string; name: string } | { error: string };

/** What {@link parkBridgeSession} can answer. */
export type ParkOutcome = { parked: boolean; reason?: string } | null;

export type PromoteDecision = { promote: true } | { promote: false; reason: string };

/**
 * Whether a park response clears the way to resume the session in this terminal.
 * Only a *reasoned* refusal means "wait" — same reading as the resume-path
 * handshake in `main.ts`:
 *
 * - `null` — bridge unreachable. Nothing is holding the session, and this is
 *   the only way to reach one orphaned by a dead daemon.
 * - `{ parked: true }` — the bridge released it.
 * - `{ parked: false }` with no reason — the bridge does not own this session.
 * - `{ parked: false, reason }` — the Slack side is busy; retry.
 */
export function decidePromotion(outcome: ParkOutcome): PromoteDecision {
	if (outcome === null || outcome.parked || !outcome.reason) return { promote: true };
	return { promote: false, reason: outcome.reason.slice(0, MAX_REASON_CHARS) };
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
			sessionFile: file,
			header: () => {
				const lines = [
					`${theme.bold(name)}  ${theme.fg("warning", "SPECTATING")} ${theme.fg("dim", "— owned by Slack")}`,
					theme.fg("dim", "Enter: steer · Ctrl+T: take over · Ctrl+X: interrupt · Esc: quit"),
				];
				if (status) lines.push(status);
				return lines;
			},
			hint: "empty input → j/k:scroll  g/G:top/bottom  ctrl+o:expand",
			onSubmit: text => void steer(text),
			onKey: data => {
				if (matchesKey(data, "ctrl+t")) {
					void takeOver();
					return true;
				}
				if (matchesKey(data, "ctrl+x")) {
					void interrupt();
					return true;
				}
				// Only swallow Esc while a take-over is pending; otherwise it quits.
				if (waiting && matchesKey(data, "escape")) {
					waiting = false;
					setStatus(theme.fg("dim", "take over cancelled"));
					return true;
				}
				return false;
			},
		},
	});

	const finish = (promoted: boolean): void => {
		if (finished) return;
		finished = true;
		waiting = false;
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
		// ponytail: re-poll on a fixed sleep rather than track a cancellable timer —
		// Esc clears `waiting`, so the loop exits at the next checkpoint.
		while (waiting && !finished) {
			const decision = decidePromotion(await parkBridgeSession(file));
			if (!waiting || finished) return;
			if (decision.promote) {
				finish(true);
				return;
			}
			setStatus(theme.fg("warning", `waiting: ${decision.reason} — Esc to cancel`));
			await Bun.sleep(PARK_RETRY_MS);
		}
	};

	ui.showOverlay(viewer, { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0, fullscreen: true });
	ui.setFocus(viewer);
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
