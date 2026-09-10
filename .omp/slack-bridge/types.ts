/**
 * Shared contracts for the omp Slack bridge.
 *
 * SINGLE SOURCE OF TRUTH. Implementations (omp-rpc.ts, slack.ts, bridge.ts,
 * blocks.ts, registry.ts) import from this file and MUST NOT redefine or
 * widen these types. Protocol shapes mirror ~/oh-my-pi-src/docs/rpc.md.
 */

// ============================================================================
// omp RPC protocol frames (subset the bridge uses)
// ============================================================================

/**
 * A vision-model image block, exactly as omp's RPC `prompt` frame accepts it
 * (`docs/rpc.md`: `images?: ImageContent[]`). `data` is base64 with no data-URL
 * prefix. omp resizes these for the active model and drops them entirely for a
 * text-only one, so the bridge never has to reason about model capability.
 */
export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

/** Commands written to the RPC child's stdin (one JSON object per line). */
export type OmpRpcCommand =
	| {
			id: string;
			type: "prompt";
			message: string;
			images?: ImageContent[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { id: string; type: "abort" }
	| { id: string; type: "get_state" }
	| { id: string; type: "get_last_assistant_text" }
	| { id: string; type: "set_session_name"; name: string }
	| { id: string; type: "set_host_tools"; tools: OmpHostToolDefinition[] }
	| { id: string; type: "get_subagents" };

/** Response frame correlated by `id`. */
export interface OmpRpcResponse {
	type: "response";
	id?: string;
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
}

/** `get_state` payload subset the bridge consumes. */
export interface OmpSessionState {
	model?: { provider: string; id: string };
	isStreaming: boolean;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	messageCount?: number;
	contextUsage?: { tokens: number; contextWindow: number; percent: number } | null;
}

export interface OmpSubagentSnapshot {
	id: string;
	agent: string;
	status: string;
	task?: string;
	sessionFile?: string;
	lastUpdate: number;
}

/**
 * Streaming delta carried by `message_update` — the subset the bridge reads.
 * Types mirror `AssistantMessageEvent` in packages/ai: `thinking_start` /
 * `thinking_delta` / `thinking_end`, and the `text_*` / `toolcall_*` families
 * whose arrival means the open thinking block is over.
 */
export interface OmpAssistantMessageEvent {
	type: string;
	/** Increment on a `*_delta`. */
	delta?: string;
	/** Whole block content on a `*_end`. */
	content?: string;
	/** Index of the assistant content block this delta belongs to. */
	contentIndex?: number;
}

/** Agent lifecycle/tool events forwarded by RPC mode (fields beyond `type` are loosely typed on purpose — treat unknown shapes as absent). */
export interface OmpAgentEvent {
	type:
		| "agent_start"
		| "agent_end"
		| "turn_start"
		| "turn_end"
		| "tool_execution_start"
		| "tool_execution_update"
		| "tool_execution_end"
		| "message_start"
		| "message_update"
		| "message_end"
		| "auto_compaction_start"
		| "auto_compaction_end"
		| "auto_retry_start"
		| "auto_retry_end";
	/** Present on tool_execution_* in current runtime; extract defensively. */
	toolName?: string;
	args?: Record<string, unknown>;
	/** Present on `message_update`: the streaming delta that triggered it. */
	assistantMessageEvent?: OmpAssistantMessageEvent;
	[key: string]: unknown;
}

/** Extension/tool UI request emitted by the RPC server (ask questions arrive as `select`). */
export type OmpUiRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| { type: "extension_ui_request"; id: string; method: "notify"; message: string; level?: string }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; text?: string }
	| { type: "extension_ui_request"; id: string; method: "open_url"; url: string; instructions?: string };

/** UI response written to stdin. `value`: select → chosen option LABEL, input/editor → text. */
export type OmpUiResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Host tool sub-protocol (docs/rpc.md §Host Tool Sub-Protocol)
//
// The builtin `ask` tool does NOT register in RPC mode (no interactive UI at
// tool-registry construction), so the bridge owns an `ask` host tool instead:
// registered via set_host_tools, served via host_tool_call/host_tool_result.
// ============================================================================

/** Host-owned tool definition sent with `set_host_tools`. `parameters` is JSON Schema. */
export interface OmpHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** Server → host: execute a host-owned tool. */
export interface OmpHostToolCall {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Server → host: a pending host tool call was aborted. */
export interface OmpHostToolCancel {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Host → server: completion for a host_tool_call (correlate on its `id`). */
export interface OmpHostToolResult {
	type: "host_tool_result";
	id: string;
	result: { content: Array<{ type: "text"; text: string }> };
	isError?: boolean;
}

/** Arguments of the bridge-owned `ask` host tool (mirrors the builtin ask schema). */
export interface AskToolArgs {
	questions: Array<{
		id: string;
		question: string;
		header?: string;
		options: Array<{ label: string; description?: string }>;
		multi?: boolean;
		recommended?: number;
	}>;
}

// ============================================================================
// OmpRpc — contract implemented by omp-rpc.ts (RpcCore)
// ============================================================================

export interface OmpRpcOptions {
	/** argv[0] for the omp CLI (default "omp"; may be a shell-script wrapper). */
	ompBin: string;
	/** Working directory for the agent process. */
	cwd: string;
	/** Resume an existing session file instead of starting fresh. */
	resumeSessionPath?: string;
	/** Extra env merged over process.env (e.g. OMP_HUB_NEW_SESSION=1). */
	env?: Record<string, string>;
	/** Extra CLI args (e.g. ["-m", "provider/model"]). */
	extraArgs?: string[];
	/** Ready-handshake timeout ms (default 30_000). */
	readyTimeoutMs?: number;
}

export interface OmpRpcEvents {
	/** Agent lifecycle/tool events (see OmpAgentEvent). */
	onEvent(listener: (event: OmpAgentEvent) => void): () => void;
	/** UI requests needing a host answer (select/confirm/input/editor) or display (notify/…). */
	onUiRequest(listener: (req: OmpUiRequest) => void): () => void;
	/** Host tool execution requests (after setHostTools). */
	onHostToolCall(listener: (call: OmpHostToolCall) => void): () => void;
	/** Cancellation of a pending host tool call (targetId = call id). */
	onHostToolCancel(listener: (cancel: OmpHostToolCancel) => void): () => void;
	/** Process exited (code null when killed). Fires exactly once. */
	onExit(listener: (code: number | null) => void): () => void;
}

/**
 * Raw JSONL client over a spawned `omp --mode rpc` child.
 *
 * Semantics:
 * - start(): spawns, waits for {"type":"ready"}; rejects with stderr tail on
 *   early exit or timeout (child killed on failure). Callable once per instance.
 * - Commands auto-assign ids and resolve/reject on the correlated response
 *   (reject when success:false, message = error field).
 * - prompt(): ALWAYS sends streamingBehavior:"steer". Immediate ack; turn
 *   completion is observed via onEvent agent_end. `images` ride the same frame,
 *   so a Slack screenshot reaches the model without a `read` round trip.
 * - respondUi(): fire-and-forget stdin write (no response frame exists).
 * - stop(): SIGTERM, then SIGKILL after 5s if still alive; pending requests
 *   reject; onExit fires exactly once.
 * - alive: true between successful start() and exit.
 */
export interface OmpRpc extends OmpRpcEvents {
	readonly alive: boolean;
	start(): Promise<void>;
	prompt(message: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<OmpSessionState>;
	getLastAssistantText(): Promise<string | null>;
	/** Per-subagent snapshots (empty when none). Rejects on a malformed payload so park fails closed. */
	getSubagents(): Promise<OmpSubagentSnapshot[]>;
	setSessionName(name: string): Promise<void>;
	respondUi(response: OmpUiResponse): void;
	/** Register/replace host-owned tools (id-correlated `set_host_tools`). */
	setHostTools(tools: OmpHostToolDefinition[]): Promise<void>;
	/** Fire-and-forget completion write for a host_tool_call. */
	respondHostTool(result: OmpHostToolResult): void;
	stop(): Promise<void>;
}

// ============================================================================
// Slack transport — contract implemented by slack.ts (SlackTransport)
// ============================================================================

/** A file carried by an inbound message (`files[]` on the Slack event). */
export interface SlackFileRef {
	id: string;
	name: string;
	mimetype: string;
	/** Byte size; 0 for externally hosted files. */
	size: number;
	/** Token-authenticated download URL. Absent for external (Drive/Box/…) files. */
	downloadUrl?: string;
	/** Slack permalink — always usable by a human, never by the bot. */
	permalink?: string;
}

/** Inbound DM (message.im event, bot/self messages already filtered out). */
export interface SlackInboundMessage {
	kind: "message";
	channel: string;
	user: string;
	text: string;
	ts: string;
	/** Set when the message is a threaded reply. */
	threadTs?: string;
	/** Attached files (uploads and external references), if any. */
	files?: SlackFileRef[];
	/** URLs Slack unfurled into `attachments` (Drive docs, links, …), if any. */
	links?: string[];
}

/** One `conversations.history` row: the message plus the thread metadata only history exposes. */
export interface SlackHistoryEntry {
	message: SlackInboundMessage;
	/** Replies in this message's thread (0 when it has no thread). */
	replyCount: number;
	/** Users who replied in the thread (`reply_users`, capped by Slack at 5). */
	replyUsers: string[];
}

/** Inbound block action (button click / select) from an `interactive` envelope. */
export interface SlackBlockAction {
	kind: "action";
	channel: string;
	user: string;
	/** ts of the message carrying the actioned block. */
	messageTs: string;
	threadTs?: string;
	actionId: string;
	/** Button value / selected option value. */
	value: string;
}

export type SlackInbound = SlackInboundMessage | SlackBlockAction;

/** Minimal Block Kit types the bridge emits (structural, not exhaustive). */
export interface SlackBlock {
	type: string;
	[key: string]: unknown;
}

export interface SlackPostArgs {
	channel: string;
	text: string;
	blocks?: SlackBlock[];
	threadTs?: string;
}

/**
 * Socket Mode client + Web API wrapper. Zero omp knowledge.
 *
 * Semantics:
 * - start(): auth.test (validates bot token, learns bot user id), opens the
 *   Socket Mode WebSocket via apps.connections.open, resolves once connected.
 *   Auto-reconnects with capped exponential backoff until stop(); envelopes
 *   are acked immediately, then dispatched; event deliveries deduped by
 *   event_id (bounded LRU); messages from the bot itself never dispatched.
 * - onInbound: message.im events and block actions from allowed envelope
 *   types, normalized. NO allowlist filtering here — bridge owns policy.
 * - Web API calls throw Error(`slack ${method}: ${error}`) on ok:false.
 * - postMessage returns the new message ts.
 * - uploadFiles: files.uploadV2 flow (getUploadURLExternal → POST bytes →
 *   completeUploadExternal) attaching one or more files to the thread. A single
 *   finalize call means N files arrive as ONE Slack message, and Slack renders
 *   image types inline — the only way a screenshot is actually visible.
 *   uploadText is the text-snippet special case.
 * - A 30s client ping keeps the socket honest: a peer that vanished without a
 *   FIN (proxy/NAT drop) surfaces as a write error → close → reconnect.
 *   `connected` reports the live readyState; `reconnect()` forces a new socket.
 * - fetchHistory/downloadFile exist for the bridge's catch-up sweep and
 *   attachment materialization; they never dispatch to onInbound.
 */
export interface SlackTransport {
	start(): Promise<void>;
	stop(): Promise<void>;
	onInbound(listener: (inbound: SlackInbound) => void): () => void;
	postMessage(args: SlackPostArgs): Promise<string>;
	updateMessage(args: { channel: string; ts: string; text: string; blocks?: SlackBlock[] }): Promise<void>;
	uploadText(args: { channel: string; threadTs: string; filename: string; content: string }): Promise<void>;
	uploadFiles(args: {
		channel: string;
		threadTs: string;
		files: Array<{ filename: string; bytes: Uint8Array }>;
		/** Message text posted with the files (`initial_comment`). */
		comment?: string;
	}): Promise<void>;
	/** Open (or fetch) the bot↔user DM channel; returns its channel id. */
	openDm(userId: string): Promise<string>;
	/**
	 * Top-level messages of `channel` newer than `oldestTs`, newest first.
	 * Thread replies are NOT included (Slack keeps them out of history).
	 */
	fetchHistory(args: { channel: string; oldestTs: string; limit?: number }): Promise<SlackHistoryEntry[]>;
	/**
	 * GET an authenticated `files.slack.com` URL with the bot token.
	 * Throws when the token lacks `files:read` (Slack answers 200 + an HTML
	 * sign-in page rather than an error).
	 */
	downloadFile(url: string): Promise<Uint8Array>;
	/** Tear down the current socket and reconnect (used when it looks stale). */
	reconnect(): void;
	/** True while the Socket Mode websocket is OPEN. */
	readonly connected: boolean;
	/** Bot's own user id (available after start()). */
	readonly botUserId: string;
}

// ============================================================================
// Registry — contract implemented by registry.ts (BridgeCore)
// ============================================================================

export interface TaskRecord {
	/** Slack thread root ts — primary key. */
	threadTs: string;
	/** DM channel id. */
	channel: string;
	/** Durable session key; set once known (post-start get_state). */
	sessionPath?: string;
	/** Working directory the task was started in. */
	cwd: string;
	/** Display name (session name / prompt head). */
	name: string;
	createdAt: number;
	lastActivityAt: number;
}

export interface RegistryData {
	tasks: TaskRecord[];
	/**
	 * channel → ts of the newest message the catch-up sweep has already
	 * considered. Monotonic: a message is never replayed twice across restarts.
	 */
	catchup?: Record<string, string>;
}

// ============================================================================
// Control socket — implemented by control.ts, consumed by omp core
// (packages/coding-agent src/hub/bridge-client.ts mirrors these shapes) and
// by the slack-notify extension.
//
// Unix domain socket at `<stateDir>/bridge.sock`, one JSON object per line,
// exactly one response per request. Doubles as the single-instance lock:
// a starting bridge that gets a `ping` answer from the socket exits; a dead
// socket file is unlinked and rebound.
// ============================================================================

export type ControlRequest =
	| { op: "ping" }
	| { op: "status" }
	/** Park the live task owning `sessionPath` — ONLY when quiescent (turn done,
	 * no running subagents, no pending ask). Stops its RPC process (registry
	 * entry and Slack thread survive) and posts a handoff note to the thread.
	 * Busy → { parked: false, reason }. Used by `omp --resume` / spectator promote. */
	| { op: "park"; sessionPath: string }
	/** Route text into a bridge-owned live session as a prompt/steer (spectator
	 * proxy input). Session not live under the bridge → error. */
	| { op: "steer"; sessionPath: string; text: string }
	/** Abort the main agent's current turn only (running subagents unaffected). */
	| { op: "interrupt"; sessionPath: string }
	/** From the slack-notify extension inside a terminal session: post/refresh a
	 * notification thread for the session. Binds sessionPath ↔ thread in the
	 * registry so later thread replies attach the session to Slack. */
	| { op: "notify"; sessionPath: string; cwd: string; kind: "turn_end" | "ask_pending"; text: string }
	| { op: "subagents"; sessionPath: string };

export interface ControlTaskInfo {
	sessionPath?: string;
	threadTs: string;
	channel: string;
	name: string;
	turnActive: boolean;
	/** Running subagent count at status time (0 when unknown/none). */
	subagentsRunning: number;
}

export interface ControlSubagentInfo {
	id: string;
	agent: string;
	status: string;
	task?: string;
	sessionFile?: string;
	lastUpdate: number;
}

export type ControlResponse =
	| { ok: true; pid: number }
	| { ok: true; tasks: ControlTaskInfo[] }
	| { ok: true; parked: boolean; reason?: string }
	| { ok: true; subagents: ControlSubagentInfo[] }
	| { ok: true }
	| { ok: false; error: string };

// ============================================================================
// Front-door router (local model via Shuttle, driven by the `pi` harness)
// ============================================================================

/**
 * One agent the router may pick for a `run`.
 *
 * `name` is what `omp --agent <name>` takes; `description` is the agent's own
 * frontmatter description, offered WHOLE (they run long) because it is what the
 * router matches a task shape against. Built by `agent-defs.ts` from the repo's
 * `.omp/agents` and the home agent dir.
 */
export interface AgentOption {
	name: string;
	description: string;
}

/**
 * One command the router resolved a free-form Slack message into.
 *
 * Mirrors the top-level command surface one-for-one: the router picks the
 * command and its arguments, the bridge executes it. `dir` is a REPOS alias or
 * an absolute path under $HOME — the bridge re-validates it via `#resolveDir`
 * and never trusts the model's choice. `agent` is a **name from the offered
 * inventory** and is re-validated the same way (`#resolveAgent`): anything else
 * is dropped, leaving the default worker. There is no `orchestrate` command —
 * an orchestration request is a `run` with `agent: "orchestrate"`.
 */
export type RouterDecision = (
	| { command: "run"; dir?: string; prompt: string; agent?: string }
	| { command: "sessions"; alias?: string }
	| { command: "resume"; target: string }
	| { command: "status" }
	| { command: "help" }
) & { trace?: RouterTrace };

/**
 * What the routing run says about itself — the only explanation the user gets
 * for why their message went where it did. Cosmetic by construction: every
 * field is optional, and a decision with no trace renders exactly as it did
 * before, so a quiet or confused worker costs a sub-line, never a command.
 */
export interface RouterTrace {
	/**
	 * The worker's own account of the routing, at most three lines — the
	 * post-tool reply `router/prompts/entry.md` asks it for. Already clamped and
	 * trimmed by `parseDecision`; still untrusted model text, so it is escaped
	 * at render time like any other.
	 */
	summary?: string;
	/** Turns the worker took. Two is the healthy shape: call the command, then explain it. */
	turns?: number;
}

/** What the router is told about the message besides its text. */
export interface RouterContext {
	/** alias → absolute path, from `REPOS`. */
	repos: Record<string, string>;
	defaultRepo?: string;
	/**
	 * The agents the router may pick from, from `agent-defs.ts`. Offered as
	 * `name: description` lines so a task lands on an agent that actually exists
	 * on this box rather than an invented one. Absent or empty → the router is
	 * never told about agents and never passes one.
	 */
	agents?: AgentOption[];
	/**
	 * Where the routing run persists its own transcript: the **omp** session dir
	 * for the repo, so a gemma routing run lands beside the agent sessions it
	 * starts and cc-callbacks audits both from one tree. Absent → pi's own
	 * per-cwd dir.
	 */
	sessionDir?: string;
	/**
	 * Working directory for the routing run. cc-callbacks records the process cwd
	 * as the audited run's `project_root`, so pointing it at the repo attributes
	 * the routing turn to that project instead of the bridge's install dir.
	 */
	cwd?: string;
	/**
	 * One-line inventory of the message's attachments (`screenshot.png
	 * (image/png)`), or absent when it carries none. The router model gets the
	 * *names and types only* — never bytes, never paths: a local model served by
	 * Shuttle has no vision, and its only job is picking a command. Without this
	 * a bare "what's wrong here?" plus a screenshot reads as pure ambiguity and
	 * routes to `help`.
	 */
	attachments?: string;
}

/**
 * Router seam — tests inject a fake, production spawns `router/route.sh`.
 *
 * FAIL-OPEN CONTRACT: resolves `undefined` whenever the router is disabled,
 * unreachable, times out, or produces no parseable decision. `undefined` means
 * "no opinion" and the caller MUST fall back to the literal first-token parser,
 * so a dead local model can never swallow a Slack message. Implementations
 * therefore never reject.
 */
export type RouteMessage = (text: string, ctx: RouterContext) => Promise<RouterDecision | undefined>;

// ============================================================================
// Bridge config
// ============================================================================

export interface BridgeConfig {
	slackAppToken: string;
	slackBotToken: string;
	/** Slack member IDs allowed to use the bridge. Non-empty (enforced at load). */
	allowedUsers: string[];
	ompBin: string;
	/** alias → absolute path. */
	repos: Record<string, string>;
	defaultRepo?: string;
	maxTasks: number;
	idleTtlMin: number;
	sessionNamePrefix: string;
	/**
	 * How far back the catch-up sweep may reach for DMs missed while the socket
	 * was down (minutes). 0 disables catch-up entirely.
	 */
	catchupWindowMin: number;
	/**
	 * pi model spec for the front-door router (e.g. `shuttle/gemma-4-26b`).
	 * Empty string disables the router: every message goes straight to the
	 * literal first-token parser.
	 */
	routerModel: string;
	/** Hard deadline for one routing call; on elapse the router fails open. */
	routerTimeoutMs: number;
	/** Absolute path to `router/route.sh`. */
	routerScript: string;
	/** State/registry directory (default ~/.omp/slack-bridge). */
	stateDir: string;
}
