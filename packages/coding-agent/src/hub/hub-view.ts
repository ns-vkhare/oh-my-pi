/**
 * Hub view — the fullscreen TUI shown in the hub's tmux window.
 *
 * Rendered to match the welcome pane (shared {@link ../modes/components/box-layout}):
 * a rounded two-column box with the OMP logo and a session count on the left,
 * and the selectable session list on the right. Beneath the box sits a real
 * {@link CustomEditor} — the same composer the interactive CLI uses — so it
 * gets a visible cursor, and drag-and-dropped image files attach exactly like
 * the normal flow (dispatched to the new session as `@file` args).
 *
 * Arrow keys move the session selection, → foregrounds the selected session
 * when the editor is empty, Enter dispatches a new session (or opens the
 * selection when the editor is empty), and Esc clears the editor or, when
 * empty, detaches the hub.
 */
import {
	type AutocompleteProvider,
	type Component,
	type Focusable,
	getKeybindings,
	matchesKey,
	padding,
	truncateToWidth,
	visibleWidth,
} from "@oh-my-pi/pi-tui";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { assembleTwoColumnBox, centerText, computeTwoColumnLayout } from "../modes/components/box-layout";
import { CustomEditor } from "../modes/components/custom-editor";
import { REST_FRAME } from "../modes/components/welcome";
import { PLACEHOLDER_REGEX } from "../modes/image-references";
import { getEditorTheme, theme } from "../modes/theme/theme";

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
	/** Dispatch a brand-new session seeded with `prompt` and any attached image paths. */
	onDispatch: (prompt: string, imagePaths: readonly string[]) => void;
	/** Leave the hub (detach). */
	onExit: () => void;
	/** Ask the host to repaint (async image attach, editor animation). */
	requestRender: () => void;
}

/** Visible width of a row's ` > ● ` prefix (space, cursor, space, dot, space). */
const ROW_PREFIX_WIDTH = 5;
/** Blank cells kept between a row's meta and the box border so text never kisses the edge. */
const ROW_RIGHT_MARGIN = 2;
/** Cap on session rows so the box never outgrows a typical terminal height. */
const MAX_SESSION_ROWS = 12;
/** Narrowest left column that still shows the logo (its glyph width). */
const LOGO_WIDTH = 12;
/** Max visible rows the editor grows to before it scrolls internally. */
const EDITOR_MAX_HEIGHT = 6;

/** Placeholder ghost text shown while the composer is empty. */
const EDITOR_PLACEHOLDER = "Describe a new session…";

/** Minimal autocomplete provider: no completions, only the empty-buffer placeholder hint. */
const placeholderProvider: AutocompleteProvider = {
	getSuggestions: () => Promise.resolve(null),
	applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
	getInlineHint: lines => (lines.length === 1 && lines[0] === "" ? EDITOR_PLACEHOLDER : null),
};

export class HubView implements Component, Focusable {
	focused = false;
	#rows: HubRow[] = [];
	#selectedIndex = 0;
	#editor: CustomEditor;
	/** Paths of images dropped into the composer, dispatched as `@file` args on submit. */
	#imagePaths: string[] = [];

	constructor(
		private readonly callbacks: HubViewCallbacks,
		private readonly getRows: () => HubRow[],
	) {
		this.#rows = getRows();
		const editor = new CustomEditor(getEditorTheme());
		editor.setMaxHeight(EDITOR_MAX_HEIGHT);
		editor.setAutocompleteProvider(placeholderProvider);
		editor.setShimmerRepaintHandler(() => this.callbacks.requestRender());
		editor.onSubmit = text => this.#submit(text);
		editor.onPasteImagePath = path => this.#attachImage(path);
		this.#editor = editor;
	}

	/** TUI forwards the hardware-cursor mode; the hub runs with it off, so the editor draws
	 *  its own visible cursor glyph. */
	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#editor.setUseTerminalCursor(useTerminalCursor);
	}

	/** Rebuild rows from the live source (called on a timer and after each action). */
	refresh(): void {
		this.#rows = this.getRows();
		if (this.#selectedIndex >= this.#rows.length) {
			this.#selectedIndex = Math.max(0, this.#rows.length - 1);
		}
	}

	/** Record a dropped/pasted image and insert a positional marker so it's visible in the draft. */
	#attachImage(path: string): void {
		this.#imagePaths.push(path);
		this.#editor.insertText(`[Image #${this.#imagePaths.length}] `);
		this.callbacks.requestRender();
	}

	/** Enter handler: dispatch a new session when the draft has text or images, else open the
	 *  selected session. Editor text arrives with paste markers expanded; strip the image markers
	 *  since the paths ride along out-of-band as `@file` args. */
	#submit(text: string): void {
		const prompt = text.replace(PLACEHOLDER_REGEX, "").replace(/\s+/g, " ").trim();
		const images = this.#imagePaths;
		this.#imagePaths = [];
		if (prompt.length > 0 || images.length > 0) {
			this.callbacks.onDispatch(prompt, images);
			return;
		}
		const row = this.#rows[this.#selectedIndex];
		if (row) this.callbacks.onForeground(row);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.cancel")) {
			// Esc / Ctrl+C: with a draft, clear it; otherwise leave the hub.
			if (this.#editor.getText().length > 0 || this.#imagePaths.length > 0) {
				this.#editor.setText("");
				this.#imagePaths = [];
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
		// → opens the selected session only when the composer is empty; otherwise it moves the
		// editor cursor like normal.
		if (matchesKey(keyData, "right") && this.#editor.getText().length === 0) {
			const row = this.#rows[this.#selectedIndex];
			if (row) this.callbacks.onForeground(row);
			return;
		}
		// Everything else (text, Enter, backspace, paste, image drop) is the editor's.
		this.#editor.handleInput(keyData);
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

		// The composer renders its own rounded box beneath the pane. Keep its focus
		// in sync so it emits the visible cursor, and label its top border.
		this.#editor.focused = this.focused;
		this.#editor.setTopBorder({ content: theme.fg("muted", " New session "), width: visibleWidth(" New session ") });
		lines.push("");
		lines.push(...this.#editor.render(boxWidth));
		lines.push(` ${theme.fg("dim", "↑/↓ select · enter/→ open · type + enter new session · esc detach")}`);
		return lines;
	}

	/** Compose one session row to the column width, leaving a right margin: ` > ● name … meta  `. */
	#rowLine(row: HubRow, selected: boolean, colWidth: number): string {
		const usable = Math.max(1, colWidth - ROW_RIGHT_MARGIN);
		const cursor = selected ? theme.fg("accent", ">") : " ";
		const dot = row.live ? theme.fg("success", "●") : theme.fg("dim", "○");
		const metaVis = visibleWidth(row.meta);
		const nameBudget = Math.max(1, usable - ROW_PREFIX_WIDTH - metaVis - 1);
		const nameVis = visibleWidth(row.title);
		const name = nameVis > nameBudget ? truncateToWidth(row.title, nameBudget) : row.title;
		const namePainted = selected ? theme.fg("accent", name) : theme.fg("muted", name);
		const gap = Math.max(1, usable - ROW_PREFIX_WIDTH - Math.min(nameVis, nameBudget) - metaVis);
		return ` ${cursor} ${dot} ${namePainted}${padding(gap)}${theme.fg("dim", row.meta)}`;
	}
}
