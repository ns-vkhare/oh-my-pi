/**
 * Live smoke test for the omp RPC side of the bridge (no Slack required).
 *
 * Usage: bun smoke.ts [--ask]
 *
 * Spawns a real `omp --mode rpc` in a temp directory, runs a trivial prompt,
 * and (with --ask) exercises the ask-tool relay: waits for the select UI
 * request, answers it programmatically, and checks the agent saw the answer.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createOmpRpc } from "./omp-rpc";
import type { OmpHostToolCall } from "./types";

const runAsk = process.argv.includes("--ask");
const ompBin = process.env.OMP_BIN ?? "omp";
const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-slack-smoke-"));

function fail(message: string): never {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}

const rpc = createOmpRpc({ ompBin, cwd, readyTimeoutMs: 60_000 });

const agentEnd = () => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unsub = rpc.onEvent(event => {
		if (event.type === "agent_end") {
			unsub();
			resolve();
		}
	});
	return promise;
};

console.log(`spawning ${ompBin} --mode rpc in ${cwd} ...`);
await rpc.start();
console.log("ready ✓");

if (!runAsk) {
	const done = agentEnd();
	await rpc.prompt('Reply with exactly "OK" and nothing else. Do not use any tools.');
	await Promise.race([done, Bun.sleep(180_000).then(() => fail("timeout waiting for agent_end"))]);
	const text = (await rpc.getLastAssistantText())?.trim() ?? "";
	console.log(`assistant: ${JSON.stringify(text)}`);
	if (!text.includes("OK")) fail(`expected "OK", got ${JSON.stringify(text)}`);
} else {
	// The builtin ask tool does not register in RPC mode; the bridge exposes an
	// `ask` HOST tool instead. Register the same tool here and serve one call.
	await rpc.setHostTools([
		{
			name: "ask",
			label: "Ask",
			description:
				"Ask the user one or more multiple-choice questions and wait for their answers. " +
				"Use when you need a decision or clarification.",
			parameters: {
				type: "object",
				properties: {
					questions: {
						type: "array",
						minItems: 1,
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								question: { type: "string" },
								options: {
									type: "array",
									items: {
										type: "object",
										properties: { label: { type: "string" }, description: { type: "string" } },
										required: ["label"],
										additionalProperties: false,
									},
								},
								multi: { type: "boolean" },
								recommended: { type: "number" },
							},
							required: ["id", "question", "options"],
							additionalProperties: false,
						},
					},
				},
				required: ["questions"],
				additionalProperties: false,
			},
		},
	]);
	console.log("ask host tool registered ✓");

	const callSeen = (() => {
		const { promise, resolve } = Promise.withResolvers<OmpHostToolCall>();
		const unsub = rpc.onHostToolCall(call => {
			console.log(`host tool call: ${call.toolName}`);
			unsub();
			resolve(call);
		});
		return promise;
	})();
	const done = agentEnd();
	await rpc.prompt(
		'Use the ask tool exactly once with a single question "Pick a color" and options "Red" and "Blue". ' +
			"After receiving the answer, reply with exactly the chosen option label and nothing else.",
	);
	const call = await Promise.race([
		callSeen,
		Bun.sleep(180_000).then(() => fail("timeout waiting for ask host tool call")),
	]);
	const args = call.arguments as { questions?: Array<{ question: string; options: Array<{ label: string }> }> };
	const question = args.questions?.[0];
	if (!question) fail(`ask call had no questions: ${JSON.stringify(call.arguments)}`);
	console.log(`question: ${JSON.stringify(question.question)} options: ${JSON.stringify(question.options)}`);
	const choice = question.options.find(opt => opt.label === "Blue")?.label ?? question.options[0]?.label;
	if (!choice) fail("ask question had no options");
	rpc.respondHostTool({
		type: "host_tool_result",
		id: call.id,
		result: { content: [{ type: "text", text: `User answered ${JSON.stringify(question.question)}: ${choice}` }] },
	});
	console.log(`answered: ${JSON.stringify(choice)}`);
	await Promise.race([done, Bun.sleep(180_000).then(() => fail("timeout waiting for agent_end after answer"))]);
	const text = (await rpc.getLastAssistantText())?.trim() ?? "";
	console.log(`assistant: ${JSON.stringify(text)}`);
	if (!text.toLowerCase().includes(choice.toLowerCase())) {
		fail(`expected final text to include ${JSON.stringify(choice)}, got ${JSON.stringify(text)}`);
	}
}

await rpc.stop();
await fs.rm(cwd, { recursive: true, force: true });
console.log("PASS");
// Explicit exit: losing Bun.sleep() race arms would otherwise keep the event
// loop alive and invoke fail() after success.
process.exit(0);
