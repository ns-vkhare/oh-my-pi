#!/usr/bin/env bash
# ---
# name: route.sh
# brief: Classify one Slack message into a single bridge command (local model via Shuttle).
# description: |
#   Spawns a restricted omp session on a Shuttle-served local model whose only
#   tools are the five bridge commands (run, sessions, resume, status, help).
#   The model calls exactly one of them; that call IS the routing decision. An
#   orchestration request is a `run` with `agent: orchestrate`, not a command of
#   its own. The worker's fixed role comes from prompts/entry.md and
#   the tools from tools/commands.ts; the Slack message arrives on STDIN and is
#   passed as the user turn, never as an argv word — it is untrusted text.
#
#   The harness is omp, not pi, so a routing run is an ordinary omp session:
#   its transcript lands in omp's own session tree and the omp plugins —
#   cc-callbacks above all — audit it exactly like an agent session.
#
#   stdout carries EXACTLY ONE line — the decision as compact JSON — or nothing
#   at all. Everything else (health failures, timeouts, omp's own stderr, an
#   empty extraction) goes to stderr. The caller parses stdout blindly and
#   falls back to its literal parser on any non-zero exit, so a dead or
#   confused model can never swallow a Slack message.
#
#   The decision carries a `trace` object alongside the command: `turns` (how
#   many turns the worker took) and `summary` (its own three-line account of the
#   routing, i.e. the post-tool reply entry.md asks for). Both are read out of
#   the same event stream, cost no extra model call, and are never allowed to
#   cost a decision — see the harvest at the bottom.
# arguments: "--model <spec> [--omp-bin <path>] [--repos \"a=p,b=q\"] [--default-repo <alias>] [--agents \"name: description\\nname: description\"] [--attachments \"a.png (image/png)\"] [--session-dir <dir>] [--timeout <sec>]  # message on stdin"
# ---
#
# Usage:
#   echo "run omp fix the flaky test" | route.sh --model shuttle/gemma-4-26b --repos "omp=/Users/x/oh-my-pi-src"
#
# Options:
#   --model <spec>        Model to route through Shuttle. A full provider/model
#                         id (e.g. shuttle/gemma-4-26b) is used verbatim; a bare
#                         name resolves to shuttle/<name>. Required.
#   --omp-bin <path>      omp binary to run (default: $OMP_BIN, else `omp`).
#   --repos <list>        Comma-separated alias=path pairs offered to the model
#                         as the legal values for `dir`. May be empty.
#   --default-repo <a>    Alias the bridge falls back to when `dir` is omitted.
#   --agents <text>       The agents installable on this box, ONE argv value
#                         holding newline-separated `name: description` lines,
#                         offered as the legal values for `agent` on run. May be
#                         empty or absent, in which case agents are never
#                         mentioned and the router never picks one.
#   --attachments <list>  One-line inventory of the message's attachments (names
#                         and types only — the model never sees bytes or paths).
#                         Without it an uncaptioned screenshot reads as ambiguity.
#   --timeout <seconds>   Kill the worker after N seconds (default: 60).
#   --session-dir <dir>   Where to persist this routing run's transcript. The
#                         bridge points it at `<repo session dir>/router` so gemma
#                         runs sit in the same tree as the agent sessions they
#                         start without crowding the resumable listing. omp has no
#                         session-name flag, so the directory is the marker.
#                         Default: omp's own per-cwd session dir.
#
# Notes:
#   Requires Shuttle (or a compatible local server) serving the target model at
#   http://127.0.0.1:8780/v1, a `shuttle` provider in ~/.omp/agent/models.yml,
#   and jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OMP_BIN_ARG=""
MODEL=""
REPOS=""
DEFAULT_REPO=""
AGENTS=""
ATTACHMENTS=""
TIMEOUT=60
SESSION_DIR=""
SHUTTLE_ENDPOINT="${SHUTTLE_ENDPOINT:-http://127.0.0.1:8780}"

PROMPT_FILE="$SCRIPT_DIR/prompts/entry.md"
COMMANDS_TOOL="$SCRIPT_DIR/tools/commands.ts"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)        MODEL="$2"; shift 2 ;;
    --repos)        REPOS="$2"; shift 2 ;;
    --default-repo) DEFAULT_REPO="$2"; shift 2 ;;
    --agents)       AGENTS="$2"; shift 2 ;;
    --attachments)  ATTACHMENTS="$2"; shift 2 ;;
    --timeout)      TIMEOUT="$2"; shift 2 ;;
    --session-dir)  SESSION_DIR="$2"; shift 2 ;;
    --omp-bin)      OMP_BIN_ARG="$2"; shift 2 ;;
    *)              echo "route.sh: unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$MODEL" ]]; then
  echo "route.sh: --model is required" >&2
  exit 1
