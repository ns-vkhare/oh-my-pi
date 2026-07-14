/**
 * Hub view — the fullscreen TUI shown in the hub's tmux window.
 *
 * Lists every session as a row: live sessions (an omp process running in a tmux
 * window) and idle recent sessions (a `.jsonl` on disk with no live window).
 * Arrow keys move the selection, Enter foregrounds the selected session (or
 * dispatches a new one when the input line has text), and Esc exits the hub.
 * This is the Claude-Code "agent view" surface, with tmux as the supervisor.
 */
import {
	CURSOR_MARKER,
	type Component,
	type Focusable,
	extractPrintableText,
	getKeybindings,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { theme as tuiTheme } from "../modes/theme/theme";

export interface HubRow {
	/** Stable identity: the session `.jsonl` path, or the tmux window id for a live-but-unsaved session. */
	key: string;
	/** Display name (session title / first prompt / window name). */
	title: string;
	/** Right-aligned meta (age, or live activity). */
	meta: string;
	/** True when an omp process is running in a tmux window for this session. */
	live: boolean;
	/** Session `.jsonl` path when known (idle rows always have one; fresh live rows may not). */
	sessionPath: string | undefined;
	/** tmux window id when live. */
	windowId: string | undefined;
}

export interface HubViewCallbacks {
	/** Foreground the row: select its live window, or open one resuming its session. */
	onForeground: (row: HubRow) => void;
	/** Dispatch a brand-new session seeded with `prompt`. */
	onDispatch: (prompt: string) => void;
	/** Leave the hub (detach). */
	onExit: () => void;
}

const CURSOR = ">";

export class HubView implements Component, Focusable {
	focused = false;
	#rows: HubRow[] = [];
	#selectedIndex = 0;
	#input = "";

	constructor(
		private readonly callbacks: HubViewCallbacks,
		private readonly getRows: () => HubRow[],
	) {
		this.#rows = getRows();
	}

	/** Rebuild rows from the live source (called on a timer and after each action). */
	refresh(): void {
		this.#rows = this.getRows();
		if (this.#selectedIndex >= this.#rows.length) {
			this.#selectedIndex = Math.max(0, this.#rows.length - 1);
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			// Esc / Ctrl+C: with text in the input, clear it; otherwise leave the hub.
			if (this.#input.length > 0) {
				this.#input = "";
				return;
			}
			this.callbacks.onExit();
			return;
		}
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.#rows.length > 0) {
				this.#selectedIndex = this.#selectedIndex === 0 ? this.#rows.length - 1 : this.#selectedIndex - 1;
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			if (this.#rows.length > 0) {
				this.#selectedIndex = this.#selectedIndex === this.#rows.length - 1 ? 0 : this.#selectedIndex + 1;
			}
			return;
		}
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const prompt = this.#input.trim();
			if (prompt.length > 0) {
				this.#input = "";
				this.callbacks.onDispatch(prompt);
				return;
			}
			const row = this.#rows[this.#selectedIndex];
			if (row) this.callbacks.onForeground(row);
			return;
		}
		if (kb.matches(keyData, "tui.editor.deleteCharBackward")) {
			this.#input = this.#input.slice(0, -1);
			return;
		}
		const printable = extractPrintableText(keyData);
		if (printable) this.#input += printable;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const accent = (s: string) => tuiTheme.fg("accent", s);
		const dim = (s: string) => tuiTheme.fg("dim", s);
		const muted = (s: string) => tuiTheme.fg("muted", s);

		lines.push(accent(tuiTheme.bold("  omp session hub")));
		lines.push(dim(`  ${this.#rows.length} session${this.#rows.length === 1 ? "" : "s"} · tmux-supervised`));
		lines.push("");

		if (this.#rows.length === 0) {
			lines.push(dim("  No sessions yet. Type a prompt below and press Enter to dispatch one."));
		} else {
			for (let i = 0; i < this.#rows.length; i++) {
				const row = this.#rows[i];
				if (!row) continue;
				const selected = i === this.#selectedIndex;
				// Live = running process (bright dot); idle = on-disk only (dim dot).
				const dot = row.live ? tuiTheme.fg("success", "●") : dim("○");
				const cursor = selected ? accent(CURSOR) : " ";
				const metaWidth = visibleWidth(row.meta);
				const nameBudget = Math.max(1, width - 6 - metaWidth);
				const name = visibleWidth(row.title) > nameBudget ? truncateToWidth(row.title, nameBudget) : row.title;
				const namePainted = selected ? accent(name) : muted(name);
				const gap = Math.max(1, width - 4 - visibleWidth(name) - metaWidth);
				lines.push(` ${cursor} ${dot} ${namePainted}${padding(gap)}${dim(row.meta)}`);
			}
		}

		lines.push("");
		lines.push(dim("  ─────────────────────────────────────────────"));
		// Dispatch input. Emit CURSOR_MARKER at the caret so the hardware cursor
		// (when enabled) tracks the input; the visible caret is the trailing space.
		const promptLabel = accent("  dispatch ");
		const caret = this.focused ? CURSOR_MARKER : "";
		lines.push(`${promptLabel}${this.#input}${caret}`);
		lines.push("");
		lines.push(dim("  ↑/↓ select · enter foreground/dispatch · esc detach"));
		return lines;
	}
}
