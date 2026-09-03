---
name: slack-bridge
description: Operate, configure, debug, or extend the omp Slack bridge and its Gemma front-door router — the daemon that turns Slack DMs into omp sessions. Use when the user says "the bridge is not answering", "add a Slack command", "the router picked the wrong command", "restart the bridge", or asks how routing, the control socket, or the orchestrate command work.
---

# omp Slack Bridge

## What it is

A local daemon that maps a Slack DM to an omp session: one Slack **thread** ↔
one session `.jsonl` ↔ at most one live `omp --mode rpc` child (JSONL over
stdio, spawned lazily and reaped when idle). It runs from
`~/.omp/slack-bridge`, but the **source of truth is the repo copy** at
`.omp/slack-bridge/` — `install.sh` deploys it (preserving `.env` and
`state.json`). Editing the deployed copy is how a fix gets silently lost.

## Layout

All paths relative to `.omp/slack-bridge/`.

| File | Owns |
|---|---|
| `types.ts` | Every shared contract. Implementations import from here, never redefine. |
| `bridge.ts` | Daemon entry: command dispatch, task lifecycle, ask relay, catch-up sweep. |
| `omp-rpc.ts` | JSONL protocol client over the spawned `omp --mode rpc` process. |
| `slack.ts` | Socket Mode WS client + Web API wrapper. Zero omp knowledge. |
| `blocks.ts` | Block Kit / mrkdwn rendering + sanitizers. |
| `registry.ts` | Thread↔session registry, persisted to `state.json`. |
| `control.ts` | Unix-socket control plane (`bridge.sock`) + single-instance lock. |
| `router.ts` | `createRouter` — spawns `route.sh`, enforces the timeout, parses one JSON line, fails open. |
| `agent-defs.ts` | `listAgentDefinitions` — `name:` + `description:` of every agent definition (`<repo>/.omp/agents/*.md`, then `~/.omp/agent/agents/*.md`; project shadows home), the inventory the router picks from. |
| `router/route.sh` | omp harness invocation: message on stdin → one decision line on stdout. |
| `router/prompts/entry.md` | System prompt for the routing model. |
| `router/tools/commands.ts` | omp extension registering the five commands as tools (plain JSON-Schema params, zero deps). |
| `prompts/slack-reply.md`, `prompts/slack-repos.md` | Text appended to every spawned agent's system prompt: how to answer into Slack, and the `REPOS` inventory. |
| `install.sh`, `manifest.json`, `.env.example` | Deploy script, Slack app manifest, config template. |

## Operating

```sh
pgrep -fl bridge.ts                          # exactly one process
tail -20 ~/.omp/slack-bridge/bridge.log      # "bridge up — …", no "fatal:"
launchctl kickstart -k gui/$(id -u)/com.omp.slack-bridge   # restart
bash ~/oh-my-pi-src/.omp/slack-bridge/install.sh           # redeploy repo → ~
```

State lives in `~/.omp/slack-bridge/`: `state.json` (task registry +
per-channel catch-up watermarks), `bridge.log`, `.env`, `bridge.sock`.

The control socket speaks JSONL — one request object per line, exactly one
response line. `nc -U` gets nothing useful; use a socket client:

```js
const net = await import("node:net");
const c = net.createConnection(`${process.env.HOME}/.omp/slack-bridge/bridge.sock`);
c.on("connect", () => c.write('{"op":"status"}\n'));
c.on("data", d => { console.log(d.toString()); c.end(); });
```

| Verb | Payload | Answer |
|---|---|---|
| `ping` | — | `{ok, pid}` — MUST match the live `bridge.ts` pid. |
| `status` | — | live tasks. |
| `park` | `sessionPath` | hand a session back to the terminal (quiescence-gated, fails closed). |
| `steer` | `sessionPath`, `text` | deliver a steer into a live turn. |
| `interrupt` | `sessionPath` | abort the current turn. |
| `notify` | `sessionPath`, `cwd`, … | post a terminal session's turn-end/ask into Slack. |

## The router

A free-form DM is classified into exactly one top-level command by a local
model (default `shuttle/gemma-4-26b`, served by Shuttle on `127.0.0.1:8780`),
driven through the `omp` CLI by `router/route.sh`. Enabled by `ROUTER_MODEL` in
`.env`; empty (the default) disables it. See `DESIGN.md` for the full design.

- An **explicit** first-token command (`run`, `orchestrate`, `sessions`,
  `resume`, `status`, `help`) is dispatched literally and never reaches the
  model.
