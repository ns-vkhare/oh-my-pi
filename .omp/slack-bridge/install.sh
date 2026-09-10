#!/usr/bin/env bash
# Install (or update) the omp Slack bridge from this repo checkout into the
# user-local runtime dir. Code is copied; runtime state and secrets in the
# destination (.env, state.json) are always preserved.
#
# Usage: bash install.sh [dest] [--daemon]   (default dest: ~/.omp/slack-bridge)
#   --daemon   install+load the launchd agent non-interactively (no prompt)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON=0
DEST=""
for arg in "$@"; do
	case "$arg" in
		--daemon) DAEMON=1 ;;
		*) DEST="$arg" ;;
	esac
done
DEST="${DEST:-$HOME/.omp/slack-bridge}"

FILES=(
	types.ts omp-rpc.ts slack.ts blocks.ts registry.ts bridge.ts smoke.ts
	router.ts agent-defs.ts
	omp-rpc.test.ts slack.test.ts bridge.test.ts blocks.test.ts
	router.test.ts agent-defs.test.ts
	slack-notify.extension.ts slack-notify.test.ts
	control.ts control.test.ts
	manifest.json .env.example README.md DESIGN.md TEAM-SETUP.md
	package.json tsconfig.json assets.d.ts
)

mkdir -p "$DEST"
for f in "${FILES[@]}"; do
	cp "$SRC/$f" "$DEST/$f"
done

# Front-door router worker (pi harness assets). A subtree, not a flat file, and
# route.sh must stay executable — bridge.ts defaults ROUTER_SCRIPT to the
# router/route.sh sitting next to the installed bridge module.
rm -rf "$DEST/router"
cp -R "$SRC/router" "$DEST/router"
chmod +x "$DEST/router/route.sh"

# Prompt assets bridge.ts imports as text. Missing here means the daemon fails to
# start, which is the intended loud failure: a bridge that silently spawns agents
# without the Slack reply guidance is the bug this directory exists to prevent.
rm -rf "$DEST/prompts"
cp -R "$SRC/prompts" "$DEST/prompts"

# Terminal-session notifier: loads in EVERY omp session, pings this bridge when
# a terminal turn ends / an agent asks. Code, not config — always overwrite.
EXT_DIR="$HOME/.omp/agent/extensions"
mkdir -p "$EXT_DIR"
cp "$SRC/slack-notify.extension.ts" "$EXT_DIR/slack-notify.ts"
echo "installed notifier extension to $EXT_DIR/slack-notify.ts"

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

# Optional: keep the bridge alive across logins via a launchd user agent.
install_launchd() {
	local bun_bin omp_bin plist label bin_path
	bun_bin="$(command -v bun || true)"
	if [[ -z "$bun_bin" ]]; then
		echo "cannot install launchd agent: bun not on PATH" >&2
		return 1
	fi
	omp_bin="$(command -v omp || true)"
	if [[ -z "$omp_bin" ]]; then
		echo "cannot install launchd agent: omp not on PATH (bridge needs it to spawn agents)" >&2
		return 1
	fi
	# launchd starts with a minimal PATH, so seed one covering the bun + omp
	# dirs and pin OMP_BIN to the absolute omp resolved at install time.
	bin_path="$(dirname "$bun_bin"):$(dirname "$omp_bin"):/usr/bin:/bin"
	label="com.omp.slack-bridge"
	plist="$HOME/Library/LaunchAgents/$label.plist"
	mkdir -p "$HOME/Library/LaunchAgents"
	cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun_bin</string>
    <string>bridge.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OMP_BIN</key><string>$omp_bin</string>
    <key>PATH</key><string>$bin_path</string>
$( [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && printf '    <key>NODE_EXTRA_CA_CERTS</key><string>%s</string>\n' "$NODE_EXTRA_CA_CERTS" )
$( [ -n "${SSL_CERT_FILE:-}" ] && printf '    <key>SSL_CERT_FILE</key><string>%s</string>\n' "$SSL_CERT_FILE" )
  </dict>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DEST/bridge.log</string>
  <key>StandardErrorPath</key><string>$DEST/bridge.log</string>
</dict>
</plist>
PLIST
	launchctl unload "$plist" >/dev/null 2>&1 || true
	launchctl load "$plist"
	echo "launchd agent installed and loaded: $plist"
}

# Restart the loaded launchd job onto freshly installed code — never killing
# live tasks (their sessions would drop mid-turn; parked ones resume fine).
restart_launchd_if_idle() {
	local label live_tasks
	label="com.omp.slack-bridge"
	live_tasks="$(bun -e "
		import { controlRequest } from \"$DEST/control\";
		try {
			const res = await controlRequest(\"$DEST/bridge.sock\", { op: \"status\" }, 1500);
			console.log(\"tasks\" in res ? res.tasks.length : 0);
		} catch { console.log(0); }
	" 2>/dev/null || echo 0)"
	if [[ "$live_tasks" == "0" ]]; then
		launchctl kickstart -k "gui/$(id -u)/$label" 2>/dev/null &&
			echo "restarted launchd bridge on the new code" ||
			echo "could not restart launchd bridge — run: launchctl kickstart -k gui/\$(id -u)/$label" >&2
	else
		echo "bridge busy ($live_tasks live task(s)) — restart when idle: launchctl kickstart -k gui/\$(id -u)/$label"
	fi
}

if [[ "$DAEMON" -eq 1 ]]; then
	install_launchd # unload+load already starts the new code
elif launchctl list "com.omp.slack-bridge" >/dev/null 2>&1; then
	# Agent already installed: this run is an update, not an onboarding — no
	# prompt, just bounce the daemon onto the new code when it's safe.
	restart_launchd_if_idle
elif [[ -t 0 ]]; then
	printf 'Install launchd agent so the bridge starts on login? [y/N] '
	reply=""
	read -r -t 30 reply || true
	case "$reply" in
		[yY]*) install_launchd ;;
		*) echo "skipped launchd agent (re-run with --daemon to install)" ;;
	esac
fi
