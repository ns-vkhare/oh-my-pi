# omp Slack bridge — workspace setup (for Neeraj / workspace admins)

The omp bridge lets each engineer dispatch and steer **their own local omp
coding agents** from Slack DMs: `run <repo> <prompt>` in a DM starts an agent
on their machine, agent questions come back as Block Kit buttons, thread
replies steer the session. Transport is Slack **Socket Mode** — no public
URLs, no inbound network exposure, nothing hosted.

## Architecture decision: one app per user (not one shared app)

A single shared app cannot serve per-user local daemons:

1. **Socket Mode load-balances.** Each event is delivered to exactly ONE of an
   app's open connections. With N teammates' daemons connected to one app,
   a user's DM lands on a random teammate's daemon and is dropped by that
   daemon's allowlist. Messages are silently lost by design.
2. **Tokens are app-wide.** One app = one shared `xoxb`+`xapp` pair. Every
   holder can post as the bot and — because `im:history` means "DMs with this
   bot", not "my DMs" — read every user's traffic with the bot. Cross-user
   gating by configuration is impossible; possession of the token is the
   permission.

Per-user apps make isolation structural instead of procedural: each engineer's
bot receives only their own DMs, their tokens never leave their machine, and
their bridge daemon additionally allowlists their own member ID. Same model as
nomad-cc's "routing is local" principle, extended to tokens.

## What each engineer does (self-serve, ~5 min)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App**
   → **From a manifest** → pick the Netskope workspace → paste the manifest
   below, replacing `<username>` in both name fields.
2. **Basic Information → App-Level Tokens** → generate a token with scope
   `connections:write` → this is `SLACK_APP_TOKEN` (`xapp-…`).
3. **Install App** → install to workspace (this may queue an admin approval —
   see below) → copy the **Bot User OAuth Token** → `SLACK_BOT_TOKEN`
   (`xoxb-…`).
4. Tokens go into `~/.omp/slack-bridge/.env` on their machine (chmod 600),
   together with their own Slack member ID as `SLACK_ALLOWED_USERS`.
5. Run the bridge daemon locally (`bun start` in `~/.omp/slack-bridge`).

## Manifest (per user — replace `<username>`)

```json
{
  "display_information": {
    "name": "omp bridge (<username>)",
    "description": "Dispatch and steer local omp coding agents from Slack",
    "background_color": "#1a1d21"
  },
  "features": {
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "omp-<username>",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "im:history",
        "im:write",
        "users:read",
        "files:read",
        "files:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "message.im"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "socket_mode_enabled": true,
    "org_deploy_enabled": false,
    "token_rotation_enabled": false
  }
}
```

## What admins are approving (risk profile)

- **Scopes are DM-only.** `chat:write`, `im:history`, `im:write`, `users:read`,
  `files:read`, `files:write`. No channel read scopes, no `channels:history`,
  no admin scopes. The bot cannot see any conversation except direct messages
  sent to it. `files:read`/`files:write` cover files in those DMs only: reading
  an attachment the user sent the bot, and uploading long agent outputs back as
  snippets into the bot DM thread.
- **Only `message.im` events.** The app is deaf to channels, mentions, and
  every other workspace surface.
- **No hosting, no data egress path.** Socket Mode = outbound WebSocket from
  the engineer's Mac to Slack. Content flows Slack ↔ that engineer's own
  machine only.
- **Command execution is machine-local and double-gated.** The daemon ignores
  every Slack user except the IDs in its local allowlist (typically just the
  machine owner), and only starts agents in directories from its local repo
  map. A teammate DMing someone else's bot gets silence.
- **Blast radius per app = one user.** Compromised token ⇒ attacker can DM
  that one bot / read that one bot's DMs. Revoking one person's app touches
  nobody else — the exact failure-isolation nomad-cc's shared token lacks.
- Suggested convention for tracking approvals: app name `omp bridge (<username>)`,
  one per engineer, owner = that engineer.

## Neeraj's actual TODO

1. If the workspace restricts app installs: approve `omp bridge (<username>)`
   requests matching the manifest above (verify scopes match the list — reject
   anything asking for channel scopes).
2. Optionally pre-bless the manifest by sharing this doc + the bridge repo
   path (`~/.omp/slack-bridge` setup, README inside) on the team wiki.
3. Nothing to host, no tokens to distribute, no shared secret to rotate —
   unlike nomad-cc there is deliberately no central component.

## Relationship to nomad-cc

Complementary, not a replacement. nomad-cc stays the write-only notifier for
Claude Code (`Stop`/`Notification` hooks → private channel). The omp bridge
covers the interactive loop (dispatch/steer/answer) for omp agents, which a
write-only shared bot cannot do (no Socket Mode, no events, no interactivity,
and extending the shared token to receive commands would invert its security
model). Both bots can be invited to the same private channel.
