/**
 * omp Slack bridge daemon.
 *
 * Wires the Slack transport (./slack) to omp RPC processes (./omp-rpc):
 * routes DM commands and thread replies, relays `ask`/UI requests as Block Kit
 * messages, renders per-turn status, persists the thread↔session registry, and
 * reaps idle processes (hub parity). Run with `bun bridge.ts`.
 */

import * as os from "node:os";
import * as path from "node:path";
import SLACK_REPLY_GUIDANCE from "./prompts/slack-reply.md" with { type: "text" };
import SLACK_REPOS_GUIDANCE from "./prompts/slack-repos.md" with { type: "text" };
import { listAgentDefinitions } from "./agent-defs";
import {
	answeredBlocks,
	askAnsweredBlocks,
	askQuestionBlocks,
	escapeMrkdwn,
	finalTextBlocks,
	notifyText,
	routedBlocks,
	statusText,
	taskHeaderBlocks,
	thinkingLine,
	uiRequestBlocks,
} from "./blocks";
import { BridgeAlreadyRunningError, type ControlHost, startControlServer } from "./control";
import { createOmpRpc } from "./omp-rpc";
import { createSlackTransport, LruSet } from "./slack";
import { TaskRegistry } from "./registry";
import { createRouter } from "./router";
import type {
	AgentOption,
	AskToolArgs,
	BridgeConfig,
	ImageContent,
	OmpAgentEvent,
	OmpAssistantMessageEvent,
	OmpHostToolCall,
	OmpHostToolCancel,
	OmpHostToolDefinition,
	OmpRpc,
	OmpRpcOptions,
	OmpSubagentSnapshot,
	OmpUiRequest,
	RouteMessage,
	RouterDecision,
	SlackBlockAction,
	ControlSubagentInfo,
	ControlTaskInfo,
	SlackInbound,
	SlackInboundMessage,
	SlackTransport,
	TaskRecord,
} from "./types";

const STATUS_THROTTLE_MS = 2_000;
const REAPER_INTERVAL_MS = 60_000;
/** Slack section text cap; longer final text is uploaded as a snippet. */
const FINAL_INLINE_MAX = 2_900;
const MINUTE_MS = 60_000;
/** Park's subagent-count probe deadline; a slow/failed probe fails the park CLOSED. */
const PARK_SUBAGENT_TIMEOUT_MS = 3_000;
const TERMINAL_SUBAGENT_STATUSES: Record<string, true> = { completed: true, failed: true, aborted: true };
/**
 * Catch-up cadence — the ceiling on how late a DM can land when Socket Mode
 * silently stops delivering (see #catchUp).
 */
const CATCHUP_INTERVAL_MS = 120_000;
/** Per-file ceiling for attachments materialized to disk. */
const ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;
/**
 * What omp can hand a vision model (`SUPPORTED_IMAGE_MIME_TYPES` in
 * `packages/utils/src/mime.ts`). Anything else — HEIC off an iPhone, SVG, TIFF —
 * stays path-only: `read` reports an unsupported format cleanly, whereas an
 * undecodable block reaches the provider and fails the whole turn.
 */
const INLINE_IMAGE_MIME_TYPES: Record<string, true> = {
	"image/png": true,
	"image/jpeg": true,
	"image/gif": true,
	"image/webp": true,
};
/**
 * Ceiling for an image sent inline, well under omp's own 20MB input cap. Base64
 * inflates by a third and the frame is a single JSONL line, so a phone-camera
 * dump stays a path the agent can open on demand instead of an 11MB stdin write.
 */
const INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** Ceiling on the attachment inventory handed to the router, in characters. */
const ATTACHMENT_SUMMARY_MAX_CHARS = 200;
/** Most files one `attach_file` call may upload, and the per-file byte ceiling. */
const ATTACH_MAX_FILES = 10;
const ATTACH_MAX_BYTES = 32 * 1024 * 1024;
/** Remembered inbound message ts values (live + replayed), for dedup. */
const SEEN_MESSAGE_CAP = 500;
/**
 * Default `router/route.sh`: resolved relative to the running bridge module, so
 * a deployed copy (`~/.omp/slack-bridge`) runs its own script rather than the
 * repo's. ROUTER_SCRIPT overrides it.
 */
const DEFAULT_ROUTER_SCRIPT = new URL("./router/route.sh", import.meta.url).pathname;

function countActiveSubagents(list: readonly OmpSubagentSnapshot[]): number {
	let active = 0;
	for (const entry of list) {
		if (TERMINAL_SUBAGENT_STATUSES[entry.status] !== true) active++;
	}
	return active;
}

/**
 * A message's attachments, ready to hand to the agent: the prompt note naming
 * every file (paths for the fetched ones, a reason for the rest) and the image
 * blocks that ride the prompt frame alongside it.
 */
interface AttachmentPayload {
	note: string;
	images: ImageContent[];
}

/** Shared no-attachment result — the overwhelmingly common case. */
const EMPTY_ATTACHMENTS: AttachmentPayload = { note: "", images: [] };

/** A UI request awaiting a Slack answer, plus the message showing it. */
interface PendingUi {
	req: OmpUiRequest;
	messageTs: string;
}

/**
 * A live `ask` host-tool call awaiting answers. One Slack message per question
 * (parallel arrays), answers filled as they arrive; completion fires when all
 * are answered.
 */
interface PendingAsk {
	callId: string;
	questions: AskToolArgs["questions"];
	answers: Array<string | undefined>;
	messageTs: string[];
}

/** In-memory state for one live RPC process bound to a Slack thread. */
interface LiveTask {
	rpc: OmpRpc;
	record: TaskRecord;
	statusTs?: string;
	/** In-flight status post — guards against agent_start/turn_start double-posting. */
	statusPost?: Promise<void>;
	/** Turn timeline rendered into the status message: thinking excerpts and tool labels, in arrival order. */
	statusLines: string[];
	/** Open thinking block: its content-block index, its slot in `statusLines` (unset until it has renderable text), and the text so far. */
	thinking?: { block: number; line?: number; text: string };
	turnActive: boolean;
	pendingUi: Map<string, PendingUi>;
	pendingTextUi?: PendingUi;
	pendingAsk?: PendingAsk;
	/** Last text posted per setStatus key (dedup). */
	statusByKey: Map<string, string>;
	/** Throttle bookkeeping for status chat.update. */
	lastStatusUpdate: number;
	/** Last status text sent this turn — the immediate and trailing flush often render the same lines, and Slack should not be told twice. */
	lastStatusText?: string;
	statusUpdateTimer?: ReturnType<typeof setTimeout>;
	/** True while a park is stopping this task — refuses concurrent steer/prompt/park. */
	parking?: boolean;
	disposers: Array<() => void>;
}

// ============================================================================
// Config
// ============================================================================

/** Parse a `.env` file body: KEY=VALUE lines, `#` comments, optional quotes. */
export function parseEnvFile(body: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		let value = line.slice(eq + 1).trim();
		if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}

function expandHome(path: string, home: string): string {
	if (path === "~") return home;
	if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
	return path;
}

/** Build the bridge config from environment variables (see DESIGN.md §Config). */
export function loadConfig(env: Record<string, string | undefined>, home: string): BridgeConfig {
	const slackAppToken = env.SLACK_APP_TOKEN?.trim() ?? "";
	const slackBotToken = env.SLACK_BOT_TOKEN?.trim() ?? "";
	if (!slackAppToken) throw new Error("SLACK_APP_TOKEN is required (see ~/.omp/slack-bridge/.env)");
	if (!slackBotToken) throw new Error("SLACK_BOT_TOKEN is required (see ~/.omp/slack-bridge/.env)");

	const allowedUsers = (env.SLACK_ALLOWED_USERS ?? "")
		.split(",")
		.map((u) => u.trim())
		.filter(Boolean);
	if (allowedUsers.length === 0) {
		throw new Error("SLACK_ALLOWED_USERS is empty — refusing to start (set a comma-separated list of Slack member IDs)");
	}

	const repos: Record<string, string> = {};
	for (const entry of (env.REPOS ?? "").split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const alias = trimmed.slice(0, eq).trim();
		const path = expandHome(trimmed.slice(eq + 1).trim(), home);
		if (alias && path) repos[alias] = path;
	}

	const maxTasksRaw = Number.parseInt(env.MAX_TASKS ?? "", 10);
	const idleTtlRaw = Number.parseInt(env.IDLE_TTL_MIN ?? "", 10);
	const catchupRaw = Number.parseInt(env.CATCHUP_WINDOW_MIN ?? "", 10);
	const routerTimeoutRaw = Number.parseInt(env.ROUTER_TIMEOUT_MS ?? "", 10);
	const routerScript = env.ROUTER_SCRIPT?.trim();

	return {
		slackAppToken,
		slackBotToken,
		allowedUsers,
		ompBin: expandHome(env.OMP_BIN?.trim() || "omp", home),
		repos,
		defaultRepo: env.DEFAULT_REPO?.trim() || undefined,
		maxTasks: Number.isFinite(maxTasksRaw) && maxTasksRaw > 0 ? maxTasksRaw : 4,
		idleTtlMin: Number.isFinite(idleTtlRaw) && idleTtlRaw > 0 ? idleTtlRaw : 30,
		sessionNamePrefix: env.SESSION_NAME_PREFIX ?? "slack:",
		catchupWindowMin: Number.isFinite(catchupRaw) && catchupRaw >= 0 ? catchupRaw : 60,
		routerModel: env.ROUTER_MODEL?.trim() ?? "",
		routerTimeoutMs: Number.isFinite(routerTimeoutRaw) && routerTimeoutRaw > 0 ? routerTimeoutRaw : 60_000,
		routerScript: routerScript ? expandHome(routerScript, home) : DEFAULT_ROUTER_SCRIPT,
		stateDir: `${home}/.omp/slack-bridge`,
	};
}

// ============================================================================
// Session store listing
// ============================================================================

/** Newest sessions listed per repo. */
const SESSIONS_PER_REPO = 8;
const SESSIONS_LIST_TIMEOUT_MS = 10_000;
/** How long an agent inventory is trusted before another disk scan. */
const AGENTS_TTL_MS = 5 * MINUTE_MS;

/** One `omp sessions --json` row, narrowed to the fields the bridge renders. */
export interface StoreSession {
	path: string;
	title?: string;
	firstMessage?: string;
	/** ISO mtime; absent when omp could not derive one. */
	modified?: string;
}

