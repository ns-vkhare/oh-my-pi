import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import type { BridgeSubagentInfo } from "@oh-my-pi/pi-coding-agent/hub/bridge-client";
import { getThemeByName, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SubagentTranscript } from "@oh-my-pi/pi-coding-agent/registry/subagent-transcripts";
import { getKeybindings, setKeybindings, type KeybindingsManager as TuiKeybindingsManager } from "@oh-my-pi/pi-tui";
import { buildSubagentRows, SubagentPicker, type SubagentPickerRow } from "../components/subagent-picker";

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const MAIN = { id: "Main", sessionFile: "/sessions/main.jsonl" };

function transcript(over: Partial<SubagentTranscript> & { id: string; sessionFile: string }): SubagentTranscript {
	return {
		displayName: over.id,
		kind: "sub",
		parentId: "Main",
		depth: 1,
		mtimeMs: NOW,
		size: 1,
		...over,
	};
}

function liveInfo(over: Partial<BridgeSubagentInfo> & { id: string }): BridgeSubagentInfo {
	return { agent: "task", status: "running", lastUpdate: NOW, ...over };
}

describe("buildSubagentRows", () => {
	it("always leads with the main session row", () => {
		const rows = buildSubagentRows({ main: MAIN, scanned: [], live: null, now: NOW });

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: "Main",
			sessionFile: "/sessions/main.jsonl",
			kind: "main",
			depth: 0,
			label: "Main",
			detail: "session",
		});
	});

	it("records nesting depth without padding the label and keeps scan order", () => {
		const scanned = [
			transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl" }),
			transcript({ id: "Beta", sessionFile: "/sessions/main/Alpha/Beta.jsonl", depth: 2, parentId: "Alpha" }),
			transcript({ id: "Gamma", sessionFile: "/sessions/main/Gamma.jsonl" }),
		];

		const rows = buildSubagentRows({ main: MAIN, scanned, live: null, now: NOW });

		expect(rows.map(row => row.label)).toEqual(["Main", "Alpha", "Beta", "Gamma"]);
		expect(rows.map(row => row.depth)).toEqual([0, 1, 2, 1]);
	});

	it("uses the advisor display name and marks the row read-only", () => {
		const scanned = [
			transcript({
				id: "Main/advisor:plan",
				displayName: "advisor:plan",
				kind: "advisor",
				sessionFile: "/sessions/main/__advisor.plan.jsonl",
				mtimeMs: NOW - 120_000,
			}),
		];

		const rows = buildSubagentRows({ main: MAIN, scanned, live: null, now: NOW });

		expect(rows[1]?.label).toBe("advisor:plan");
		expect(rows[1]?.kind).toBe("advisor");
		expect(rows[1]?.detail).toBe("2m ago · read-only");
	});

	it("takes status and task from a live entry matched by session file", () => {
		const scanned = [transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl" })];
		const live = [liveInfo({ id: "SomeOtherId", sessionFile: "/sessions/main/Alpha.jsonl", task: "fix the parser" })];

		const rows = buildSubagentRows({ main: MAIN, scanned, live, now: NOW });

		expect(rows).toHaveLength(2);
		expect(rows[1]?.detail).toBe("running · fix the parser");
	});

	it("falls back to the agent name when a matched live entry has no task", () => {
		const scanned = [transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl" })];
		const live = [liveInfo({ id: "Alpha", agent: "scout", status: "idle", sessionFile: "/elsewhere/Alpha.jsonl" })];

		const rows = buildSubagentRows({ main: MAIN, scanned, live, now: NOW });

		expect(rows).toHaveLength(2);
		expect(rows[1]?.detail).toBe("idle · scout");
	});

	it("shows the transcript age when no live entry matches", () => {
		const scanned = [transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl", mtimeMs: NOW - 120_000 })];

		const rows = buildSubagentRows({ main: MAIN, scanned, live: [], now: NOW });

		expect(rows[1]?.detail).toBe("2m ago");
	});

	it("reports no activity for a transcript that could not be stat'd", () => {
		const scanned = [transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl", mtimeMs: 0 })];

		const rows = buildSubagentRows({ main: MAIN, scanned, live: null, now: NOW });

		expect(rows[1]?.detail).toBe("no activity");
	});

	it("appends a live subagent that has a session file but no scanned transcript", () => {
		const live = [
			liveInfo({ id: "Fresh", status: "running", task: "just started", sessionFile: "/sessions/main/Fresh.jsonl" }),
		];

		const rows = buildSubagentRows({ main: MAIN, scanned: [], live, now: NOW });

		expect(rows).toHaveLength(2);
		expect(rows[1]).toMatchObject({
			id: "Fresh",
			sessionFile: "/sessions/main/Fresh.jsonl",
			kind: "sub",
			depth: 1,
			label: "Fresh",
			detail: "running · just started",
		});
	});

	it("drops a live subagent that has no session file to tail", () => {
		const live = [liveInfo({ id: "Phantom", task: "nothing to tail" })];

		const rows = buildSubagentRows({ main: MAIN, scanned: [], live, now: NOW });

		expect(rows).toHaveLength(1);
		expect(rows.map(row => row.id)).not.toContain("Phantom");
	});

	it("still lists every scanned transcript when the bridge is unreachable", () => {
		const scanned = [
			transcript({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl" }),
			transcript({ id: "Beta", sessionFile: "/sessions/main/Beta.jsonl" }),
		];

		const rows = buildSubagentRows({ main: MAIN, scanned, live: null, now: NOW });

		expect(rows.map(row => row.id)).toEqual(["Main", "Alpha", "Beta"]);
	});

	it("collapses tabs and newlines out of labels and details", () => {
		const scanned = [transcript({ id: "Al\tpha\nWorker", sessionFile: "/sessions/main/Alpha.jsonl" })];
		const live = [liveInfo({ id: "Alpha", sessionFile: "/sessions/main/Alpha.jsonl", task: "line one\nline two" })];

		const rows = buildSubagentRows({ main: MAIN, scanned, live, now: NOW });

		const row = rows[1];
		expect(row?.label).not.toMatch(/[\t\r\n]/);
		expect(row?.detail).not.toMatch(/[\t\r\n]/);
		expect(row?.detail).toBe("running · line one line two");
	});

	it("strips terminal control sequences out of filenames and bridge strings", () => {
		const scanned = [transcript({ id: "\u001b]2;PWN\u0007Worker", sessionFile: "/sessions/main/Worker.jsonl" })];
		const live = [
			liveInfo({ id: "Worker", sessionFile: "/sessions/main/Worker.jsonl", task: "\u001b[31mRED\u001b[0m alert" }),
		];

		const rows = buildSubagentRows({ main: MAIN, scanned, live, now: NOW });

		const row = rows[1];
		expect(row?.label).toBe("Worker");
		expect(row?.detail).toBe("running · RED alert");
		expect(row?.label).not.toContain("\u001b");
		expect(row?.detail).not.toContain("\u001b");
	});
});

function pickerRow(id: string, detail: string): SubagentPickerRow {
	return { id, sessionFile: `/sessions/main/${id}.jsonl`, kind: "sub", depth: 1, label: id, detail };
}

describe("SubagentPicker", () => {
	let darkTheme: Theme | undefined;
	let previousTheme: Theme;
	let previousKeybindings: TuiKeybindingsManager;

	beforeAll(async () => {
		previousTheme = theme;
		previousKeybindings = getKeybindings();
		darkTheme = await getThemeByName("dark");
		if (!darkTheme) throw new Error("Failed to load dark theme");
	});

	afterAll(() => {
		setThemeInstance(previousTheme);
		setKeybindings(previousKeybindings);
	});

	beforeEach(() => {
		setThemeInstance(darkTheme!);
		setKeybindings(KeybindingsManager.inMemory());
	});

	const rows: SubagentPickerRow[] = [
		{ id: "Main", sessionFile: MAIN.sessionFile, kind: "main", depth: 0, label: "Main", detail: "session" },
		...Array.from({ length: 14 }, (_, index) => pickerRow(`Alpha${index}`, "running")),
		pickerRow("Zephyr", "running"),
	];

	function mount(): { picker: SubagentPicker; picked: () => SubagentPickerRow | undefined; renders: () => number } {
		let picked: SubagentPickerRow | undefined;
		let renders = 0;
		const picker = new SubagentPicker({
			rows,
			selected: MAIN.sessionFile,
			onPick: row => {
				picked = row;
			},
			onCancel: () => {},
			requestRender: () => {
				renders++;
			},
		});
		return { picker, picked: () => picked, renders: () => renders };
	}

	it("keeps the typed filter and the highlighted row across a refresh", () => {
		const { picker, picked } = mount();

		picker.handleInput("z");
		const filtered = Bun.stripANSI(picker.render(80).join("\n"));
		expect(filtered).toContain("Search: z");
		expect(filtered).toContain("Zephyr");
		expect(filtered).not.toContain("Alpha0");

		picker.setRows(
			rows.map(row => (row.kind === "main" ? row : { ...row, detail: "idle · handed off" })),
			MAIN.sessionFile,
		);

		const refreshed = Bun.stripANSI(picker.render(80).join("\n"));
		expect(refreshed).toContain("Search: z");
		expect(refreshed).toContain("Zephyr");
		expect(refreshed).toContain("idle · handed off");
		expect(refreshed).not.toContain("Alpha0");

		picker.handleInput("\n");
		expect(picked()?.id).toBe("Zephyr");
	});

	it("prefixes a nested row with the depth guide at render time", () => {
		const nested: SubagentPickerRow[] = [
			{ id: "Main", sessionFile: MAIN.sessionFile, kind: "main", depth: 0, label: "Main", detail: "session" },
			{ ...pickerRow("Alpha", "running"), depth: 1 },
			{ ...pickerRow("Beta", "running"), depth: 2 },
		];
		const picker = new SubagentPicker({
			rows: nested,
			selected: MAIN.sessionFile,
			onPick: () => {},
			onCancel: () => {},
			requestRender: () => {},
		});

		const lines = picker.render(80).map(line => Bun.stripANSI(line));
		const alpha = lines.find(line => line.includes("Alpha"));
		const beta = lines.find(line => line.includes("Beta"));

		expect(alpha).toBeDefined();
		expect(alpha).not.toContain("│ Alpha");
		expect(beta).toContain("│ Beta");
	});

	it("falls back to the watched session when the selected row disappears", () => {
		const { picker, picked, renders } = mount();

		picker.handleInput("\x1b[B");
		picker.handleInput("\n");
		expect(picked()?.id).toBe("Alpha0");

		picker.setRows(
			rows.filter(row => row.id !== "Alpha0"),
			MAIN.sessionFile,
		);

		expect(renders()).toBe(1);
		picker.handleInput("\n");
		expect(picked()?.id).toBe("Main");
		expect(picked()?.sessionFile).toBe(MAIN.sessionFile);
	});
});
