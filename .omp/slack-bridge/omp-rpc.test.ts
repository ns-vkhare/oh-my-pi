/**
 * Hermetic tests for the OmpRpc client. No real omp is spawned; a fake child is
 * driven by an inline `bun` fixture script written to a temp dir. The fixture
 * ignores the `--mode rpc ...` argv the client passes and speaks the JSONL
 * protocol on stdio, its behavior toggled via env vars.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOmpRpc } from "./omp-rpc";
import type { OmpAgentEvent, OmpHostToolCall, OmpHostToolCancel, OmpUiRequest } from "./types";

/**
 * Fixture protocol:
 * - Prints {"type":"ready"} on start unless FIXTURE_NO_READY is set.
 * - FIXTURE_NO_READY: write FIXTURE_STDERR to stderr, exit 3 before ready.
 * - FIXTURE_EMIT: after ready, emit one agent event (agent_start) and one
 *   extension_ui_request (select). On receiving an extension_ui_response, echo
 *   it back as a message_update event carrying the response value for proof.
 * - FIXTURE_HANG: never respond to get_state (leaves the request pending).
 * - FIXTURE_EMIT_HOSTTOOL: after ready, emit one host_tool_call frame and one
 *   host_tool_cancel frame.
 * - Otherwise: echo responses for known commands read from stdin. get_state
 *   returns a state payload; a set_session_name with FIXTURE_FAIL responds
 *   success:false. set_host_tools responds success:true echoing the received
 *   tool names in data. A received host_tool_result is echoed back as a
 *   message_update event carrying the payload for proof.
 */
const FIXTURE = String.raw`
const noReady = !!process.env.FIXTURE_NO_READY;
const emit = !!process.env.FIXTURE_EMIT;
const hang = !!process.env.FIXTURE_HANG;
const emitHostTool = !!process.env.FIXTURE_EMIT_HOSTTOOL;

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

if (noReady) {
  const msg = process.env.FIXTURE_STDERR || "boom";
  process.stderr.write(msg);
  // Give the parent a tick to attach its stderr reader, then exit non-zero.
  setTimeout(() => process.exit(3), 50);
} else {
  send({ type: "ready" });
  if (emit) {
    send({ type: "agent_start", turnId: "t1" });
    send({ type: "extension_ui_request", id: "u1", method: "select", title: "Pick one", options: ["A", "B"] });
  }
  if (emitHostTool) {
    send({ type: "host_tool_call", id: "h1", toolCallId: "tc1", toolName: "ask", arguments: { questions: [{ id: "q1" }] } });
    send({ type: "host_tool_cancel", id: "h2", targetId: "h1" });
  }

  let buf = "";
  process.stdin.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (!t) continue;
      let frame;
      try { frame = JSON.parse(t); } catch { continue; }
      handle(frame);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

function handle(frame) {
  if (frame.type === "extension_ui_response") {
    // Prove receipt: echo the response back as a custom agent event.
    send({ type: "message_update", echoedUi: frame });
    return;
  }
  if (frame.type === "host_tool_result") {
    // Prove receipt: echo the result back as a custom agent event.
    send({ type: "message_update", echoedHostToolResult: frame });
    return;
  }
  const id = frame.id;
  switch (frame.type) {
    case "get_state":
      if (hang) return; // leave pending
      send({ type: "response", id, command: "get_state", success: true, data: { isStreaming: true, sessionName: "fix", messageCount: 2 } });
      break;
    case "get_last_assistant_text":
      send({ type: "response", id, command: "get_last_assistant_text", success: true, data: { text: "hello" } });
      break;
    case "prompt":
      // Prove what landed on the wire, including whether images was sent.
      send({ type: "message_update", echoedPrompt: { message: frame.message, images: frame.images, streamingBehavior: frame.streamingBehavior } });
      send({ type: "response", id, command: "prompt", success: true, data: { agentInvoked: true } });
      break;
    case "abort":
      send({ type: "response", id, command: "abort", success: true });
      break;
    case "set_session_name":
      if (process.env.FIXTURE_FAIL) {
        send({ type: "response", id, command: "set_session_name", success: false, error: "name rejected" });
      } else {
        send({ type: "response", id, command: "set_session_name", success: true });
      }
      break;
    case "get_subagents": {
      const mode = process.env.FIXTURE_SUBAGENTS || "";
      let subagents;
      if (mode === "not-array") subagents = "not-an-array";
      else if (mode === "junk-entry") subagents = ["junk"];
      else if (mode === "no-id") subagents = [{ agent: "task", status: "running" }];
      else if (mode === "no-status") subagents = [{ id: "Bare", agent: "task" }];
      else if (mode === "sloppy") subagents = [{ id: "Sloppy", status: "done", lastUpdate: "nope", task: "", sessionFile: "" }];
      else subagents = [
        { id: "Scout", agent: "scout", status: "running", task: "map the repo", sessionFile: "/s/scout.jsonl", lastUpdate: 42 },
        { id: "Sonic", agent: "sonic", status: "done", lastUpdate: 7 },
      ];
      send({ type: "response", id, command: "get_subagents", success: true, data: { subagents } });
      break;
    }
    case "set_host_tools": {
      const names = Array.isArray(frame.tools) ? frame.tools.map((t) => t && t.name) : [];
      // Prove receipt of the tools array before acking the command.
      send({ type: "message_update", echoedSetHostTools: { names } });
      send({ type: "response", id, command: "set_host_tools", success: true, data: { names } });
      break;
    }
    default:
      break;
  }
}
`;