/** Session-store lister seam — tests inject a fake, production shells out. */
export type ListSessions = (dir: string) => Promise<StoreSession[]>;

/** Keep well-formed rows only; every rendered field is checked, never cast. */
function toStoreSession(value: unknown): StoreSession | undefined {
	if (!isRecord(value) || typeof value.path !== "string") return undefined;
	return {
		path: value.path,
		title: typeof value.title === "string" ? value.title : undefined,
		firstMessage: typeof value.firstMessage === "string" ? value.firstMessage : undefined,
		modified: typeof value.modified === "string" ? value.modified : undefined,
	};
}

/** Production `ListSessions`: `omp sessions --json --dir <dir>`, killed after 10s. */
export function spawnSessionLister(ompBin: string): ListSessions {
	return async (dir) => {
		const proc = Bun.spawn([ompBin, "sessions", "--json", "--dir", dir], { stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), SESSIONS_LIST_TIMEOUT_MS);
		try {
			const stdout = await new Response(proc.stdout).text();
			const code = await proc.exited;
			if (code !== 0) throw new Error(`omp sessions exited ${code}`);
			const parsed: unknown = JSON.parse(stdout);
			if (!Array.isArray(parsed)) throw new Error("omp sessions --json did not return an array");
			return parsed.map(toStoreSession).filter((s): s is StoreSession => s !== undefined);
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * Agent-inventory seam — tests inject a fake, production reads the agent files.
 *
 * The list is the agent definitions visible from the task's cwd (`name` +
 * `description`). It is the *only* set the router may pick from, so a routed
 * task can never land on an agent that does not exist.
 */
export type ListAgents = (cwd: string) => Promise<AgentOption[]>;

// ============================================================================
// Bridge
// ============================================================================

export interface BridgeDeps {
	config: BridgeConfig;
	slack: SlackTransport;
	registry: TaskRegistry;
	createRpc: (opts: OmpRpcOptions) => OmpRpc;
	/** Session-store lister; defaults to shelling out to `omp sessions --json`. */
	listSessions?: ListSessions;
	/** Agent-inventory lister; defaults to scanning omp's agent-definition roots. */
	listAgents?: ListAgents;
	/** Front-door intent router; defaults to the local-model router (fails open). */
	route?: RouteMessage;
}

const HELP_TEXT = [
	"*omp slack bridge*",
	"• `run <alias|path> <prompt…>` — start a new task",
	"• `orchestrate <alias|path> <prompt…>` — new task on the orchestrator agent (parallel subagents)",
	"• say it in plain words — the router picks the agent (planner, scout, reviewer, librarian, implementer, sonic, orchestrate)",
	"• `sessions [alias]` — browse omp sessions (⚡ live·slack, 🔗 attached)",
	"• `resume <n|sessionPath>` — attach a listed or on-disk session",
	"• `status` — bridge status",
	"Reply inside a task thread to steer it, or `abort` / `kill` / `status`.",
].join("\n");

/**
 * Prefixed to the help fallback when the router was *enabled* and still produced
 * nothing (dead model, blown deadline, unparseable answer). Without it a routing
 * failure is indistinguishable from "I could not understand you", so a detailed
 * request silently becomes a help card and the user retypes it minutes later.
 */
const ROUTER_FAILED_NOTE = "_The routing model did not answer, so this fell through to the literal parser — retry, or name the command yourself._";

/**
 * Prompt used when a DM is nothing but attachments. Deliberately does no work:
 * the user said nothing, so the agent describes what it was handed and waits.
 * That single turn is enough to bind the thread, and every reply after it is a
 * normal steer.
 */
const ATTACHMENT_ONLY_PROMPT =
	"The attachments below arrived from Slack with no accompanying message. Describe what each one is, then stop and wait for instructions — do not start any work yet.";

/** The bridge-owned `ask` host tool (see DESIGN.md §omp RPC protocol). */
const ASK_HOST_TOOL: OmpHostToolDefinition = {
	name: "ask",
	description:
		"Ask the user one or more multiple-choice questions and wait for their answers. Use when you need a decision, clarification, or a choice between approaches. The user answers asynchronously via Slack; there is no timeout. Prefer 2-5 concise options; use recommended: <index> for the default.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["questions"],
		properties: {
			questions: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["id", "question", "options"],
					properties: {
						id: { type: "string" },
						question: { type: "string" },
						header: { type: "string" },
						options: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								required: ["label"],
								properties: {
									label: { type: "string" },
									description: { type: "string" },
								},
							},
						},
						multi: { type: "boolean" },
						recommended: { type: "number" },
					},
				},
			},
		},
	},
};

/**
 * The bridge-owned `attach_file` host tool.
 *
 * Slack renders an uploaded image inline; a filesystem path in the reply text is
 * invisible to someone reading a DM. This is the only way a screenshot the agent
 * produced actually reaches the user, so the description says so plainly — the
 * model has no other signal that its usual "see /tmp/shot.png" habit fails here.
 */
const ATTACH_HOST_TOOL: OmpHostToolDefinition = {
	name: "attach_file",
	description:
		"Upload local files into the Slack thread so the user can see them. Images (png, jpeg, gif, webp) render inline; anything else arrives as a downloadable file. Use this for every screenshot, chart, diagram, or rendered image that is part of your answer — the user reads Slack and cannot open a filesystem path or click a markdown link to a local file. Paths must be absolute.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["paths"],
		properties: {
			paths: {
				type: "array",
				minItems: 1,
				maxItems: ATTACH_MAX_FILES,
				items: { type: "string" },
				description: "Absolute paths of the files to upload.",
			},
			comment: {
				type: "string",
				description: "One line posted with the files, e.g. what they show.",
			},
		},
	},
};

/**
 * The `REPOS` inventory appended to a spawned agent's system prompt: every alias
 * with its absolute path, the task's own checkout marked. Those aliases are the
 * vocabulary the person uses in Slack, so an agent that never sees them has to
 * guess which directory "nomad" is. Empty string when nothing is configured —
 * the section drops entirely rather than shipping a heading over an empty list.
 */
function repoInventory(repos: Record<string, string>, cwd: string): string {
	const lines = Object.entries(repos).map(([alias, dir]) => `- \`${alias}\` → \`${dir}\`${dir === cwd ? " — this session's cwd" : ""}`);
	return lines.length === 0 ? "" : SLACK_REPOS_GUIDANCE.replace("{{repos}}", lines.join("\n")).trim();
}

export class Bridge {
	readonly #config: BridgeConfig;
	readonly #slack: SlackTransport;
	readonly #registry: TaskRegistry;
	readonly #createRpc: (opts: OmpRpcOptions) => OmpRpc;
	readonly #listSessions: ListSessions;
	readonly #route: RouteMessage;
	readonly #listAgents: ListAgents;
	readonly #live = new Map<string, LiveTask>();
	readonly #startedAt = Date.now();
	#reaperTimer: ReturnType<typeof setInterval> | undefined;
	#catchupTimer: ReturnType<typeof setInterval> | undefined;
	/** Guards against overlapping catch-up sweeps (a replay can outlive the interval). */
	#catchupRunning = false;
	/** ts of every message already routed, live or replayed — the two paths must not both act. */
	readonly #seenMessages = new LruSet(SEEN_MESSAGE_CAP);
	#unsubscribeInbound: (() => void) | undefined;
	#shuttingDown = false;
	/** Cached bot↔user DM channel for top-level notify posts (resolved lazily). */
	#dmChannel: string | undefined;
	/** channel → (index → session) from that channel's last `sessions` listing, consumed by `resume <n>`. */
	#lastListing = new Map<string, Map<number, { path: string; cwd: string }>>();
	/** cwd → agent inventory, re-scanned at most every AGENTS_TTL_MS. */
	readonly #agentsCache = new Map<string, { agents: AgentOption[]; at: number }>();

	constructor(deps: BridgeDeps) {
		this.#config = deps.config;
		this.#slack = deps.slack;
		this.#registry = deps.registry;
		this.#createRpc = deps.createRpc;
		this.#listSessions = deps.listSessions ?? spawnSessionLister(deps.config.ompBin);
		this.#listAgents = deps.listAgents ?? ((cwd) => listAgentDefinitions(cwd, this.#home()));
		this.#route = deps.route ?? createRouter(deps.config);
	}

