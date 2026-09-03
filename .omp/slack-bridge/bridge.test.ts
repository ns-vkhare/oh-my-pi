/**
 * Hermetic bridge tests — fake SlackTransport + fake OmpRpc, no network, no omp.
 *
 * Covers config loading, DM command routing, allowlist enforcement, UI relay
 * (select buttons + input replies), turn completion rendering, lazy respawn,
 * and registry persistence.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { Bridge, loadConfig, ompSessionDir, type ListAgents, type ListSessions, type StoreSession } from "./bridge";
import { TaskRegistry } from "./registry";
import type {
	AgentOption,
	BridgeConfig,
	ImageContent,
	OmpAgentEvent,
	OmpHostToolCall,
	OmpHostToolCancel,
	OmpHostToolDefinition,
	OmpHostToolResult,
	OmpRpc,
	OmpRpcOptions,
	OmpSessionState,
	OmpSubagentSnapshot,
	OmpUiRequest,
	OmpUiResponse,
	RouteMessage,
	RouterContext,
	RouterDecision,
	SlackBlock,
	SlackBlockAction,
	SlackFileRef,
	SlackHistoryEntry,
	SlackInbound,
	SlackInboundMessage,
	SlackPostArgs,
	SlackTransport,
	TaskRecord,
} from "./types";

const HOME = "/home/tester";

// --- fakes ------------------------------------------------------------------

interface PostedMessage {
	ts: string;
	args: SlackPostArgs;
}

interface UpdatedMessage {
	ts: string;
	text: string;
	blocks?: SlackBlock[];
}

/** One `uploadFiles` call: Slack turns each batch into a single thread message. */
interface UploadedBatch {
	threadTs: string;
	files: Array<{ filename: string; text: string }>;
	comment?: string;
}

class FakeSlack implements SlackTransport {
	readonly botUserId = "UBOT";
	readonly posted: PostedMessage[] = [];
	readonly updated: UpdatedMessage[] = [];
	readonly uploads: Array<{ threadTs: string; content: string }> = [];
	/** One entry per uploadFiles batch — Slack posts each batch as one message. */
	readonly uploadedFiles: UploadedBatch[] = [];
	#uploadWaiters: Array<(batch: UploadedBatch) => void> = [];
	/** channel → history rows the catch-up sweep will see (newest first). */
	readonly history = new Map<string, SlackHistoryEntry[]>();
	/** downloadUrl → bytes. Unknown urls throw, like a missing files:read scope. */
	readonly downloads = new Map<string, Uint8Array>();
	connected = true;
	reconnects = 0;
	#listeners = new Set<(inbound: SlackInbound) => void>();
	#counter = 0;
	#postWaiters: Array<(args: SlackPostArgs) => void> = [];

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onInbound(listener: (inbound: SlackInbound) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async postMessage(args: SlackPostArgs): Promise<string> {
		const ts = `ts${++this.#counter}`;
		this.posted.push({ ts, args });
		this.#postWaiters.splice(0).forEach((resolve) => resolve(args));
		return ts;
	}

	/** The newest posted message, awaiting one when none has been posted yet. */
	nextPost(): Promise<SlackPostArgs> {
		const last = this.posted.at(-1);
		if (last) return Promise.resolve(last.args);
		const { promise, resolve } = Promise.withResolvers<SlackPostArgs>();
		this.#postWaiters.push(resolve);
		return promise;
	}

	async updateMessage(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
		this.updated.push({ ts: args.ts, text: args.text, blocks: args.blocks });
	}

	async uploadText(args: { channel: string; threadTs: string; filename: string; content: string }): Promise<void> {
		this.uploads.push({ threadTs: args.threadTs, content: args.content });
	}

	async uploadFiles(args: {
		channel: string;
		threadTs: string;
		files: Array<{ filename: string; bytes: Uint8Array }>;
		comment?: string;
	}): Promise<void> {
		const batch = {
			threadTs: args.threadTs,
			files: args.files.map((f) => ({ filename: f.filename, text: new TextDecoder().decode(f.bytes) })),
			comment: args.comment,
		};
		this.uploadedFiles.push(batch);
		this.#uploadWaiters.splice(0).forEach((resolve) => resolve(batch));
	}

	/** The newest uploadFiles batch, awaiting one when it is still being read off disk. */
	nextUpload(): Promise<UploadedBatch> {
		const last = this.uploadedFiles.at(-1);
		if (last) return Promise.resolve(last);
		const { promise, resolve } = Promise.withResolvers<UploadedBatch>();
		this.#uploadWaiters.push(resolve);
		return promise;
	}

	async openDm(userId: string): Promise<string> {
		return `D-${userId}`;
	}

	async fetchHistory(args: { channel: string; oldestTs: string; limit?: number }): Promise<SlackHistoryEntry[]> {
		const rows = this.history.get(args.channel) ?? [];
		return rows.filter((entry) => Number(entry.message.ts) > Number(args.oldestTs));
	}

	async downloadFile(url: string): Promise<Uint8Array> {
		const bytes = this.downloads.get(url);
		if (!bytes) throw new Error("sign-in page — the bot token lacks the files:read scope");
		return bytes;
	}

	reconnect(): void {
		this.reconnects++;
	}

	/** Inject an inbound and let the async handler chain settle. */
	async inject(inbound: SlackInbound): Promise<void> {
		for (const listener of this.#listeners) listener(inbound);
		await settle();
	}
}

class FakeRpc implements OmpRpc {
	readonly opts: OmpRpcOptions;
	alive = false;
	readonly commands: string[] = [];
	readonly uiResponses: OmpUiResponse[] = [];
	readonly prompts: string[] = [];
	/** Images sent with the same-index entry of {@link prompts}. */
	readonly promptImages: Array<ImageContent[] | undefined> = [];
	readonly hostTools: OmpHostToolDefinition[][] = [];
	readonly hostToolResults: OmpHostToolResult[] = [];
	lastAssistantText: string | null = "done";
	/** Shaped like a real session file — `<timestamp>_<sessionId>.jsonl` — so the id is derivable. */
	state: OmpSessionState = {
		isStreaming: false,
		sessionFile: `${HOME}/.omp/agent/sessions/2026-07-29T12-00-00_9f3c1a2b.jsonl`,
		sessionName: "sess",
		model: { provider: "anthropic", id: "claude-opus-5" },
	};
	startError?: Error;
	#promptWaiters: Array<(prompt: SentPrompt) => void> = [];
	#hostResultWaiters: Array<(result: OmpHostToolResult) => void> = [];
	#eventListeners = new Set<(e: OmpAgentEvent) => void>();
	#uiListeners = new Set<(r: OmpUiRequest) => void>();
	#hostCallListeners = new Set<(c: OmpHostToolCall) => void>();
	#hostCancelListeners = new Set<(c: OmpHostToolCancel) => void>();
	#exitListeners = new Set<(code: number | null) => void>();

	constructor(opts: OmpRpcOptions) {
		this.opts = opts;
	}

	onEvent(listener: (e: OmpAgentEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => this.#eventListeners.delete(listener);
	}
	onUiRequest(listener: (r: OmpUiRequest) => void): () => void {
		this.#uiListeners.add(listener);
		return () => this.#uiListeners.delete(listener);
	}
	onHostToolCall(listener: (c: OmpHostToolCall) => void): () => void {
		this.#hostCallListeners.add(listener);
		return () => this.#hostCallListeners.delete(listener);
	}
	onHostToolCancel(listener: (c: OmpHostToolCancel) => void): () => void {
		this.#hostCancelListeners.add(listener);
		return () => this.#hostCancelListeners.delete(listener);
	}
	onExit(listener: (code: number | null) => void): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.startError) throw this.startError;
		this.alive = true;
	}
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		this.commands.push("prompt");
		this.prompts.push(message);
		this.promptImages.push(images);
		this.#promptWaiters.splice(0).forEach((resolve) => resolve({ text: message, images }));
	}

	/**
	 * The newest prompt, awaiting one when it has not arrived yet.
	 *
	 * Same idiom as {@link Harness.nextRpc}: an inbound chain that materializes
	 * attachments suspends on real disk writes, which a microtask drain cannot
	 * flush, so tests await the effect itself rather than a wall-clock guess.
	 */
	nextPrompt(): Promise<SentPrompt> {
		const last = this.prompts.length - 1;
		if (last >= 0) return Promise.resolve({ text: this.prompts[last]!, images: this.promptImages[last] });
		const { promise, resolve } = Promise.withResolvers<SentPrompt>();
		this.#promptWaiters.push(resolve);
		return promise;
	}
	async abort(): Promise<void> {
		this.commands.push("abort");
	}
	async getState(): Promise<OmpSessionState> {
		this.commands.push("get_state");
		return this.state;
	}
	async getLastAssistantText(): Promise<string | null> {
		this.commands.push("get_last_assistant_text");
		return this.lastAssistantText;
	}
	subagents: OmpSubagentSnapshot[] = [];
	async getSubagents(): Promise<OmpSubagentSnapshot[]> {
		this.commands.push("get_subagents");
		return this.subagents;
	}
	async setSessionName(name: string): Promise<void> {
		this.commands.push(`set_session_name:${name}`);
	}
	respondUi(response: OmpUiResponse): void {
		this.uiResponses.push(response);
	}
	async stop(): Promise<void> {
		this.commands.push("stop");
		this.alive = false;
	}
	async setHostTools(tools: OmpHostToolDefinition[]): Promise<void> {
		this.commands.push("set_host_tools");
		this.hostTools.push(tools);
	}
	respondHostTool(result: OmpHostToolResult): void {
		this.hostToolResults.push(result);
		this.#hostResultWaiters.splice(0).forEach((resolve) => resolve(result));
	}

