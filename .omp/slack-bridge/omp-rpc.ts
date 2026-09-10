/**
 * Raw JSONL protocol client over a spawned `omp --mode rpc` child.
 *
 * See `./types` (OmpRpc / OmpRpcOptions) for the contract this implements and
 * `~/oh-my-pi-src/docs/rpc.md` for the wire protocol.
 */

import type {
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
} from "./types";

/** Last N bytes of stderr retained for failure diagnostics. */
const STDERR_CAP = 4096;

/** Grace period between SIGTERM and SIGKILL in stop(). */
const STOP_GRACE_MS = 5000;

const AGENT_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"message_start",
	"message_update",
	"message_end",
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAgentEventType(t: string): t is OmpAgentEvent["type"] {
	return AGENT_EVENT_TYPES.has(t);
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

/** Command shape written to stdin; `id` is injected by {@link OmpRpcClient.send}. */
type OutboundCommand =
	| { type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior: "steer" }
	| { type: "abort" }
	| { type: "get_state" }
	| { type: "get_last_assistant_text" }
	| { type: "set_session_name"; name: string }
	| { type: "set_host_tools"; tools: OmpHostToolDefinition[] }
	| { type: "get_subagents" };

class OmpRpcClient implements OmpRpc {
	readonly #options: OmpRpcOptions;
	#child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#started = false;
	#alive = false;
	#exited = false;
	#exitCode: number | null = null;
	#stopRequested = false;
	#seq = 0;
	#stderr = "";
	#stderrDone: Promise<void> = Promise.resolve();
	readonly #pending = new Map<string, Pending>();
	readonly #eventListeners = new Set<(event: OmpAgentEvent) => void>();
	readonly #uiListeners = new Set<(req: OmpUiRequest) => void>();
	readonly #hostToolCallListeners = new Set<(call: OmpHostToolCall) => void>();
	readonly #hostToolCancelListeners = new Set<(cancel: OmpHostToolCancel) => void>();
	readonly #exitListeners = new Set<(code: number | null) => void>();
	readonly #ready = Promise.withResolvers<void>();

	constructor(options: OmpRpcOptions) {
		this.#options = options;
	}

	get alive(): boolean {
		return this.#alive;
	}

	async start(): Promise<void> {
		if (this.#started) throw new Error("OmpRpcClient.start() already called");
		this.#started = true;

		const { ompBin, cwd, resumeSessionPath, env, extraArgs } = this.#options;
		const args = [
			"--mode",
			"rpc",
			...(resumeSessionPath ? ["--resume", resumeSessionPath] : []),
			...(extraArgs ?? []),
		];
		const child = Bun.spawn([ompBin, ...args], {
			cwd,
			env: { ...process.env, ...env },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.#child = child;

		this.#readStdout(child.stdout).catch((err) => {
			console.error("[omp-rpc] stdout reader crashed:", err);
		});
		this.#stderrDone = this.#readStderr(child.stderr).catch((err) => {
			console.error("[omp-rpc] stderr reader crashed:", err);
		});
		this.#watchExit(child);

		const timeoutMs = this.#options.readyTimeoutMs ?? 30_000;
		const timer = setTimeout(() => {
			this.#ready.reject(new Error(`omp RPC ready handshake timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		try {
			await this.#ready.promise;
			this.#alive = true;
		} catch (err) {
			try {
				child.kill();
			} catch {
				// child may already be gone
			}
			await this.#stderrDone.catch(() => {});
			const base = err instanceof Error ? err.message : String(err);
			const tail = this.#stderr.slice(-STDERR_CAP);
			throw new Error(tail ? `${base}\n--- stderr ---\n${tail}` : base);
		} finally {
			clearTimeout(timer);
		}
	}

	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		// The field is omitted rather than sent empty: an absent `images` is the
		// documented "text only" frame, and it keeps the session transcript clean.
		const frame: OutboundCommand = { type: "prompt", message, streamingBehavior: "steer" };
		if (images && images.length > 0) frame.images = images;
		await this.#send(frame);
	}

	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	async getState(): Promise<OmpSessionState> {
		const data = await this.#send({ type: "get_state" });
		return this.#parseState(data);
	}

	async getLastAssistantText(): Promise<string | null> {
		const data = await this.#send({ type: "get_last_assistant_text" });
		if (isRecord(data) && typeof data.text === "string") return data.text;
		return null;
	}

	async getSubagents(): Promise<OmpSubagentSnapshot[]> {
		const data = await this.#send({ type: "get_subagents" });
		if (!isRecord(data) || !Array.isArray(data.subagents)) throw new Error("get_subagents: malformed response");
		const snapshots: OmpSubagentSnapshot[] = [];
		for (const entry of data.subagents) {
			if (!isRecord(entry)) throw new Error("get_subagents: malformed subagent entry");
			const { id, status } = entry;
			if (typeof id !== "string" || id.length === 0) throw new Error("get_subagents: subagent entry without an id");
			if (typeof status !== "string" || status.length === 0)
				throw new Error(`get_subagents: subagent ${id} without a status`);
			const snapshot: OmpSubagentSnapshot = {
				id,
				agent: typeof entry.agent === "string" ? entry.agent : "",
				status,
				lastUpdate: typeof entry.lastUpdate === "number" && Number.isFinite(entry.lastUpdate) ? entry.lastUpdate : 0,
			};
			if (typeof entry.task === "string" && entry.task.length > 0) snapshot.task = entry.task;
			if (typeof entry.sessionFile === "string" && entry.sessionFile.length > 0) snapshot.sessionFile = entry.sessionFile;
			snapshots.push(snapshot);
		}
		return snapshots;
	}

	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	respondUi(response: OmpUiResponse): void {
		if (!this.#alive) return;
		try {
			this.#writeLine(response);
		} catch (err) {
			console.error("[omp-rpc] respondUi write failed:", err);
		}
	}

	async setHostTools(tools: OmpHostToolDefinition[]): Promise<void> {
		await this.#send({ type: "set_host_tools", tools });
	}

	respondHostTool(result: OmpHostToolResult): void {
		if (!this.#alive) return;
		try {
			this.#writeLine(result);
		} catch (err) {
			console.error("[omp-rpc] respondHostTool write failed:", err);
		}
	}

	onEvent(listener: (event: OmpAgentEvent) => void): () => void {
		this.#eventListeners.add(listener);
		return () => {
			this.#eventListeners.delete(listener);
		};
	}

	onUiRequest(listener: (req: OmpUiRequest) => void): () => void {
		this.#uiListeners.add(listener);
		return () => {
			this.#uiListeners.delete(listener);
		};
	}

	onHostToolCall(listener: (call: OmpHostToolCall) => void): () => void {
		this.#hostToolCallListeners.add(listener);
		return () => {
			this.#hostToolCallListeners.delete(listener);
		};
	}

	onHostToolCancel(listener: (cancel: OmpHostToolCancel) => void): () => void {
		this.#hostToolCancelListeners.add(listener);
		return () => {
			this.#hostToolCancelListeners.delete(listener);
		};
	}

	onExit(listener: (code: number | null) => void): () => void {
		if (this.#exited) {
			try {
				listener(this.#exitCode);
			} catch (err) {
				console.error("[omp-rpc] exit listener error:", err);
			}
			return () => {};
		}
		this.#exitListeners.add(listener);
		return () => {
			this.#exitListeners.delete(listener);
		};
	}

	async stop(): Promise<void> {
		const child = this.#child;
		if (!this.#alive || !child) return;
		this.#stopRequested = true;
		this.#rejectAllPending(new Error("rpc stopped"));
		child.kill();
		const exitedCleanly = await Promise.race([
			child.exited.then(() => true),
			Bun.sleep(STOP_GRACE_MS).then(() => false),
		]);
		if (!exitedCleanly && !this.#exited) {
			child.kill(9);
			await child.exited;
		}
	}

	// ---- internals -------------------------------------------------------

	#send(command: OutboundCommand): Promise<unknown> {
		if (!this.#alive) return Promise.reject(new Error("rpc not alive"));
		const id = `r${++this.#seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.#pending.set(id, { resolve, reject });
		try {
			this.#writeLine({ ...command, id });
		} catch (err) {
			this.#pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
		return promise;
	}

	#writeLine(frame: unknown): void {
		const sink = this.#child?.stdin;
		if (!sink) throw new Error("rpc stdin unavailable");
		sink.write(`${JSON.stringify(frame)}\n`);
		sink.flush();
	}

	async #readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		let buffer = "";
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					this.#handleLine(buffer.slice(0, nl));
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf("\n");
				}
			}
			buffer += decoder.decode();
			this.#handleLine(buffer);
		} finally {
			reader.releaseLock();
		}
	}

	async #readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		const reader = stream.getReader();
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				this.#appendStderr(decoder.decode(value, { stream: true }));
			}
			this.#appendStderr(decoder.decode());
		} finally {
			reader.releaseLock();
		}
	}

	#appendStderr(chunk: string): void {
		if (!chunk) return;
		this.#stderr += chunk;
		if (this.#stderr.length > STDERR_CAP) this.#stderr = this.#stderr.slice(-STDERR_CAP);
	}

	#handleLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // noise — never crash the read loop
		}
		if (!isRecord(parsed)) return;
		this.#routeFrame(parsed);
	}

	#routeFrame(frame: Record<string, unknown>): void {
		const type = frame.type;
		if (typeof type !== "string") return;
		if (type === "ready") {
			this.#ready.resolve();
			return;
		}
		if (type === "response") {
			this.#routeResponse(frame);
			return;
		}
		if (type === "extension_ui_request") {
			const req = this.#parseUiRequest(frame);
			if (req) this.#fanOut(this.#uiListeners, req);
			return;
		}
		if (type === "host_tool_call") {
			const call = this.#parseHostToolCall(frame);
			if (call) this.#fanOut(this.#hostToolCallListeners, call);
			return;
		}
		if (type === "host_tool_cancel") {
			const cancel = this.#parseHostToolCancel(frame);
			if (cancel) this.#fanOut(this.#hostToolCancelListeners, cancel);
			return;
		}
		if (isAgentEventType(type)) {
			const event: OmpAgentEvent = { type };
			for (const [key, value] of Object.entries(frame)) {
				if (key !== "type") event[key] = value;
			}
			this.#fanOut(this.#eventListeners, event);
		}
	}

	#routeResponse(frame: Record<string, unknown>): void {
		const id = frame.id;
		if (typeof id !== "string") return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (frame.success === false) {
			const message = typeof frame.error === "string" ? frame.error : "rpc command failed";
			pending.reject(new Error(message));
		} else {
			pending.resolve(frame.data);
		}
	}

	#parseState(data: unknown): OmpSessionState {
		const state: OmpSessionState = { isStreaming: false };
		if (!isRecord(data)) return state;
		if (typeof data.isStreaming === "boolean") state.isStreaming = data.isStreaming;
		const model = data.model;
		if (isRecord(model) && typeof model.provider === "string" && typeof model.id === "string") {
			state.model = { provider: model.provider, id: model.id };
		}
		if (typeof data.sessionFile === "string") state.sessionFile = data.sessionFile;
		if (typeof data.sessionId === "string") state.sessionId = data.sessionId;
		if (typeof data.sessionName === "string") state.sessionName = data.sessionName;
		if (typeof data.messageCount === "number") state.messageCount = data.messageCount;
		const usage = data.contextUsage;
		if (usage === null) {
			state.contextUsage = null;
		} else if (
			isRecord(usage) &&
			typeof usage.tokens === "number" &&
			typeof usage.contextWindow === "number" &&
			typeof usage.percent === "number"
		) {
			state.contextUsage = {
				tokens: usage.tokens,
				contextWindow: usage.contextWindow,
				percent: usage.percent,
			};
		}
		return state;
	}

	#parseUiRequest(frame: Record<string, unknown>): OmpUiRequest | null {
		const { method, id } = frame;
		const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
		if (typeof id !== "string") return null;
		switch (method) {
			case "select": {
				const { title, options: rawOptions } = frame;
				if (typeof title !== "string" || !Array.isArray(rawOptions)) return null;
				const options = rawOptions.filter((o): o is string => typeof o === "string");
				if (options.length !== rawOptions.length) return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "select", title, options };
				if (timeout !== undefined) req.timeout = timeout;
				return req;
			}
			case "confirm": {
				const { title, message } = frame;
				if (typeof title !== "string" || typeof message !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "confirm", title, message };
				if (timeout !== undefined) req.timeout = timeout;
				return req;
			}
			case "input": {
				const { title } = frame;
				if (typeof title !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "input", title };
				if (typeof frame.placeholder === "string") req.placeholder = frame.placeholder;
				if (timeout !== undefined) req.timeout = timeout;
				return req;
			}
			case "editor": {
				const { title } = frame;
				if (typeof title !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "editor", title };
				if (typeof frame.prefill === "string") req.prefill = frame.prefill;
				if (timeout !== undefined) req.timeout = timeout;
				return req;
			}
			case "cancel": {
				const { targetId } = frame;
				if (typeof targetId !== "string") return null;
				return { type: "extension_ui_request", id, method: "cancel", targetId };
			}
			case "notify": {
				const { message } = frame;
				if (typeof message !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "notify", message };
				if (typeof frame.level === "string") req.level = frame.level;
				return req;
			}
			case "setStatus": {
				const { statusKey } = frame;
				if (typeof statusKey !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "setStatus", statusKey };
				if (typeof frame.text === "string") req.text = frame.text;
				return req;
			}
			case "open_url": {
				const { url } = frame;
				if (typeof url !== "string") return null;
				const req: OmpUiRequest = { type: "extension_ui_request", id, method: "open_url", url };
				if (typeof frame.instructions === "string") req.instructions = frame.instructions;
				return req;
			}
			default:
				return null;
		}
	}

	#parseHostToolCall(frame: Record<string, unknown>): OmpHostToolCall | null {
		const { id, toolCallId, toolName, arguments: args } = frame;
		if (typeof id !== "string" || typeof toolCallId !== "string" || typeof toolName !== "string") return null;
		if (!isRecord(args)) return null;
		return { type: "host_tool_call", id, toolCallId, toolName, arguments: args };
	}

	#parseHostToolCancel(frame: Record<string, unknown>): OmpHostToolCancel | null {
		const { id, targetId } = frame;
		if (typeof id !== "string" || typeof targetId !== "string") return null;
		return { type: "host_tool_cancel", id, targetId };
	}

	#watchExit(child: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
		child.exited
			.then(() => {
				const code = child.exitCode;
				this.#handleExit(typeof code === "number" ? code : null);
			})
			.catch(() => {
				this.#handleExit(null);
			});
	}

	#handleExit(code: number | null): void {
		if (this.#exited) return;
		this.#exited = true;
		this.#exitCode = code;
		this.#alive = false;
		// Unblock a start() still waiting on the ready handshake (no-op once resolved).
		this.#ready.reject(new Error("omp RPC process exited before ready"));
		this.#rejectAllPending(new Error(this.#stopRequested ? "rpc stopped" : "rpc process exited"));
		for (const listener of this.#exitListeners) {
			try {
				listener(code);
			} catch (err) {
				console.error("[omp-rpc] exit listener error:", err);
			}
		}
		this.#exitListeners.clear();
	}

	#rejectAllPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}

	#fanOut<T>(listeners: Set<(value: T) => void>, value: T): void {
		for (const listener of listeners) {
			try {
				listener(value);
			} catch (err) {
				console.error("[omp-rpc] listener error:", err);
			}
		}
	}
}

export function createOmpRpc(options: OmpRpcOptions): OmpRpc {
	return new OmpRpcClient(options);
}