	start(): void {
		this.#unsubscribeInbound = this.#slack.onInbound((inbound) => {
			void this.#handleInbound(inbound).catch((err) => {
				console.error(`bridge: inbound handler error: ${String(err)}`);
			});
		});
		this.#reaperTimer = setInterval(() => void this.#reap(), REAPER_INTERVAL_MS);
		this.#catchupTimer = setInterval(() => void this.catchUp(), CATCHUP_INTERVAL_MS);
		void this.catchUp();
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		clearInterval(this.#reaperTimer);
		this.#reaperTimer = undefined;
		clearInterval(this.#catchupTimer);
		this.#catchupTimer = undefined;
		this.#unsubscribeInbound?.();
		await Promise.all([...this.#live.values()].map((task) => task.rpc.stop().catch(() => {})));
		await this.#registry.flush();
		await this.#slack.stop().catch(() => {});
	}

	// --- Control plane ------------------------------------------------------

	/** The ControlHost surface served over the control socket (see control.ts). */
	controlHost(): ControlHost {
		return {
			pid: process.pid,
			status: () => this.#controlStatus(),
			park: (sessionPath) => this.#controlPark(sessionPath),
			steer: (sessionPath, text) => this.#controlSteer(sessionPath, text),
			interrupt: (sessionPath) => this.#controlInterrupt(sessionPath),
			subagents: (sessionPath) => this.#controlSubagents(sessionPath),
			notify: (event) => this.#controlNotify(event),
		};
	}

	#findLiveBySessionPath(sessionPath: string): LiveTask | undefined {
		for (const task of this.#live.values()) {
			if (task.record.sessionPath === sessionPath) return task;
		}
		return undefined;
	}

	async #controlStatus(): Promise<ControlTaskInfo[]> {
		return Promise.all(
			[...this.#live.values()].map(async (task) => ({
				sessionPath: task.record.sessionPath,
				threadTs: task.record.threadTs,
				channel: task.record.channel,
				name: task.record.name,
				turnActive: task.turnActive,
				subagentsRunning: await task.rpc
					.getSubagents()
					.then(countActiveSubagents)
					.catch(() => 0),
			})),
		);
	}

	async #controlPark(sessionPath: string): Promise<{ parked: boolean; reason?: string }> {
		const task = this.#findLiveBySessionPath(sessionPath);
		if (!task) return { parked: false }; // Not live under the bridge — caller may resume freely.
		if (task.parking) return { parked: false, reason: "busy: park already in progress" };
		if (task.turnActive) return { parked: false, reason: "busy: turn active" };
		if (task.pendingUi.size > 0) return { parked: false, reason: "busy: pending UI request" };
		if (task.pendingTextUi) return { parked: false, reason: "busy: pending input" };
		if (task.pendingAsk) return { parked: false, reason: "busy: pending ask" };
		// Claim the task synchronously (before any await) so a concurrent steer/park
		// can't slip through the quiescence-check → stop() window (TOCTOU).
		task.parking = true;
		try {
			// Fail CLOSED: an unknown subagent count must NOT park a session that may
			// still have live subagents. Bound the probe so a hung RPC can't wedge park.
			const running = await withTimeout(task.rpc.getSubagents(), PARK_SUBAGENT_TIMEOUT_MS)
				.then(countActiveSubagents)
				.catch(() => undefined);
			if (running === undefined) return { parked: false, reason: "subagent state unknown" };
			if (running > 0) return { parked: false, reason: `busy: ${running} subagents running` };
			// Quiescent: stop the proc and dispose listeners now (registry entry +
			// Slack thread survive). Explicit dispose avoids the ~5s window where
			// #onExit would otherwise still be pending during stop()'s grace period.
			await task.rpc.stop().catch(() => {});
			this.#disposeTask(task);
			this.#live.delete(task.record.threadTs);
			await this.#slack
				.postMessage({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					text: "⏸ picked up in terminal — reply here to take back",
				})
				.catch(() => {});
			return { parked: true };
		} finally {
			task.parking = false;
		}
	}

	async #controlSteer(sessionPath: string, text: string): Promise<void> {
		const task = this.#findLiveBySessionPath(sessionPath);
		if (!task) throw new Error("session not live under the bridge");
		if (task.parking) throw new Error("session is being parked");
		await task.rpc.prompt(text);
		this.#registry.touch(task.record.threadTs);
	}

	async #controlInterrupt(sessionPath: string): Promise<void> {
		const task = this.#findLiveBySessionPath(sessionPath);
		if (!task) throw new Error("session not live under the bridge");
		await task.rpc.abort();
	}

	async #controlSubagents(sessionPath: string): Promise<ControlSubagentInfo[]> {
		const task = this.#findLiveBySessionPath(sessionPath);
		if (!task) throw new Error("session not live under the bridge");
		return task.rpc.getSubagents();
	}

	async #controlNotify(event: { sessionPath: string; cwd: string; kind: string; text: string }): Promise<void> {
		const existing = this.#registry.bySessionPath(event.sessionPath);
		if (existing) {
			await this.#slack.postMessage({ channel: existing.channel, threadTs: existing.threadTs, text: event.text });
			this.#registry.touch(existing.threadTs);
			return;
		}
		// No thread yet: open a new top-level DM message; its ts becomes the thread.
		const channel = await this.#dmChannelForNotify();
		const threadTs = await this.#slack.postMessage({ channel, text: event.text });
		this.#registry.upsert({
			threadTs,
			channel,
			sessionPath: event.sessionPath,
			cwd: event.cwd,
			name: headOf(event.text),
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		});
	}

	async #dmChannelForNotify(): Promise<string> {
		if (this.#dmChannel) return this.#dmChannel;
		const user = this.#config.allowedUsers[0];
		if (!user) throw new Error("notify: no allowed users configured");
		this.#dmChannel = await this.#slack.openDm(user);
		return this.#dmChannel;
	}

	// --- Inbound routing ----------------------------------------------------

	async #handleInbound(inbound: SlackInbound): Promise<void> {
		if (!this.#config.allowedUsers.includes(inbound.user)) return;
		if (inbound.kind === "action") {
			await this.#handleAction(inbound);
			return;
		}
		// The live socket and the catch-up sweep can both surface the same message
		// (a reply that has not landed in history yet still looks unanswered).
		if (this.#seenMessages.seen(inbound.ts)) return;
		if (inbound.threadTs) {
			await this.#handleThreadReply(inbound, inbound.threadTs);
			return;
		}
		await this.#handleTopLevel(inbound);
	}

	// --- Catch-up -----------------------------------------------------------

	/**
	 * Replay DMs Socket Mode never delivered.
	 *
	 * Socket Mode has no backlog. Anything sent while the bridge is down — or
	 * while its socket is a zombie the OS never closed, which is what a proxy
	 * that drops idle TLS leaves behind — is gone for good. So the bridge also
	 * *asks*: on startup and every {@link CATCHUP_INTERVAL_MS}, it reads recent
	 * DM history and routes anything it has not already answered.
	 *
	 * Unanswered means: no thread replies, no task record keyed on its ts, and
	 * not already routed this process. The per-channel watermark keeps the sweep
	 * monotonic across restarts; `catchupWindowMin` bounds how far a cold start
	 * (empty watermark) reaches back.
	 */
	async catchUp(): Promise<void> {
		if (this.#config.catchupWindowMin <= 0 || this.#catchupRunning || this.#shuttingDown) return;
		this.#catchupRunning = true;
		try {
			for (const user of this.#config.allowedUsers) {
				await this.#catchUpUser(user);
			}
		} catch (err) {
			console.error(`bridge: catch-up sweep failed: ${String(err)}`);
		} finally {
			this.#catchupRunning = false;
		}
	}

	async #catchUpUser(user: string): Promise<void> {
		const channel = await this.#slack.openDm(user);
		const floorTs = ((Date.now() - this.#config.catchupWindowMin * MINUTE_MS) / 1000).toFixed(6);
		const mark = this.#registry.catchupTs(channel);
		const oldestTs = mark && Number(mark) > Number(floorTs) ? mark : floorTs;

		const entries = await this.#slack.fetchHistory({ channel, oldestTs });
		if (entries.length === 0) return;

		let newestTs = oldestTs;
		const missed: SlackInboundMessage[] = [];
		// history arrives newest-first; replay in the order the user typed.
		for (const entry of entries.slice().reverse()) {
			const msg = entry.message;
			if (Number(msg.ts) > Number(newestTs)) newestTs = msg.ts;
			if (msg.user !== user) continue;
			if (msg.threadTs && msg.threadTs !== msg.ts) continue; // thread replies are not in history
			if (entry.replyCount > 0) continue; // the bridge already answered in-thread
			if (this.#registry.byThread(msg.ts)) continue; // already spawned a task on it
			missed.push(msg);
		}
		this.#registry.setCatchupTs(channel, newestTs);
		if (missed.length === 0) return;

		// Messages the socket should have delivered but didn't: it is lying about
		// being open. Rebuild it before replaying, or the next DM is lost too.
		if (this.#slack.connected) {
			console.error(`bridge: socket reported open but missed ${missed.length} DM(s) — forcing reconnect`);
			this.#slack.reconnect();
		}
		for (const msg of missed) {
			console.log(`bridge: replaying missed DM ${msg.ts}`);
			await this.#handleInbound(msg).catch((err) => {
				console.error(`bridge: replay of ${msg.ts} failed: ${String(err)}`);
			});
		}
	}

	/**
	 * Materialize a message's Slack attachments: local copies, a prompt note
	 * describing them, and decoded blocks for the ones the model can see directly.
	 *
	 * Slack files are not reachable by path from a repo checkout, so an attachment
	 * informs a run two ways. Every fetched file lands on disk and is named with
	 * its path, which is what makes a PDF or a log readable via `read`. An image
	 * additionally rides the prompt frame as an {@link ImageContent} block, so the
	 * model sees the screenshot in the same turn instead of having to guess that a
	 * path is worth opening. Both are emitted for an image on purpose: the block
	 * is what it looks at, the path is what `inspect_image` and re-reads need.
	 *
	 * Files that cannot be fetched (external hosts, oversized, missing scope) are
	 * still named — the agent must know something was attached and why it is not
	 * readable rather than silently answering without it.
	 */
	async #attachmentNote(msg: SlackInboundMessage): Promise<AttachmentPayload> {
		const files = msg.files ?? [];
		const links = msg.links ?? [];
		if (files.length === 0 && links.length === 0) return EMPTY_ATTACHMENTS;

		const dir = `${os.tmpdir()}/omp-slack-attachments/${msg.ts}`;
		const lines: string[] = [];
		const images: ImageContent[] = [];
		for (const file of files) {
			if (!file.downloadUrl) {
				lines.push(`- ${file.name} — hosted outside Slack, no local copy${file.permalink ? ` (${file.permalink})` : ""}`);
				continue;
			}
			if (file.size > ATTACHMENT_MAX_BYTES) {
				lines.push(`- ${file.name} — skipped, ${file.size} bytes exceeds the ${ATTACHMENT_MAX_BYTES} byte cap`);
				continue;
			}
			try {
				const bytes = await this.#slack.downloadFile(file.downloadUrl);
				const path = `${dir}/${safeFilename(file.name)}`;
				await Bun.write(path, bytes);
				lines.push(`- ${path} (${file.mimetype}, ${bytes.byteLength} bytes)`);
				const inline = inlineImageOf(file.mimetype, bytes);
				if (inline?.image) images.push(inline.image);
				else if (inline?.refusal) lines.push(`  (not shown inline: ${inline.refusal} — read the path above)`);
			} catch (err) {
				console.error(`bridge: attachment ${file.name} failed: ${String(err)}`);
				lines.push(`- ${file.name} — download failed: ${String(err)}`);
			}
		}
		for (const link of links) lines.push(`- ${link} — linked, not downloaded`);
		return { note: `\n\nAttached in Slack:\n${lines.join("\n")}`, images };
	}

	/**
	 * Thread every reply hangs under: the triggering message itself for a
	 * top-level DM — so the answer (and a task's whole thread) reads as a reply
	 * to what the user typed — or the existing root when the message is already
	 * a thread reply, since Slack has no nested threads.
	 */
	#replyThread(msg: SlackInboundMessage): string {
		return msg.threadTs ?? msg.ts;
	}

	async #handleTopLevel(msg: SlackInboundMessage): Promise<void> {
		const text = msg.text.trim();
		const [first, ...restTokens] = text.split(/\s+/);
		const command = (first ?? "").toLowerCase();
		const rest = text.slice((first ?? "").length).trim();

		// An explicit command is never routed: `run …` behaves byte-for-byte as it
		// always has, at zero added latency, no matter what the local model is doing.
		switch (command) {
			case "run":
				await this.#cmdRun(msg, rest);
				return;
			case "orchestrate":
				await this.#cmdOrchestrate(msg, rest);
				return;
			case "sessions":
				await this.#cmdSessions(msg, restTokens[0]);
				return;
			case "resume":
				await this.#cmdResume(msg, restTokens[0]);
				return;
			case "status":
				await this.#cmdStatus(msg);
				return;
			case "help":
				await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: HELP_TEXT });
				return;
		}

		const attachments = attachmentSummary(msg);

		// A bare attachment with no words: there is nothing to classify, and the
		// router rejects an empty message anyway. Dropping it here is what made a
		// pasted screenshot vanish into the help text, so it starts a task instead
		// — which also puts the user in a live thread, where every later reply is
		// an ordinary steer and carries its own attachments.
		if (text.length === 0 && attachments !== undefined) {
			// No DEFAULT_REPO means no repo to start in and no `run` line to imitate.
			// The files are still materialized and their paths handed back, so the
			// follow-up (`run omp look at /tmp/…/shot.png`) can name them — a reply
			// carries only its own attachments, so an unnamed file would be lost.
			if (!this.#config.defaultRepo) {
				const attached = await this.#attachmentNote(msg);
				await this.#slack.postMessage({
					channel: msg.channel,
					threadTs: this.#replyThread(msg),
					text: `Got ${escapeMrkdwn(attachments)} with no message — say what to do with it, e.g. \`run <alias|path> review this\`.${attached.note}`,
				});
				return;
			}
			await this.#cmdRun(msg, `${this.#config.defaultRepo} ${ATTACHMENT_ONLY_PROMPT}`);
			return;
		}

		// Free-form: let the router say what was meant. It fails open — disabled,
		// unreachable, slow or unparseable all resolve undefined, and a dead local
		// model must never swallow a Slack message.
		const location = this.#routerLocation();
		const decision = await this.#route(text, {
			repos: this.#config.repos,
			defaultRepo: this.#config.defaultRepo,
			agents: await this.#agents(location.cwd),
			...location,
			attachments,
		});
		if (decision) {
			await this.#dispatchDecision(msg, decision);
			return;
		}
		// An enabled router that answered nothing is a failure, not ambiguity: say so
		// above the help card, or the user reads their request as unintelligible.
		const fallback = this.#config.routerModel.trim().length > 0 ? `${ROUTER_FAILED_NOTE}\n${HELP_TEXT}` : HELP_TEXT;
		await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: fallback });
	}

	/**
	 * Execute one router decision by handing it to the very command method the
	 * literal parser would have called. Nothing here trusts the model: `#cmdRun`
	 * re-resolves `dir` and falls back to DEFAULT_REPO when it names neither an
	 * alias nor a path, and `#resolveAgent` drops an `agent` that is not one of
	 * the definitions on disk, so a hallucinated field degrades instead of escaping.
	 */
	async #dispatchDecision(msg: SlackInboundMessage, decision: RouterDecision): Promise<void> {
		// Breadcrumb first: the routing decision is visible before its effects, with
		// the worker's own account of it as a sub-line — the only explanation the
		// user ever gets for why their message went where it did.
		const picked = "agent" in decision ? decision.agent : undefined;
		await this.#slack
			.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				...routedBlocks({ command: decision.command, agent: picked, trace: decision.trace }),
			})
			.catch(() => {});

		switch (decision.command) {
			case "run":
				await this.#startTask(msg, [decision.dir, decision.prompt].filter(Boolean).join(" "), { agent: decision.agent });
				return;
			case "sessions":
				await this.#cmdSessions(msg, decision.alias);
				return;
			case "resume":
				await this.#cmdResume(msg, decision.target);
				return;
			case "status":
				await this.#cmdStatus(msg);
				return;
			case "help":
				await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: HELP_TEXT });
				return;
		}
	}

	/** Agent definitions visible from `cwd`, cached: one disk scan per cwd per TTL. */
	async #agents(cwd: string): Promise<AgentOption[]> {
		const cached = this.#agentsCache.get(cwd);
		if (cached && Date.now() - cached.at < AGENTS_TTL_MS) return cached.agents;
		try {
			const agents = await this.#listAgents(cwd);
			this.#agentsCache.set(cwd, { agents, at: Date.now() });
			return agents;
		} catch (err) {
			// Cache the failure too: an unreadable agent root must not cost a scan per
			// DM. An empty list simply drops `agent` from what the router is offered.
			console.error(`bridge: agent definitions unavailable: ${String(err)}`);
			this.#agentsCache.set(cwd, { agents: [], at: Date.now() });
			return [];
		}
	}

	/**
	 * A router-chosen agent token → the canonical name of an agent that exists,
	 * else undefined (omp's default worker). Matching is case-insensitive against
	 * the very list the router was offered, so an invented name is dropped rather
	 * than handed to `omp --agent`, where it would abort the spawn.
	 */
	async #resolveAgent(token: string | undefined, cwd: string): Promise<string | undefined> {
		const wanted = token?.trim();
		if (!wanted) return undefined;
		const match = (await this.#agents(cwd)).find((agent) => agent.name.toLowerCase() === wanted.toLowerCase());
		if (match) return match.name;
		console.error(`bridge: unknown agent ${wanted} — using the default worker`);
		return undefined;
	}

	/**
	 * Where a routing run lives: the cwd it runs in and the session dir it
	 * persists into — `<repo's omp session dir>/router`. Same tree as the agent
	 * sessions the routing starts (so cc-callbacks audits both from one place and
	 * `project_root` is the repo), one level down so `omp sessions --dir <repo>`,
	 * and therefore Slack's `sessions` listing, never shows routing transcripts
	 * beside resumable work.
	 *
	 * The repo is only known *after* routing, so the target is the best guess
	 * available: DEFAULT_REPO, else home.
	 */
	#routerLocation(): { cwd: string; sessionDir: string } {
		const home = this.#home();
		const target = (this.#config.defaultRepo ? this.#resolveDir(this.#config.defaultRepo) : undefined) ?? home;
		return { cwd: target, sessionDir: `${ompSessionDir(home, target)}/router` };
	}

	async #cmdRun(msg: SlackInboundMessage, rest: string): Promise<void> {
		await this.#startTask(msg, rest, {});
	}

	/**
	 * `run` on the orchestrator agent. Both deltas are applied in `#startTask`:
	 * the child runs as omp's `orchestrate` agent (which pins its own model and
	 * thinking level), and the prompt is prefixed so the `orchestrator-identity`
	 * skill triggers.
	 */
	async #cmdOrchestrate(msg: SlackInboundMessage, rest: string): Promise<void> {
		await this.#startTask(msg, rest, { agent: "orchestrate" });
	}

	async #startTask(msg: SlackInboundMessage, rest: string, opts: { agent?: string }): Promise<void> {
		// Orchestration is keyed off what was *asked for*, not what resolved: a
		// missing `orchestrate.md` must still produce an orchestration prompt.
		const orchestrating = (opts.agent ?? "").trim().toLowerCase() === "orchestrate";
		const verb = orchestrating ? "orchestrate" : "run";
		const sp = rest.indexOf(" ");
		let dirToken = (sp === -1 ? rest : rest.slice(0, sp)).trim();
		let prompt = (sp === -1 ? "" : rest.slice(sp + 1)).trim();

		// `run <prompt…>` without a repo token falls back to DEFAULT_REPO: when the
		// first word resolves to neither an alias nor a path, treat all of `rest`
		// as the prompt.
		let cwd = dirToken ? this.#resolveDir(dirToken) : undefined;
		if (!cwd && this.#config.defaultRepo) {
			const fallback = this.#resolveDir(this.#config.defaultRepo);
			if (fallback) {
				cwd = fallback;
				prompt = rest.trim();
				dirToken = this.#config.defaultRepo;
			}
		}
		if (!prompt) {
			await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: `Usage: \`${verb} <alias|path> <prompt…>\`` });
			return;
		}
		if (!cwd) {
			await this.#slack.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				text: `Unknown repo \`${dirToken}\`. Use a REPOS alias or an absolute path under \`${this.#home()}\`, or set DEFAULT_REPO.`,
			});
			return;
		}

		if (this.#live.size >= this.#config.maxTasks) {
			const names = [...this.#live.values()].map((t) => `• ${t.record.name}`).join("\n");
			await this.#slack.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				text: `At capacity (${this.#config.maxTasks} live tasks). Finish or \`kill\` one first:\n${names}`,
			});
			return;
		}

		const name = `${this.#config.sessionNamePrefix}${headOf(prompt)}`;
		// The task thread IS the user's message: the header is its first reply, so
		// everything about the task reads as an answer to what they asked for.
		const threadTs = this.#replyThread(msg);
		const headerTs = await this.#slack.postMessage({
			channel: msg.channel,
			threadTs,
			text: name,
			blocks: taskHeaderBlocks({ name, cwd }),
		});
		const record: TaskRecord = {
			threadTs,
			channel: msg.channel,
			cwd,
			name,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		};
		this.#registry.upsert(record);
		// Only an agent the router was actually offered reaches argv; anything else
		// degrades to omp's default worker rather than aborting the spawn.
		const agent = await this.#resolveAgent(opts.agent, cwd);
		// The skill keys on the word "orchestrate", so the prompt must carry it —
		// including when no `orchestrate` definition exists and the default worker
		// takes the task, since the skill is what supplies the identity.
		const message = orchestrating ? `orchestrate: ${prompt}` : prompt;
		const attached = await this.#attachmentNote(msg);
		await this.#spawn({
			record,
			isNew: true,
			prompt: message + attached.note,
			images: attached.images,
			sessionName: name,
			agent,
			headerTs,
		});
	}

	async #cmdSessions(msg: SlackInboundMessage, alias: string | undefined): Promise<void> {
		const targets = this.#sessionTargets(alias);
		if (targets.length === 0) {
			await this.#slack.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				text: alias
					? `Unknown repo \`${alias}\`. Use a REPOS alias or an absolute path under \`${this.#home()}\`.`
					: "No repos configured — set `REPOS` in `.env`.",
			});
			return;
		}

		const listed = await Promise.all(
			targets.map(async (target) => {
				try {
					return { ...target, sessions: await this.#listSessions(target.path) };
				} catch (err) {
					return { ...target, error: String(err) };
				}
			}),
		);

		const listing = new Map<number, { path: string; cwd: string }>();
		const lines: string[] = [];
		for (const repo of listed) {
			lines.push(`*${repo.alias}* · \`${repo.path}\``);
			if ("error" in repo) {
				lines.push(`  _listing failed: ${repo.error}_`);
				continue;
			}
			// `omp sessions --json` already sorts newest-first.
			const newest = repo.sessions.slice(0, SESSIONS_PER_REPO);
			if (newest.length === 0) lines.push("  _no sessions_");
			for (const session of newest) {
				const index = listing.size + 1;
				listing.set(index, { path: session.path, cwd: repo.path });
				lines.push(`${index}. ${this.#sessionBadges(session.path)}${sessionLine(session)}`);
			}
		}
		this.#lastListing.set(msg.channel, listing);
		await this.#slack.postMessage({
			channel: msg.channel,
			threadTs: this.#replyThread(msg),
			text: `${lines.join("\n")}\n_\`resume <n>\` to attach one._`,
		});
	}

	/** Repo alias→path pairs to list: the named one, or every configured repo. */
	#sessionTargets(alias: string | undefined): Array<{ alias: string; path: string }> {
		if (alias) {
			const path = this.#resolveDir(alias);
			return path ? [{ alias, path }] : [];
		}
		return Object.entries(this.#config.repos).map(([name, path]) => ({ alias: name, path }));
	}

	/**
	 * Liveness/attachment badges for a store session.
	 * ponytail: tmux liveness unknown from bridge; badge only slack-owned.
	 */
	#sessionBadges(sessionPath: string): string {
		const marks: string[] = [];
		if (this.#findLiveBySessionPath(sessionPath)) marks.push("⚡ live·slack");
		if (this.#registry.bySessionPath(sessionPath)) marks.push("🔗");
		return marks.length > 0 ? `${marks.join(" ")} ` : "";
	}

	async #cmdResume(msg: SlackInboundMessage, token: string | undefined): Promise<void> {
		if (!token) {
			await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: "Usage: `resume <n|sessionPath>`" });
			return;
		}

		let sessionPath = token;
		let listedCwd: string | undefined;
		if (/^\d+$/.test(token)) {
			const picked = this.#lastListing.get(msg.channel)?.get(Number.parseInt(token, 10));
			if (!picked) {
				await this.#slack.postMessage({
					channel: msg.channel,
					threadTs: this.#replyThread(msg),
					text: `No session #${token} in the last listing — run \`sessions\` first.`,
				});
				return;
			}
			sessionPath = picked.path;
			listedCwd = picked.cwd;
		}

		// A second RPC child would double-attach: bridge-owned children set
		// OMP_SLACK_BRIDGE=1, so omp's resume park hook self-skips for them.
		// ponytail: terminal-owned liveness isn't visible from here — the
		// cross-owner guard lands with the hub-side lock if it ever bites.
		const live = this.#findLiveBySessionPath(sessionPath);
		if (live) {
			await this.#slack.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				text: `Already live under the bridge — steer it in its thread (*${live.record.name}*).`,
			});
			return;
		}
		// Dedup both `resume <n>` and `resume <sessionPath>`: an existing registry
		// record (live or idle) means a thread already owns this session — never
		// spawn a second thread for it.
		const attached = this.#registry.bySessionPath(sessionPath);
		if (attached) {
			await this.#slack.postMessage({
				channel: msg.channel,
				threadTs: this.#replyThread(msg),
				text: `Already attached — continue in its thread: *${attached.name}* (thread \`${attached.threadTs}\`).`,
			});
			return;
		}

		const name = `${this.#config.sessionNamePrefix}${basename(sessionPath)}`;
		const cwd = listedCwd ?? this.#home();
		// Same as `run`: the resumed task's thread hangs under the user's message.
		const threadTs = this.#replyThread(msg);
		const headerTs = await this.#slack.postMessage({
			channel: msg.channel,
			threadTs,
			text: name,
			blocks: taskHeaderBlocks({ name, cwd, sessionPath, sessionId: sessionIdOf(sessionPath) }),
		});
		const record: TaskRecord = {
			threadTs,
			channel: msg.channel,
			cwd,
			name,
			sessionPath,
			createdAt: Date.now(),
			lastActivityAt: Date.now(),
		};
		this.#registry.upsert(record);
		await this.#spawn({ record, isNew: false, resumeSessionPath: sessionPath, headerTs });
	}

	async #cmdStatus(msg: SlackInboundMessage): Promise<void> {
		const uptimeMin = Math.floor((Date.now() - this.#startedAt) / MINUTE_MS);
		await this.#slack.postMessage({
			channel: msg.channel,
			threadTs: this.#replyThread(msg),
			text: `*bridge* · ${this.#live.size} live · ${this.#registry.all().length} registered · up ${uptimeMin}m`,
		});
	}

	async #handleThreadReply(msg: SlackInboundMessage, threadTs: string): Promise<void> {
		let task = this.#live.get(threadTs);
		if (!task) {
			const record = this.#registry.byThread(threadTs);
			// Not a task thread — e.g. a reply under a `sessions` listing or a help
			// message. Treat it as a fresh top-level command so the reply is answered
			// instead of silently swallowed.
			if (!record?.sessionPath) {
				await this.#handleTopLevel(msg);
				return;
			}
			await this.#spawn({ record, isNew: false, resumeSessionPath: record.sessionPath });
			task = this.#live.get(threadTs);
			if (!task) return;
		}

		const text = msg.text.trim();

		if (task.pendingTextUi) {
			const pending = task.pendingTextUi;
			task.pendingTextUi = undefined;
			task.rpc.respondUi({ type: "extension_ui_response", id: pending.req.id, value: text });
			await this.#slack
				.updateMessage({
					channel: task.record.channel,
					ts: pending.messageTs,
					text: `✅ answered`,
					blocks: answeredBlocks({ title: uiTitle(pending.req), answer: text, user: msg.user }),
				})
				.catch(() => {});
			this.#registry.touch(threadTs);
			return;
		}

		const command = text.toLowerCase();
		if (task.pendingAsk && command !== "abort" && command !== "kill" && command !== "status") {
			// A typed reply means "here is my actual answer" — cancel the structured
			// ask and submit the freeform text as the tool result, rather than filling
			// one question at a time and leaving the turn blocked on the rest. Option
			// buttons remain the per-question path (#handleAskAction).
			await this.#answerAskFreeform(task, text, msg.user);
			return;
		}
		if (command === "abort") {
			await task.rpc.abort().catch((err) => this.#note(task!, `abort failed: ${String(err)}`));
			return;
		}
		if (command === "kill") {
			await task.rpc.stop().catch(() => {});
			await this.#clearPendingAsk(task, "⌛ cancelled");
			await this.#updateStatusMessage(task, "killed");
			return;
		}
		if (command === "status") {
			await this.#postState(task);
			return;
		}
		if (task.parking) {
			await this.#note(task, "parking in progress — reply again once it settles");
			return;
		}
		const attached = await this.#attachmentNote(msg);
		await task.rpc
			.prompt(text + attached.note, attached.images)
			.catch((err) => this.#note(task!, `prompt failed: ${String(err)}`));
		this.#registry.touch(threadTs);
	}

	async #postState(task: LiveTask): Promise<void> {
		try {
			const state = await task.rpc.getState();
			const model = state.model ? `${state.model.provider}/${state.model.id}` : "—";
			const pct = state.contextUsage ? `${state.contextUsage.percent}%` : "—";
			await this.#slack.postMessage({
				channel: task.record.channel,
				threadTs: task.record.threadTs,
				text: `*state* · ${model} · streaming ${state.isStreaming ? "yes" : "no"} · context ${pct} · \`${state.sessionFile ?? "?"}\``,
			});
		} catch (err) {
			await this.#note(task, `get_state failed: ${String(err)}`);
		}
	}

	async #handleAction(action: SlackBlockAction): Promise<void> {
		if (action.actionId.startsWith("ask:")) {
			await this.#handleAskAction(action);
			return;
		}
		const parsed = parseActionId(action.actionId);
		if (!parsed) return;
		const found = this.#findPendingUi(parsed.reqId);
		if (!found) {
			await this.#slack
				.updateMessage({ channel: action.channel, ts: action.messageTs, text: "⌛ this request has expired", blocks: [] })
				.catch(() => {});
			return;
		}
		const { task, pending } = found;
		const req = pending.req;

		let answerLabel: string;
		if (req.method === "confirm") {
			const confirmed = parsed.suffix === "yes";
			task.rpc.respondUi({ type: "extension_ui_response", id: req.id, confirmed });
			answerLabel = confirmed ? "Yes" : "No";
		} else if (req.method === "select") {
			answerLabel = action.value;
			task.rpc.respondUi({ type: "extension_ui_response", id: req.id, value: action.value });
		} else {
			return; // input/editor are answered by thread reply, not actions.
		}

		task.pendingUi.delete(req.id);
		await this.#slack
			.updateMessage({
				channel: action.channel,
				ts: pending.messageTs,
				text: `✅ answered`,
				blocks: answeredBlocks({ title: uiTitle(req), answer: answerLabel, user: action.user }),
			})
			.catch(() => {});
		this.#registry.touch(task.record.threadTs);
	}

	#findPendingUi(reqId: string): { task: LiveTask; pending: PendingUi } | undefined {
		for (const task of this.#live.values()) {
			const pending = task.pendingUi.get(reqId);
			if (pending) return { task, pending };
			if (task.pendingTextUi?.req.id === reqId) return { task, pending: task.pendingTextUi };
		}
		return undefined;
	}

	async #handleAskAction(action: SlackBlockAction): Promise<void> {
		const parsed = parseAskActionId(action.actionId);
		const task = parsed ? this.#findPendingAsk(parsed.callId) : undefined;
		if (!parsed || !task) {
			await this.#slack
				.updateMessage({ channel: action.channel, ts: action.messageTs, text: "⌛ expired", blocks: [] })
				.catch(() => {});
			return;
		}
		// answer = button value or selected option value (both surface as action.value).
		await this.#answerAskQuestion(task, parsed.questionIndex, action.value, action.user);
	}

	#findPendingAsk(callId: string): LiveTask | undefined {
		for (const task of this.#live.values()) {
			if (task.pendingAsk?.callId === callId) return task;
		}
		return undefined;
	}

	// --- Task lifecycle -----------------------------------------------------

	async #spawn(args: {
		record: TaskRecord;
		isNew: boolean;
		prompt?: string;
		/** Image blocks delivered with `prompt` (Slack screenshots); ignored without one. */
		images?: ImageContent[];
		resumeSessionPath?: string;
		sessionName?: string;
		/** Run the child as this omp agent (`omp --agent <name>`); the default worker when absent. */
		agent?: string;
		/** Task header message to edit once the session identity is known. */
		headerTs?: string;
	}): Promise<void> {
		const { record, isNew } = args;
		// Reply guidance plus the repo inventory, in one flag: --append-system-prompt
		// is last-wins, not repeatable.
		const guidance = [SLACK_REPLY_GUIDANCE.trim(), repoInventory(this.#config.repos, record.cwd)].filter(Boolean).join("\n\n");
		const rpc = this.#createRpc({
			ompBin: this.#config.ompBin,
			cwd: record.cwd,
			resumeSessionPath: args.resumeSessionPath,
			// OMP_SLACK_BRIDGE marks bridge-owned children: the slack-notify
			// extension and omp's resume park hook skip themselves under it.
			env: isNew ? { OMP_SLACK_BRIDGE: "1", OMP_HUB_NEW_SESSION: "1" } : { OMP_SLACK_BRIDGE: "1" },
			// Every bridge-owned turn — new session or resumed — is answered into
			// Slack, so the reply guidance rides the system prompt rather than the
			// first user message: it applies to later steers too, and never lands in
			// the transcript as something the user appears to have said.
			extraArgs: [
				...(args.agent ? ["--agent", args.agent] : []),
				"--append-system-prompt",
				guidance,
			],
		});

		const task: LiveTask = {
			rpc,
			record,
			statusLines: [],
			turnActive: false,
			pendingUi: new Map(),
			statusByKey: new Map(),
			lastStatusUpdate: 0,
			disposers: [],
		};
		this.#live.set(record.threadTs, task);
		this.#wireTask(task);

		try {
			await rpc.start();
		} catch (err) {
			this.#disposeTask(task);
			this.#live.delete(record.threadTs);
			await this.#slack.postMessage({
				channel: record.channel,
				threadTs: record.threadTs,
				text: `❌ failed to start agent: ${String(err)}`,
			});
			return;
		}

		if (isNew && args.sessionName) {
			await rpc.setSessionName(args.sessionName).catch(() => {});
		}
		let model: string | undefined;
		try {
			const state = await rpc.getState();
			if (state.sessionFile) record.sessionPath = state.sessionFile;
			if (state.sessionName) record.name = state.sessionName;
			if (state.model) model = `${state.model.provider}/${state.model.id}`;
		} catch {
			// Non-fatal: sessionPath fills in on a later get_state.
		}
		record.lastActivityAt = Date.now();
		this.#registry.upsert(record);

		// The session file is minted by the child, so the header was posted before
		// its id existed: edit the identity in now that the handshake is done. A
		// failed edit costs a header line, never the task.
		if (args.headerTs) {
			await this.#slack
				.updateMessage({
					channel: record.channel,
					ts: args.headerTs,
					text: record.name,
					blocks: taskHeaderBlocks({
						name: record.name,
						cwd: record.cwd,
						sessionPath: record.sessionPath,
						sessionId: sessionIdOf(record.sessionPath),
						model,
					}),
				})
				.catch((err) => console.error(`bridge: header update failed: ${String(err)}`));
		}

		await rpc
			.setHostTools([ASK_HOST_TOOL, ATTACH_HOST_TOOL])
			.catch((err) => console.error(`bridge: set_host_tools failed: ${String(err)}`));

		if (isNew && args.prompt) {
			await rpc.prompt(args.prompt, args.images).catch((err) => this.#note(task, `prompt failed: ${String(err)}`));
		}
	}

	#wireTask(task: LiveTask): void {
		task.disposers.push(
			task.rpc.onEvent((event) => void this.#onEvent(task, event)),
			task.rpc.onUiRequest((req) => void this.#onUiRequest(task, req)),
			task.rpc.onHostToolCall((call) => void this.#onHostToolCall(task, call)),
			task.rpc.onHostToolCancel((cancel) => void this.#onHostToolCancel(task, cancel)),
			task.rpc.onExit((code) => void this.#onExit(task, code)),
		);
	}

	async #onEvent(task: LiveTask, event: OmpAgentEvent): Promise<void> {
		if (event.type === "agent_start" || event.type === "turn_start") {
			task.turnActive = true;
			task.statusLines = [];
			task.thinking = undefined;
			task.lastStatusText = undefined;
			await this.#ensureStatusMessage(task);
			return;
		}
		if (event.type === "message_update") {
			this.#onAssistantDelta(task, event.assistantMessageEvent);
			return;
		}
		if (event.type === "tool_execution_start") {
			const label = toolLabel(event.toolName, event.args);
			if (task.statusLines[task.statusLines.length - 1] !== label) task.statusLines.push(label);
			this.#throttledStatusUpdate(task);
			return;
		}
		if (event.type === "agent_end") {
			task.turnActive = false;
			task.thinking = undefined;
			this.#clearStatusTimer(task);
			await this.#finishTurn(task);
			this.#registry.touch(task.record.threadTs);
		}
	}

	/**
	 * Give each thinking block its own status line, rewritten in place as the
	 * block streams — so a turn that reasons for a minute before its first tool
	 * call still shows movement. Any other delta (text, tool call) closes the
	 * open block, so the next one claims a fresh line instead of appending.
	 * Slack traffic is unchanged: updates go through the same 2s throttle.
	 */
	#onAssistantDelta(task: LiveTask, delta: OmpAssistantMessageEvent | undefined): void {
		if (!delta) return;
		if (delta.type !== "thinking_delta" && delta.type !== "thinking_end") {
			task.thinking = undefined;
			return;
		}
		const block = delta.contentIndex ?? 0;
		if (task.thinking?.block !== block) task.thinking = { block, text: "" };
		const open = task.thinking;
		open.text = delta.type === "thinking_end" ? (delta.content ?? open.text) : open.text + (delta.delta ?? "");
		const line = thinkingLine(open.text);
		if (line) {
			if (open.line === undefined) {
				open.line = task.statusLines.length;
				task.statusLines.push(line);
			} else {
				task.statusLines[open.line] = line;
			}
			this.#throttledStatusUpdate(task);
		}
		if (delta.type === "thinking_end") task.thinking = undefined;
	}

	#ensureStatusMessage(task: LiveTask): Promise<void> {
		if (task.statusTs) return Promise.resolve();
		// Coalesce concurrent callers (agent_start + turn_start fire together):
		// only the first posts; the rest await the same in-flight promise.
		task.statusPost ??= (async () => {
			try {
				task.statusTs = await this.#slack.postMessage({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					text: statusText({ phase: "starting", lines: [] }),
				});
			} catch (err) {
				console.error(`bridge: failed to post status message: ${String(err)}`);
			} finally {
				task.statusPost = undefined;
			}
		})();
		return task.statusPost;
	}

	#throttledStatusUpdate(task: LiveTask): void {
		const now = Date.now();
		const elapsed = now - task.lastStatusUpdate;
		if (elapsed >= STATUS_THROTTLE_MS) {
			void this.#updateStatusMessage(task, "working");
			return;
		}
		// Guarantee a trailing update lands after the throttle window.
		if (task.statusUpdateTimer === undefined) {
			task.statusUpdateTimer = setTimeout(() => {
				task.statusUpdateTimer = undefined;
				void this.#updateStatusMessage(task, "working");
			}, STATUS_THROTTLE_MS - elapsed);
		}
	}

	async #updateStatusMessage(task: LiveTask, phase: "starting" | "working" | "done" | "error" | "killed"): Promise<void> {
		if (!task.statusTs) return;
		const text = statusText({ phase, lines: task.statusLines });
		if (text === task.lastStatusText) return; // Nothing moved since the last flush.
		task.lastStatusText = text;
		task.lastStatusUpdate = Date.now();
		await this.#slack
			.updateMessage({ channel: task.record.channel, ts: task.statusTs, text })
			.catch(() => {});
	}

	async #finishTurn(task: LiveTask): Promise<void> {
		let finalText: string | null = null;
		try {
			finalText = await task.rpc.getLastAssistantText();
		} catch {
			finalText = null;
		}
		const body = finalText ?? "_(no output)_";

		if (!task.statusTs) {
			// No status message was posted; send the result as a fresh message.
			await this.#slack
				.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: body, blocks: finalTextBlocks(body) })
				.catch(() => {});
			return;
		}

		if (body.length <= FINAL_INLINE_MAX) {
			await this.#slack
				.updateMessage({ channel: task.record.channel, ts: task.statusTs, text: body, blocks: finalTextBlocks(body) })
				.catch(() => {});
		} else {
			await this.#updateStatusMessage(task, "done");
			await this.#slack
				.uploadText({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					filename: "response.md",
					content: body,
				})
				.catch((err) => console.error(`bridge: uploadText failed: ${String(err)}`));
		}
		task.statusTs = undefined; // Next turn posts a fresh status message.
		task.lastStatusText = undefined;
	}

	async #onUiRequest(task: LiveTask, req: OmpUiRequest): Promise<void> {
		try {
			if (req.method === "select" || req.method === "confirm") {
				const ts = await this.#slack.postMessage({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					text: uiTitle(req),
					blocks: uiRequestBlocks(req),
				});
				task.pendingUi.set(req.id, { req, messageTs: ts });
			} else if (req.method === "input" || req.method === "editor") {
				const ts = await this.#slack.postMessage({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					text: uiTitle(req),
					blocks: uiRequestBlocks(req),
				});
				task.pendingTextUi = { req, messageTs: ts };
			} else if (req.method === "notify") {
				await this.#slack.postMessage({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					text: notifyText(req.level, req.message),
				});
			} else if (req.method === "setStatus") {
				if (req.text === undefined) return;
				if (task.statusByKey.get(req.statusKey) === req.text) return;
				task.statusByKey.set(req.statusKey, req.text);
				await this.#slack.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: `ℹ️ ${req.text}` });
			} else if (req.method === "open_url") {
				await this.#slack.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: req.url });
			} else if (req.method === "cancel") {
				await this.#cancelUi(task, req.targetId);
			}
		} catch (err) {
			console.error(`bridge: ui request (${req.method}) handling error: ${String(err)}`);
		}
	}

	async #cancelUi(task: LiveTask, targetId: string): Promise<void> {
		const pending = task.pendingUi.get(targetId) ?? (task.pendingTextUi?.req.id === targetId ? task.pendingTextUi : undefined);
		if (!pending) return;
		task.pendingUi.delete(targetId);
		if (task.pendingTextUi?.req.id === targetId) task.pendingTextUi = undefined;
		await this.#slack.updateMessage({ channel: task.record.channel, ts: pending.messageTs, text: "⌛ cancelled", blocks: [] }).catch(() => {});
	}

	/**
	 * Upload the named files into the task's Slack thread.
	 *
	 * Every path is reported on individually and a bad one never fails the batch:
	 * the tool result is the only thing the agent learns from, so "3 attached, 1
	 * missing" has to survive as a sentence it can act on. A refusal is an
	 * ordinary result rather than isError — the turn is fine, one file was not.
	 */
	async #onAttachFile(task: LiveTask, call: OmpHostToolCall): Promise<void> {
		const paths = parseAttachPaths(call.arguments);
		if (!paths) {
			task.rpc.respondHostTool({
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "invalid attach_file arguments: expected paths: string[]" }] },
				isError: true,
			});
			return;
		}

		const files: Array<{ filename: string; bytes: Uint8Array }> = [];
		const notes: string[] = [];
		for (const rawPath of paths.slice(0, ATTACH_MAX_FILES)) {
			// Resolved against the task's cwd so a relative path still works, even
			// though the tool asks for absolute ones.
			const abs = path.resolve(task.record.cwd, rawPath);
			try {
				const file = Bun.file(abs);
				const size = file.size;
				if (size > ATTACH_MAX_BYTES) {
					notes.push(`${abs}: ${size} bytes exceeds the ${ATTACH_MAX_BYTES} byte upload cap`);
					continue;
				}
				files.push({ filename: basename(abs), bytes: new Uint8Array(await file.arrayBuffer()) });
			} catch (err) {
				notes.push(`${abs}: ${String(err)}`);
			}
		}
		if (paths.length > ATTACH_MAX_FILES) {
			notes.push(`only the first ${ATTACH_MAX_FILES} of ${paths.length} paths were uploaded`);
		}

		if (files.length > 0) {
			const comment = nonEmptyString(call.arguments.comment);
			try {
				await this.#slack.uploadFiles({
					channel: task.record.channel,
					threadTs: task.record.threadTs,
					files,
					comment,
				});
				this.#registry.touch(task.record.threadTs);
			} catch (err) {
				notes.push(`upload failed: ${String(err)}`);
				files.length = 0;
			}
		}

		const attached = files.length > 0 ? `Attached to the Slack thread: ${files.map((f) => f.filename).join(", ")}.` : "Nothing was attached.";
		const text = notes.length > 0 ? `${attached}\n${notes.join("\n")}` : attached;
		task.rpc.respondHostTool({
			type: "host_tool_result",
			id: call.id,
			result: { content: [{ type: "text", text }] },
			isError: files.length === 0,
		});
	}

	// --- Host tools ---------------------------------------------------------

	async #onHostToolCall(task: LiveTask, call: OmpHostToolCall): Promise<void> {
		if (call.toolName === "attach_file") {
			await this.#onAttachFile(task, call);
			return;
		}
		if (call.toolName !== "ask") {
			task.rpc.respondHostTool({
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "unknown host tool" }] },
				isError: true,
			});
			return;
		}
		const questions = parseAskQuestions(call.arguments);
		if (!questions) {
			task.rpc.respondHostTool({
				type: "host_tool_result",
				id: call.id,
				result: { content: [{ type: "text", text: "invalid ask arguments" }] },
				isError: true,
			});
			return;
		}

		// Supersede an already-pending ask on this task.
		if (task.pendingAsk) await this.#supersedePendingAsk(task);

		const messageTs: string[] = [];
		for (let i = 0; i < questions.length; i++) {
			const q = questions[i]!;
			const ts = await this.#slack.postMessage({
				channel: task.record.channel,
				threadTs: task.record.threadTs,
				text: q.question,
				blocks: askQuestionBlocks({
					callId: call.id,
					questionIndex: i,
					question: q.question,
					header: q.header,
					options: q.options,
					multi: q.multi,
					recommended: q.recommended,
				}),
			});
			messageTs.push(ts);
		}
		task.pendingAsk = { callId: call.id, questions, answers: new Array(questions.length).fill(undefined), messageTs };
		this.#registry.touch(task.record.threadTs);
	}

	async #onHostToolCancel(task: LiveTask, cancel: OmpHostToolCancel): Promise<void> {
		if (task.pendingAsk?.callId !== cancel.targetId) return;
		await this.#clearPendingAsk(task, "⌛ cancelled");
	}

	/** Record an answer, edit the message; complete the call when all answered. */
	async #answerAskQuestion(task: LiveTask, questionIndex: number, answer: string, user: string): Promise<void> {
		const pending = task.pendingAsk;
		if (!pending) return;
		if (questionIndex < 0 || questionIndex >= pending.questions.length) return;
		if (pending.answers[questionIndex] !== undefined) return; // Already answered.
		pending.answers[questionIndex] = answer;
		await this.#slack
			.updateMessage({
				channel: task.record.channel,
				ts: pending.messageTs[questionIndex]!,
				text: `✅ ${answer}`,
				blocks: askAnsweredBlocks({ question: pending.questions[questionIndex]!.question, answer, user }),
			})
			.catch(() => {});
		this.#registry.touch(task.record.threadTs);

		if (pending.answers.every((a) => a !== undefined)) {
			task.rpc.respondHostTool({
				type: "host_tool_result",
				id: pending.callId,
				result: { content: [{ type: "text", text: formatAskResult(pending) }] },
			});
			task.pendingAsk = undefined;
			this.#registry.touch(task.record.threadTs);
		}
	}

	/**
	 * A typed thread reply resolves a pending ask with freeform text: submit the
	 * reply as the tool result and drop the ask. Any options already clicked are
	 * folded into the result so they are not lost; the still-open question messages
	 * are collapsed to a plain answered marker (the user's reply is already visible
	 * in the thread right below them).
	 */
	async #answerAskFreeform(task: LiveTask, text: string, user: string): Promise<void> {
		const pending = task.pendingAsk;
		if (!pending) return;
		task.pendingAsk = undefined;
		task.rpc.respondHostTool({
			type: "host_tool_result",
			id: pending.callId,
			result: { content: [{ type: "text", text: formatAskFreeform(pending, text) }] },
		});
		for (let i = 0; i < pending.messageTs.length; i++) {
			if (pending.answers[i] !== undefined) continue;
			await this.#slack
				.updateMessage({
					channel: task.record.channel,
					ts: pending.messageTs[i]!,
					text: "✅ answered in thread",
					blocks: askAnsweredBlocks({ question: pending.questions[i]!.question, answer: text, user }),
				})
				.catch(() => {});
		}
		this.#registry.touch(task.record.threadTs);
	}

	/** Edit unanswered ask messages to `label` and drop pendingAsk. */
	async #clearPendingAsk(task: LiveTask, label: string): Promise<void> {
		const pending = task.pendingAsk;
		if (!pending) return;
		task.pendingAsk = undefined;
		for (let i = 0; i < pending.messageTs.length; i++) {
			if (pending.answers[i] !== undefined) continue;
			await this.#slack.updateMessage({ channel: task.record.channel, ts: pending.messageTs[i]!, text: label, blocks: [] }).catch(() => {});
		}
	}

	/** Supersede an outstanding ask (agent issued a new one before answers landed). */
	async #supersedePendingAsk(task: LiveTask): Promise<void> {
		await this.#clearPendingAsk(task, "⌛ superseded");
	}

	async #onExit(task: LiveTask, code: number | null): Promise<void> {
		this.#clearStatusTimer(task);
		await this.#clearPendingAsk(task, "⌛ cancelled");
		if (task.turnActive) {
			await this.#slack
				.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: `💀 agent process exited (code ${code ?? "?"})` })
				.catch(() => {});
		}
		this.#disposeTask(task);
		this.#live.delete(task.record.threadTs); // Record kept — resumable.
	}

	async #note(task: LiveTask, text: string): Promise<void> {
		await this.#slack
			.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: `⚠️ ${text}` })
			.catch(() => {});
	}

	#clearStatusTimer(task: LiveTask): void {
		clearTimeout(task.statusUpdateTimer);
		task.statusUpdateTimer = undefined;
	}

	#disposeTask(task: LiveTask): void {
		this.#clearStatusTimer(task);
		for (const dispose of task.disposers) dispose();
		task.disposers = [];
	}

	async #reap(): Promise<void> {
		const now = Date.now();
		const ttlMs = this.#config.idleTtlMin * MINUTE_MS;
		for (const task of [...this.#live.values()]) {
			if (task.turnActive || task.pendingUi.size > 0 || task.pendingTextUi || task.pendingAsk) continue;
			if (now - task.record.lastActivityAt <= ttlMs) continue;
			await task.rpc.stop().catch(() => {});
			await this.#slack
				.postMessage({ channel: task.record.channel, threadTs: task.record.threadTs, text: "⏸ idle — parked (reply to resume)" })
				.catch(() => {});
			this.#disposeTask(task);
			this.#live.delete(task.record.threadTs);
		}
	}

	// --- helpers ------------------------------------------------------------

	#home(): string {
		// stateDir is `<home>/.omp/slack-bridge`; recover home from it.
		return this.#config.stateDir.replace(/\/\.omp\/slack-bridge$/, "");
	}

	#resolveDir(token: string): string | undefined {
		const alias = this.#config.repos[token];
		if (alias) return alias;
		if (token.startsWith("/")) {
			const home = this.#home();
			if (token === home || token.startsWith(`${home}/`)) return token;
		}
		return undefined;
	}
}

