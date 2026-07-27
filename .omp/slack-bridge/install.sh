#!/usr/bin/env bash
# Install (or update) the omp Slack bridge from this repo checkout into the
# user-local runtime dir. Code is copied; runtime state and secrets in the
# destination (.env, state.json) are always preserved.
#
# Usage: bash install.sh [dest]   (default dest: ~/.omp/slack-bridge)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-$HOME/.omp/slack-bridge}"

FILES=(
	types.ts omp-rpc.ts slack.ts blocks.ts registry.ts bridge.ts smoke.ts
	omp-rpc.test.ts slack.test.ts bridge.test.ts
	manifest.json .env.example README.md DESIGN.md TEAM-SETUP.md
	package.json tsconfig.json
)

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
	cp "$SRC/$f" "$DEST/$f"
done

if [[ ! -f "$DEST/.env" ]]; then
	cp "$SRC/.env.example" "$DEST/.env"
	chmod 600 "$DEST/.env"
	echo "created $DEST/.env from template — fill in SLACK_APP_TOKEN, SLACK_BOT_TOKEN, SLACK_ALLOWED_USERS"
else
	echo "kept existing $DEST/.env"
fi

if command -v bun >/dev/null 2>&1; then
	(cd "$DEST" && bun install --silent)
else
	echo "WARNING: bun not found on PATH — install bun, then run 'bun install' in $DEST" >&2
fi

echo "installed to $DEST"
echo "next: create your Slack app from manifest.json (see README.md), then: cd $DEST && bun start"
