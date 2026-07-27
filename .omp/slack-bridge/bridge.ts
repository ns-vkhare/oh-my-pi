/**
 * omp Slack bridge daemon.
 *
 * Wires the Slack transport (./slack) to omp RPC processes (./omp-rpc):
 * routes DM commands and thread replies, relays `ask`/UI requests as Block Kit
 * messages, renders per-turn status, persists the thread↔session registry, and
 * reaps idle processes (hub parity). Run with `bun bridge.ts`.
 */

import {
	answeredBlocks,
	askAnsweredBlocks,
	askQuestionBlocks,
	finalTextBlocks,
	notifyText,
	statusText,
	taskHeaderBlocks,
	thinkingLine,
	uiRequestBlocks,
} from "./blocks";
import { BridgeAlreadyRunningError, type ControlHost, startControlServer } from "./control";
import { createOmpRpc } from "./omp-rpc";
import { createSlackTransport } from "./slack";
import { TaskRegistry } from "./registry";
import type {
	AskToolArgs,
	BridgeConfig,
	OmpAgentEvent,
	OmpAssistantMessageEvent,
	OmpHostToolCall,
	OmpHostToolCancel,
	OmpHostToolDefinition,
	OmpRpc,
	OmpRpcOptions,
	OmpUiRequest,
	SlackBlockAction,
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
		stateDir: `${home}/.omp/slack-bridge`,
	};
}

// ============================================================================
// Session store listing
// ============================================================================

/** Newest sessions listed per repo. */
const SESSIONS_PER_REPO = 8;
const SESSIONS_LIST_TIMEOUT_MS = 10_000;

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
}

const HELP_TEXT = [
	"*omp slack bridge*",
	"• `run <alias|path> <prompt…>` — start a new task",
	"• `sessions [alias]` — browse omp sessions (⚡ live·slack, 🔗 attached)",
	"• `resume <n|sessionPath>` — attach a listed or on-disk session",
	"• `status` — bridge status",
	"Reply inside a task thread to steer it, or `abort` / `kill` / `status`.",
].join("\n");

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

export class Bridge {
	readonly #config: BridgeConfig;
	readonly #slack: SlackTransport;
	readonly #registry: TaskRegistry;
	readonly #createRpc: (opts: OmpRpcOptions) => OmpRpc;
	readonly #listSessions: ListSessions;
	readonly #live = new Map<string, LiveTask>();
	readonly #startedAt = Date.now();
	#reaperTimer: ReturnType<typeof setInterval> | undefined;
	#unsubscribeInbound: (() => void) | undefined;
	#shuttingDown = false;
	/** Cached bot↔user DM channel for top-level notify posts (resolved lazily). */
	#dmChannel: string | undefined;
	/** channel → (index → session) from that channel's last `sessions` listing, consumed by `resume <n>`. */
	#lastListing = new Map<string, Map<number, { path: string; cwd: string }>>();

	constructor(deps: BridgeDeps) {
		this.#config = deps.config;
		this.#slack = deps.slack;
		this.#registry = deps.registry;
		this.#createRpc = deps.createRpc;
		this.#listSessions = deps.listSessions ?? spawnSessionLister(deps.config.ompBin);
	}

	start(): void {
		this.#unsubscribeInbound = this.#slack.onInbound((inbound) => {
			void this.#handleInbound(inbound).catch((err) => {
				console.error(`bridge: inbound handler error: ${String(err)}`);
			});
		});
		this.#reaperTimer = setInterval(() => void this.#reap(), REAPER_INTERVAL_MS);
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		clearInterval(this.#reaperTimer);
		this.#reaperTimer = undefined;
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
				subagentsRunning: await task.rpc.getSubagents().catch(() => 0),
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
			const running = await withTimeout(task.rpc.getSubagents(), PARK_SUBAGENT_TIMEOUT_MS).catch(() => undefined);
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
		if (inbound.threadTs) {
			await this.#handleThreadReply(inbound, inbound.threadTs);
			return;
		}
		await this.#handleTopLevel(inbound);
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

		if (command === "run") {
			await this.#cmdRun(msg, rest);
		} else if (command === "sessions") {
			await this.#cmdSessions(msg, restTokens[0]);
		} else if (command === "resume") {
			await this.#cmdResume(msg, restTokens[0]);
		} else if (command === "status") {
			await this.#cmdStatus(msg);
		} else {
			await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: HELP_TEXT });
		}
	}

	async #cmdRun(msg: SlackInboundMessage, rest: string): Promise<void> {
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
			await this.#slack.postMessage({ channel: msg.channel, threadTs: this.#replyThread(msg), text: "Usage: `run <alias|path> <prompt…>`" });
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
		await this.#slack.postMessage({
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
		await this.#spawn({ record, isNew: true, prompt, sessionName: name });
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
		await this.#slack.postMessage({
			channel: msg.channel,
			threadTs,
			text: name,
			blocks: taskHeaderBlocks({ name, cwd, sessionPath }),
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
		await this.#spawn({ record, isNew: false, resumeSessionPath: sessionPath });
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
			const idx = task.pendingAsk.answers.findIndex((a) => a === undefined);
			if (idx !== -1) {
				await this.#answerAskQuestion(task, idx, text, msg.user);
				return;
			}
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
		await task.rpc.prompt(text).catch((err) => this.#note(task!, `prompt failed: ${String(err)}`));
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

	async #spawn(args: { record: TaskRecord; isNew: boolean; prompt?: string; resumeSessionPath?: string; sessionName?: string }): Promise<void> {
		const { record, isNew } = args;
		const rpc = this.#createRpc({
			ompBin: this.#config.ompBin,
			cwd: record.cwd,
			resumeSessionPath: args.resumeSessionPath,
			// OMP_SLACK_BRIDGE marks bridge-owned children: the slack-notify
			// extension and omp's resume park hook skip themselves under it.
			env: isNew ? { OMP_SLACK_BRIDGE: "1", OMP_HUB_NEW_SESSION: "1" } : { OMP_SLACK_BRIDGE: "1" },
			extraArgs: [],
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
		try {
			const state = await rpc.getState();
			if (state.sessionFile) record.sessionPath = state.sessionFile;
			if (state.sessionName) record.name = state.sessionName;
		} catch {
			// Non-fatal: sessionPath fills in on a later get_state.
		}
		record.lastActivityAt = Date.now();
		this.#registry.upsert(record);

		await rpc.setHostTools([ASK_HOST_TOOL]).catch((err) => console.error(`bridge: set_host_tools failed: ${String(err)}`));

		if (isNew && args.prompt) {
			await rpc.prompt(args.prompt).catch((err) => this.#note(task, `prompt failed: ${String(err)}`));
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

	// --- Ask host tool ------------------------------------------------------

	async #onHostToolCall(task: LiveTask, call: OmpHostToolCall): Promise<void> {
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

/** Text summary of a fully-answered ask (single vs. multi-question form). */
function formatAskResult(pending: PendingAsk): string {
	if (pending.questions.length === 1) {
		return `User answered "${pending.questions[0]!.question}": ${pending.answers[0] ?? ""}`;
	}
	const lines = pending.questions.map((q, i) => `${i + 1}. ${q.question} → ${pending.answers[i] ?? ""}`);
	return `User answers:\n${lines.join("\n")}`;
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

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
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
