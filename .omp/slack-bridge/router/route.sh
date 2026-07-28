#!/usr/bin/env bash
# ---
# name: route.sh
# brief: Classify one Slack message into a single bridge command (local model via Shuttle).
# description: |
#   Spawns a restricted pi session on a Shuttle-served local model whose only
#   tools are the six bridge commands (run, orchestrate, sessions, resume,
#   status, help). The model calls exactly one of them; that call IS the
#   routing decision. The worker's fixed role comes from prompts/entry.md and
#   the tools from tools/commands.ts; the Slack message arrives on STDIN and is
#   passed as the user turn, never as an argv word — it is untrusted text.
#
#   stdout carries EXACTLY ONE line — the decision as compact JSON — or nothing
#   at all. Everything else (health failures, timeouts, pi's own stderr, an
#   empty extraction) goes to stderr. The caller parses stdout blindly and
#   falls back to its literal parser on any non-zero exit, so a dead or
#   confused model can never swallow a Slack message.
# arguments: "--model <spec> [--repos \"a=p,b=q\"] [--default-repo <alias>] [--timeout <sec>]  # message on stdin"
# ---
#
# Usage:
#   echo "run omp fix the flaky test" | route.sh --model shuttle/gemma-4-26b --repos "omp=/Users/x/oh-my-pi-src"
#
# Options:
#   --model <spec>        Model to route through Shuttle. A full provider/model
#                         id (e.g. shuttle/gemma-4-26b) is used verbatim; a bare
#                         name resolves to shuttle/<name>. Required.
#   --repos <list>        Comma-separated alias=path pairs offered to the model
#                         as the legal values for `dir`. May be empty.
#   --default-repo <a>    Alias the bridge falls back to when `dir` is omitted.
#   --timeout <seconds>   Kill the worker after N seconds (default: 60).
#
# Notes:
#   Requires Shuttle (or a compatible local server) serving the target model at
#   http://127.0.0.1:8780/v1, a matching `shuttle` pi provider entry, and jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODEL=""
REPOS=""
DEFAULT_REPO=""
TIMEOUT=60
SHUTTLE_ENDPOINT="${SHUTTLE_ENDPOINT:-http://127.0.0.1:8780}"

PROMPT_FILE="$SCRIPT_DIR/prompts/entry.md"
COMMANDS_TOOL="$SCRIPT_DIR/tools/commands.ts"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)        MODEL="$2"; shift 2 ;;
    --repos)        REPOS="$2"; shift 2 ;;
    --default-repo) DEFAULT_REPO="$2"; shift 2 ;;
    --timeout)      TIMEOUT="$2"; shift 2 ;;
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
# there, as a single argv value to pi's -p — never as shell-parsed words.
MESSAGE=$(cat)
if [[ -z "${MESSAGE//[[:space:]]/}" ]]; then
  echo "route.sh: empty message on stdin" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "route.sh: jq is required to extract the routing decision from pi's event stream" >&2
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

# The user turn: the aliases the model may legally put in `dir`, then the
# verbatim message.
if [[ -n "$REPOS" ]]; then
  USER_TURN="Repo aliases: ${REPOS//,/, }"
else
  USER_TURN="Repo aliases: (none configured)"
fi
if [[ -n "$DEFAULT_REPO" ]]; then
  USER_TURN="$USER_TURN"$'\n'"Default repo alias: $DEFAULT_REPO"
fi
USER_TURN="$USER_TURN"$'\n\n'"$MESSAGE"

# pi's --tools is a single allowlist over builtin AND extension tools, so an
# empty value ("") disables the six command tools along with the builtins and
# the model can never route. Verified against pi 0.80.7: with --tools "" the
# request carries no tool schemas (~544 prompt tokens, the model answers in
# prose); with the six names it carries them (~1200) and the model calls one.
# Naming them explicitly also pins the surface to exactly these six.
TOOLS="run,orchestrate,sessions,resume,status,help"

PI_ARGS=(
  --model "$MODEL_ID"
  --tools "$TOOLS"
  --no-extensions
  --no-context-files
  --no-skills
  --no-prompt-templates
  --no-session
  --extension "$COMMANDS_TOOL"
  --system-prompt "$PROMPT_FILE"
  --mode json
  -p "$USER_TURN"
)

# pi's stderr is left attached to ours: it is diagnostics, and merging it into
# the captured stream would both hide it and pollute the event lines.
EXIT_CODE=0
OUTPUT=$(perl -e 'alarm shift; exec @ARGV' "$TIMEOUT" pi "${PI_ARGS[@]}") || EXIT_CODE=$?
if [[ $EXIT_CODE -eq 142 ]]; then
  echo "route.sh: worker timed out after ${TIMEOUT}s" >&2
elif [[ $EXIT_CODE -ne 0 ]]; then
  echo "route.sh: pi exited $EXIT_CODE" >&2
fi

# pi exits 0 even when the model call itself fails (that surfaces as an
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

printf '%s\n' "$DECISION"
