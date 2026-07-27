# omp slack bridge

Dispatch and steer local [omp](https://github.com/can1357/oh-my-pi) coding agents from Slack DMs.

Source of truth lives in the oh-my-pi repo at `.omp/slack-bridge/`. Install or
update the local runtime copy (preserves your `.env` and task state):

```sh
bash ~/oh-my-pi-src/.omp/slack-bridge/install.sh   # → ~/.omp/slack-bridge
```

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