// ============================================================================
// Pure helpers (module-private)
// ============================================================================

function parseActionId(actionId: string): { reqId: string; suffix?: string } | undefined {
	if (!actionId.startsWith("ui:")) return undefined;
	const rest = actionId.slice(3);
	const colon = rest.lastIndexOf(":");
	if (colon === -1) return { reqId: rest };
	const suffix = rest.slice(colon + 1);
	// Numeric index or yes/no suffix; anything else is part of a colon-free id.
	if (suffix === "yes" || suffix === "no" || /^\d+$/.test(suffix)) {
		return { reqId: rest.slice(0, colon), suffix };
	}
	return { reqId: rest };
}

/** Parse `ask:<callId>:<questionIndex>[:<optionIndex>]` action ids. */
function parseAskActionId(actionId: string): { callId: string; questionIndex: number } | undefined {
	if (!actionId.startsWith("ask:")) return undefined;
	const parts = actionId.slice(4).split(":");
	// callId, questionIndex, and optional optionIndex — callId never contains ':'.
	if (parts.length < 2) return undefined;
	const callId = parts[0]!;
	const questionIndex = Number.parseInt(parts[1]!, 10);
	if (!callId || !Number.isInteger(questionIndex) || questionIndex < 0) return undefined;
	return { callId, questionIndex };
}