	/** The newest host-tool result, awaiting one when the handler is still working. */
	nextHostToolResult(): Promise<OmpHostToolResult> {
		const last = this.hostToolResults.at(-1);
		if (last) return Promise.resolve(last);
		const { promise, resolve } = Promise.withResolvers<OmpHostToolResult>();
		this.#hostResultWaiters.push(resolve);
		return promise;
	}

	emitEvent(event: OmpAgentEvent): void {
		for (const l of this.#eventListeners) l(event);
	}
	emitUi(req: OmpUiRequest): void {
		for (const l of this.#uiListeners) l(req);
	}
	emitExit(code: number | null): void {
		for (const l of this.#exitListeners) l(code);
	}
	emitHostToolCall(call: OmpHostToolCall): void {
		for (const l of this.#hostCallListeners) l(call);
	}
	emitHostToolCancel(cancel: OmpHostToolCancel): void {
		for (const l of this.#hostCancelListeners) l(cancel);
	}
}

/**
 * Drain the microtask queue so the awaited inbound-handler chains complete.
 * Every fake operation resolves synchronously, so repeated microtask yields
 * flush the whole chain deterministically — no wall-clock waiting.
 */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** One prompt as the agent received it. */
interface SentPrompt {
	text: string;
	images?: ImageContent[];
}

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		slackAppToken: "xapp-1",
		slackBotToken: "xoxb-1",
		allowedUsers: ["UALICE"],
		ompBin: "omp",
		repos: { omp: `${HOME}/oh-my-pi-src` },
		defaultRepo: undefined,
		maxTasks: 4,
		idleTtlMin: 30,
		sessionNamePrefix: "slack:",
		// Off by default: only the catch-up tests want a sweep on start().
		catchupWindowMin: 0,
		routerModel: "",
		routerTimeoutMs: 60_000,
		routerScript: "/nonexistent/route.sh",
		stateDir: `${HOME}/.omp/slack-bridge`,
		...overrides,
	};
}

interface Harness {
	slack: FakeSlack;
	registry: TaskRegistry;
	bridge: Bridge;
	rpcs: FakeRpc[];
	/**
	 * Resolves with the next RPC the bridge spawns. `settle()` only drains
	 * microtasks, so a spawn gated on real filesystem I/O — the agent inventory
	 * scan reads agent definitions from disk — needs the actual signal rather
	 * than a wall-clock wait.
	 */
	nextRpc: () => Promise<FakeRpc>;
}

/** Bridges created via makeHarness; shut down after each test to clear timers. */
const liveHarnesses: Bridge[] = [];
afterEach(async () => {
	while (liveHarnesses.length > 0) await liveHarnesses.pop()!.shutdown();
});

/**
 * Stand-in for the agent definitions under `.omp/agents` / `~/.omp/agent/agents`.
 * Injected by default so no test ever reads the developer's real inventory.
 */
const AGENTS: AgentOption[] = [
	{ name: "orchestrate", description: "decompose the work and fan it out to parallel subagents" },
	{ name: "planner", description: "plan and scope a change before any code is written" },
	{ name: "scout", description: "read-only research in this codebase" },
];

async function makeHarness(
	config: BridgeConfig,
	seed: TaskRecord[] = [],
	listSessions?: ListSessions,
	route?: RouteMessage,
	listAgents: ListAgents = async () => AGENTS,
): Promise<Harness> {
	const slack = new FakeSlack();
	const dir = `/tmp/bridge-test-${Math.random().toString(36).slice(2)}`;
	const registry = await TaskRegistry.load(dir);
	for (const rec of seed) registry.upsert(rec);
	const rpcs: FakeRpc[] = [];
	const waiters: Array<(rpc: FakeRpc) => void> = [];
	const createRpc = (opts: OmpRpcOptions): OmpRpc => {
		const rpc = new FakeRpc(opts);
		rpcs.push(rpc);
		waiters.splice(0).forEach((resolve) => resolve(rpc));
		return rpc;
	};
	const bridge = new Bridge({ config, slack, registry, createRpc, listSessions, route, listAgents });
	bridge.start();
	// start() kicks a catch-up sweep; drain it so a test's own sweep is not
	// swallowed by the overlap guard.
	await settle();
	liveHarnesses.push(bridge);
	const nextRpc = (): Promise<FakeRpc> => {
		const pending = rpcs.at(-1);
		if (pending) return Promise.resolve(pending);
		const { promise, resolve } = Promise.withResolvers<FakeRpc>();
		waiters.push(resolve);
		return promise;
	};
	return { slack, registry, bridge, rpcs, nextRpc };
}

let dmSeq = 0;

function dm(text: string, user = "UALICE", threadTs?: string): SlackInboundMessage {
	return { kind: "message", channel: "D1", user, text, ts: `m${++dmSeq}`, threadTs };
}

/**
 * Emit one streaming thinking block the way RPC mode forwards it: start, deltas
 * in small chunks (so partial-headline states are exercised), then end.
 */
function emitThinking(rpc: FakeRpc, text: string, contentIndex = 0): void {
	rpc.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex } });
	for (const chunk of text.match(/[\s\S]{1,12}/g) ?? []) {
		rpc.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta: chunk } });
	}
	rpc.emitEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex, content: text } });
}

// --- tests ------------------------------------------------------------------

describe("loadConfig", () => {
	test("happy path parses REPOS aliases and allowlist", () => {
		const config = loadConfig(
			{
				SLACK_APP_TOKEN: "xapp-1",
				SLACK_BOT_TOKEN: "xoxb-1",
				SLACK_ALLOWED_USERS: "UALICE, UBOB",
				REPOS: "omp=~/oh-my-pi-src,api=/srv/api",
				MAX_TASKS: "6",
			},
			HOME,
		);
		expect(config.allowedUsers).toEqual(["UALICE", "UBOB"]);
		expect(config.repos.omp).toBe(`${HOME}/oh-my-pi-src`);
		expect(config.repos.api).toBe("/srv/api");
		expect(config.maxTasks).toBe(6);
		expect(config.ompBin).toBe("omp");
	});

	test("empty SLACK_ALLOWED_USERS throws", () => {
		expect(() =>
			loadConfig({ SLACK_APP_TOKEN: "xapp-1", SLACK_BOT_TOKEN: "xoxb-1", SLACK_ALLOWED_USERS: "" }, HOME),
		).toThrow(/SLACK_ALLOWED_USERS/);
	});

	test("missing tokens throw", () => {
		expect(() => loadConfig({ SLACK_ALLOWED_USERS: "UALICE" }, HOME)).toThrow(/SLACK_APP_TOKEN/);
	});
});

describe("run command", () => {
	test("non-allowlisted user is ignored", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("run omp fix the bug", "UMALLORY"));
		expect(h.slack.posted).toHaveLength(0);
		expect(h.rpcs).toHaveLength(0);
	});

	test("allowlisted run threads under the user's message, spawns rpc with cwd + OMP_HUB_NEW_SESSION, prompts after start", async () => {
		const h = await makeHarness(makeConfig());
		const msg = dm("run omp fix the bug");
		await h.slack.inject(msg);

		// The task thread IS the user's message: the header is its first reply.
		expect(h.slack.posted.length).toBeGreaterThanOrEqual(1);
		const header = h.slack.posted[0]!;
		expect(header.args.blocks).toBeDefined();
		expect(header.args.threadTs).toBe(msg.ts);
		expect(h.slack.posted.every((p) => p.args.threadTs === msg.ts)).toBe(true);

		expect(h.rpcs).toHaveLength(1);
		const rpc = h.rpcs[0]!;
		expect(rpc.opts.cwd).toBe(`${HOME}/oh-my-pi-src`);
		expect(rpc.opts.env?.OMP_HUB_NEW_SESSION).toBe("1");
		expect(rpc.prompts).toEqual(["fix the bug"]);
		// Registry keyed by the user's message ts, so later replies to it route back.
		expect(h.registry.byThread(msg.ts)).toBeDefined();
	});

	test("help for an unknown top-level command replies in the message's thread", async () => {
		const h = await makeHarness(makeConfig());
		const msg = dm("what can you do");
		await h.slack.inject(msg);
		expect(h.slack.posted).toHaveLength(1);
		expect(h.slack.posted[0]!.args.threadTs).toBe(msg.ts);
	});
});

