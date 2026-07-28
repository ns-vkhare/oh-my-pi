import { type Component, type SelectItem, SelectList } from "@oh-my-pi/pi-tui";
import { formatAge, sanitizeText } from "@oh-my-pi/pi-utils";
import type { BridgeSubagentInfo } from "../../hub/bridge-client";
import type { SubagentTranscript } from "../../registry/subagent-transcripts";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import { getSelectListTheme, theme } from "../theme/theme";
import { DynamicBorder } from "./dynamic-border";

export interface SubagentPickerRow {
	id: string;
	sessionFile: string;
	kind: "main" | "sub" | "advisor";
	depth: number;
	label: string;
	detail: string;
}

export interface SubagentRowInput {
	main: { id: string; sessionFile: string };
	scanned: readonly SubagentTranscript[];
	live: readonly BridgeSubagentInfo[] | null;
	now: number;
}

const MAX_VISIBLE_ROWS = 12;
const DETAIL_SEPARATOR = " · ";
const READ_ONLY_MARKER = "read-only";
const NO_ACTIVITY = "no activity";
const JUST_NOW = "just now";
const NESTING_GUIDE = "│ ";

function cell(text: string, maxWidth: number): string {
	return truncateToWidth(replaceTabs(sanitizeText(text)).replace(/[\r\n]+/g, " "), maxWidth);
}

function toItems(rows: readonly SubagentPickerRow[]): SelectItem[] {
	return rows.map(row => ({
		value: row.sessionFile,
		label: NESTING_GUIDE.repeat(Math.max(0, row.depth - 1)) + row.label.trimStart(),
		description: row.detail,
	}));
}

function ageLabel(mtimeMs: number, now: number): string {
	if (!mtimeMs) return NO_ACTIVITY;
	return formatAge(Math.max(0, Math.round((now - mtimeMs) / 1000))) || JUST_NOW;
}

function liveDetail(info: BridgeSubagentInfo): string[] {
	const parts = [info.status];
	const what = info.task ?? info.agent;
	if (what) parts.push(what);
	return parts;
}

export function buildSubagentRows(input: SubagentRowInput): SubagentPickerRow[] {
	const { main, scanned, live, now } = input;
	const rows: SubagentPickerRow[] = [
		{
			id: main.id,
			sessionFile: main.sessionFile,
			kind: "main",
			depth: 0,
			label: cell(main.id, TRUNCATE_LENGTHS.TITLE),
			detail: cell("session", TRUNCATE_LENGTHS.SHORT),
		},
	];

	const byFile = new Map<string, BridgeSubagentInfo>();
	const byId = new Map<string, BridgeSubagentInfo>();
	const unmatched = new Set<BridgeSubagentInfo>();
	for (const info of live ?? []) {
		if (!info.sessionFile) continue;
		unmatched.add(info);
		if (!byFile.has(info.sessionFile)) byFile.set(info.sessionFile, info);
		if (!byId.has(info.id)) byId.set(info.id, info);
	}

	for (const entry of scanned) {
		const match = byFile.get(entry.sessionFile) ?? byId.get(entry.id);
		if (match) unmatched.delete(match);
		const parts = match ? liveDetail(match) : [ageLabel(entry.mtimeMs, now)];
		if (entry.kind === "advisor") parts.push(READ_ONLY_MARKER);
		const name = entry.kind === "advisor" ? entry.displayName : entry.id;
		rows.push({
			id: entry.id,
			sessionFile: entry.sessionFile,
			kind: entry.kind,
			depth: entry.depth,
			label: cell(name, TRUNCATE_LENGTHS.TITLE),
			detail: cell(parts.filter(Boolean).join(DETAIL_SEPARATOR), TRUNCATE_LENGTHS.SHORT),
		});
	}

	for (const info of unmatched) {
		rows.push({
			id: info.id,
			sessionFile: info.sessionFile ?? "",
			kind: "sub",
			depth: 1,
			label: cell(info.id, TRUNCATE_LENGTHS.TITLE),
			detail: cell(liveDetail(info).filter(Boolean).join(DETAIL_SEPARATOR), TRUNCATE_LENGTHS.SHORT),
		});
	}

	return rows;
}

export interface SubagentPickerDeps {
	rows: readonly SubagentPickerRow[];
	selected: string;
	onPick: (row: SubagentPickerRow) => void;
	onCancel: () => void;
	requestRender: () => void;
}

export class SubagentPicker implements Component {
	#deps: SubagentPickerDeps;
	#rows: readonly SubagentPickerRow[];
	#list: SelectList;

	constructor(deps: SubagentPickerDeps) {
		this.#deps = deps;
		this.#rows = deps.rows;
		this.#list = new SelectList(toItems(deps.rows), MAX_VISIBLE_ROWS, getSelectListTheme());
		this.#list.setSelectedValue(deps.selected);
		this.#list.onSelect = item => {
			const row = this.#rows.find(candidate => candidate.sessionFile === item.value);
			if (row) this.#deps.onPick(row);
		};
		this.#list.onCancel = () => this.#deps.onCancel();
	}

	setRows(rows: readonly SubagentPickerRow[], selected: string): void {
		const current = this.#list.getSelectedItem()?.value;
		this.#rows = rows;
		this.#list.setItems(toItems(rows));
		if (current === undefined || !rows.some(row => row.sessionFile === current)) {
			this.#list.setSelectedValue(selected);
		}
		this.#deps.requestRender();
	}

	invalidate(): void {
		this.#list.invalidate();
	}

	handleInput(data: string): void {
		this.#list.handleInput(data);
	}

	render(width: number): readonly string[] {
		let subagents = 0;
		for (const row of this.#rows) if (row.kind !== "main") subagents++;
		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		lines.push(` ${theme.fg("accent", "Subagents")} ${theme.fg("dim", `(${subagents})`)}`);
		lines.push(...new DynamicBorder().render(width));
		lines.push(...this.#list.render(width));
		lines.push(` ${theme.fg("dim", "Enter: watch · Esc: back")}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}
}