/** Narrow an unknown to an index-readable object (checked, no unchecked cast). */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Validate and normalize `ask` host-tool arguments; undefined when malformed. */
function parseAskQuestions(args: Record<string, unknown>): AskToolArgs["questions"] | undefined {
	const raw = args.questions;
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	const questions: AskToolArgs["questions"] = [];
	for (const item of raw) {
		if (!isRecord(item)) return undefined;
		const id = item.id;
		const question = item.question;
		const rawOptions = item.options;
		if (typeof id !== "string" || typeof question !== "string" || !Array.isArray(rawOptions)) return undefined;
		const options: Array<{ label: string; description?: string }> = [];
		for (const opt of rawOptions) {
			if (!isRecord(opt) || typeof opt.label !== "string") return undefined;
			options.push({ label: opt.label, description: typeof opt.description === "string" ? opt.description : undefined });
		}
		questions.push({
			id,
			question,
			header: typeof item.header === "string" ? item.header : undefined,
			options,
			multi: typeof item.multi === "boolean" ? item.multi : undefined,
			recommended: typeof item.recommended === "number" ? item.recommended : undefined,
		});
	}
	return questions;
}

/**
 * Validate `attach_file` paths; undefined when malformed.
 *
 * Blank entries are dropped rather than rejected — a model that pads the array
 * with an empty string still gets its real files uploaded.
 */