/**
 * Socket Mode drops whatever arrives while the connection is down — or while it
 * is a zombie the OS never closed. These cover the recovery path: what gets
 * replayed, what must never be replayed twice, and what the sweep infers about
 * a socket that reported itself connected while missing DMs.
 */
describe("catch-up", () => {
	const CHANNEL = "D-UALICE";

	/** A Slack ts `secondsAgo` in the past — the sweep filters on the wall clock. */
	function agoTs(secondsAgo: number): string {
		return (Date.now() / 1000 - secondsAgo).toFixed(6);
	}

	function entry(over: {
		ts: string;
		text?: string;
		user?: string;
		replyCount?: number;
		files?: SlackFileRef[];
		links?: string[];
	}): SlackHistoryEntry {
		const message: SlackInboundMessage = {
			kind: "message",
			channel: CHANNEL,
			user: over.user ?? "UALICE",
			text: over.text ?? "run omp fix the bug",
			ts: over.ts,
		};
		if (over.files) message.files = over.files;
		if (over.links) message.links = over.links;
		return { message, replyCount: over.replyCount ?? 0, replyUsers: [] };
	}

	async function sweep(h: Harness, rows: SlackHistoryEntry[]): Promise<void> {
		h.slack.history.set(CHANNEL, rows);
		await h.bridge.catchUp();
		await settle();
	}

	test("a DM the socket never delivered is replayed as a command", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		const ts = agoTs(30);
		await sweep(h, [entry({ ts })]);

		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.opts.cwd).toBe(`${HOME}/oh-my-pi-src`);
		expect(h.rpcs[0]!.prompts[0]).toBe("fix the bug");
		expect(h.slack.posted[0]!.args.threadTs).toBe(ts);
	});

	test("a DM already answered in its thread is left alone", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		await sweep(h, [entry({ ts: agoTs(30), replyCount: 2 })]);

		expect(h.rpcs).toHaveLength(0);
		expect(h.slack.reconnects).toBe(0);
	});

	test("a second sweep does not replay what the first one took", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		const rows = [entry({ ts: agoTs(30) })];
		await sweep(h, rows);
		await sweep(h, rows);

		expect(h.rpcs).toHaveLength(1);
	});

	test("a message the live socket already routed is not replayed", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		const ts = agoTs(5);
		await h.slack.inject({ kind: "message", channel: CHANNEL, user: "UALICE", text: "run omp fix the bug", ts });
		expect(h.rpcs).toHaveLength(1);

		// The header reply has not landed in history yet, so the row still looks
		// unanswered — the ts dedup is what must stop the second spawn.
		await sweep(h, [entry({ ts })]);
		expect(h.rpcs).toHaveLength(1);
	});

	test("DMs older than the window are never replayed", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		await sweep(h, [entry({ ts: agoTs(4 * 3600) })]);

		expect(h.rpcs).toHaveLength(0);
	});

	test("catchupWindowMin=0 disables the sweep", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 0 }));
		await sweep(h, [entry({ ts: agoTs(30) })]);

		expect(h.rpcs).toHaveLength(0);
	});

	test("missing a DM while the socket reports connected forces a reconnect", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		h.slack.connected = true;
		await sweep(h, [entry({ ts: agoTs(30) })]);

		expect(h.slack.reconnects).toBe(1);
		expect(h.rpcs).toHaveLength(1);
	});

	test("an attached file is downloaded and the agent gets its local path", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		const url = "https://files.slack.test/F1";
		h.slack.downloads.set(url, new TextEncoder().encode("%PDF-1.7 resume"));
		await sweep(h, [
			entry({
				ts: agoTs(30),
				text: "run omp summarize the resume",
				files: [{ id: "F1", name: "vivek resume.pdf", mimetype: "application/pdf", size: 15, downloadUrl: url }],
				links: ["https://docs.google.com/document/d/abc/edit"],
			}),
		]);

		const prompt = h.rpcs[0]!.prompts[0] ?? "";
		const local = prompt.match(/^- (\/.+\.pdf) \(application\/pdf/m)?.[1];
		expect(local).toBeDefined();
		expect(await Bun.file(local!).text()).toBe("%PDF-1.7 resume");
		expect(prompt).toContain("https://docs.google.com/document/d/abc/edit");
		expect(prompt.startsWith("summarize the resume")).toBe(true);
	});

	test("an unfetchable attachment is named in the prompt with the reason", async () => {
		const h = await makeHarness(makeConfig({ catchupWindowMin: 60 }));
		await sweep(h, [
			entry({
				ts: agoTs(30),
				text: "run omp read these",
				files: [
					{ id: "F1", name: "gone.pdf", mimetype: "application/pdf", size: 10, downloadUrl: "https://files.slack.test/missing" },
					{ id: "F2", name: "loop.docx", mimetype: "application/vnd.doc", size: 0, permalink: "https://slack.test/F2" },
				],
			}),
		]);

		const prompt = h.rpcs[0]!.prompts[0] ?? "";
		expect(prompt).toContain("gone.pdf — download failed");
		expect(prompt).toContain("files:read");
		expect(prompt).toContain("loop.docx — hosted outside Slack");
	});
});

describe("ui relay", () => {
	async function runningTask(h: Harness): Promise<{ rpc: FakeRpc; threadTs: string }> {
		const msg = dm("run omp do work");
		await h.slack.inject(msg);
		return { rpc: h.rpcs[0]!, threadTs: msg.ts };
	}

	test("select request posts buttons with ui:<id>:0 and click responds with label", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitUi({ type: "extension_ui_request", id: "req1", method: "select", title: "Pick one", options: ["Alpha", "Beta"] });
		await settle();

		const uiPost = h.slack.posted.find((p) => p.args.blocks?.some((b) => b.type === "actions"));
		expect(uiPost).toBeDefined();
		const actions = uiPost!.args.blocks!.find((b) => b.type === "actions") as SlackBlock & { elements: Array<{ action_id: string; value: string }> };
		expect(actions.elements[0]!.action_id).toBe("ui:req1:0");
		expect(actions.elements[0]!.value).toBe("Alpha");

		// Click the first button.
		const action: SlackBlockAction = {
			kind: "action",
			channel: "D1",
			user: "UALICE",
			messageTs: uiPost!.ts,
			threadTs,
			actionId: "ui:req1:0",
			value: "Alpha",
		};
		await h.slack.inject(action);

		expect(rpc.uiResponses).toEqual([{ type: "extension_ui_response", id: "req1", value: "Alpha" }]);
		// The ui message is edited to the answered state.
		expect(h.slack.updated.some((u) => u.ts === uiPost!.ts)).toBe(true);
	});

	test("input request is answered by the next thread reply, not turned into a prompt", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);
		rpc.prompts.length = 0; // Drop the initial run prompt.

		rpc.emitUi({ type: "extension_ui_request", id: "reqIn", method: "input", title: "Your name?" });
		await settle();

		await h.slack.inject(dm("Ada", "UALICE", threadTs));

		expect(rpc.uiResponses).toContainEqual({ type: "extension_ui_response", id: "reqIn", value: "Ada" });
		expect(rpc.prompts).toEqual([]); // Never became a prompt.
	});
});

describe("turn completion", () => {
	test("agent_end with short text updates status message and bumps lastActivityAt", async () => {
		const h = await makeHarness(makeConfig());
		const msg = dm("run omp go");
		await h.slack.inject(msg);
		const threadTs = msg.ts;
		const rpc = h.rpcs[0]!;
		rpc.lastAssistantText = "All finished.";

		rpc.emitEvent({ type: "agent_start" });
		await settle();
		const statusTs = h.slack.posted[h.slack.posted.length - 1]!.ts;

		const record = h.registry.byThread(threadTs)!;
		record.lastActivityAt = 1; // Force a detectable bump.

		rpc.emitEvent({ type: "agent_end" });
		await settle();

		const finalUpdate = h.slack.updated.find((u) => u.ts === statusTs && u.text.includes("All finished."));
		expect(finalUpdate).toBeDefined();
		expect(h.registry.byThread(threadTs)!.lastActivityAt).toBeGreaterThan(1);
	});
});

