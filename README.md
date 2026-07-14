<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="omp">
</p>

<p align="center">
  <strong>A coding agent with the IDE wired in — this fork adds a tmux session hub and auto-worktree isolation.</strong>
</p>

<p align="center">
  Fork of <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> (<code>omp</code>) by <a href="https://github.com/can1357">@can1357</a>, itself a fork of <a href="https://github.com/badlogic/pi-mono">Pi</a> by <a href="https://github.com/mariozechner">@mariozechner</a>.
</p>

---

> **This README only covers what this fork adds.** For the full picture — the 40+ providers, 32 built-in tools, LSP/DAP integration, hashline edits, subagents, collab, memory, and everything else that makes `omp` what it is — read the [upstream README](https://github.com/can1357/oh-my-pi#readme) and [omp.sh](https://omp.sh). Nothing below replaces that; it sits on top of it.

## What this fork adds

### Agent Hub — `omp hub`

A tmux-supervised session multiplexer (Claude-Code "agent view" model). One background tmux session per project supervises the hub; window 0 hosts the hub TUI and every `omp` conversation runs in its own window. Unselected sessions **keep running in the background** — select one to foreground it, tap `←` on an empty editor to send it back to the hub.

<video src="https://github.com/ns-vkhare/oh-my-pi/raw/develop/assets/agent-hub.mov" controls muted width="100%"></video>

> If the player above doesn't load, [watch the recording ↗](https://github.com/ns-vkhare/oh-my-pi/raw/develop/assets/agent-hub.mov).

- **Styled like the welcome pane** — a two-column rounded box: OMP logo + active model + session count on the left, the selectable session list on the right, and a live composer (visible cursor, drag-and-drop image attach) below that dispatches a new session by default.
- **Navigation** — `↑`/`↓` select, `Enter`/`→` foreground the selected session (or dispatch when the editor has text), `Esc` detaches the hub.
- **Delete a session** — `Ctrl+X` arms the selected row (turns red with a confirm hint), `Ctrl+X` again kills its live window and removes the session file + artifacts. If the session owns a git worktree, the hub then offers to delete that too.
- **Per-project isolation** — the hub's tmux session name is scoped per project directory (`omp-hub-<project>-<hash>`), so concurrent `omp hub` runs in different projects never mirror each other. A re-run in the same project reattaches to its existing background hub.
- **`omp hub list`** — enumerate every active hub across projects: session name, supervised directory, live-session count, attach state, and last activity, with the current project's hub marked.
- **Auto-reap** — a backgrounded session idle > 24h has its window killed and reverts to an idle row; returning to it respawns fresh via `omp --resume`.

### Auto worktree detection & isolation

Parallel hub sessions must not stomp each other in the same working tree, so the fork makes worktree isolation the default:

- **On dispatch**, a session started fresh from `omp hub` is instructed to create a **new git worktree** for its task before touching files (unless the prompt explicitly names a worktree/branch/tree, or the repo isn't a git repo). Resumed sessions are unaffected — gated on `OMP_HUB_NEW_SESSION`.
- **On delete / status**, the hub *recovers* a session's worktree even though no explicit link is stored (the `omp` process stays in the project root while the agent works in a sibling worktree). It reconstructs the worktree from the session header cwd and every `git worktree add` the agent ran (quote-aware tokenizer), verified against `git worktree list` so the primary checkout is never touched.
- **The status line follows the worktree** — path and git (branch/status/PR) segments resolve the session's own worktree (background-resolved, cached per session file, gated to hub windows), falling back to the project root's branch when the session has none.

### Bedrock: silent AWS SSO token refresh

An expired `~/.aws/sso/cache` token is now renewed transparently via the SSO-OIDC `CreateToken` API using the cached refresh token + client registration (matching the AWS SDK/CLI), instead of failing with *"Run aws sso login to refresh."* The error is surfaced only when the refresh token or client registration is itself missing/expired; a transient failure on a still-valid token falls back to the existing token.

## Build & install from source

This fork is not published to npm — build it from source. Requires [Bun](https://bun.sh) ≥ 1.3.14.

```sh
git clone https://github.com/ns-vkhare/oh-my-pi.git
cd oh-my-pi

# Install workspace deps + build the Rust/N-API native addon (@oh-my-pi/pi-natives).
bun setup

# Run the source CLI.
bun dev

# Non-interactive smoke check.
bun dev -- --version

# Open the session hub.
bun dev -- hub
```

`bun setup` installs Bun workspaces and builds `@oh-my-pi/pi-natives`. Re-run `bun run build:native` after changing any Rust crate or `packages/natives`. Use `bun check` (never `tsc`) for type-checking.

To install a runnable `omp` binary onto your `PATH` from this tree, build and link it:

```sh
bun run build          # produce the bundled CLI
bun link               # expose `omp` from this checkout
```

For architecture and contribution guidelines, see [packages/coding-agent/DEVELOPMENT.md](packages/coding-agent/DEVELOPMENT.md).

## Everything else

This fork tracks [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi). For install via the official channels, the complete feature tour, provider/model routing, the tool reference, SDK/RPC/ACP entry points, and the monorepo package map, use upstream:

- **Docs & downloads** — [omp.sh](https://omp.sh)
- **Upstream README** — [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi#readme)
- **Upstream changelog** — [packages/coding-agent/CHANGELOG.md](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).

© 2025 Mario Zechner · © 2025-2026 Can Bölük
