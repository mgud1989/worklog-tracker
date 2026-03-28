#!/bin/bash
# ── Setup Global Claude Code Hooks ────────────────────────────────────────────
# Installs session-logger hooks into ~/.claude/settings.json
# so they run on EVERY project. Session logs are the foundation for tempo push.
# Toggl timer management is handled by Claude via SKILL.md instructions.
#
# Usage:
#   ./scripts/setup-global-hooks.sh          # install
#   ./scripts/setup-global-hooks.sh --remove # uninstall

set -euo pipefail

# ── Resolve project root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Paths ────────────────────────────────────────────────────────────────────
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
SESSION_LOGGER="$PROJECT_DIR/session-logger/session-logger.sh"

# ── Check for jq ─────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

# ── Remove mode ──────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--remove" ]]; then
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    echo "Nothing to remove: $CLAUDE_SETTINGS not found." >&2
    exit 0
  fi
  echo "Removing session-logger hooks from $CLAUDE_SETTINGS..."

  jq --arg marker "session-logger.sh" '
    if .hooks then
      .hooks |= with_entries(
        .value |= map(
          .hooks |= map(select(.command | contains($marker) | not))
        )
        | .value |= map(select(.hooks | length > 0))
      )
      | if (.hooks | to_entries | map(select(.value | length > 0)) | length) == 0
        then del(.hooks)
        else .hooks |= with_entries(select(.value | length > 0))
        end
    else .
    end
  ' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" \
    && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

  echo "Done. Session-logger hooks removed (other hooks preserved)."
  exit 0
fi

# ── Validate ─────────────────────────────────────────────────────────────────
if [[ ! -x "$SESSION_LOGGER" ]]; then
  echo "ERROR: session-logger.sh not found or not executable at:" >&2
  echo "  $SESSION_LOGGER" >&2
  exit 1
fi

if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
  echo "ERROR: $CLAUDE_SETTINGS not found. Is Claude Code installed?" >&2
  exit 1
fi

# ── Build hooks (session-logger only) ────────────────────────────────────────
HOOKS_JSON=$(cat <<ENDJSON
{
  "SessionStart": [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER start" } ] } ],
  "Stop": [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER activity" } ] } ],
  "SessionEnd": [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER stop" } ] } ]
}
ENDJSON
)

# ── Merge into settings.json ────────────────────────────────────────────────
echo "Installing session-logger hooks into $CLAUDE_SETTINGS..."

jq --argjson hooks "$HOOKS_JSON" '.hooks = $hooks' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" \
  && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

echo ""
echo "Hooks installed globally:"
echo "  session-logger: $SESSION_LOGGER"
echo ""
echo "Session logs run on ALL Claude Code sessions."
echo "Toggl timer is managed by Claude via worklog-tracker skill."
echo "To remove: $0 --remove"
