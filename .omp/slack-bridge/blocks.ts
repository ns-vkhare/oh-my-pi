/**
 * Block Kit / mrkdwn rendering helpers. Pure — no I/O.
 *
 * Every user-visible string routes through these so mrkdwn control chars are
 * escaped and long content is chunked/truncated to Slack limits.
 */

import type { OmpUiRequest, RouterTrace, SlackBlock } from "./types";

/** Slack section text hard limit is 3000 chars; leave headroom. */
const DEFAULT_CHUNK_SIZE = 2900;
/** static_select option labels cap at 75 chars. */
const OPTION_LABEL_MAX = 75;
/** Buttons vs. dropdown threshold for select requests. */
const BUTTON_LIMIT = 5;
/** finalTextBlocks caps its section count; caller uploads the full text. */
const FINAL_BLOCK_CAP = 8;
/** Status-line budget for one thinking excerpt. */
const THINKING_EXCERPT_MAX = 90;

const PHASE_EMOJI: Record<string, string> = {
	starting: "⏳",
	working: "🛠️",
	done: "✅",
	error: "❌",
	killed: "💀",
};

const NOTIFY_EMOJI: Record<string, string> = {
	info: "ℹ️",
	warn: "⚠️",
	error: "❌",
};

/** Escape the three mrkdwn control characters per Slack's rules. */
export function escapeMrkdwn(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Truncate to `max` chars with a trailing ellipsis when cut. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	if (max <= 1) return text.slice(0, max);
	return `${text.slice(0, max - 1)}…`;
}

/** Split text into chunks ≤ `chunkSize`, preferring line boundaries. */
export function chunkText(text: string, chunkSize: number = DEFAULT_CHUNK_SIZE): string[] {
	if (text.length <= chunkSize) return [text];
	const chunks: string[] = [];
	let current = "";
	for (const line of text.split("\n")) {
		// A single line longer than the chunk size is hard-split.
		if (line.length > chunkSize) {
			if (current) {
				chunks.push(current);
				current = "";
			}
			for (let i = 0; i < line.length; i += chunkSize) {
				chunks.push(line.slice(i, i + chunkSize));
			}
			continue;
		}
		const candidate = current ? `${current}\n${line}` : line;
		if (candidate.length > chunkSize) {
			chunks.push(current);
			current = line;
		} else {
			current = candidate;
		}
	}
	if (current) chunks.push(current);
	return chunks.length > 0 ? chunks : [""];
}

function section(text: string): SlackBlock {
	return { type: "section", text: { type: "mrkdwn", text } };
}

/**
 * The routing breadcrumb: the decision on top, the router's own account of it in
 * a context sub-line underneath.
 *
 * `text` stays the one-line form every notification and test already reads, so
 * the blocks are pure enrichment — a decision with no trace renders as the bare
 * line it always did. The summary is the worker's untrusted text: already clamped
 * to three short lines by `parseDecision`, escaped here, and italicised per line
 * so a multi-line account still reads as one aside rather than as agent output.
 */
export function routedBlocks(args: { command: string; agent?: string; trace?: RouterTrace }): { text: string; blocks?: SlackBlock[] } {
	const text = `_routed → \`${escapeMrkdwn(args.command)}\`${args.agent ? ` as \`${escapeMrkdwn(args.agent)}\`` : ""}_`;
	const details: string[] = [];
	if (args.trace?.turns !== undefined) {
		details.push(`🧭 ${args.trace.turns} ${args.trace.turns === 1 ? "turn" : "turns"}`);
	}
	for (const line of args.trace?.summary?.split("\n") ?? []) {
		details.push(`_${escapeMrkdwn(line)}_`);
	}
	if (details.length === 0) return { text };
	return {
		text,
		blocks: [section(text), { type: "context", elements: [{ type: "mrkdwn", text: details.join("\n") }] }],
	};
}

/**
 * Header for a newly dispatched task: name, context line, session identity,
 * interaction hint. `sessionId` is the id `omp --resume <id>` takes, so the
 * thread opens with the handle a reader needs to pick the session up elsewhere.
 */
export function taskHeaderBlocks(args: { name: string; cwd: string; sessionPath?: string; sessionId?: string; model?: string }): SlackBlock[] {
	const contextParts = [`📁 \`${escapeMrkdwn(args.cwd)}\``];
	if (args.model) contextParts.push(`🧠 ${escapeMrkdwn(args.model)}`);
	const blocks: SlackBlock[] = [
		section(`*${escapeMrkdwn(args.name)}*`),
		{ type: "context", elements: [{ type: "mrkdwn", text: contextParts.join("  ·  ") }] },
	];
	const sessionParts: string[] = [];
	if (args.sessionId) sessionParts.push(`🆔 \`${escapeMrkdwn(args.sessionId)}\``);
	if (args.sessionPath) sessionParts.push(`🗂️ \`${escapeMrkdwn(args.sessionPath)}\``);
	if (sessionParts.length > 0) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: sessionParts.join("  ·  ") }],
		});
	}
	blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "💬 _reply in this thread to interact_" }] });
	return blocks;
}

