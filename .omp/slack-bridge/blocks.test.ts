/**
 * Rendering rules for `blocks.ts` that are not obvious from the bridge tests:
 * the thinking excerpt has to survive a *streaming* text buffer, where every
 * intermediate prefix of a reasoning summary is a legal input.
 */
import { describe, expect, test } from "bun:test";
import { routedBlocks, statusText, thinkingLine } from "./blocks";

describe("thinkingLine", () => {
	test("uses the newest complete reasoning-summary headline", () => {
		const text = "**Reading the bridge**\n\nOnly tool labels render.\n\n**Patching the renderer**\n\nGive thinking a line.";
		expect(thinkingLine(text)).toBe("💭 Patching the renderer");
	});

	test("holds the previous headline while the next one is still streaming", () => {
		expect(thinkingLine("**Reading the bridge**\n\nOnly tool labels render.\n\n**Patching th")).toBe("💭 Reading the bridge");
	});

	test("renders nothing until the first headline closes", () => {
		expect(thinkingLine("**Readi")).toBe("");
		expect(thinkingLine("**Reading the brid")).toBe("");
	});

	test("falls back to the newest finished sentence of headline-free thinking", () => {
		expect(thinkingLine("First I check the registry.\n\nThen I patch the renderer.")).toBe("💭 Then I patch the renderer.");
	});

	test("holds back a half-streamed sentence rather than showing a stub", () => {
		expect(thinkingLine("I")).toBe("");
		expect(thinkingLine("I need to ch")).toBe("");
		expect(thinkingLine("I need to check the registry. Then I pa")).toBe("💭 I need to check the registry.");
	});

	test("shows a long terminator-free tail, for models that think in fragments", () => {
		expect(thinkingLine("- read the bridge event handler\n- give thinking its own status line")).toBe("💭 - give thinking its own status line");
	});

	test("does not split a sentence on in-word punctuation", () => {
		expect(thinkingLine("The label lives in blocks.ts:112 and renders once. Next")).toBe("💭 The label lives in blocks.ts:112 and renders once.");
	});

	test("drops gpt-5.x empty-comment padding and blank tails", () => {
		expect(thinkingLine("**Done reasoning**\n\n<!-- -->\n\n")).toBe("💭 Done reasoning");
		expect(thinkingLine("<!-- -->")).toBe("");
		expect(thinkingLine("   \n\n")).toBe("");
	});

	test("ignores bold used mid-prose, which is emphasis and not a headline", () => {
		expect(thinkingLine("The **registry** is keyed by thread ts.")).toBe("💭 The **registry** is keyed by thread ts.");
	});

	test("truncates a long excerpt so the status line stays one line", () => {
		const excerpt = thinkingLine(`**${"headline ".repeat(20).trim()}**`);
		expect(excerpt.length).toBeLessThanOrEqual("💭 ".length + 90);
		expect(excerpt.endsWith("…")).toBe(true);
	});
});

describe("statusText", () => {
	test("keeps the phase line plus the last four timeline lines", () => {
		const text = statusText({ phase: "working", lines: ["a", "b", "c", "d", "e"] });
		expect(text.split("\n")).toEqual(["🛠️ *working*", "> b", "> c", "> d", "> e"]);
	});

	test("escapes mrkdwn control characters in timeline lines", () => {
		expect(statusText({ phase: "working", lines: ["⏵ bash echo <a> & <b>"] })).toContain("&lt;a&gt; &amp; &lt;b&gt;");
	});
});

describe("routedBlocks", () => {
	// No trace ⇒ no blocks at all: the breadcrumb stays the one-line message it
	// has always been, so a silent worker costs nothing.
	test("a traceless decision renders as the bare breadcrumb line", () => {
		expect(routedBlocks({ command: "run" })).toEqual({ text: "_routed → `run`_" });
	});

	// The agent is the whole point of the breadcrumb now: it is the only place the
	// user learns which agent took their message.
	test("the routed agent shows in the breadcrumb", () => {
		expect(routedBlocks({ command: "run", agent: "planner" })).toEqual({ text: "_routed → `run` as `planner`_" });
	});

	test("a trace becomes a context sub-line: turn count, then one italic line per step", () => {
		const { text, blocks } = routedBlocks({
			command: "run",
			agent: "planner",
			trace: { turns: 2, summary: "read it as a planning request\ncalled run in omp as planner" },
		});

		expect(text).toBe("_routed → `run` as `planner`_");
		expect(blocks).toEqual([
			{ type: "section", text: { type: "mrkdwn", text: "_routed → `run` as `planner`_" } },
			{
				type: "context",
				elements: [{ type: "mrkdwn", text: "🧭 2 turns\n_read it as a planning request_\n_called run in omp as planner_" }],
			},
		]);
	});

	test("a lone turn count still renders, singular", () => {
		const { blocks } = routedBlocks({ command: "help", trace: { turns: 1 } });
		expect(blocks?.at(-1)).toEqual({ type: "context", elements: [{ type: "mrkdwn", text: "🧭 1 turn" }] });
	});

	test("escapes mrkdwn control characters in the worker's own text", () => {
		const { blocks } = routedBlocks({ command: "run", trace: { summary: "read <a> & <b> as a fix" } });
		expect(blocks?.at(-1)).toEqual({
			type: "context",
			elements: [{ type: "mrkdwn", text: "_read &lt;a&gt; &amp; &lt;b&gt; as a fix_" }],
		});
	});
});
