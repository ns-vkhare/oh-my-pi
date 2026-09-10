import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
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
	modelRegistry: ModelRegistry,
	tools: AgentTool[] = [mockTaskTool, mockEvalTool],
	options: { cwd?: string; systemPrompt?: string[] } = {},
): Promise<{
	session: AgentSession;
	settings: Settings;
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
	const settings = Settings.isolated();
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(options.cwd),
		settings,
		modelRegistry,
	});
	return { session, settings };
}

describe("AgentSession magic keyword settings", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage;
	let authRoot: string;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-magic-keywords-auth-"));
		authStorage = await AuthStorage.create(path.join(authRoot, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(authRoot, "models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		await removeWithRetries(authRoot);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) await session.dispose();
		session = undefined;
	});

	it("does not append magic keyword notices when disabled", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.enabled", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this and ultrathink through it");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("honors non-ultrathink per-keyword notice toggles", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("magicKeywords.orchestrate", false);
		created.settings.set("magicKeywords.workflow", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("still appends enabled non-ultrathink notices", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate and workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([
			"orchestrate-notice",
			"workflow-notice",
		]);
	});

	it("renders the eval-specific workflowz notice", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.batch", false);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{
			content?: string;
			customType?: string;
		}>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice");
		expect(notice?.customType).toBe("workflow-notice");
		expect(notice?.content).toContain("Default to `workpool()`");
		expect(notice?.content).toContain('`hub` with `op:"wait", ids:["<pool-name>"]`');
		expect(notice?.content).toContain("**Python:**");
		expect(notice?.content).toContain("**JavaScript:**");
		expect(notice?.content).not.toContain("parallel(thunks)");
	});

	it("updates the workflowz notice when scout is disabled during the session", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
		created.settings.set("task.disabledAgents", ["scout"]);
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ content?: string; customType?: string }>;
		const notice = promptMessages.find(message => message.customType === "workflow-notice")?.content ?? "";
		expect(notice.toLowerCase()).not.toContain("scout");
		expect(notice).toContain("Explore inline FIRST");
	});

	it("skips workflowz notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips orchestrate notice when the task tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, []);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please orchestrate this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("skips workflowz notice when the eval tool is inactive", async () => {
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool]);
		session = created.session;
		const promptSpy = vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined);

		await session.prompt("please workflowz this");

		const promptMessages = promptSpy.mock.calls[0]![0] as unknown as Array<{ customType?: string }>;
		expect(promptMessages.map(message => message.customType).filter(Boolean)).toEqual([]);
	});

	it("does not use a disabled ultrathink keyword to force auto thinking", async () => {
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
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
		const created = await createMagicKeywordSession(modelRegistry);
		session = created.session;
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
	let modelRegistry: ModelRegistry;

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
		const created = await createMagicKeywordSession(modelRegistry, [mockTaskTool, mockEvalTool], {
			cwd: root,
			systemPrompt: options.systemPrompt,
		});
		session = created.session;
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
		authStorage = await AuthStorage.create(path.join(root, "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(root, "models.yml"));
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