- Everything else reaching the top-level surface goes to the model, which calls
  exactly one command tool. The tool returns `ROUTE <json>`; `route.sh` pulls
  that out of omp's `--mode json` event stream with `jq` and prints one line.
- **Steers are never routed.** A reply inside a live task thread goes straight
  to the agent as a prompt; the router only sees true top-level DMs and thread
  replies whose thread has no bound session.
- **Fail-open.** Disabled, Shuttle down, `jq`/`omp` missing, timeout, or an
  unparseable answer → the literal parser handles it (posting help). A dead
  local model can never swallow a message.
- The model's `dir` is re-validated through the alias/`$HOME` check — a
  hallucinated path is rejected or falls back to `DEFAULT_REPO`.
- **It also picks the agent**, only from the definitions on disk (`agent-defs.ts`,
  cached 5 min per cwd in `#agents`), offered as `--agents "name: description\n…"`.
  `#resolveAgent` re-validates the answer — a listed name, case-insensitively —
  before it becomes `omp --agent <name>`; anything else is dropped to omp's default
  worker, because an invented name makes omp exit 2 and the task never start. The
  bridge passes no `--model`: the agent file pins the model, thinking level and
  tools. Dropping a new `<name>.md` with `name:` + `description:` into either scan
  root is all it takes to make it pickable from Slack.
- **The worker is `omp`, and every routing run is an audited session.** Not pi:
  the `shuttle` provider is registered in `~/.omp/agent/models.yml`, plugin
  discovery stays on so cc-callbacks loads, and the transcript is persisted into
  `--session-dir` = `<repo's omp session dir>/router` (`#routerLocation` +
  `ompSessionDir` in `bridge.ts`, mirroring `session-paths.ts:43`) with cwd = that
  repo, so the audit's `project_root` is the repo and `omp sessions --dir <repo>`
  never lists routing transcripts. `OMP_SLACK_BRIDGE=1` keeps `slack-notify`
  quiet. The surface is pinned with **`--no-tools`**, not `--tools <names>`: omp
  validates `--tools` against builtin names at parse time (naming the five
  commands is a hard error) and extension tools are active regardless of that
  filter. cc-callbacks records the run flat, never nested under the task it
  starts — nesting needs `parentSession` **and** `agentId` in the header, and the
  task session does not exist yet when routing runs.
- **The model sees only `prompts/entry.md`.** `--bare-system-prompt` (an omp flag
  added for this) drops AGENTS.md context files and the PROJECT footer;
  `router/omp-config.yml` (passed with `--config`) turns off memory, autolearn
  (which also removes the `learn`/`manage_skill` tools) and the workspace tree, and
  disables the `codex` provider so its MCP servers (`node_repl`) neither appear as
  tools nor inject instructions. Check it with an RPC probe — `get_state` →
  `systemPrompt` must be a single segment equal to entry.md, `dumpTools` exactly
  the five commands. Unchecked it was 58k chars and 11 tools.
- **Attachments are described, never shown** — `--attachments "shot.png
  (image/png)"`, names and types only. Shuttle models have no vision. Without it
  "what's wrong here?" plus a screenshot routes to `help`; with it, to `run`.

Exercise it without Slack (prints exactly one JSON line, exit 0):

```sh
echo "start a task in omp to fix the flaky test" \
  | ~/.omp/slack-bridge/router/route.sh --model shuttle/gemma-4-26b --repos "omp=$HOME/oh-my-pi-src" --agents "planner: plan and scope a change before any code is written"
```

No decision printed, in order:

1. `curl -sf http://127.0.0.1:8780/healthz` — is Shuttle up?
2. `jq` and `omp` on `PATH`?
3. is the model id registered under the `shuttle` provider in
   `~/.omp/agent/models.yml`? (`omp models | grep -i shuttle` — a YAML or schema
   error makes omp skip the whole custom file silently.)

## Attachments in

Downloaded with the bot token into `$TMPDIR/omp-slack-attachments/<ts>/` and
named by path in the prompt. A `png`/`jpeg`/`gif`/`webp` under 8MB *also* rides
the `prompt` frame as an `ImageContent` block, so the model sees it without a
`read` — other `image/*` (HEIC, SVG, TIFF) stays path-only and the note says why.
A DM of nothing but attachments starts a task in `DEFAULT_REPO` (describe-and-
wait prompt) instead of falling through to help; with no `DEFAULT_REPO` the
bridge replies with the local paths.

## Attachments out

Agents answer into Slack, where a filesystem path is dead text. Two halves, both
in `bridge.ts`:

