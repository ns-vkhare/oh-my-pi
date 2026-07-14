/**
 * Shared two-column boxed layout — the visual language of the welcome pane,
 * extracted so the session hub renders identically (rounded border, title
 * embedded in the top edge, a left column and an optional right column split by
 * a `teeUp` join, ANSI-aware cell fitting). {@link WelcomeComponent} and
 * {@link HubView} both build their `leftLines`/`rightLines` and hand them here.
 */
import { padding, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { theme } from "../theme/theme";

/** Box is responsive up to this width. */
const MAX_BOX_WIDTH = 100;
/** Logo column floor. */
const MIN_LEFT_COL = 12;
/** Right column floor below which the layout collapses to a single column. */
const MIN_RIGHT_COL = 20;
/** Preferred left-column width when there is room. */
const PREFERRED_LEFT_COL = 26;

/** Resolved column geometry for a boxed pane. */
export interface BoxLayout {
	/** Total box width including both vertical borders. */
	boxWidth: number;
	/** Left content-column width (or the whole inner width in single-column mode). */
	leftCol: number;
	/** Right content-column width; 0 in single-column mode. */
	rightCol: number;
	/** Whether the right column fits (else the pane is single-column). */
	showRightColumn: boolean;
}

/**
 * Resolve box + column widths for `termWidth`. `leftMinContentWidth` is the
 * narrowest the left column may be while still showing the right column; below
 * it (or when the right column can't reach {@link MIN_RIGHT_COL}) the layout
 * collapses to a single full-width column. Mirrors the welcome pane exactly.
 */
export function computeTwoColumnLayout(termWidth: number, leftMinContentWidth: number): BoxLayout {
	const boxWidth = Math.min(MAX_BOX_WIDTH, Math.max(0, termWidth - 2));
	const dualContentWidth = boxWidth - 3; // 3 = │ + │ + │
	const desiredLeftCol = Math.min(PREFERRED_LEFT_COL, Math.max(MIN_LEFT_COL, Math.floor(dualContentWidth * 0.35)));
	const dualLeftCol =
		dualContentWidth >= MIN_RIGHT_COL + 1
			? Math.min(desiredLeftCol, dualContentWidth - MIN_RIGHT_COL)
			: Math.max(1, dualContentWidth - 1);
	const dualRightCol = Math.max(1, dualContentWidth - dualLeftCol);
	const showRightColumn = dualLeftCol >= leftMinContentWidth && dualRightCol >= MIN_RIGHT_COL;
	return {
		boxWidth,
		leftCol: showRightColumn ? dualLeftCol : boxWidth - 2,
		rightCol: showRightColumn ? dualRightCol : 0,
		showRightColumn,
	};
}

/** Center `text` within `width`, ANSI-aware; truncates when it overflows. */
export function centerText(text: string, width: number): string {
	const visLen = visibleWidth(text);
	if (visLen >= width) return truncateToWidth(text, width);
	const leftPad = Math.floor((width - visLen) / 2);
	return padding(leftPad) + text + padding(width - visLen - leftPad);
}

/** Fit `str` to exactly `width` visible columns: pad when short, ANSI-aware truncate when long. */
export function fitToWidth(str: string, width: number): string {
	const visLen = visibleWidth(str);
	if (visLen === width) return str;
	if (visLen < width) return str + padding(width - visLen);
	return truncateToWidth(str, width);
}

/**
 * Assemble the rounded box: a top border with `title` embedded after a 3-cell
 * lead, one row per max(left,right) content line (single column when the layout
 * collapsed), and a bottom border joined with `teeUp` under the column divider.
 * `leftLines`/`rightLines` are pre-styled; each is fit to its column here.
 */
export function assembleTwoColumnBox(
	layout: BoxLayout,
	title: string,
	leftLines: readonly string[],
	rightLines: readonly string[],
): string[] {
	const { boxWidth, leftCol, rightCol, showRightColumn } = layout;
	const hChar = theme.boxRound.horizontal;
	const h = theme.fg("dim", hChar);
	const v = theme.fg("dim", theme.boxRound.vertical);
	const tl = theme.fg("dim", theme.boxRound.topLeft);
	const tr = theme.fg("dim", theme.boxRound.topRight);
	const bl = theme.fg("dim", theme.boxRound.bottomLeft);
	const br = theme.fg("dim", theme.boxRound.bottomRight);

	const lines: string[] = [];
	// Top border with embedded title.
	const titleText = ` ${title} `;
	const titlePrefixRaw = hChar.repeat(3);
	const titleStyled = theme.fg("dim", titlePrefixRaw) + theme.fg("muted", titleText);
	const titleVisLen = titlePrefixRaw.length + visibleWidth(titleText);
	const titleSpace = boxWidth - 2;
	if (titleVisLen >= titleSpace) {
		lines.push(tl + truncateToWidth(titleStyled, titleSpace) + tr);
	} else {
		lines.push(tl + titleStyled + theme.fg("dim", hChar.repeat(titleSpace - titleVisLen)) + tr);
	}
	// Content rows.
	const maxRows = showRightColumn ? Math.max(leftLines.length, rightLines.length) : leftLines.length;
	for (let i = 0; i < maxRows; i++) {
		const left = fitToWidth(leftLines[i] ?? "", leftCol);
		if (showRightColumn) {
			lines.push(v + left + v + fitToWidth(rightLines[i] ?? "", rightCol) + v);
		} else {
			lines.push(v + left + v);
		}
	}
	// Bottom border.
	if (showRightColumn) {
		lines.push(bl + h.repeat(leftCol) + theme.fg("dim", theme.boxRound.teeUp) + h.repeat(rightCol) + br);
	} else {
		lines.push(bl + h.repeat(leftCol) + br);
	}
	return lines;
}