describe("thinking status", () => {
	/**
	 * Status updates are chat.update-throttled (2s), so a real turn's stream lands
	 * as a first immediate flush plus a trailing one. These tests read `Date.now`
	 * through a spy that jumps 5s per read, so every emitted event flushes at once
	 * and assertions never wait on a wall-clock timer.
	 */
	let clock: Mock<() => number> | undefined;
	afterEach(() => {
		clock?.mockRestore();
		clock = undefined;
	});

	async function startedTurn(h: Harness): Promise<FakeRpc> {
		await h.slack.inject(dm("run omp do work"));
		const rpc = h.rpcs[0]!;
		rpc.emitEvent({ type: "agent_start" });
		await settle(); // Status message posted; updates can now land.
		let t = Date.now();
		clock = spyOn(Date, "now").mockImplementation(() => (t += 5_000));
		return rpc;
	}

	test("a reasoning-summary headline reaches the status message before any tool runs", async () => {
		const h = await makeHarness(makeConfig());
		const rpc = await startedTurn(h);

		emitThinking(rpc, "**Mapping the event flow**\n\nThe status only renders tool labels today.\n\n<!-- -->");
		await settle();

		const text = h.slack.updated.at(-1)!.text;
		expect(text).toContain("💭 Mapping the event flow");
		expect(text).not.toContain("<!--");
		expect(text).not.toContain("⏵"); // No tool call has run yet.
	});

	test("raw thinking without headlines shows its newest paragraph", async () => {
		const h = await makeHarness(makeConfig());
		const rpc = await startedTurn(h);

		emitThinking(rpc, "First I check the registry.\n\nThen I patch the renderer.");
		await settle();

		expect(h.slack.updated.at(-1)!.text).toContain("💭 Then I patch the renderer.");
	});

	test("each thinking block and tool call claims its own timeline line, in arrival order", async () => {
		const h = await makeHarness(makeConfig());
		const rpc = await startedTurn(h);

		emitThinking(rpc, "**Mapping the event flow**\n\nOnly tool labels render today.", 0);
		await settle();
		rpc.emitEvent({ type: "tool_execution_start", toolName: "read", args: { path: "bridge.ts" } });
		await settle();
		emitThinking(rpc, "**Patching the renderer**\n\nGive thinking its own line.", 1);
		await settle();

		const text = h.slack.updated.at(-1)!.text;
		expect(text).toContain("💭 Mapping the event flow");
		expect(text).toContain("⏵ read bridge.ts");
		expect(text).toContain("💭 Patching the renderer");
		expect(text.indexOf("💭 Mapping")).toBeLessThan(text.indexOf("⏵ read"));
		expect(text.indexOf("⏵ read")).toBeLessThan(text.indexOf("💭 Patching"));
	});

	test("a new turn starts from an empty timeline", async () => {
		const h = await makeHarness(makeConfig());
		const rpc = await startedTurn(h);
		emitThinking(rpc, "**Old turn thought**\n\nstale");
		await settle();
		expect(h.slack.updated.at(-1)!.text).toContain("Old turn thought");

		rpc.emitEvent({ type: "agent_end" });
		await settle();
		rpc.emitEvent({ type: "agent_start" });
		await settle();
		emitThinking(rpc, "**Fresh thought**\n\nnew", 3);
		await settle();

		const text = h.slack.updated.at(-1)!.text;
		expect(text).toContain("💭 Fresh thought");
		expect(text).not.toContain("Old turn thought");
	});

	test("an unchanged timeline does not re-send the status message", async () => {
		const h = await makeHarness(makeConfig());
		const rpc = await startedTurn(h);
		rpc.emitEvent({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		await settle();
		const sent = h.slack.updated.length;

		// Same tool label again: the timeline is identical, so no chat.update is due.
		rpc.emitEvent({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
		await settle();
		expect(h.slack.updated).toHaveLength(sent);
	});
});

describe("lazy respawn", () => {
	test("thread reply for an idle registry record respawns via resumeSessionPath", async () => {
		const record: TaskRecord = {
			threadTs: "threadY",
			channel: "D1",
			cwd: `${HOME}/oh-my-pi-src`,
			name: "old task",
			sessionPath: `${HOME}/.omp/agent/sessions/old.jsonl`,
			createdAt: 1,
			lastActivityAt: 1,
		};
		const h = await makeHarness(makeConfig(), [record]);

		await h.slack.inject(dm("keep going", "UALICE", "threadY"));

		expect(h.rpcs).toHaveLength(1);
		const respawned = h.rpcs[0]!;
		expect(respawned.opts.resumeSessionPath).toBe(`${HOME}/.omp/agent/sessions/old.jsonl`);
		expect(respawned.opts.env?.OMP_HUB_NEW_SESSION).toBeUndefined();
		// The reply is then delivered as a prompt.
		expect(respawned.prompts).toEqual(["keep going"]);
	});
});

describe("session browsing", () => {
	const REPO = `${HOME}/oh-my-pi-src`;
	const ALPHA = `${REPO}/.omp/a.jsonl`;
	const BETA = `${REPO}/.omp/b.jsonl`;
	/** Stand-in for `omp sessions --json` — newest-first, as the real command emits. */
	const lister: ListSessions = async () => [
		{ path: ALPHA, title: "alpha work", modified: new Date(Date.now() - 5 * 60_000).toISOString() },
		{ path: BETA, firstMessage: "beta first message", modified: new Date(Date.now() - 90 * 60_000).toISOString() },
	] satisfies StoreSession[];

	function attachedRecord(): TaskRecord {
		return { threadTs: "threadA", channel: "D1", cwd: REPO, name: "alpha work", sessionPath: ALPHA, createdAt: 1, lastActivityAt: 1 };
	}

	test("sessions lists the whole store per repo, numbered and aged", async () => {
		const h = await makeHarness(makeConfig(), [], lister);
		await h.slack.inject(dm("sessions"));

		const text = h.slack.posted.at(-1)!.args.text;
		expect(text).toContain(`*omp* · \`${REPO}\``);
		expect(text).toContain("1. alpha work · 5m ago");
		expect(text).toContain("2. beta first message · 1h ago");
	});

	test("resume <n> resumes the mapped session path in its repo cwd, threaded under the resume message", async () => {
		const h = await makeHarness(makeConfig(), [], lister);
		await h.slack.inject(dm("sessions"));
		const beforeHeader = h.slack.posted.length;

		const msg = dm("resume 2");
		await h.slack.inject(msg);

		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.opts.resumeSessionPath).toBe(BETA);
		expect(h.rpcs[0]!.opts.cwd).toBe(REPO);
		expect(h.rpcs[0]!.opts.env?.OMP_HUB_NEW_SESSION).toBeUndefined();
		// The task header replies to the resume message and registers that thread.
		const header = h.slack.posted[beforeHeader]!;
		expect(header.args.blocks).toBeDefined();
		expect(header.args.threadTs).toBe(msg.ts);
		expect(h.registry.byThread(msg.ts)).toBeDefined();
	});

	test("a reply under a non-task message runs as a command instead of being dropped", async () => {
		const h = await makeHarness(makeConfig(), [], lister);
		const listing = dm("sessions");
		await h.slack.inject(listing);
		expect(h.slack.posted.at(-1)!.args.threadTs).toBe(listing.ts);

		// `resume 2` typed inside the listing's own thread still attaches.
		await h.slack.inject(dm("resume 2", "UALICE", listing.ts));

		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.opts.resumeSessionPath).toBe(BETA);
		expect(h.registry.byThread(listing.ts)).toBeDefined();
	});

	test("resume <n> with no live listing points back at `sessions`", async () => {
		const h = await makeHarness(makeConfig(), [], lister);
		await h.slack.inject(dm("resume 3"));

		expect(h.rpcs).toHaveLength(0);
		expect(h.slack.posted.at(-1)!.args.text).toContain("run `sessions` first");
	});

	test("an already-attached session is badged and resume <n> links its thread instead of spawning", async () => {
		const h = await makeHarness(makeConfig(), [attachedRecord()], lister);
		await h.slack.inject(dm("sessions"));
		expect(h.slack.posted.at(-1)!.args.text).toContain("1. 🔗 alpha work");

		await h.slack.inject(dm("resume 1"));

		expect(h.rpcs).toHaveLength(0);
		expect(h.slack.posted.at(-1)!.args.text).toContain("threadA");
	});
});

describe("TaskRegistry", () => {
	let dir: string;
	beforeEach(() => {
		dir = `/tmp/bridge-reg-${Math.random().toString(36).slice(2)}`;
	});
	afterEach(async () => {
		await Bun.$`rm -rf ${dir}`.quiet().nothrow();
	});

	test("load on a missing file yields an empty registry", async () => {
		const reg = await TaskRegistry.load(dir);
		expect(reg.all()).toEqual([]);
	});

	test("upsert + flush → reload roundtrips records", async () => {
		const reg = await TaskRegistry.load(dir);
		const rec: TaskRecord = {
			threadTs: "t1",
			channel: "D1",
			cwd: "/x",
			name: "task one",
			sessionPath: "/s/one.jsonl",
			createdAt: 10,
			lastActivityAt: 20,
		};
		reg.upsert(rec);
		await reg.flush();

		const reloaded = await TaskRegistry.load(dir);
		expect(reloaded.byThread("t1")).toEqual(rec);
		expect(reloaded.bySessionPath("/s/one.jsonl")?.name).toBe("task one");
	});

	test("catch-up watermarks survive a reload, so a restart cannot replay old DMs", async () => {
		const reg = await TaskRegistry.load(dir);
		reg.setCatchupTs("D1", "1785151799.503259");
		await reg.flush();

		const reloaded = await TaskRegistry.load(dir);
		expect(reloaded.catchupTs("D1")).toBe("1785151799.503259");
		expect(reloaded.catchupTs("D2")).toBeUndefined();
	});
});

// --- ask host tool ----------------------------------------------------------

/** Read {action_id, value} tuples from a posted message's actions block. */
function askElements(post: PostedMessage): Array<{ actionId: string; value: string }> {
	const block = post.args.blocks?.find((b) => b.type === "actions");
	const els: unknown = block?.elements;
	if (!Array.isArray(els)) return [];
	const out: Array<{ actionId: string; value: string }> = [];
	for (const el of els) {
		if (el && typeof el === "object" && "action_id" in el && typeof el.action_id === "string") {
			out.push({ actionId: el.action_id, value: "value" in el && typeof el.value === "string" ? el.value : "" });
		}
	}
	return out;
}

/** The posted message whose actions block carries an action_id with `prefix`. */
function askPostFor(h: Harness, prefix: string): PostedMessage | undefined {
	return h.slack.posted.find((p) => askElements(p).some((e) => e.actionId.startsWith(prefix)));
}

describe("ask host tool", () => {
	async function runningTask(h: Harness): Promise<{ rpc: FakeRpc; threadTs: string }> {
		const msg = dm("run omp do work");
		await h.slack.inject(msg);
		return { rpc: h.rpcs[0]!, threadTs: msg.ts };
	}

	const twoQuestions = {
		questions: [
			{ id: "q0", question: "Pick a color", options: [{ label: "Red" }, { label: "Blue" }] },
			{ id: "q1", question: "Pick a size", options: [{ label: "Small" }, { label: "Large" }] },
		],
	};

	test("spawn registers the ask host tool", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);
		expect(rpc.commands).toContain("set_host_tools");
		expect(rpc.hostTools.at(-1)?.some((t) => t.name === "ask")).toBe(true);
	});

	test("two questions: a typed reply cancels the ask and submits freeform, preserving prior clicks", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_1", toolCallId: "tc1", toolName: "ask", arguments: twoQuestions });
		await settle();

		const q0Post = askPostFor(h, "ask:host_1:0:");
		const q1Post = askPostFor(h, "ask:host_1:1:");
		expect(q0Post).toBeDefined();
		expect(q1Post).toBeDefined();

		// Click Q1 option → that message edited, call NOT completed.
		const q0Buttons = askElements(q0Post!);
		await h.slack.inject({
			kind: "action",
			channel: "D1",
			user: "UALICE",
			messageTs: q0Post!.ts,
			threadTs,
			actionId: q0Buttons[0]!.actionId,
			value: q0Buttons[0]!.value,
		});
		expect(h.slack.updated.some((u) => u.ts === q0Post!.ts)).toBe(true);
		expect(rpc.hostToolResults).toHaveLength(0);

		// Typed reply → cancels the ask and submits freeform. The earlier click is
		// preserved in the result; the reply text is submitted as the answer.
		await h.slack.inject(dm("Large", "UALICE", threadTs));
		expect(rpc.hostToolResults).toHaveLength(1);
		const text = rpc.hostToolResults[0]!.result.content[0]!.text;
		expect(text).toContain("Pick a color → Red");
		expect(text).toContain("User replied directly instead of choosing options: Large");

		// pendingAsk cleared → a later thread reply becomes a prompt.
		rpc.prompts.length = 0;
		await h.slack.inject(dm("carry on", "UALICE", threadTs));
		expect(rpc.prompts).toEqual(["carry on"]);
	});

	test("multi-question ask: a typed reply with no clicks cancels and submits immediately", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_f", toolCallId: "tcf", toolName: "ask", arguments: twoQuestions });
		await settle();
		expect(askPostFor(h, "ask:host_f:0:")).toBeDefined();
		expect(askPostFor(h, "ask:host_f:1:")).toBeDefined();

		// No button click at all — one typed reply completes the whole ask.
		await h.slack.inject(dm("just do the safe thing for both", "UALICE", threadTs));
		expect(rpc.hostToolResults).toHaveLength(1);
		const text = rpc.hostToolResults[0]!.result.content[0]!.text;
		expect(text).toBe("User replied directly instead of choosing options: just do the safe thing for both");

		// pendingAsk cleared → a later thread reply becomes a prompt, not an answer.
		rpc.prompts.length = 0;
		await h.slack.inject(dm("carry on", "UALICE", threadTs));
		expect(rpc.prompts).toEqual(["carry on"]);
	});

	test("single question answered by button yields User answered result", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitHostToolCall({
			type: "host_tool_call",
			id: "host_2",
			toolCallId: "tc2",
			toolName: "ask",
			arguments: { questions: [{ id: "only", question: "Deploy now?", options: [{ label: "Yes" }, { label: "No" }] }] },
		});
		await settle();

		const post = askPostFor(h, "ask:host_2:0:")!;
		const buttons = askElements(post);
		await h.slack.inject({
			kind: "action",
			channel: "D1",
			user: "UALICE",
			messageTs: post.ts,
			threadTs,
			actionId: buttons[0]!.actionId,
			value: buttons[0]!.value,
		});

		expect(rpc.hostToolResults).toHaveLength(1);
		expect(rpc.hostToolResults[0]!.result.content[0]!.text).toBe('User answered "Deploy now?": Yes');
	});

	test("unknown host tool is rejected with isError", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);
		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_x", toolCallId: "tcx", toolName: "mystery", arguments: {} });
		await settle();
		expect(rpc.hostToolResults).toHaveLength(1);
		expect(rpc.hostToolResults[0]!.isError).toBe(true);
		expect(rpc.hostToolResults[0]!.result.content[0]!.text).toBe("unknown host tool");
	});

	test("malformed ask arguments are rejected with isError", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);
		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_bad", toolCallId: "tcb", toolName: "ask", arguments: { questions: [] } });
		await settle();
		expect(rpc.hostToolResults).toHaveLength(1);
		expect(rpc.hostToolResults[0]!.isError).toBe(true);
		expect(rpc.hostToolResults[0]!.result.content[0]!.text).toBe("invalid ask arguments");
	});

	test("host_tool_cancel edits unanswered messages, clears state, and stale click expires", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_3", toolCallId: "tc3", toolName: "ask", arguments: twoQuestions });
		await settle();
		const q0Post = askPostFor(h, "ask:host_3:0:")!;

		rpc.emitHostToolCancel({ type: "host_tool_cancel", id: "hc1", targetId: "host_3" });
		await settle();
		expect(h.slack.updated.some((u) => u.ts === q0Post.ts && u.text.includes("cancelled"))).toBe(true);

		// Stale click after cancel → 'expired' update, no completion.
		const buttons = askElements(q0Post);
		await h.slack.inject({
			kind: "action",
			channel: "D1",
			user: "UALICE",
			messageTs: q0Post.ts,
			threadTs,
			actionId: buttons[0]!.actionId,
			value: buttons[0]!.value,
		});
		expect(h.slack.updated.some((u) => u.ts === q0Post.ts && u.text.includes("expired"))).toBe(true);
		expect(rpc.hostToolResults).toHaveLength(0);
	});

	test("thread reply 'abort' while a pendingAsk exists still aborts (command precedence)", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);

		rpc.emitHostToolCall({ type: "host_tool_call", id: "host_4", toolCallId: "tc4", toolName: "ask", arguments: twoQuestions });
		await settle();

		await h.slack.inject(dm("abort", "UALICE", threadTs));
		expect(rpc.commands).toContain("abort");
		expect(rpc.hostToolResults).toHaveLength(0);
	});
});

