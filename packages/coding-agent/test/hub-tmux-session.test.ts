import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hubTmuxSession, parseHubPanes } from "@oh-my-pi/pi-coding-agent/hub/tmux";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";

// The hub tmux session name is the sole scope that keeps two concurrent
// `omp hub` runs in different projects from attaching to the same tmux session
// and mirroring each other. These tests defend that contract: the name is
// stable per project, distinct across projects (even same-basename ones), and
// always tmux-safe.

describe("hubTmuxSession", () => {
	let tmp: string;
	const savedCwd = process.cwd();
	const savedProjectDir = getProjectDir();

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hub-tmux-"));
	});

	afterEach(async () => {
		// setProjectDir chdir's; restore both the project dir and the cwd so this
		// file cannot poison later tests in the suite.
		process.chdir(savedCwd);
		setProjectDir(savedProjectDir);
		await removeWithRetries(tmp);
	});

	const TMUX_SAFE = /^[A-Za-z0-9_-]+$/;

	test("is stable for a given project dir and always tmux-safe", async () => {
		const proj = path.join(tmp, "my-project");
		await fs.mkdir(proj);
		setProjectDir(proj);
		const first = hubTmuxSession();
		const second = hubTmuxSession();

		expect(first).toBe(second);
		expect(first).toMatch(TMUX_SAFE);
		expect(first.startsWith("omp-hub-")).toBe(true);
		// Human-readable: the project basename is embedded.
		expect(first).toContain("my-project");
	});

	test("distinguishes different projects that share a basename", async () => {
		const a = path.join(tmp, "a", "proj");
		const b = path.join(tmp, "b", "proj");
		await fs.mkdir(a, { recursive: true });
		await fs.mkdir(b, { recursive: true });

		setProjectDir(a);
		const nameA = hubTmuxSession();
		setProjectDir(b);
		const nameB = hubTmuxSession();

		// Same readable slug, different disambiguating hash → distinct sessions.
		expect(nameA).not.toBe(nameB);
		expect(nameA).toContain("proj");
		expect(nameB).toContain("proj");
	});

	test("sanitizes spaces and unsafe characters in the project name", async () => {
		const proj = path.join(tmp, "my cool proj");
		await fs.mkdir(proj);
		setProjectDir(proj);
		const name = hubTmuxSession();

		expect(name).toMatch(TMUX_SAFE);
		// tmux target chars (`.`/`:`) and spaces never leak into the name.
		expect(name).not.toContain(" ");
		expect(name).not.toContain(".");
		expect(name).not.toContain(":");
	});
});

// `omp hub list` parsing contract: group panes by session, keep only hub
// sessions, count live windows minus the hub window, take the project dir from
// the hub (lowest-index) window, mark the current project's hub, sort by
// recency.
const TAB = "\t";
function paneRow(fields: {
	name: string;
	windows: number;
	attached: 0 | 1;
	activity: number;
	windowIndex: number;
	panePath: string;
}): string {
	return [fields.name, fields.windows, fields.attached, fields.activity, fields.windowIndex, fields.panePath].join(
		TAB,
	);
}

describe("parseHubPanes", () => {
	test("summarizes a hub: window count excludes the hub window, project from hub window", () => {
		const out = [
			paneRow({
				name: "omp-hub-proj-abc123",
				windows: 3,
				attached: 1,
				activity: 200,
				windowIndex: 0,
				panePath: "/work/proj",
			}),
			paneRow({
				name: "omp-hub-proj-abc123",
				windows: 3,
				attached: 1,
				activity: 200,
				windowIndex: 1,
				panePath: "/work/proj/sub",
			}),
			paneRow({
				name: "omp-hub-proj-abc123",
				windows: 3,
				attached: 1,
				activity: 200,
				windowIndex: 2,
				panePath: "/work/proj/other",
			}),
		].join("\n");

		const hubs = parseHubPanes(out, "omp-hub-proj-abc123");
		expect(hubs).toHaveLength(1);
		expect(hubs[0].sessions).toBe(2); // 3 windows - hub window
		expect(hubs[0].project).toBe("/work/proj"); // lowest window index wins
		expect(hubs[0].attached).toBe(true);
		expect(hubs[0].current).toBe(true);
	});

	test("ignores non-hub sessions and picks project dir from the lowest window index regardless of row order", () => {
		const out = [
			paneRow({ name: "my-work", windows: 1, attached: 0, activity: 999, windowIndex: 0, panePath: "/nope" }),
			// hub window (index 1, base-index 1) appears after a higher-index row
			paneRow({
				name: "omp-hub-a-111",
				windows: 2,
				attached: 0,
				activity: 50,
				windowIndex: 2,
				panePath: "/a/wrong",
			}),
			paneRow({
				name: "omp-hub-a-111",
				windows: 2,
				attached: 0,
				activity: 50,
				windowIndex: 1,
				panePath: "/a/right",
			}),
		].join("\n");

		const hubs = parseHubPanes(out, "omp-hub-other-000");
		expect(hubs.map(h => h.session)).toEqual(["omp-hub-a-111"]);
		expect(hubs[0].project).toBe("/a/right");
		expect(hubs[0].current).toBe(false);
	});

	test("sorts multiple hubs most-recently-active first", () => {
		const out = [
			paneRow({ name: "omp-hub-old-111", windows: 1, attached: 0, activity: 100, windowIndex: 0, panePath: "/old" }),
			paneRow({ name: "omp-hub-new-222", windows: 1, attached: 0, activity: 500, windowIndex: 0, panePath: "/new" }),
			paneRow({ name: "omp-hub-mid-333", windows: 1, attached: 0, activity: 300, windowIndex: 0, panePath: "/mid" }),
		].join("\n");

		const hubs = parseHubPanes(out, "");
		expect(hubs.map(h => h.session)).toEqual(["omp-hub-new-222", "omp-hub-mid-333", "omp-hub-old-111"]);
		// A hub whose only window is the hub window reports zero live sessions.
		expect(hubs.every(h => h.sessions === 0)).toBe(true);
	});

	test("returns [] for empty output", () => {
		expect(parseHubPanes("", "omp-hub-x-1")).toEqual([]);
	});
});
