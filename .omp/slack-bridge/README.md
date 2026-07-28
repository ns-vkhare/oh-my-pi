# omp slack bridge

Dispatch and steer local [omp](https://github.com/can1357/oh-my-pi) coding agents from Slack DMs.

Source of truth lives in the oh-my-pi repo at `.omp/slack-bridge/`. Install or
update the local runtime copy (preserves your `.env` and task state):

```sh
bash ~/oh-my-pi-src/.omp/slack-bridge/install.sh   # → ~/.omp/slack-bridge
```

## Quick start (already set up?)

```sh
bash install.sh --daemon    # install/update + run at login
```

Then DM the **omp** bot:

```
run omp fix the flaky watcher test in packages/tui
```

The bot replies **in a thread on your message**, and everything about that task
happens in that thread.

## Setup

1. **Create the Slack app** — go to [api.slack.com/apps](https://api.slack.com/apps) → *Create New App* → *From a manifest* → pick your workspace → paste the contents of `manifest.json`.
2. **App-level token** — *Basic Information* → *App-Level Tokens* → *Generate Token and Scopes* with the `connections:write` scope. Copy the `xapp-…` token → `SLACK_APP_TOKEN`.
3. **Install** — *Install App* → install to workspace → copy the *Bot User OAuth Token* (`xoxb-…`) → `SLACK_BOT_TOKEN`.
4. **Allowlist yourself** — in Slack, open your profile → three-dot menu → *Copy member ID* → `SLACK_ALLOWED_USERS` (comma-separated for multiple users).
5. **Configure**:

   ```sh
   cp .env.example .env
   # fill in tokens, allowed users, repos
   ```

6. **Run**:

   ```sh
   bun start
   ```

   Or keep it alive via launchd — `~/Library/LaunchAgents/com.omp.slack-bridge.plist`:

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>Label</key><string>com.omp.slack-bridge</string>
     <key>ProgramArguments</key>
     <array>
       <string>/opt/homebrew/bin/bun</string>
       <string>bridge.ts</string>
     </array>
     <key>WorkingDirectory</key><string>/Users/YOU/.omp/slack-bridge</string>
     <key>KeepAlive</key><true/>
     <key>StandardErrorPath</key><string>/Users/YOU/.omp/slack-bridge/bridge.log</string>
   </dict>
   </plist>
   ```

   Then `launchctl load ~/Library/LaunchAgents/com.omp.slack-bridge.plist`.

   **Pre-flight (no Slack needed)** — validate the omp RPC side first:

   ```sh
   bun smoke.ts        # plain dispatch round-trip
   bun smoke.ts --ask  # ask-tool relay (the button-question path)
   ```

## Commands

### Top-level DM (start / find work)

| Command | What it does |
|---|---|
| `run <alias\|path> <prompt…>` | Start a new omp task in the repo mapped to `<alias>` (see `REPOS` in `.env`) or an absolute path under `$HOME`. The bot threads its reply under your message — everything about the task happens in that thread. With `DEFAULT_REPO` set, `run <prompt>` alone targets it. |
| `orchestrate <alias\|path> <prompt…>` | Like `run`, but the agent takes omp's **orchestrator** identity (decompose the work, fan out subagents) and runs on the orchestrator's pinned model instead of omp's default. Same dir rules as `run`. |
| `sessions [alias]` | Browse **every** omp session on disk — newest 8 per configured repo (or just `<alias>`), numbered. Badges: ⚡ `live·slack` (running under the bridge), 🔗 (already has a thread). |
| `resume <n>` | Attach session `n` from the last `sessions` listing to a new thread, with full context. |
| `resume <sessionPath>` | Same, by explicit `.jsonl` path. Already-attached sessions link back to their existing thread instead of double-attaching. |
| `status` | Bridge health: live tasks, registry size. |
| `help` (or anything else) | This command list. |

### Inside a task thread (drive the task)

| Message | What it does |
|---|---|
| any text | Steers the running turn, continues an idle task, or — if the agent asked a free-text question — answers it. A parked/reaped task is resumed automatically with full context. |
| *(click a button)* | Answers the agent's multiple-choice question. |
| `abort` | Abort the current turn (running subagents keep going; their results arrive next turn). |
| `kill` | Stop the task's omp process. The session survives — reply again later to resume it. |
| `status` | Task state: model, streaming, context usage, session file. |

Sessions are standard omp sessions — they also appear in `omp hub` (badged
`live · slack` while the bridge owns them), can be watched read-only with
`omp --watch <sessionPath>`, and taken over in the terminal with `omp --resume`
(the bridge parks its task and posts a handoff note to the thread). Inside the
watcher, `alt+a` lists the task's subagents — live status and current task come
from the bridge — and Enter switches the tail to one of them; Esc returns to the
main transcript.

### Example: dispatch, answer a question, get the result

```
you   run omp add a --json flag to the sessions command
bot   └ ▶ slack:add a --json flag to the sessions command   (in a thread on your message)
bot     ⏳ starting → 🛠️ working  💭 Checking how sessions is listed today  ⏵ read  💭 Picking the output shape  ⏵ edit
bot     ❓ Pick an output shape:   [array of objects] [NDJSON]
you   (click "array of objects")
bot     ✅ array of objects — @you
bot     Done — sessions --json emits a single array; test added. (full diff in response.md)
```

The status line keeps the last four things the agent did: `💭` lines are what it
is reasoning about (headline or newest sentence, refreshed at most every 2s),
`⏵` lines are tool calls.

### Example: steer mid-task

```
you   (reply in thread) also cover the --dir flag in the test
bot   ➕ steering delivered — agent will pick it up between tool calls
```

### Example: send a file along

```
you   run omp summarize this resume against the JD  📎 vivek.pdf
bot   └ ▶ slack:summarize this resume against the JD
bot     (the agent gets a local copy of vivek.pdf and reads it)
```

Attachments are downloaded with the bot token into `$TMPDIR/omp-slack-attachments/`
and their paths appended to the prompt. Files hosted outside Slack (Google Drive,
Box) cannot be fetched by the bot — they are passed through as links, named so the
agent knows what it could not read. This needs the `files:read` bot scope: if you
created the app before that scope existed, re-paste `manifest.json` under
*App Manifest* and reinstall the app.

### Missed messages

Slack keeps no backlog for Socket Mode apps, so a DM sent while the bridge is
down — or while its socket is silently dead — is never delivered. The bridge
re-reads recent DM history on startup and every 2 minutes and runs anything it
never answered (window: `CATCHUP_WINDOW_MIN`, default 60 minutes; each message
is answered at most once). Replies typed *inside a task thread* during an outage
are not recoverable — Slack keeps thread replies out of channel history — so
retype those.

### Example: long output

Final answers over ~3k chars arrive as a rendered `response.md` snippet in the
thread instead of a wall of text.

### Example: continue an old task days later

```
you   (reply in the same thread) did the tests stay green after the rebase?
bot   ⏸ session was parked — resuming with full context…
bot   🛠️ working  ⏵ bash
bot   Yes — 32/32 pass on current develop.
```

### Example: terminal session pings you

```
bot   ✅ oh-my-pi-src: turn finished — "Refactored the hub reaper; ready for review."
you   (reply) run the full test suite before I look
bot   (session resumes under Slack, runs it, replies in the same thread)
```

## Router (optional)

Talk to the bridge in plain English instead of remembering the command list:
"start a task in omp to fix the flaky watcher test" is classified into
`run omp fix the flaky watcher test` by a **local** model — the message never
leaves your machine.

Prerequisites:

- Shuttle running on `127.0.0.1:8780`, serving the model.
- `pi` and `jq` on `PATH`.
- a `shuttle` provider in `~/.pi/agent/models.json` with that model id
  registered under it.

Turn it on in `.env` (then restart the bridge):

```sh
ROUTER_MODEL=shuttle/gemma-4-26b
```

Test it by hand — this prints exactly one JSON line:

```sh
echo "start a task in omp to fix the flaky test" \
  | .omp/slack-bridge/router/route.sh --model shuttle/gemma-4-26b --repos "omp=$HOME/oh-my-pi-src"
```

Turn it off by unsetting `ROUTER_MODEL` — empty is the default. Two things stay
true either way: a message whose first token is already a command (`run`,
`orchestrate`, `sessions`, `resume`, `status`, `help`) is dispatched literally
and never reaches the model, and a router that is off, down, slow, or confused
falls back to that same literal parser. A dead local model can never swallow a
message. Replies inside a task thread are steers and skip the router entirely.

## Terminal session notifications

`install.sh` also drops a `slack-notify` extension into `~/.omp/agent/extensions/`,
so *every* omp session (including ones you start in a terminal) pings this bridge
when a turn finishes or an agent asks a question — the notification lands as a
Slack thread you can then reply into to steer the session. It is fail-soft: if the
bridge is down every notify is a silent no-op and the session never blocks.

## Run at login

`bash install.sh --daemon` installs and loads a launchd user agent
(`~/Library/LaunchAgents/com.omp.slack-bridge.plist`, logs to `bridge.log`) that
keeps the bridge alive across logins. Without `--daemon`, an interactive install
asks before setting it up.
