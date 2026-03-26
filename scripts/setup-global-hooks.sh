#!/bin/bash
# ── Setup Global Claude Code Hooks for Toggl MCP ─────────────────────────────
# Installs session-logger and toggl timer hooks into ~/.claude/settings.json
# so they run on EVERY project, not just one.
#
# Usage:
#   ./scripts/setup-global-hooks.sh          # install
#   ./scripts/setup-global-hooks.sh --remove # uninstall

set -euo pipefail

# ── Resolve toggl-mcp root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOGGL_MCP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Paths ────────────────────────────────────────────────────────────────────
CLAUDE_SETTINGS="$HOME/.claude/settings.json"

# ── Check for jq ─────────────────────────────────────────────────────────────
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required. Install with: brew install jq" >&2
  exit 1
fi

# ── Remove mode (no build required) ─────────────────────────────────────────
if [[ "${1:-}" == "--remove" ]]; then
  if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
    echo "Nothing to remove: $CLAUDE_SETTINGS not found." >&2
    exit 0
  fi
  echo "Removing toggl-mcp hooks from $CLAUDE_SETTINGS..."

  # Remove only hook entries whose command contains toggl-mcp, preserve the rest
  jq --arg marker "toggl-mcp" '
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

  echo "Done. Toggl-mcp hooks removed (other hooks preserved)."
  exit 0
fi

# ── Validate required files (only for install) ──────────────────────────────
SESSION_LOGGER="$TOGGL_MCP_DIR/session-logger/session-logger.sh"
CLI_JS="$TOGGL_MCP_DIR/dist/cli.js"

if [[ ! -x "$SESSION_LOGGER" ]]; then
  echo "ERROR: session-logger.sh not found or not executable at:" >&2
  echo "  $SESSION_LOGGER" >&2
  exit 1
fi

if [[ ! -f "$CLI_JS" ]]; then
  echo "ERROR: dist/cli.js not found. Did you run 'npm run build'?" >&2
  echo "  Expected: $CLI_JS" >&2
  exit 1
fi

if [[ ! -f "$CLAUDE_SETTINGS" ]]; then
  echo "ERROR: $CLAUDE_SETTINGS not found. Is Claude Code installed?" >&2
  exit 1
fi

# ── Read mode from mcp.config.json ───────────────────────────────────────────
MCP_CONFIG="$TOGGL_MCP_DIR/mcp.config.json"
if [[ -f "$MCP_CONFIG" ]]; then
  MODE=$(jq -r '.mode // "both"' "$MCP_CONFIG")
else
  MODE="both"
fi

if [[ "$MODE" != "toggl" && "$MODE" != "tempo" && "$MODE" != "both" ]]; then
  echo "ERROR: Invalid mode '$MODE' in mcp.config.json. Expected: toggl, tempo, or both" >&2
  exit 1
fi

echo "Mode: $MODE"

# ── Build hooks based on mode ────────────────────────────────────────────────
# Session logger hooks run in ALL modes (foundation for tempo push)
# Toggl timer hooks only in "toggl" and "both"

SESSION_START_HOOKS="{ \"type\": \"command\", \"command\": \"$SESSION_LOGGER start\" }"
STOP_HOOKS="{ \"type\": \"command\", \"command\": \"$SESSION_LOGGER activity\" }"
SESSION_END_HOOKS="{ \"type\": \"command\", \"command\": \"$SESSION_LOGGER stop\" }"

if [[ "$MODE" == "toggl" || "$MODE" == "both" ]]; then
  TOGGL_START="{ \"type\": \"command\", \"command\": \"BRANCH=\$(git branch --show-current 2>/dev/null || echo 'no-branch') && cd $TOGGL_MCP_DIR && node $CLI_JS timer start --description \\\"\$BRANCH\\\"\" }"
  TOGGL_STOP="{ \"type\": \"command\", \"command\": \"cd $TOGGL_MCP_DIR && node $CLI_JS timer stop\" }"
  SESSION_START_HOOKS="$SESSION_START_HOOKS, $TOGGL_START"
  SESSION_END_HOOKS="$SESSION_END_HOOKS, $TOGGL_STOP"
fi

HOOKS_JSON=$(cat <<ENDJSON
{
  "SessionStart": [ { "hooks": [ $SESSION_START_HOOKS ] } ],
  "Stop": [ { "hooks": [ $STOP_HOOKS ] } ],
  "SessionEnd": [ { "hooks": [ $SESSION_END_HOOKS ] } ]
}
ENDJSON
)

# ── Merge into settings.json ────────────────────────────────────────────────
echo "Installing toggl-mcp hooks into $CLAUDE_SETTINGS..."

jq --argjson hooks "$HOOKS_JSON" '.hooks = $hooks' "$CLAUDE_SETTINGS" > "${CLAUDE_SETTINGS}.tmp" \
  && mv "${CLAUDE_SETTINGS}.tmp" "$CLAUDE_SETTINGS"

echo ""
echo "Hooks installed globally. Paths resolved to:"
echo "  session-logger: $SESSION_LOGGER"
echo "  cli.js:         $CLI_JS"
echo "  mode:           $MODE"
echo ""
echo "These hooks will run on ALL Claude Code sessions."
echo "To remove: $0 --remove"