- the `attach_file` host tool (beside `ask` in `setHostTools`) — `paths[]` +
  optional `comment`, ≤10 files, ≤32MB each, uploaded as ONE Slack message via
  `slack.uploadFiles`. A bad path becomes a note in the tool result, never a
  failed batch.
- `prompts/slack-reply.md`, appended to every spawn's system prompt with
  `--append-system-prompt` (so it covers steers too, and never shows up as
  user text): attach images, keep the answer under `FINAL_INLINE_MAX` (2900) or
  the bridge uploads it as `response.md`, never answer by pointing at a file,
  absolute paths only.

Editing those prompts is how you change agent reply behavior — they are deployed
assets, so `install.sh` copies the `prompts/` subtree and a missing file stops the
daemon at startup rather than silently dropping the guidance.

## Repo aliases reach the agent

`REPOS` (from `.env`, `process.env` winning) is passed to three places, and the
third is the one that gets forgotten:

1. the literal command parser — `run <alias> …` via `#resolveDir`;
2. the router — `--repos "alias=path,…"`, the only legal values for its `dir`;
3. **the agent itself** — `repoInventory()` renders `prompts/slack-repos.md`
   (`{{repos}}` → one `alias → path` line each, the task's own cwd marked) and
   joins it onto `SLACK_REPLY_GUIDANCE` in the single `--append-system-prompt`
   the spawn passes. That flag is last-wins, not repeatable, so it MUST stay one
   string. No aliases configured → the section is omitted entirely.

Without (3) the agent has the alias in the user's words but not its path, so
"check what shuttle does here" turns into a filesystem hunt. New repo in `REPOS`
is picked up by every task spawned after the daemon restarts.

## Adding a command

Four places, and the last three are what people forget:

1. the literal chain in `#handleTopLevel` (`bridge.ts`);
2. `HELP_TEXT`;
3. a `#cmdX` method implementing it;
4. **if the router should be able to pick it** — a matching tool in
   `router/tools/commands.ts`, a `RouterDecision` variant in `types.ts`, and a
   case in `parseDecision` / `#dispatchDecision`.

Skipping (4) is not a bug in the model: an unregistered command is invisible to
it, so free-form phrasing falls through to help.

## Gotchas

- **Socket Mode has no backlog.** A DM sent while the bridge is down is never
  delivered and never retried. The catch-up sweep re-reads DM history and
  covers **top-level DMs only** — a steer typed into a task thread during an
  outage is gone; retype it.
- **`omp --agent <name>` is the whole agent selection.** omp resolves the name
  against `<repo>/.omp/agents/`, then `~/.omp/agent/agents/` — note the `agent`
  segment; `~/.omp/agents` is not an omp scan root — and applies that file's model,
  thinking level, tools and system-prompt body. Unknown name → omp exits 2, so the
  bridge only ever passes a name it read off disk itself. `orchestrate` additionally
  prefixes the prompt with `orchestrate: `, because the identity comes from the
  `orchestrator-identity` skill, not the agent file: with no `orchestrate.md` the
  prefix still goes out and the default worker reads the skill.
- **Steers bypass the router entirely** — never debug a mis-routed thread reply
  as a router problem; check whether the thread has a bound session instead.
- **The task header is edited, not posted complete.** `#startTask` posts it
  before the child exists and `#spawn` edits session id / path / model in from
  the post-handshake `get_state`. The id shown is parsed out of
  `<timestamp>_<id>.jsonl` (`sessionIdOf`) — the id `omp --resume <id>` accepts —
  never `get_state.sessionId`, which is the *provider* session id and can
  diverge. A header stuck without an id means `get_state` never answered.
- **The agent is chosen at spawn, never mid-session.** Literal `run` takes omp's
  default worker and literal `orchestrate` the `orchestrate` agent; only a *routed*
  message can pick another, from the inventory on disk. RPC does expose `set_model`
  / `cycle_model` / `get_available_models` (`docs/rpc.md`), but `omp-rpc.ts`
  implements none of them — switching a live session's model would need those
  methods plus an in-thread command. Today the answer to "run this as X" is a new
  task.
- **Project memory is omp's, not the bridge's.** Every spawn gets
  `~/.omp/agent/memories/<encoded cwd>/memory_summary.md` + `learned.md` injected
  by omp's own system-prompt build, keyed on the task's cwd — so each `REPOS`
  alias has its own memory and the bridge passes nothing.
- Restarting picks up redeployed code, never new OAuth scopes: a manifest scope
  change needs a workspace reinstall (user action).