fi

if ! [[ "$TIMEOUT" =~ ^[1-9][0-9]*$ ]]; then
  echo "route.sh: --timeout must be a positive integer number of seconds" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_FILE" ]]; then
  echo "route.sh: system-prompt artifact not found: $PROMPT_FILE" >&2
  exit 1
fi

if [[ ! -f "$COMMANDS_TOOL" ]]; then
  echo "route.sh: command tool extension not found: $COMMANDS_TOOL" >&2
  exit 1
fi

# The message is untrusted user text, so it only ever travels on stdin and, from
# there, as a single argv value to omp's -p — never as shell-parsed words.
MESSAGE=$(cat)
if [[ -z "${MESSAGE//[[:space:]]/}" ]]; then
  echo "route.sh: empty message on stdin" >&2
  exit 1
fi

OMP="${OMP_BIN_ARG:-${OMP_BIN:-omp}}"
if ! command -v "$OMP" >/dev/null 2>&1 && [[ ! -x "$OMP" ]]; then
  echo "route.sh: omp binary not found: $OMP" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "route.sh: jq is required to extract the routing decision from omp's event stream" >&2
  exit 1
fi

# Resolve the model id: a full provider/model id is used verbatim, a bare name
# resolves against the `shuttle` provider.
case "$MODEL" in
  */*) MODEL_ID="$MODEL" ;;
  *)   MODEL_ID="shuttle/$MODEL" ;;
esac

# Pre-flight: Shuttle serves /healthz; a compatible bare llama-server serves
# /health. Accept either. A dead server must fail here, on stderr, so the caller
# falls back instead of waiting out the full timeout.
if ! curl -sf "$SHUTTLE_ENDPOINT/healthz" >/dev/null 2>&1 \
   && ! curl -sf "$SHUTTLE_ENDPOINT/health" >/dev/null 2>&1; then
  echo "route.sh: no model server responding at $SHUTTLE_ENDPOINT (tried /healthz and /health)" >&2
  exit 1
fi

# The user turn: the aliases the model may legally put in `dir`, what the message
# carried alongside its text, then the verbatim message.
if [[ -n "$REPOS" ]]; then
  USER_TURN="Repo aliases: ${REPOS//,/, }"
else
  USER_TURN="Repo aliases: (none configured)"
fi
if [[ -n "$DEFAULT_REPO" ]]; then
  USER_TURN="$USER_TURN"$'\n'"Default repo alias: $DEFAULT_REPO"
fi
if [[ -n "$AGENTS" ]]; then
  USER_TURN="$USER_TURN"$'\n'"Agents (pass one as \`agent\` on run, or omit it for the default worker):"$'\n'"$AGENTS"
fi
if [[ -n "$ATTACHMENTS" ]]; then
  USER_TURN="$USER_TURN"$'\n'"Attachments on this message: $ATTACHMENTS"
fi
USER_TURN="$USER_TURN"$'\n\n'"$MESSAGE"

# omp validates `--tools` against BUILTIN names only (extension tools are not
# registered at parse time), so naming the five commands there is an error —
# `--no-tools` is the omp spelling of the same intent: zero builtins, while
# extension-registered tools are always included (sdk.ts: "Custom tools and
# extension-registered tools are always included regardless of toolNames
# filter"). The routing surface is therefore exactly the five commands, and the
# prompt carries only their schemas.

# Extension/plugin discovery stays ON: cc-callbacks is an omp plugin and is what
# turns this run into an audited transcript. `--no-tools` still keeps every
# builtin out, so a discovered extension cannot hand the router a file-editing
# tool. OMP_SLACK_BRIDGE=1 marks the child as bridge-owned, which is what makes
# the slack-notify extension skip itself — without it every routing run would
# post a turn-end notification into Slack.
#
# `--bare-system-prompt` + omp-config.yml make prompts/entry.md the ENTIRE system
# prompt: no AGENTS.md context files, no PROJECT footer, no memory guidance, no
# MCP instructions, and no learn/manage_skill/mcp_* tools. Verified via
# `get_state`: one segment, byte-identical to entry.md, and exactly the five
# command tools (58k chars and 11 tools before).
#
# The session is persisted (no --no-session) into --session-dir, which the bridge
# points at a `router/` dir inside the repo's own session dir: same tree as the
# agent sessions it starts, one level down so it cannot crowd out `sessions`.
OMP_ARGS=(
  --model "$MODEL_ID"
  --no-tools
  --no-skills
  --bare-system-prompt
  --config "$SCRIPT_DIR/omp-config.yml"
  --extension "$COMMANDS_TOOL"
  --system-prompt "$PROMPT_FILE"
  --mode json
)
if [[ -n "$SESSION_DIR" ]]; then
  OMP_ARGS+=(--session-dir "$SESSION_DIR")
fi
OMP_ARGS+=(-p "$USER_TURN")

# omp's stderr is left attached to ours: it is diagnostics, and merging it into
# the captured stream would both hide it and pollute the event lines.
EXIT_CODE=0
OUTPUT=$(OMP_SLACK_BRIDGE=1 perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" "$OMP" "${OMP_ARGS[@]}") || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 142 ]]; then
  echo "route.sh: worker timed out after ${TIMEOUT}s" >&2
elif [[ $EXIT_CODE -ne 0 ]]; then
  echo "route.sh: omp exited $EXIT_CODE" >&2
fi

# omp exits 0 even when the model call itself fails (that surfaces as an
# assistant message with stopReason:"error"), and a killed worker may still have
# emitted its decision before dying. So the extraction — not the exit code — is
# what decides whether there is a decision. `-R … fromjson? // empty` keeps a
# stray non-JSON line from turning the whole extraction into a jq error.
DECISION=$(printf '%s\n' "$OUTPUT" \
  | jq -rc -R 'fromjson? // empty | select(.type=="tool_execution_end") | .result.content[]? | select(.type=="text") | .text' \
  | sed -n 's/^ROUTE //p' \
  | tail -1)

# Re-parse before emitting: stdout is load-bearing, so it carries a single valid
# compact JSON object or nothing.
DECISION=$(printf '%s' "$DECISION" | jq -c . 2>/dev/null || true)
if [[ -z "$DECISION" ]]; then
  echo "route.sh: no routing decision in worker output" >&2
  exit 1
fi

# The worker's own account of the run, harvested from the SAME event stream the
# decision came from, and attached to it as `trace` so the bridge can show the
# user why their message went where it did:
#
#   * `turns` — one per `turn_end`. Two is the healthy shape (the turn that calls
#     the command, then the turn that explains it); one means the model never got
#     to explain itself, and more means it argued with itself on the way.
#   * `summary` — the text of the LAST assistant message, i.e. the post-tool reply
#     prompts/entry.md asks for. That turn already happens today and its text was
#     discarded, so this costs nothing: no extra call, no extra latency. Emitted
#     as a JSON string (`jq -c`) so its newlines survive `tail -1` intact.
#
# Both are telemetry and MUST never cost a decision: TURNS is range-checked, and
# a failed enrichment leaves the plain decision standing rather than blanking it
# (an empty stdout would send the bridge to its literal parser over a cosmetic
# field). Clamping to three lines is the bridge's business — it owns the display
# contract — so nothing here truncates the model's text.
TURNS=$(printf '%s\n' "$OUTPUT" | jq -c -R 'fromjson? // empty | select(.type=="turn_end")' | wc -l | tr -d '[:space:]')
[[ "$TURNS" =~ ^[0-9]+$ ]] || TURNS=0
SUMMARY=$(printf '%s\n' "$OUTPUT" \
  | jq -c -R 'fromjson? // empty
      | select(.type=="message_end")
      | .message
      | select(.role=="assistant")
      | [.content[]? | select(.type=="text") | .text]
      | join("\n")
      | select(length > 0)' \
  | tail -1)
ENRICHED=$(printf '%s' "$DECISION" \
  | jq -c --argjson turns "$TURNS" --argjson summary "${SUMMARY:-null}" \
      '. + {trace: ({turns: $turns} + (if ($summary | type) == "string" then {summary: $summary} else {} end))}' \
      2>/dev/null || true)
if [[ -n "$ENRICHED" ]]; then
  DECISION="$ENRICHED"
fi

printf '%s\n' "$DECISION"
