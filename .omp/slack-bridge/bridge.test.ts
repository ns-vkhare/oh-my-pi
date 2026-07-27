/**
 * Hermetic bridge tests — fake SlackTransport + fake OmpRpc, no network, no omp.
 *
 * Covers config loading, DM command routing, allowlist enforcement, UI relay
 * (select buttons + input replies), turn completion rendering, lazy respawn,
 * and registry persistence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Bridge, loadConfig, type ListSessions, type StoreSession } from "./bridge";
import { TaskRegistry } from "./registry";
import type {
	BridgeConfig,
	OmpAgentEvent,
	OmpHostToolCall,
	OmpHostToolCancel,
	OmpHostToolDefinition,
	OmpHostToolResult,
	OmpRpc,
	OmpRpcOptions,
	OmpSessionState,
	OmpUiRequest,
	OmpUiResponse,
	SlackBlock,
	SlackBlockAction,
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

class FakeSlack implements SlackTransport {
	readonly botUserId = "UBOT";
	readonly posted: PostedMessage[] = [];
	readonly updated: UpdatedMessage[] = [];
	readonly uploads: Array<{ threadTs: string; content: string }> = [];
	#listeners = new Set<(inbound: SlackInbound) => void>();
	#counter = 0;

	async start(): Promise<void> {}
	async stop(): Promise<void> {}

	onInbound(listener: (inbound: SlackInbound) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async postMessage(args: SlackPostArgs): Promise<string> {
		const ts = `ts${++this.#counter}`;
		this.posted.push({ ts, args });
		return ts;
	}

	async updateMessage(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
		this.updated.push({ ts: args.ts, text: args.text, blocks: args.blocks });
	}

	async uploadText(args: { channel: string; threadTs: string; filename: string; content: string }): Promise<void> {
		this.uploads.push({ threadTs: args.threadTs, content: args.content });
	}

	async openDm(userId: string): Promise<string> {
		return `D-${userId}`;
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
	readonly hostTools: OmpHostToolDefinition[][] = [];
	readonly hostToolResults: OmpHostToolResult[] = [];
	lastAssistantText: string | null = "done";
	state: OmpSessionState = { isStreaming: false, sessionFile: `${HOME}/.omp/agent/sessions/x.jsonl`, sessionName: "sess" };
	startError?: Error;

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
	async prompt(message: string): Promise<void> {
		this.commands.push("prompt");
		this.prompts.push(message);
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
	subagentsRunning = 0;
	async getSubagents(): Promise<number> {
		this.commands.push("get_subagents");
		return this.subagentsRunning;
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
		stateDir: `${HOME}/.omp/slack-bridge`,
		...overrides,
	};
}

interface Harness {
	slack: FakeSlack;
	registry: TaskRegistry;
	bridge: Bridge;
	rpcs: FakeRpc[];
}

/** Bridges created via makeHarness; shut down after each test to clear timers. */
const liveHarnesses: Bridge[] = [];
afterEach(async () => {
	while (liveHarnesses.length > 0) await liveHarnesses.pop()!.shutdown();
});

async function makeHarness(config: BridgeConfig, seed: TaskRecord[] = [], listSessions?: ListSessions): Promise<Harness> {
	const slack = new FakeSlack();
	const dir = `/tmp/bridge-test-${Math.random().toString(36).slice(2)}`;
	const registry = await TaskRegistry.load(dir);
	for (const rec of seed) registry.upsert(rec);
	const rpcs: FakeRpc[] = [];
	const createRpc = (opts: OmpRpcOptions): OmpRpc => {
		const rpc = new FakeRpc(opts);
		rpcs.push(rpc);
		return rpc;
	};
	const bridge = new Bridge({ config, slack, registry, createRpc, listSessions });
	bridge.start();
	liveHarnesses.push(bridge);
	return { slack, registry, bridge, rpcs };
}

