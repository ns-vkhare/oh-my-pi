---
name: omp-cleanup
description: Tear down and restart the local omp runtime — hub/view tmux sessions, live agent processes, and the Slack bridge launchd daemon — after redeploying backend code or bridge changes. Use when the user says "close all omp sessions", "clean up omp", "restart the slack daemon/bridge", or when patched code is not taking effect because old processes are still running.
---

# omp Cleanup

Patching source does **not** restart what is already running. A hub backend, a
live agent session, and a bridge-owned `--mode rpc` child each hold the module
graph they booted with; the fix only lands after they are killed and respawned.

**Restarting picks up redeployed code — never new OAuth scopes.** A Slack
manifest scope change needs a workspace reinstall (user action); no amount of
restarting grants it.

## Prime directive: do not kill yourself

You run *inside* a pane of an `omp-hub-*` tmux session. Killing that session
kills the agent mid-task.

```sh
echo $$                                     # your pid
tmux list-panes -a -F '#{session_name} win#{window_index} pid=#{pane_pid}'
```

Match your pid to a `session_name`. That hub session and the `omp-view-*`
mirroring it are **off limits**; everything else is fair game. Kill sibling
windows inside your own hub individually, never the hub session itself.

Also: NEVER kill an **attached** view (`tmux ls` marks it `(attached)`) — that
is the user's terminal.

## Inventory first

```sh
tmux ls
tmux list-panes -a -F '#{session_name} | win#{window_index} #{window_name} | pane_pid=#{pane_pid} | #{pane_title}'
pgrep -fl bridge.ts                         # slack bridge daemon
pgrep -P <bridge_pid>                       # its --mode rpc children
```

`pane_title` carries the session name (`π: <name>`), so you can tell an agent
pane from a hub UI pane (`hub` window, title is the hub id) before killing it.

## Teardown order

1. **SIGTERM the agent processes.** Transcripts flush; the pane exits and tmux
   closes the window on its own.
   ```sh
   /bin/kill -TERM <pid>
   ```
   The embedded shell's `kill` builtin rejects multiple pids
   (`kill: too many jobs or processes specified`) — call `/bin/kill` **once per
   pid**, chained with `;`.
2. **Kill view sessions, then their hub sessions** (views first: a view holds
   linked windows).
   ```sh
   tmux kill-session -t omp-view-<slug>-<id> ; tmux kill-session -t omp-hub-<slug>
   ```
3. **Restart the Slack bridge last**, so its startup catch-up sweep runs against
   a settled system.
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.omp.slack-bridge
   ```
   `kickstart -k` restarts regardless of exit code; the daemon reaps its own RPC
   children (verify — do not leave orphans).

## Verify

```sh
tmux ls                                     # only your hub + attached view
pgrep -fl bridge.ts                         # exactly one, new pid
tail -5 ~/.omp/slack-bridge/bridge.log      # fresh "bridge up — …", no "fatal:"
ps -o pid,command -p <old_rpc_child_pid>    # empty
```

Control-plane probe — `nc -U` returns nothing against this socket; use a
JSONL client over the Unix socket instead (`{"op":"ping"}` → `{ok, pid}`,
`{"op":"status"}` → live tasks):

```js
const net = await import("node:net");
const c = net.createConnection(`${process.env.HOME}/.omp/slack-bridge/bridge.sock`);
c.on("connect", () => c.write('{"op":"status"}\n'));
c.on("data", d => { console.log(d.toString()); c.end(); });
```

`ping.pid` MUST equal the new `bridge.ts` pid — a mismatch means a stale socket
file or a second instance.

## What survives, by design

- **Session transcripts** — `~/.omp/agent/sessions/**.jsonl`, written
  incrementally; SIGTERM loses nothing already streamed.
- **Bridge `state.json`** — task registry + per-channel catch-up watermarks. A
  task whose RPC child you killed stays registered and respawns on the next
  Slack activity in its thread.
- **Slack threads** — thread ↔ session bindings are in `state.json`, not in
  process memory.

## Reinstall-required changes (not a restart)

Scope/manifest edits, token rotation, and app reinstalls are **user-gated**:
propose, get explicit permission, then act. After the user completes an install,
confirm with the granted-scope header rather than the manifest:

```js
const r = await fetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${tok}` } });
r.headers.get("x-oauth-scopes");            // truth for the *issued* token
```

The live manifest can declare a scope the issued token does not carry.