function parseAttachPaths(args: Record<string, unknown>): string[] | undefined {
	const raw = args.paths;
	if (!Array.isArray(raw)) return undefined;
	const paths: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") return undefined;
		const trimmed = item.trim();
		if (trimmed.length > 0) paths.push(trimmed);
	}
	return paths.length > 0 ? paths : undefined;
}

/** The trimmed string, or undefined when absent, non-string, or blank. */
function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.trim();
	return text.length > 0 ? text : undefined;
}

/** Text summary of a fully-answered ask (single vs. multi-question form). */
function formatAskResult(pending: PendingAsk): string {
	if (pending.questions.length === 1) {
		return `User answered "${pending.questions[0]!.question}": ${pending.answers[0] ?? ""}`;
	}
	const lines = pending.questions.map((q, i) => `${i + 1}. ${q.question} → ${pending.answers[i] ?? ""}`);
	return `User answers:\n${lines.join("\n")}`;
}

/**
 * Result text when the user answered an ask with a freeform thread reply instead
 * of choosing options. Any options clicked before the reply are preserved so the
 * agent still sees them.
 */
function formatAskFreeform(pending: PendingAsk, reply: string): string {
	const clicked = pending.questions
		.map((q, i) => (pending.answers[i] !== undefined ? `${q.question} → ${pending.answers[i]}` : undefined))
		.filter((line): line is string => line !== undefined);
	const prefix = clicked.length > 0 ? `Options selected before replying:\n${clicked.join("\n")}\n\n` : "";
	return `${prefix}User replied directly instead of choosing options: ${reply}`;
}