describe("control plane park/steer (regression)", () => {
	async function liveTask(h: Harness): Promise<{ rpc: FakeRpc; sessionPath: string }> {
		await h.slack.inject(dm("run omp do work"));
		const rpc = h.rpcs[0]!;
		return { rpc, sessionPath: rpc.state.sessionFile! };
	}

	test("park fails CLOSED when the subagent probe errors", async () => {
		// F1: getSubagents() failure must NOT park (a session may still have live
		// subagents); it returns {parked:false, reason:"subagent state unknown"}.
		// Both causes route here: a dead RPC, and a malformed get_subagents payload
		// the strict parser rejects rather than mistaking for quiescence.
		for (const cause of ["rpc down", "get_subagents: malformed response"]) {
			const h = await makeHarness(makeConfig());
			const { rpc, sessionPath } = await liveTask(h);
			await settle();
			rpc.getSubagents = () => Promise.reject(new Error(cause));
			const res = await h.bridge.controlHost().park(sessionPath);
			expect(res).toEqual({ parked: false, reason: "subagent state unknown" });
			expect(rpc.commands).not.toContain("stop"); // never stopped an unknown-state session
		}
	});

	test("a park in progress refuses a concurrent steer (TOCTOU lock)", async () => {
		// F2: park claims the task synchronously (parking=true) before its first
		// await, so a steer landing in the quiescence→stop window is rejected.
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		const gate = Promise.withResolvers<OmpSubagentSnapshot[]>();
		rpc.getSubagents = () => gate.promise; // park blocks inside the window
		const parkP = h.bridge.controlHost().park(sessionPath); // sets parking=true now
		await expect(h.bridge.controlHost().steer(sessionPath, "hi")).rejects.toThrow(/being parked/);
		gate.resolve([]); // quiescent → park completes
		expect(await parkP).toEqual({ parked: true });
	});

	test("park refuses while a subagent is still running", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		rpc.subagents = [
			{ id: "Scout", agent: "scout", status: "running", lastUpdate: 7 },
			{ id: "Writer", agent: "task", status: "completed", lastUpdate: 8 },
		];
		expect(await h.bridge.controlHost().park(sessionPath)).toEqual({
			parked: false,
			reason: "busy: 1 subagents running",
		});
		expect(rpc.commands).not.toContain("stop");
	});

	test("park refuses while a subagent is queued or in an unrecognised state", async () => {
		for (const status of ["pending", "queued"]) {
			const h = await makeHarness(makeConfig());
			const { rpc, sessionPath } = await liveTask(h);
			await settle();
			rpc.subagents = [{ id: "Queued", agent: "task", status, lastUpdate: 3 }];
			expect(await h.bridge.controlHost().park(sessionPath)).toEqual({
				parked: false,
				reason: "busy: 1 subagents running",
			});
			expect(rpc.commands).not.toContain("stop");
		}
	});

	test("park succeeds once every subagent reached a terminal status", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		rpc.subagents = [
			{ id: "Done", agent: "task", status: "completed", lastUpdate: 1 },
			{ id: "Broke", agent: "task", status: "failed", lastUpdate: 2 },
			{ id: "Killed", agent: "task", status: "aborted", lastUpdate: 3 },
		];
		expect(await h.bridge.controlHost().park(sessionPath)).toEqual({ parked: true });
		expect(rpc.commands).toContain("stop");
	});

	test("controlHost().subagents returns the RPC snapshots for a live task", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		rpc.subagents = [
			{ id: "Scout", agent: "scout", status: "running", task: "map the repo", sessionFile: "/s/scout.jsonl", lastUpdate: 42 },
		];
		expect(await h.bridge.controlHost().subagents(sessionPath)).toEqual(rpc.subagents);
		expect(rpc.commands).toContain("get_subagents");
	});

	test("controlHost().subagents rejects for a session the bridge does not own", async () => {
		const h = await makeHarness(makeConfig());
		await liveTask(h);
		await settle();
		await expect(h.bridge.controlHost().subagents("/nope/absent.jsonl")).rejects.toThrow(/not live/);
	});

	test("resume <sessionPath> dedups against an existing registry record", async () => {
		// F4: the raw-path form used to bypass the bySessionPath dedup that the
		// numeric form had, spawning a second thread for the same session.
		const sessionPath = `${HOME}/.omp/agent/sessions/dedup.jsonl`;
		const seed: TaskRecord = {
			threadTs: "T-existing",
			channel: "D1",
			cwd: `${HOME}/oh-my-pi-src`,
			name: "slack:existing",
			sessionPath,
			createdAt: 1,
			lastActivityAt: 1,
		};
		const h = await makeHarness(makeConfig(), [seed]);
		await h.slack.inject(dm(`resume ${sessionPath}`));
		expect(h.rpcs).toHaveLength(0); // no second RPC spawned
		expect(h.slack.posted.some((p) => p.args.text?.includes("Already attached"))).toBe(true);
	});
});