/** Single mrkdwn status line: phase emoji + up to the last 4 timeline lines. */
export function statusText(args: { phase: "starting" | "working" | "done" | "error" | "killed"; lines: string[]; detail?: string }): string {
	const emoji = PHASE_EMOJI[args.phase] ?? "•";
	const out = [`${emoji} *${args.phase}*${args.detail ? ` — ${escapeMrkdwn(args.detail)}` : ""}`];
	for (const line of args.lines.slice(-4)) out.push(`> ${escapeMrkdwn(line)}`);
	return out.join("\n");
}

/** gpt-5.x pads every reasoning-summary part with an empty HTML comment. */
const THINKING_NOISE_RE = /<!--\s*-->/g;
/** Bold headline a gpt-5.x/codex reasoning-summary part opens with (line-anchored: bold mid-prose is not a headline). */
const THINKING_HEADLINE_RE = /^\s*\*\*(.+?)\*\*/gm;
/** One finished sentence: ends at a terminator that closes a word, so `blocks.ts:112` and `3.5` stay inside the sentence. */
const THINKING_SENTENCE_RE = /[^\n]*?[.!?:]+(?=\s|$)/g;
/** Shorter terminator-free tails are first-delta stubs (`I need to ch`), not thoughts. */
const THINKING_MIN_TAIL = 24;

/**
 * Status line for a thinking block, rendered from a *streaming* buffer where
 * every prefix is a legal input: the newest complete reasoning-summary headline
 * (gpt-5.x/codex), else the newest finished sentence of raw thinking, else a
 * long-enough tail for models that think in fragments. Empty while the block has
 * only a stub — better no line than `💭 I` or a half-written `**headl`.
 */
export function thinkingLine(text: string): string {
	const clean = text.replace(THINKING_NOISE_RE, "");
	let excerpt = "";
	for (const match of clean.matchAll(THINKING_HEADLINE_RE)) excerpt = match[1]!.trim();
	if (!excerpt) {
		for (const match of clean.matchAll(THINKING_SENTENCE_RE)) excerpt = match[0]!.trim();
	}
	if (!excerpt) {
		let tail = "";
		for (const raw of clean.split("\n")) {
			const line = raw.trim();
			if (line) tail = line;
		}
		if (!tail.startsWith("**") && tail.length >= THINKING_MIN_TAIL) excerpt = tail;
	}
	return excerpt ? `💭 ${truncate(excerpt, THINKING_EXCERPT_MAX)}` : "";
}

/** Blocks for a UI request needing a Slack answer (select/confirm/input/editor). */
export function uiRequestBlocks(req: OmpUiRequest & { method: "select" | "confirm" | "input" | "editor" }): SlackBlock[] {
	if (req.method === "select") {
		const listed = req.options.map((opt, i) => `${i + 1}. ${escapeMrkdwn(opt)}`).join("\n");
		const blocks: SlackBlock[] = [section(`*${escapeMrkdwn(req.title)}*\n${listed}`)];
		if (req.options.length <= BUTTON_LIMIT) {
			blocks.push({
				type: "actions",
				elements: req.options.map((opt, i) => ({
					type: "button",
					text: { type: "plain_text", text: truncate(opt, OPTION_LABEL_MAX) },
					action_id: `ui:${req.id}:${i}`,
					value: opt,
					...(i === 0 ? { style: "primary" } : {}),
				})),
			});
		} else {
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "static_select",
						action_id: `ui:${req.id}`,
						placeholder: { type: "plain_text", text: "Choose an option" },
						options: req.options.map((opt) => ({
							text: { type: "plain_text", text: truncate(opt, OPTION_LABEL_MAX) },
							value: opt,
						})),
					},
				],
			});
		}
		return blocks;
	}

	if (req.method === "confirm") {
		return [
			section(`*${escapeMrkdwn(req.title)}*\n${escapeMrkdwn(req.message)}`),
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Yes" },
						action_id: `ui:${req.id}:yes`,
						value: "yes",
						style: "primary",
					},
					{
						type: "button",
						text: { type: "plain_text", text: "No" },
						action_id: `ui:${req.id}:no`,
						value: "no",
						style: "danger",
					},
				],
			},
		];
	}

	// input / editor — answered by a thread reply.
	const hint = req.method === "input" ? req.placeholder : req.prefill;
	const blocks: SlackBlock[] = [section(`*${escapeMrkdwn(req.title)}*\n_Reply in this thread with your answer._`)];
	if (hint) blocks.push(section(`> ${escapeMrkdwn(hint)}`));
	return blocks;
}