let dir: string;
let fixture: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "omp-rpc-test-"));
	fixture = join(dir, "fixture.ts");
	// Shebang lets us point ompBin directly at the script; args (--mode rpc …) are ignored.
	writeFileSync(fixture, `#!/usr/bin/env bun\n${FIXTURE}`);
	chmodSync(fixture, 0o755);
});

afterAll(() => {
	// temp dir left for OS cleanup; nothing persistent to tear down
});

function newRpc(env: Record<string, string> = {}) {
	return createOmpRpc({ ompBin: fixture, cwd: dir, env, readyTimeoutMs: 5000 });
}

describe("OmpRpcClient", () => {
	test("start() resolves on ready frame", async () => {
		const rpc = newRpc();
		await rpc.start();
		expect(rpc.alive).toBe(true);
		await rpc.stop();
		expect(rpc.alive).toBe(false);
	});

	test("start() rejects with stderr tail when child exits before ready", async () => {
		const rpc = newRpc({ FIXTURE_NO_READY: "1", FIXTURE_STDERR: "explosive-startup-failure" });
		let error: Error | null = null;
		try {
			await rpc.start();
		} catch (err) {
			error = err instanceof Error ? err : new Error(String(err));
		}
		expect(error).not.toBeNull();
		expect(error?.message).toContain("explosive-startup-failure");
		expect(rpc.alive).toBe(false);
	});

	test("getState() resolves with echoed payload; success:false rejects with error", async () => {
		const ok = newRpc();
		await ok.start();
		const state = await ok.getState();
		expect(state.isStreaming).toBe(true);
		expect(state.sessionName).toBe("fix");
		expect(state.messageCount).toBe(2);
		const text = await ok.getLastAssistantText();
		expect(text).toBe("hello");
		await ok.stop();

		const failing = newRpc({ FIXTURE_FAIL: "1" });
		await failing.start();
		let error: Error | null = null;
		try {
			await failing.setSessionName("nope");
		} catch (err) {
			error = err instanceof Error ? err : new Error(String(err));
		}
		expect(error?.message).toBe("name rejected");
		await failing.stop();
	});

	test("getSubagents() maps well-formed snapshots", async () => {
		const rpc = newRpc();
		await rpc.start();
		expect(await rpc.getSubagents()).toEqual([
			{
				id: "Scout",
				agent: "scout",
				status: "running",
				task: "map the repo",
				sessionFile: "/s/scout.jsonl",
				lastUpdate: 42,
			},
			{ id: "Sonic", agent: "sonic", status: "done", lastUpdate: 7 },
		]);
		await rpc.stop();
	});

	test("getSubagents() coerces display-only fields instead of rejecting", async () => {
		const rpc = newRpc({ FIXTURE_SUBAGENTS: "sloppy" });
		await rpc.start();
		expect(await rpc.getSubagents()).toEqual([{ id: "Sloppy", agent: "", status: "done", lastUpdate: 0 }]);
		await rpc.stop();
	});

	// A malformed payload must not read as quiescence: park counts running entries,
	// so a dropped/defaulted entry would let the bridge park a busy session.
	test.each(["not-array", "junk-entry", "no-id", "no-status"])(
		"getSubagents() rejects a malformed payload (%s)",
		async (mode) => {
			const rpc = newRpc({ FIXTURE_SUBAGENTS: mode });
			await rpc.start();
			await expect(rpc.getSubagents()).rejects.toThrow(/get_subagents/);
			await rpc.stop();
		},
	);

	test("agent events and ui requests fan out; respondUi write is received", async () => {
		const rpc = newRpc({ FIXTURE_EMIT: "1" });
		const events: OmpAgentEvent[] = [];
		const uiReqs: OmpUiRequest[] = [];
		const gotUi = Promise.withResolvers<void>();
		const gotEcho = Promise.withResolvers<OmpAgentEvent>();

		rpc.onEvent((e) => {
			events.push(e);
			if (e.type === "message_update" && "echoedUi" in e) gotEcho.resolve(e);
		});
		rpc.onUiRequest((r) => {
			uiReqs.push(r);
			gotUi.resolve();
		});

		await rpc.start();
		await gotUi.promise;
		expect(uiReqs).toHaveLength(1);
		expect(uiReqs[0]).toMatchObject({ id: "u1", method: "select", title: "Pick one", options: ["A", "B"] });
		expect(events.some((e) => e.type === "agent_start")).toBe(true);

		rpc.respondUi({ type: "extension_ui_response", id: "u1", value: "A" });
		const echo = await gotEcho.promise;
		const echoed = echo.echoedUi;
		expect(echoed).toMatchObject({ type: "extension_ui_response", id: "u1", value: "A" });

		await rpc.stop();
	});

	test("stop() terminates child, pending request rejects, onExit fires once", async () => {
		const rpc = newRpc({ FIXTURE_HANG: "1" });
		let exitCount = 0;
		rpc.onExit(() => {
			exitCount++;
		});
		await rpc.start();

		// Capture the rejection as a value so CFA narrows it (assignment in a .catch closure would not).
		const settled = rpc.getState().then(
			() => ({ ok: true as const }),
			(err: unknown) => ({ ok: false as const, error: err instanceof Error ? err : new Error(String(err)) }),
		);

		await rpc.stop();
		const result = await settled;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe("rpc stopped");
		// stop() awaits child.exited, so #handleExit has already run; the guard is structural.
		expect(exitCount).toBe(1);
		expect(rpc.alive).toBe(false);
	});

	test("setHostTools() resolves on success response; fixture receives the tools array", async () => {
		const rpc = newRpc();
		const echoed = Promise.withResolvers<OmpAgentEvent>();
		rpc.onEvent((e) => {
			if (e.type === "message_update" && "echoedSetHostTools" in e) echoed.resolve(e);
		});
		await rpc.start();
		await rpc.setHostTools([
			{ name: "ask", description: "Ask the user", parameters: { type: "object" } },
		]);
		const echo = await echoed.promise;
		expect(echo.echoedSetHostTools).toMatchObject({ names: ["ask"] });
		await rpc.stop();
	});

	test("host_tool_call fans out to onHostToolCall; host_tool_cancel to onHostToolCancel", async () => {
		const rpc = newRpc({ FIXTURE_EMIT_HOSTTOOL: "1" });
		const gotCall = Promise.withResolvers<OmpHostToolCall>();
		const gotCancel = Promise.withResolvers<OmpHostToolCancel>();
		rpc.onHostToolCall((c) => gotCall.resolve(c));
		rpc.onHostToolCancel((c) => gotCancel.resolve(c));

		await rpc.start();
		const call = await gotCall.promise;
		expect(call).toMatchObject({ type: "host_tool_call", id: "h1", toolCallId: "tc1", toolName: "ask" });
		expect(call.arguments).toMatchObject({ questions: [{ id: "q1" }] });
		const cancel = await gotCancel.promise;
		expect(cancel).toMatchObject({ type: "host_tool_cancel", id: "h2", targetId: "h1" });

		await rpc.stop();
	});

	test("respondHostTool() writes a parseable host_tool_result line the fixture echoes back", async () => {
		const rpc = newRpc();
		const gotEcho = Promise.withResolvers<OmpAgentEvent>();
		rpc.onEvent((e) => {
			if (e.type === "message_update" && "echoedHostToolResult" in e) gotEcho.resolve(e);
		});
		await rpc.start();
		rpc.respondHostTool({
			type: "host_tool_result",
			id: "h1",
			result: { content: [{ type: "text", text: "done" }] },
		});
		const echo = await gotEcho.promise;
		expect(echo.echoedHostToolResult).toMatchObject({
			type: "host_tool_result",
			id: "h1",
			result: { content: [{ type: "text", text: "done" }] },
		});
		await rpc.stop();
	});

	test("prompt() puts images on the wire and omits the field when there are none", async () => {
		const rpc = newRpc();
		const frames: unknown[] = [];
		rpc.onEvent((e) => {
			if (e.type === "message_update" && "echoedPrompt" in e) frames.push(e.echoedPrompt);
		});
		await rpc.start();

		await rpc.prompt("look at this", [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
		await rpc.prompt("and now just words");
		await rpc.prompt("empty array is the same as none", []);

		expect(frames).toHaveLength(3);
		expect(frames[0]).toEqual({
			message: "look at this",
			images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			streamingBehavior: "steer",
		});
		// An absent `images` is the documented text-only frame, not `images: []`.
		expect(frames[1]).toEqual({ message: "and now just words", streamingBehavior: "steer" });
		expect(frames[2]).toEqual({ message: "empty array is the same as none", streamingBehavior: "steer" });

		await rpc.stop();
	});
});