/** A `RouteMessage` fake that records its calls, like the RPC/Slack fakes. */
function fakeRoute(decision?: RouterDecision): RouteMessage & { calls: Array<{ text: string; ctx: RouterContext }> } {
	const calls: Array<{ text: string; ctx: RouterContext }> = [];
	return Object.assign(
		async (text: string, ctx: RouterContext) => {
			calls.push({ text, ctx });
			return decision;
		},
		{ calls },
	);
}

/**
 * The front door: an explicit command still parses literally and never pays for
 * the model, a free-form message goes through the router, and a router that
 * declines for any reason (disabled, down, slow, unparseable) falls back to
 * help rather than swallowing the message.
 */
describe("front-door router", () => {
	const REPO = `${HOME}/oh-my-pi-src`;
	const lister: ListSessions = async () => [{ path: `${REPO}/.omp/a.jsonl`, title: "alpha work", modified: new Date().toISOString() }];

	test("an explicit `run` dispatches literally and never consults the router", async () => {
		const route = fakeRoute({ command: "status" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("run omp do a thing"));

		expect(route.calls).toHaveLength(0);
		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.prompts).toEqual(["do a thing"]);
	});

	test("a free-form DM routed to `sessions` renders the listing", async () => {
		const route = fakeRoute({ command: "sessions" });
		const h = await makeHarness(makeConfig(), [], lister, route);
		const msg = dm("what have I been working on lately?");
		await h.slack.inject(msg);

		expect(route.calls).toHaveLength(1);
		expect(route.calls[0]!.text).toBe("what have I been working on lately?");
		expect(route.calls[0]!.ctx.repos).toEqual({ omp: REPO });
		expect(h.slack.posted.at(-1)!.args.text).toContain(`*omp* · \`${REPO}\``);
		expect(h.slack.posted.at(-1)!.args.text).toContain("1. alpha work");
	});

	test("a router that declines falls back to help (fail-open)", async () => {
		const route = fakeRoute(undefined);
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("hey, are you around?"));

		expect(route.calls).toHaveLength(1);
		expect(h.slack.posted).toHaveLength(1);
		expect(h.slack.posted[0]!.args.text).toContain("*omp slack bridge*");
		expect(h.rpcs).toHaveLength(0);
	});

	test("an enabled router that declines says so above the help card", async () => {
		const route = fakeRoute(undefined);
		const h = await makeHarness(makeConfig({ routerModel: "shuttle/gemma-4-26b" }), [], undefined, route);
		await h.slack.inject(dm("in the verification steps PR, add these changes to the UI"));

		const posted = h.slack.posted.at(-1)!.args.text ?? "";
		expect(posted).toContain("The routing model did not answer");
		expect(posted).toContain("*omp slack bridge*");
		expect(h.rpcs).toHaveLength(0);
	});

	test("a `run` decision with no agent spawns one rpc in the alias cwd, on the default worker", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "fix the thing" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("could you please fix the thing over in omp"));

		// The breadcrumb lands before the task header so the routing is visible.
		expect(h.slack.posted[0]!.args.text).toBe("_routed → `run`_");
		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.opts.cwd).toBe(REPO);
		// No agent named ⇒ no `--agent`; the trailing reply guidance has its own test.
		expect(h.rpcs[0]!.opts.extraArgs).not.toContain("--agent");
		expect(h.rpcs[0]!.prompts).toEqual(["fix the thing"]);
	});

	// The routing worker's account of itself has to reach Slack, not just the log:
	// it is the only explanation the user ever sees for where their message went.
	test("a decision's trace rides along as the breadcrumb's sub-line", async () => {
		const route = fakeRoute({
			command: "run",
			dir: "omp",
			prompt: "fix the thing",
			trace: { turns: 2, summary: "read it as a fix request\ncalled run in omp\nno agent, so the default worker" },
		});
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("could you please fix the thing over in omp"));

		const breadcrumb = h.slack.posted[0]!.args;
		expect(breadcrumb.text).toBe("_routed → `run`_");
		expect(breadcrumb.blocks?.at(-1)).toEqual({
			type: "context",
			elements: [{ type: "mrkdwn", text: "🧭 2 turns\n_read it as a fix request_\n_called run in omp_\n_no agent, so the default worker_" }],
		});
		// Cosmetic only: the command still dispatches exactly as it did before.
		expect(h.rpcs[0]!.prompts).toEqual(["fix the thing"]);
	});

	// The literal Slack word still works: `parseDecision` rejects an "orchestrate"
	// command, so this path exists only in the bridge's own parser.
	test("literal `orchestrate` runs the orchestrate agent and prefixes the prompt", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("orchestrate omp fix the thing"));
		const rpc = await h.nextRpc();

		expect(h.rpcs).toHaveLength(1);
		expect(rpc.opts.cwd).toBe(REPO);
		expect(rpc.opts.extraArgs?.slice(0, 2)).toEqual(["--agent", "orchestrate"]);
		// The `orchestrator-identity` skill keys on the word, so the prompt carries it.
		expect(rpc.prompts[0]!.startsWith("orchestrate: fix the thing")).toBe(true);
	});

	test("`orchestrate` with no prompt posts its own usage line", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("orchestrate"));

		expect(h.rpcs).toHaveLength(0);
		expect(h.slack.posted.at(-1)!.args.text).toBe("Usage: `orchestrate <alias|path> <prompt…>`");
	});

	// Routed orchestration is an ordinary `run` with `agent: orchestrate`, and must
	// come out identical to the literal command — same flag, same prompt prefix.
	test("a routed `orchestrate` agent prefixes the prompt just like the literal command", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "split this up", agent: "orchestrate" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("fan this out across a few agents"));
		const rpc = await h.nextRpc();

		expect(rpc.opts.extraArgs?.slice(0, 2)).toEqual(["--agent", "orchestrate"]);
		expect(rpc.prompts[0]!.startsWith("orchestrate: split this up")).toBe(true);
	});

	// The identity comes from the `orchestrator-identity` skill, not the agent file:
	// with no `orchestrate` definition the default worker still gets the prompt that
	// triggers it, rather than an `--agent` omp would refuse to start.
	test("`orchestrate` without a definition still prefixes the prompt, on the default worker", async () => {
		const h = await makeHarness(makeConfig(), [], undefined, undefined, async () => []);
		await h.slack.inject(dm("orchestrate omp fix the thing"));
		const rpc = await h.nextRpc();

		expect(rpc.opts.extraArgs).not.toContain("--agent");
		expect(rpc.prompts[0]!.startsWith("orchestrate: fix the thing")).toBe(true);
	});

	// The agents the router may pick from are the definitions on disk, so a routed
	// task can only ever land on an agent that exists.
	test("a routed agent becomes `--agent <name>` and shows in the breadcrumb", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "plan the fix", agent: "planner" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("plan out the fix for the thing in omp"));
		const rpc = await h.nextRpc();

		expect(route.calls[0]!.ctx.agents).toEqual(AGENTS);
		expect(h.slack.posted[0]!.args.text).toBe("_routed → `run` as `planner`_");
		expect(rpc.opts.extraArgs?.slice(0, 2)).toEqual(["--agent", "planner"]);
		// The agent file pins the model now; the bridge never passes one.
		expect(rpc.opts.extraArgs).not.toContain("--model");
	});

	test("a differently-cased agent name resolves to the canonical one", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "look around", agent: "SCOUT" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("where does the bridge parse commands?"));

		expect((await h.nextRpc()).opts.extraArgs?.slice(0, 2)).toEqual(["--agent", "scout"]);
	});

	// An invented name would make `omp --agent` exit 2 and the task never start, so
	// it is dropped: the work still happens, on the default worker.
	test("an agent that does not exist is dropped and the task still starts", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "fix it", agent: "wizard" });
		const h = await makeHarness(makeConfig(), [], undefined, route);
		await h.slack.inject(dm("fix it with the wizard"));
		const rpc = await h.nextRpc();

		expect(rpc.opts.extraArgs).not.toContain("--agent");
		expect(rpc.prompts).toEqual(["fix it"]);
	});

	test("the agent inventory is read once and cached across messages", async () => {
		let reads = 0;
		const route = fakeRoute({ command: "status" });
		const h = await makeHarness(makeConfig(), [], undefined, route, async () => {
			reads++;
			return AGENTS;
		});
		await h.slack.inject(dm("is the bridge up?"));
		await h.slack.inject(dm("still up?"));

		expect(route.calls).toHaveLength(2);
		expect(reads).toBe(1);
	});

	// Routing runs are persisted so cc-callbacks audits them: same tree as the
	// agent sessions they start (so `project_root` is the repo), but under
	// `router/` so they never appear beside resumable work in `sessions`.
	test("the routing run is pointed at the repo's router session dir", async () => {
		const route = fakeRoute({ command: "status" });
		const h = await makeHarness(makeConfig({ defaultRepo: "omp" }), [], undefined, route);
		await h.slack.inject(dm("is anything running?"));

		expect(route.calls[0]!.ctx.sessionDir).toBe(`${HOME}/.omp/agent/sessions/-oh-my-pi-src/router`);
		// cwd is what cc-callbacks records as project_root for the routing turn.
		expect(route.calls[0]!.ctx.cwd).toBe(REPO);
	});
});

