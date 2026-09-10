import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import * as autoThinkingClassifier from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { orchestrateAgentBody } from "@oh-my-pi/pi-coding-agent/modes/orchestrate";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getBundledAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";
import { getAgentDir, getConfigAgentDirName, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

const mockTaskTool: AgentTool = {
	name: "task",
	label: "Task",
	description: "Mock task tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

const mockEvalTool: AgentTool = {
	name: "eval",
	label: "Eval",
	description: "Mock eval tool",
	parameters: type({}),
	execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
};

async function createMagicKeywordSession(
	root: string,
	tools: AgentTool[] = [mockTaskTool, mockEvalTool],
	options: { cwd?: string; systemPrompt?: string[] } = {},
): Promise<{
	session: AgentSession;
	settings: Settings;
	authStorage: AuthStorage;
}> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled Claude Sonnet model");
	const agent = new Agent({
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? ["Test"],
			tools,
			messages: [],
			thinkingLevel: Effort.High,
		},
	});
	const authStorage = await AuthStorage.create(path.join(root, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(options.cwd),
		settings,
		modelRegistry,
	});
	return { session, settings, authStorage };
}

describe("AgentSession magic keyword settings", () => {
	let root: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await removeWithRetries(root).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("renders the eval-specific workflowz notice", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("task.batch", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice")?.content ?? "";
		expect(notice).toContain("Author the orchestration in the `eval` tool");
		expect(notice).toContain("Every eval call has:");
		expect(notice).toContain("`parallel(thunks)`");
		expect(notice).toContain("**Python (`eval`, Python backend):**");
		expect(notice).toContain("**JavaScript (`eval`, JavaScript backend):**");
	});

	it("skips workflowz notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(root, []);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips workflowz notice when the eval tool is inactive", async () => {
		const created = await createMagicKeywordSession(root, [mockTaskTool]);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		created.settings.set("magicKeywords.ultrathink", false);
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);
		const classifierSpy = vi.spyOn(autoThinkingClassifier, "classifyDifficulty").mockResolvedValue(Effort.Low);
		session.setThinkingLevel(AUTO_THINKING);

		await session.prompt("ultrathink through the unsafe refactor");

		expect(classifierSpy).toHaveBeenCalledTimes(1);
		expect(session.thinkingLevel).toBe(Effort.Low);
		expect(session.autoResolvedThinkingLevel()).toBe(Effort.Low);
	});

	it("queues the magic-keyword notice before the user message", async () => {
		const created = await createMagicKeywordSession(root);
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("ultrathink do the thing");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ role?: string; customType?: string }>;
		const noticeIdx = promptMessages.findIndex(m => m.customType === "ultrathink-notice");
		const userIdx = promptMessages.findIndex(m => m.role === "user");
		expect(noticeIdx).toBeGreaterThanOrEqual(0);
		expect(userIdx).toBeGreaterThanOrEqual(0);
		expect(noticeIdx).toBeLessThan(userIdx);
	});
});

describe("orchestrate magic keyword agent identity", () => {
	const originalAgentDir = getAgentDir();
	let root: string;
	let userAgentsDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	async function writeOrchestrateAgent(dir: string, body: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
		await fs.writeFile(
			path.join(dir, "orchestrate.md"),
			["---", "name: orchestrate", "description: test", "---", body, ""].join("\n"),
		);
	}

	// Messages handed to `agent.prompt()`, with the session rooted at the isolated temp cwd.
	async function capturePromptMessages(
		options: { text?: string; systemPrompt?: string[] } = {},
	): Promise<Array<{ content?: string; customType?: string }>> {
		const created = await createMagicKeywordSession(root, [mockTaskTool, mockEvalTool], {
			cwd: root,
			systemPrompt: options.systemPrompt,
		});
		session = created.session;
		authStorage = created.authStorage;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt(options.text ?? "orchestrate this");

		return promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
	}

	async function orchestrateNotices(options: { text?: string; systemPrompt?: string[] } = {}): Promise<string[]> {
		const messages = await capturePromptMessages(options);
		return messages
			.filter(message => message.customType === "orchestrate-notice")
			.map(message => message.content ?? "");
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-orchestrate-identity-"));
		const home = path.join(root, "home");
		// Agent discovery derives the user agents root from `homedir()` at call time and the
		// extension scan from `getAgentDir()`: isolate both so the developer's own
		// ~/.omp orchestrate agent cannot leak in. The first setAgentDir clears any active
		// profile, so the resolved dir name is stable for the second.
		vi.spyOn(os, "homedir").mockReturnValue(home);
		setAgentDir(path.join(home, ".omp", "agent"));
		const userAgentDir = path.join(home, getConfigAgentDirName());
		setAgentDir(userAgentDir);
		userAgentsDir = path.join(userAgentDir, "agents");
		await fs.mkdir(userAgentsDir, { recursive: true });
	});

	afterEach(async () => {
		setAgentDir(originalAgentDir);
		vi.restoreAllMocks();
		if (session) await session.dispose();
		authStorage?.close();
		await removeWithRetries(root).catch(() => undefined);
		session = undefined;
		authStorage = undefined;
	});

	it("injects the bundled orchestrate agent when no user or project agent exists", async () => {
		const notices = await orchestrateNotices();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("orchestrator and architect");
		expect(notices[0]).toContain("bundled agent");
	});

	it("injects a user orchestrate agent instead of the bundled one", async () => {
		await writeOrchestrateAgent(userAgentsDir, "USER-ORCHESTRATE-MARKER-91c2");

		const notices = await orchestrateNotices();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("USER-ORCHESTRATE-MARKER-91c2");
		expect(notices[0]).not.toContain("orchestrator and architect");
	});

	it("injects a project orchestrate agent instead of the user one", async () => {
		await writeOrchestrateAgent(userAgentsDir, "USER-ORCHESTRATE-MARKER-91c2");
		await writeOrchestrateAgent(path.join(root, ".omp", "agents"), "PROJECT-ORCHESTRATE-MARKER-4d8e");

		const notices = await orchestrateNotices();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("PROJECT-ORCHESTRATE-MARKER-4d8e");
		expect(notices[0]).not.toContain("USER-ORCHESTRATE-MARKER-91c2");
	});

	it("skips the notice when the system prompt already carries the orchestrate body", async () => {
		const bundled = getBundledAgent("orchestrate");
		if (!bundled) throw new Error("Expected a bundled orchestrate agent");

		const messages = await capturePromptMessages({
			text: "orchestrate this and ultrathink about it",
			// A session started with `--agent orchestrate` carries the body as the
			// prompt pipeline emits it, not as the definition file spells it.
			systemPrompt: ["Test", orchestrateAgentBody(bundled)],
		});

		// The orchestrate identity is already live; other keyword notices still fire.
		expect(messages.map(message => message.customType).filter(Boolean)).toEqual(["ultrathink-notice"]);
	});
});
