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
NUDGE_CLI="node $PROJECT_DIR/dist/cli.js nudge-check"

# ── Check for jq ─────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

# ── Remove mode ──────────────────────────────────────────────────────────────
# Removes BOTH the session-logger hooks AND the worklog-tracker nudge hook.
if [[ "${1:-}" == "--remove" ]]; then
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    echo "Nothing to remove: $CLAUDE_SETTINGS not found." >&2
    exit 0
  fi
  echo "Removing worklog-tracker hooks from $CLAUDE_SETTINGS..."

  # is_wt_hook takes its input via pipe (`.` = the command string) rather than
  # as a named parameter — jq requires parameterless defs when used with `|`.
  if ! jq '
    def is_wt_hook: contains("session-logger.sh") or contains("dist/cli.js nudge-check");
    if .hooks then
      .hooks |= with_entries(
        .value |= map(
          .hooks |= map(select(.command | is_wt_hook | not))
        )
        | .value |= map(select(.hooks | length > 0))
      )
      | if (.hooks | to_entries | map(select(.value | length > 0)) | length) == 0
        then del(.hooks)
        else .hooks |= with_entries(select(.value | length > 0))
        end
    else .
    end
  ' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"; then
    rm -f "${CLAUDE_SETTINGS}.tmp"
    echo "ERROR: jq failed to process $CLAUDE_SETTINGS — file untouched." >&2
    exit 1
  fi
  mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

  echo "Done. Worklog-tracker hooks removed (other hooks preserved)."
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

# ── Build hooks (session-logger + nudge hook) ────────────────────────────────
# UserPromptSubmit runs on every prompt the dev sends and its stdout is injected
# into the agent's context — that's what guarantees the nudge is delivered even
# when the agent never calls a worklog-tracker MCP tool.
HOOKS_JSON=$(cat <<ENDJSON
{
  "SessionStart":     [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER start" } ] } ],
  "Stop":             [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER activity" } ] } ],
  "SessionEnd":       [ { "hooks": [ { "type": "command", "command": "$SESSION_LOGGER stop" } ] } ],
  "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": "$NUDGE_CLI" } ] } ]
}
ENDJSON
)

# ── Merge into settings.json ────────────────────────────────────────────────
echo "Installing worklog-tracker hooks into $CLAUDE_SETTINGS..."

if ! jq --argjson hooks "$HOOKS_JSON" '.hooks = $hooks' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp"; then
  rm -f "${CLAUDE_SETTINGS}.tmp"
  echo "ERROR: jq failed to process $CLAUDE_SETTINGS — file untouched." >&2
  exit 1
fi
mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

echo ""
echo "Hooks installed globally:"
echo "  session-logger:    $SESSION_LOGGER"
echo "  nudge-check:       $NUDGE_CLI"
echo ""
echo "Session logs run on ALL Claude Code sessions."
echo "Toggl timer is managed by Claude via worklog-tracker skill."
echo "Nudges run on every user prompt (with cross-process cooldown)."
echo "To remove: $0 --remove"