function dm(text: string, user = "UALICE", threadTs?: string): SlackInboundMessage {
	return { kind: "message", channel: "D1", user, text, ts: `m${Math.random()}`, threadTs };
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

	test("allowlisted run posts header, spawns rpc with cwd + OMP_HUB_NEW_SESSION, prompts after start", async () => {
		const h = await makeHarness(makeConfig());
		await h.slack.inject(dm("run omp fix the bug"));

		// Header posted (first message), its ts becomes threadTs.
		expect(h.slack.posted.length).toBeGreaterThanOrEqual(1);
		const header = h.slack.posted[0]!;
		expect(header.args.blocks).toBeDefined();

		expect(h.rpcs).toHaveLength(1);
		const rpc = h.rpcs[0]!;
		expect(rpc.opts.cwd).toBe(`${HOME}/oh-my-pi-src`);
		expect(rpc.opts.env?.OMP_HUB_NEW_SESSION).toBe("1");
		expect(rpc.prompts).toEqual(["fix the bug"]);
		// Registry has the record keyed by header ts.
		expect(h.registry.byThread(header.ts)).toBeDefined();
	});
});

describe("ui relay", () => {
	async function runningTask(h: Harness): Promise<{ rpc: FakeRpc; threadTs: string }> {
		await h.slack.inject(dm("run omp do work"));
		const threadTs = h.slack.posted[0]!.ts;
		return { rpc: h.rpcs[0]!, threadTs };
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
		await h.slack.inject(dm("run omp go"));
		const threadTs = h.slack.posted[0]!.ts;
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

	test("resume <n> resumes the mapped session path in its repo cwd", async () => {
		const h = await makeHarness(makeConfig(), [], lister);
		await h.slack.inject(dm("sessions"));
		const beforeHeader = h.slack.posted.length;

		await h.slack.inject(dm("resume 2"));

		expect(h.rpcs).toHaveLength(1);
		expect(h.rpcs[0]!.opts.resumeSessionPath).toBe(BETA);
		expect(h.rpcs[0]!.opts.cwd).toBe(REPO);
		expect(h.rpcs[0]!.opts.env?.OMP_HUB_NEW_SESSION).toBeUndefined();
		// A task header opened the thread and got registered.
		const header = h.slack.posted[beforeHeader]!;
		expect(header.args.blocks).toBeDefined();
		expect(h.registry.byThread(header.ts)).toBeDefined();
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
		await h.slack.inject(dm("run omp do work"));
		const threadTs = h.slack.posted[0]!.ts;
		return { rpc: h.rpcs[0]!, threadTs };
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

	test("two questions: button answers Q1 without completing; thread reply answers Q2 and completes", async () => {
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

		// Answer Q2 via thread reply → completes with both → lines.
		await h.slack.inject(dm("Large", "UALICE", threadTs));
		expect(rpc.hostToolResults).toHaveLength(1);
		const text = rpc.hostToolResults[0]!.result.content[0]!.text;
		expect(text).toContain("Pick a color → Red");
		expect(text).toContain("Pick a size → Large");

		// pendingAsk cleared → a later thread reply becomes a prompt.
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
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		rpc.getSubagents = () => Promise.reject(new Error("rpc down"));
		const res = await h.bridge.controlHost().park(sessionPath);
		expect(res).toEqual({ parked: false, reason: "subagent state unknown" });
		expect(rpc.commands).not.toContain("stop"); // never stopped an unknown-state session
	});

	test("a park in progress refuses a concurrent steer (TOCTOU lock)", async () => {
		// F2: park claims the task synchronously (parking=true) before its first
		// await, so a steer landing in the quiescence→stop window is rejected.
		const h = await makeHarness(makeConfig());
		const { rpc, sessionPath } = await liveTask(h);
		await settle();
		const gate = Promise.withResolvers<number>();
		rpc.getSubagents = () => gate.promise; // park blocks inside the window
		const parkP = h.bridge.controlHost().park(sessionPath); // sets parking=true now
		await expect(h.bridge.controlHost().steer(sessionPath, "hi")).rejects.toThrow(/being parked/);
		gate.resolve(0); // quiescent → park completes
		expect(await parkP).toEqual({ parked: true });
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