/**
 * How a Slack attachment reaches the agent. An image rides the prompt frame as a
 * decoded block *and* is named by path; anything else — or an image the vision
 * models cannot take — is path-only with the reason stated. The router is told
 * what was attached but never sees bytes or paths, because the local model
 * serving it has no vision.
 */
describe("attachments", () => {
	const PNG_URL = "https://files.slack.test/FIMG";
	const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);
	/** base64("\x89PNG"), the block the agent must receive. */
	const PNG_BASE64 = "iVBORw==";

	function fileDm(text: string, files: SlackFileRef[], threadTs?: string): SlackInboundMessage {
		return { kind: "message", channel: "D1", user: "UALICE", text, ts: `a${++dmSeq}`, files, threadTs };
	}

	function png(name = "screenshot 2026.png", mimetype = "image/png"): SlackFileRef {
		return { id: "FIMG", name, mimetype, size: PNG_BYTES.byteLength, downloadUrl: PNG_URL, permalink: "https://slack.test/FIMG" };
	}

	test("an attached image rides the prompt frame as a block and is still named by path", async () => {
		const h = await makeHarness(makeConfig());
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("run omp why does this look wrong", [png()]));
		const sent = await (await h.nextRpc()).nextPrompt();

		expect(sent.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
		// The path stays in the prompt: inspect_image and re-reads need a file.
		expect(sent.text).toContain("omp-slack-attachments/");
		expect(sent.text).toContain("screenshot 2026.png (image/png, 4 bytes)");
	});

	test("a non-vision image format stays path-only and says why", async () => {
		const h = await makeHarness(makeConfig());
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("run omp read my photo", [png("IMG_0042.heic", "image/heic")]));
		const sent = await (await h.nextRpc()).nextPrompt();

		expect(sent.images).toEqual([]);
		expect(sent.text).toContain("not shown inline: image/heic is not a vision-model format");
		expect(sent.text).toContain("IMG_0042.heic (image/heic, 4 bytes)");
	});

	test("a non-image attachment gets no inline note at all", async () => {
		const h = await makeHarness(makeConfig());
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("run omp summarize this", [png("notes.pdf", "application/pdf")]));
		const sent = await (await h.nextRpc()).nextPrompt();

		expect(sent.images).toEqual([]);
		expect(sent.text).not.toContain("not shown inline");
		expect(sent.text).toContain("notes.pdf (application/pdf, 4 bytes)");
	});

	test("an image replied into a live task thread rides that steer", async () => {
		const h = await makeHarness(makeConfig(), [
			{
				threadTs: "threadIMG",
				channel: "D1",
				cwd: `${HOME}/oh-my-pi-src`,
				sessionPath: `${HOME}/.omp/agent/sessions/live.jsonl`,
				name: "slack:live",
				createdAt: Date.now(),
				lastActivityAt: Date.now(),
			},
		]);
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("here, look", [png()], "threadIMG"));
		const sent = await (await h.nextRpc()).nextPrompt();

		expect(sent.text).toContain("here, look");
		expect(sent.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	test("the router is told what was attached, by name and type only", async () => {
		const route = fakeRoute({ command: "run", dir: "omp", prompt: "what is wrong here" });
		const h = await makeHarness(makeConfig({ routerModel: "shuttle/gemma-4-26b" }), [], undefined, route);
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("what is wrong here", [png()]));
		await settle();

		expect(route.calls).toHaveLength(1);
		expect(route.calls[0]!.ctx.attachments).toBe("screenshot 2026.png (image/png)");
		// Bytes and local paths are the agent's business, never the router's.
		expect(route.calls[0]!.text).toBe("what is wrong here");
	});

	test("a caption-less attachment starts a task instead of answering with help", async () => {
		const route = fakeRoute({ command: "help" });
		const h = await makeHarness(makeConfig({ defaultRepo: "omp", routerModel: "shuttle/gemma-4-26b" }), [], undefined, route);
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("", [png()]));
		const rpc = await h.nextRpc();
		const sent = await rpc.nextPrompt();

		// Nothing to classify, so the router is not consulted at all.
		expect(route.calls).toHaveLength(0);
		expect(rpc.opts.cwd).toBe(`${HOME}/oh-my-pi-src`);
		expect(sent.text).toContain("arrived from Slack with no accompanying message");
		expect(sent.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
	});

	test("a caption-less attachment with no DEFAULT_REPO is answered with its local path", async () => {
		const h = await makeHarness(makeConfig());
		h.slack.downloads.set(PNG_URL, PNG_BYTES);

		await h.slack.inject(fileDm("", [png()]));
		const posted = await h.slack.nextPost();

		expect(h.rpcs).toHaveLength(0);
		// Named, and its path handed back: a later reply carries only its own files.
		expect(posted.text).toContain("screenshot 2026.png (image/png)");
		expect(posted.text).toContain("omp-slack-attachments/");
		expect(posted.text).not.toContain("*omp slack bridge*");
	});
});