/** Replacement blocks for an answered UI message. */
export function answeredBlocks(args: { title: string; answer: string; user: string }): SlackBlock[] {
	return [
		section(`*${escapeMrkdwn(args.title)}*`),
		section(`✅ ${escapeMrkdwn(args.answer)} — <@${args.user}>`),
	];
}

/**
 * Blocks for one `ask` host-tool question. Section with the question text
 * (header as a bold prefix line when present) and a numbered mrkdwn list of
 * option labels/descriptions; interactive element is buttons (≤5 options) or a
 * static_select (>5). action_id encodes callId/questionIndex[/optionIndex].
 */
export function askQuestionBlocks(args: {
	callId: string;
	questionIndex: number;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string }>;
	multi?: boolean;
	recommended?: number;
}): SlackBlock[] {
	const { callId, questionIndex, question, header, options, multi, recommended } = args;
	const lines: string[] = [];
	if (header) lines.push(`*${escapeMrkdwn(header)}*`);
	lines.push(escapeMrkdwn(question));
	const listed = options
		.map((opt, i) => `${i + 1}. *${escapeMrkdwn(opt.label)}*${opt.description ? ` — ${escapeMrkdwn(opt.description)}` : ""}`)
		.join("\n");
	if (listed) lines.push(listed);
	const blocks: SlackBlock[] = [section(lines.join("\n"))];

	if (options.length <= BUTTON_LIMIT) {
		blocks.push({
			type: "actions",
			elements: options.map((opt, i) => ({
				type: "button",
				text: { type: "plain_text", text: truncate(opt.label, OPTION_LABEL_MAX) },
				action_id: `ask:${callId}:${questionIndex}:${i}`,
				value: opt.label,
				...(recommended === i ? { style: "primary" } : {}),
			})),
		});
	} else {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "static_select",
					action_id: `ask:${callId}:${questionIndex}`,
					placeholder: { type: "plain_text", text: "Choose an option" },
					options: options.map((opt) => ({
						text: { type: "plain_text", text: truncate(opt.label, OPTION_LABEL_MAX) },
						value: truncate(opt.label, OPTION_LABEL_MAX),
					})),
				},
			],
		});
	}

	if (multi) {
		blocks.push({
			type: "context",
			elements: [{ type: "mrkdwn", text: "multi-select: reply in thread with comma-separated numbers or labels" }],
		});
	}
	return blocks;
}

/** Replacement blocks for an answered `ask` question message. */
export function askAnsweredBlocks(args: { question: string; answer: string; user: string }): SlackBlock[] {
	return [
		section(`*${escapeMrkdwn(args.question)}*`),
		section(`✅ ${escapeMrkdwn(args.answer)} — <@${args.user}>`),
	];
}

/** Chunked final-answer sections, capped at FINAL_BLOCK_CAP blocks. */
export function finalTextBlocks(text: string): SlackBlock[] {
	return chunkText(text).slice(0, FINAL_BLOCK_CAP).map((chunk) => section(chunk));
}

/** Prefixed notify line for a `notify` UI request. */
export function notifyText(level: string | undefined, message: string): string {
	const emoji = NOTIFY_EMOJI[level ?? "info"] ?? "ℹ️";
	return `${emoji} ${escapeMrkdwn(message)}`;
}