function uiTitle(req: OmpUiRequest): string {
	return "title" in req && typeof req.title === "string" ? req.title : "Question";
}

function toolLabel(toolName: string | undefined, args: Record<string, unknown> | undefined): string {
	const name = toolName ?? "tool";
	const detail = args && typeof args.path === "string" ? ` ${args.path}` : args && typeof args.command === "string" ? ` ${String(args.command).slice(0, 40)}` : "";
	return `⏵ ${name}${detail}`;
}

/** Reject with a timeout error if `promise` doesn't settle within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}

function headOf(prompt: string): string {
	const oneLine = prompt.replace(/\s+/g, " ").trim();
	return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

/**
 * omp's session directory for a cwd, mirroring `getDefaultSessionDirName`
 * (`packages/coding-agent/src/session/session-paths.ts:43`): a cwd inside $HOME
 * encodes home-relative (`/Users/me/oh-my-pi-src` → `-oh-my-pi-src`), anything
 * else falls back to the legacy absolute form. Bridge repos are always under
 * $HOME — `#resolveDir` enforces it — so the first branch is the live one.
 *
 * This is what puts a gemma routing transcript in omp's tree instead of pi's
 * (`~/.pi/agent/sessions/<slug>`, only reachable there through hand-made
 * symlinks): one location for every transcript, so cc-callbacks audits the
 * routing run and the agent session it starts from the same place.
 */