/**
 * Answering back into Slack. The agent reads Slack, not a terminal: a path in its
 * reply is dead text, so `attach_file` is the only route for a screenshot, and
 * every bridge-owned child is told as much through its system prompt.
 */
describe("replying with files", () => {
	let tmp: string;

	beforeEach(async () => {
		tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-attach-"));
	});
	afterEach(async () => {
		await fs.rm(tmp, { recursive: true, force: true });
	});

	async function runningTask(h: Harness): Promise<{ rpc: FakeRpc; threadTs: string }> {
		const msg = dm("run omp do work");
		await h.slack.inject(msg);
		return { rpc: h.rpcs[0]!, threadTs: msg.ts };
	}

	function attachCall(paths: string[], comment?: string): OmpHostToolCall {
		return {
			type: "host_tool_call",
			id: "host_att",
			toolCallId: "tc_att",
			toolName: "attach_file",
			arguments: comment === undefined ? { paths } : { paths, comment },
		};
	}

	test("every bridge child is told how to answer into Slack, alongside its agent flag", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("orchestrate omp fix the thing"));
		const rpc = await h.nextRpc();

		const args = rpc.opts.extraArgs ?? [];
		expect(args.slice(0, 2)).toEqual(["--agent", "orchestrate"]);
		const flag = args.indexOf("--append-system-prompt");
		expect(flag).toBeGreaterThan(-1);
		const guidance = args[flag + 1] ?? "";
		// The guidance must name the tool and the failure mode it exists to prevent.
		expect(guidance).toContain("attach_file");
		expect(guidance).toContain("response.md");
		expect(guidance).toContain("absolute");
	});

	test("attach_file is registered next to ask", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);
		expect(rpc.hostTools.at(-1)?.map((t) => t.name)).toEqual(["ask", "attach_file"]);
	});

	test("attach_file uploads the files as one thread message and reports what landed", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc, threadTs } = await runningTask(h);
		const shot = path.join(tmp, "shot.png");
		const chart = path.join(tmp, "chart.png");
		await Bun.write(shot, "PNG-A");
		await Bun.write(chart, "PNG-B");

		rpc.emitHostToolCall(attachCall([shot, chart], "before and after"));
		const batch = await h.slack.nextUpload();
		const result = await rpc.nextHostToolResult();

		// One batch: Slack renders a single message carrying both images.
		expect(h.slack.uploadedFiles).toHaveLength(1);
		expect(batch.threadTs).toBe(threadTs);
		expect(batch.comment).toBe("before and after");
		expect(batch.files).toEqual([
			{ filename: "shot.png", text: "PNG-A" },
			{ filename: "chart.png", text: "PNG-B" },
		]);
		expect(result.isError).toBe(false);
		expect(result.result.content[0]!.text).toBe("Attached to the Slack thread: shot.png, chart.png.");
	});

	test("an unreadable path is named in the result without sinking the rest of the batch", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);
		const good = path.join(tmp, "good.png");
		const missing = path.join(tmp, "gone.png");
		await Bun.write(good, "PNG-A");

		rpc.emitHostToolCall(attachCall([good, missing]));
		const batch = await h.slack.nextUpload();
		const result = await rpc.nextHostToolResult();

		expect(batch.files.map((f) => f.filename)).toEqual(["good.png"]);
		expect(result.isError).toBe(false);
		expect(result.result.content[0]!.text).toContain("good.png");
		expect(result.result.content[0]!.text).toContain(missing);
	});

	test("nothing readable is an error result and no Slack message", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);

		rpc.emitHostToolCall(attachCall([path.join(tmp, "nope.png")]));
		const result = await rpc.nextHostToolResult();

		expect(h.slack.uploadedFiles).toHaveLength(0);
		expect(result.isError).toBe(true);
		expect(result.result.content[0]!.text).toContain("Nothing was attached.");
	});

	test("malformed attach_file arguments are rejected", async () => {
		const h = await makeHarness(makeConfig());
		const { rpc } = await runningTask(h);

		rpc.emitHostToolCall({
			type: "host_tool_call",
			id: "host_bad",
			toolCallId: "tc_bad",
			toolName: "attach_file",
			arguments: { paths: "shot.png" },
		});
		const result = await rpc.nextHostToolResult();
		expect(result.isError).toBe(true);
		expect(result.result.content[0]!.text).toContain("expected paths: string[]");
	});
});

/**
 * The `REPOS` aliases are the vocabulary the person types in Slack, so a spawned
 * agent that never sees them has to guess which directory a name refers to.
 */
describe("repo inventory in the system prompt", () => {
	const REPO = `${HOME}/oh-my-pi-src`;
	const SHUTTLE = `${HOME}/shuttle`;

	function appendedPrompt(rpc: FakeRpc): string {
		const args = rpc.opts.extraArgs ?? [];
		const flag = args.indexOf("--append-system-prompt");
		return flag === -1 ? "" : (args[flag + 1] ?? "");
	}

	test("every configured alias and path rides the spawn, with the task's own repo marked", async () => {
		const h = await makeHarness(makeConfig({ repos: { omp: REPO, shuttle: SHUTTLE } }));
		await h.slack.inject(dm("run shuttle fix the thing"));
		const prompt = appendedPrompt(await h.nextRpc());

		expect(prompt).toContain(`\`omp\` → \`${REPO}\``);
		expect(prompt).toContain(`\`shuttle\` → \`${SHUTTLE}\``);
		// The cwd marker lands on the repo this task actually runs in, not the first.
		expect(prompt).toContain(`\`${SHUTTLE}\` — this session's cwd`);
		expect(prompt).not.toContain(`\`${REPO}\` — this session's cwd`);
		// The reply guidance is still there: one flag carries both.
		expect(prompt).toContain("attach_file");
	});

	test("no configured repos means no inventory section, not an empty list", async () => {
		const h = await makeHarness(makeConfig({ repos: {} }));
		await h.slack.inject(dm(`run ${REPO} fix the thing`));
		const prompt = appendedPrompt(await h.nextRpc());

		expect(prompt).toContain("attach_file");
		expect(prompt).not.toContain("Repos the bridge knows");
	});
});

/**
 * The thread header is the one place a reader can pick the session up from —
 * `omp --resume <id>` in a terminal, or `resume <path>` back in Slack. The id
 * only exists once the child has minted its session file, so the header is
 * posted first and edited after the handshake.
 */
describe("session identity in the task header", () => {
	const SESSION_ID = "9f3c1a2b";

	test("the header is edited with the session id, path and model once the child is up", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("run omp do work"));
		const rpc = await h.nextRpc();

		const headerTs = h.slack.posted[0]!.ts;
		const update = h.slack.updated.find((u) => u.ts === headerTs);
		expect(update).toBeDefined();
		const rendered = JSON.stringify(update!.blocks);
		expect(rendered).toContain(`🆔 \`${SESSION_ID}\``);
		expect(rendered).toContain(rpc.state.sessionFile!);
		expect(rendered).toContain("🧠 anthropic/claude-opus-5");
	});

	test("`resume <path>` shows the id in the first header post, before any child answers", async () => {
		const h = await makeHarness(makeConfig());
		const resumed = `${HOME}/.omp/agent/sessions/2026-01-01T00-00-00_deadbeef.jsonl`;
		await h.slack.inject(dm(`resume ${resumed}`));

		const rendered = JSON.stringify(h.slack.posted[0]!.args.blocks);
		expect(rendered).toContain("🆔 `deadbeef`");
		expect(rendered).toContain(resumed);
	});

	test("a session file that carries no id shows the path alone", async () => {
		const h = await makeHarness(makeConfig());
		const legacy = `${HOME}/.omp/agent/sessions/legacy.jsonl`;
		await h.slack.inject(dm(`resume ${legacy}`));

		const rendered = JSON.stringify(h.slack.posted[0]!.args.blocks);
		expect(rendered).toContain(legacy);
		expect(rendered).not.toContain("🆔");
	});
});

/**
 * The encoding omp itself uses (`session-paths.ts:43`). It decides where a
 * routing transcript lands, so a drift here silently sends gemma runs to a
 * directory no `omp sessions` listing and no audit sweep looks at.
 */
describe("ompSessionDir", () => {
	test("a repo under $HOME encodes home-relative", () => {
		expect(ompSessionDir("/Users/me", "/Users/me/oh-my-pi-src")).toBe("/Users/me/.omp/agent/sessions/-oh-my-pi-src");
		expect(ompSessionDir("/Users/me", "/Users/me/src/deep/repo")).toBe("/Users/me/.omp/agent/sessions/-src-deep-repo");
	});

	test("$HOME itself is the bare `-` dir", () => {
		expect(ompSessionDir("/Users/me", "/Users/me")).toBe("/Users/me/.omp/agent/sessions/-");
	});

	test("a path outside $HOME falls back to the absolute form", () => {
		expect(ompSessionDir("/Users/me", "/srv/checkout")).toBe("/Users/me/.omp/agent/sessions/--srv-checkout--");
	});
});
