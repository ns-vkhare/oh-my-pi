/**
 * Hub view — the fullscreen TUI shown in the hub's tmux window.
 *
 * Rendered to match the welcome pane (shared {@link ./box-layout}): a rounded
 * two-column box with the OMP logo and a session count on the left, and the
 * selectable session list on the right. Beneath the box sits an editor line
 * that dispatches a brand-new session on Enter.
 *
 * Arrow keys move the session selection, Enter or → foregrounds the selected
 * session (Enter dispatches a new one instead when the editor has text), and
 * Esc clears the editor or, when empty, detaches the hub.
 */
import {
	type Component,
	CURSOR_MARKER,
	extractPrintableText,
	type Focusable,
	getKeybindings,
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { assembleTwoColumnBox, centerText, computeTwoColumnLayout, fitToWidth } from "../modes/components/box-layout";
import { REST_FRAME } from "../modes/components/welcome";
import { theme } from "../modes/theme/theme";

/** One session row in the hub. */
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

/** Visible width of a row's ` > ● ` prefix (space, cursor, space, dot, space). */
const ROW_PREFIX_WIDTH = 5;
/** Cap on session rows so the box never outgrows a typical terminal height. */
const MAX_SESSION_ROWS = 12;
/** Narrowest left column that still shows the logo (its glyph width). */
const LOGO_WIDTH = 12;

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
			// Esc / Ctrl+C: with text in the editor, clear it; otherwise leave the hub.
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
		// → foregrounds the selected session (the editor line has no cursor movement,
		// so → has no competing meaning here).
		if (matchesKey(keyData, "right")) {
			const row = this.#rows[this.#selectedIndex];
			if (row) this.callbacks.onForeground(row);
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

	render(termWidth: number): readonly string[] {
		const count = this.#rows.length;
		const countLabel = `${count} session${count === 1 ? "" : "s"}`;
		const leftMinContentWidth = Math.max(LOGO_WIDTH, visibleWidth("Session Hub"), visibleWidth(countLabel));
		const layout = computeTwoColumnLayout(termWidth, leftMinContentWidth);
		if (layout.boxWidth < 4) return [];
		const { boxWidth, leftCol, rightCol, showRightColumn } = layout;
		// Single column mode: rows share the left column; else they own the right.
		const listCol = showRightColumn ? rightCol : leftCol;

		// Left column — logo + title + session count (mirrors the welcome pane).
		const leftLines = [
			"",
			centerText(theme.bold(theme.fg("accent", "Session Hub")), leftCol),
			"",
			...REST_FRAME.map((l: string) => centerText(l, leftCol)),
			"",
			centerText(theme.fg("muted", countLabel), leftCol),
			centerText(theme.fg("borderMuted", "tmux-supervised"), leftCol),
		];

		// Session list.
		const sessionLines: string[] = [];
		if (count === 0) {
			sessionLines.push(` ${theme.fg("dim", "No sessions yet — type below and press enter.")}`);
		} else {
			for (let i = 0; i < count && i < MAX_SESSION_ROWS; i++) {
				const row = this.#rows[i];
				if (row) sessionLines.push(this.#rowLine(row, i === this.#selectedIndex, listCol));
			}
		}
		const rightLines = [` ${theme.bold(theme.fg("accent", "Sessions"))}`, ...sessionLines, ""];

		// In single-column mode the list has no right column; append it under the
		// left content so the sessions are always visible on a narrow terminal.
		const lines = showRightColumn
			? assembleTwoColumnBox(layout, `omp hub v${VERSION}`, leftLines, rightLines)
			: assembleTwoColumnBox(layout, `omp hub v${VERSION}`, [...leftLines, "", ...rightLines], []);
		lines.push(...this.#renderEditor(boxWidth));
		lines.push(` ${theme.fg("dim", "↑/↓ select · enter/→ open · type + enter new session · esc detach")}`);
		return lines;
	}

	/**
	 * Editor box beneath the main pane: a rounded single-line input that, on
	 * Enter with text, dispatches a new session. Empty by default so the implied
	 * action is "start a new session".
	 */
	#renderEditor(boxWidth: number): string[] {
		const innerWidth = boxWidth - 2;
		const h = theme.fg("dim", theme.boxRound.horizontal);
		const v = theme.fg("dim", theme.boxRound.vertical);
		const tl = theme.fg("dim", theme.boxRound.topLeft);
		const tr = theme.fg("dim", theme.boxRound.topRight);
		const bl = theme.fg("dim", theme.boxRound.bottomLeft);
		const br = theme.fg("dim", theme.boxRound.bottomRight);

		const title = " New session ";
		const afterTitle = Math.max(0, innerWidth - visibleWidth(title));
		const top = tl + theme.fg("muted", title) + theme.fg("dim", theme.boxRound.horizontal.repeat(afterTitle)) + tr;

		// CURSOR_MARKER positions the hardware cursor at the caret; the trailing
		// block is the visible caret when focused.
		const caret = this.focused ? CURSOR_MARKER : "";
		const body =
			this.#input.length > 0
				? `${theme.fg("dim", theme.md.bullet)} ${this.#input}${caret}`
				: `${theme.fg("dim", theme.md.bullet)} ${theme.fg("dim", "Describe a new session…")}${caret}`;
		return ["", top, v + fitToWidth(` ${body}`, innerWidth) + v, bl + h.repeat(innerWidth) + br];
	}

	/** Compose one session row to the exact column width: ` > ● name … meta`. */
	#rowLine(row: HubRow, selected: boolean, colWidth: number): string {
		const cursor = selected ? theme.fg("accent", ">") : " ";
		const dot = row.live ? theme.fg("success", "●") : theme.fg("dim", "○");
		const metaVis = visibleWidth(row.meta);
		const nameBudget = Math.max(1, colWidth - ROW_PREFIX_WIDTH - metaVis - 1);
		const nameVis = visibleWidth(row.title);
		const name = nameVis > nameBudget ? truncateToWidth(row.title, nameBudget) : row.title;
		const namePainted = selected ? theme.fg("accent", name) : theme.fg("muted", name);
		const gap = Math.max(1, colWidth - ROW_PREFIX_WIDTH - Math.min(nameVis, nameBudget) - metaVis);
		return ` ${cursor} ${dot} ${namePainted}${padding(gap)}${theme.fg("dim", row.meta)}`;
	}
}