export function ompSessionDir(home: string, cwd: string): string {
	const root = `${home}/.omp/agent/sessions`;
	const relative = cwd === home ? "" : cwd.startsWith(`${home}/`) ? cwd.slice(home.length + 1) : undefined;
	if (relative === undefined) return `${root}/--${cwd.replace(/^\//, "").replace(/[/:]/g, "-")}--`;
	const encoded = relative.replace(/[/:]/g, "-");
	return `${root}/${encoded.length > 0 ? `-${encoded}` : "-"}`;
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

/**
 * The storage session id behind a session file: omp writes
 * `<timestamp>_<sessionId>.jsonl`, and that id is what `omp --resume <id>`
 * accepts. Deliberately not `get_state`'s `sessionId`, which is the *provider*
 * session id and can diverge from the on-disk one.
 */
function sessionIdOf(sessionPath: string | undefined): string | undefined {
	if (!sessionPath) return undefined;
	const file = basename(sessionPath).replace(/\.jsonl$/, "");
	const split = file.indexOf("_");
	return split > 0 ? file.slice(split + 1) || undefined : undefined;
}

/** Slack filenames are user-controlled: keep the name readable, keep it one path segment. */
function safeFilename(name: string): string {
	const flat = name.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim();
	return flat || "attachment";
}

/**
 * The decoded block for an attachment the model can look at directly, or the
 * reason it stays path-only.
 *
 * `undefined` means "not an image at all" — a PDF or a log needs no explanation,
 * its path already says everything. A `refusal` is only ever produced for a real
 * `image/*`, because there a silent omission would read as "the screenshot was
 * ignored".
 */
function inlineImageOf(mimetype: string, bytes: Uint8Array): { image?: ImageContent; refusal?: string } | undefined {
	if (!mimetype.startsWith("image/")) return undefined;
	if (INLINE_IMAGE_MIME_TYPES[mimetype] !== true) return { refusal: `${mimetype} is not a vision-model format` };
	if (bytes.byteLength > INLINE_IMAGE_MAX_BYTES) {
		return { refusal: `${bytes.byteLength} bytes exceeds the ${INLINE_IMAGE_MAX_BYTES} byte inline cap` };
	}
	return { image: { type: "image", data: Buffer.from(bytes).toBase64(), mimeType: mimetype } };
}

/**
 * `screenshot.png (image/png), notes.pdf (application/pdf), 1 link` — the
 * inventory the router model is given so an uncaptioned or terse message is not
 * mistaken for small talk. Names and types only: no bytes, no local paths.
 *
 * One line, bounded: the name is user-controlled, and this value becomes an argv
 * word and then a line of the routing prompt. A newline would forge prompt
 * structure and forty files would crowd out the message itself.
 */
function attachmentSummary(msg: SlackInboundMessage): string | undefined {
	const parts = (msg.files ?? []).map(
		(file) => `${file.name.replace(/\s+/g, " ").trim()} (${file.mimetype.replace(/\s+/g, " ").trim()})`,
	);
	const links = msg.links?.length ?? 0;
	if (links > 0) parts.push(links === 1 ? "1 link" : `${links} links`);
	if (parts.length === 0) return undefined;
	const joined = parts.join(", ");
	return joined.length > ATTACHMENT_SUMMARY_MAX_CHARS ? `${joined.slice(0, ATTACHMENT_SUMMARY_MAX_CHARS - 1)}…` : joined;
}

function ageOf(ts: number): string {
	const mins = Math.floor((Date.now() - ts) / MINUTE_MS);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

/** `<title|first message> · <age>` for one store-session row. */
function sessionLine(session: StoreSession): string {
	const label = headOf(session.title ?? session.firstMessage ?? "") || "(untitled)";
	const modified = session.modified ? Date.parse(session.modified) : Number.NaN;
	return `${label} · ${Number.isFinite(modified) ? ageOf(modified) : "?"}`;
}

// ============================================================================
// Entry point
// ============================================================================

export async function main(): Promise<void> {
	const home = process.env.HOME ?? "";
	const stateDir = `${home}/.omp/slack-bridge`;

	// Parse `<stateDir>/.env` first; process.env wins on conflicts.
	const merged: Record<string, string | undefined> = { ...process.env };
	const envFile = Bun.file(`${stateDir}/.env`);
	if (await envFile.exists()) {
		const parsed = parseEnvFile(await envFile.text());
		for (const [key, value] of Object.entries(parsed)) {
			if (merged[key] === undefined) merged[key] = value;
		}
	}

	const config = loadConfig(merged, home);
	const registry = await TaskRegistry.load(config.stateDir);
	const slack = createSlackTransport({ appToken: config.slackAppToken, botToken: config.slackBotToken });
	const bridge = new Bridge({ config, slack, registry, createRpc: createOmpRpc });

	// Acquire the single-instance lock BEFORE connecting to Slack, so a second
	// instance exits without ever subscribing to (and double-processing) events.
	const sockPath = `${config.stateDir}/bridge.sock`;
	let control: { stop(): Promise<void> };
	try {
		control = await startControlServer(sockPath, bridge.controlHost());
	} catch (err) {
		if (err instanceof BridgeAlreadyRunningError) {
			// Clean exit: a peer instance owns the socket. exit(1) triggers a
			// launchd KeepAlive churn loop, so this is a no-op success.
			console.log(`bridge: already running (pid ${err.pid}), exiting cleanly`);
			process.exit(0);
		}
		throw err;
	}

	await slack.start();
	bridge.start();

	const shutdown = () => {
		void control
			.stop()
			.catch(() => {})
			.then(() => bridge.shutdown())
			.then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	const aliases = Object.keys(config.repos).join(", ") || "(none)";
	console.log(`bridge up — ${config.allowedUsers.length} allowed user(s), repos: ${aliases}, maxTasks=${config.maxTasks}, control ${sockPath}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error(`bridge: fatal: ${String(err)}`);
		process.exit(1);
	});
}
