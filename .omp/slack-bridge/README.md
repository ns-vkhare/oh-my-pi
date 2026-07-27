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

A thread opens for the task; everything about that task happens in its thread.

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

## Usage

DM the bot:

- `run <alias> <prompt>` — start an omp task in the repo mapped to `<alias>` (see `REPOS` in `.env`). Each task gets its own thread. With `DEFAULT_REPO` set, `run <prompt>` alone targets it.
- Reply **in the task's thread** to steer a running task, or to continue a finished one.
- `sessions` — list recent bridge sessions.
- `resume <sessionPath>` — resume a previous session.
- In a task thread: `abort`, `kill`, `status`.
- When the agent asks a question, answer with the **buttons** posted in the thread.

Sessions are standard omp sessions — they also appear in `omp hub`.

### Example: dispatch, answer a question, get the result

```
you   run omp add a --json flag to the sessions command
bot   ▶ slack:add a --json flag to the sessions command   (thread opens)
bot   ⏳ starting → 🛠️ working  ⏵ read ⏵ edit ⏵ bash
bot   ❓ Pick an output shape:   [array of objects] [NDJSON]
you   (click "array of objects")
bot   ✅ array of objects — @you
bot   Done — sessions --json emits a single array; test added. (full diff in response.md)
```

### Example: steer mid-task

```
you   (reply in thread) also cover the --dir flag in the test
bot   ➕ steering delivered — agent will pick it up between tool calls
```

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
