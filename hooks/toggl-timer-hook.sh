#!/bin/bash

# ── toggl-timer-hook.sh ───────────────────────────────────────────────────────
# Dispara el timer de Toggl al inicio y fin de sesión de Claude Code.
# Responsabilidad única: control del timer. Sin lógica de log de sesión.
#
# Uso:
#   echo '{"session_id":"abc"}' | ./toggl-timer-hook.sh start
#   echo '{"session_id":"abc"}' | ./toggl-timer-hook.sh stop

set -euo pipefail

ACTION="${1:-}"
if [[ "$ACTION" != "start" && "$ACTION" != "stop" ]]; then
  echo "Uso: toggl-timer-hook.sh <start|stop>" >&2
  exit 1
fi

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_common.sh"

CLI="$SCRIPT_DIR/../dist/cli.js"
TOGGL_LOG="$SCRIPT_DIR/../.logs/toggl.log"
mkdir -p "$(dirname "$TOGGL_LOG")"

# ── Fire-and-forget timer command ─────────────────────────────────────────────
# Logs stdout+stderr to toggl.log (full audit trail — success and errors). Never blocks the hook.
toggl_timer() {
  local action="$1"
  shift
  (
    printf "[%s] [%s] " "$(timestamp)" "$action"
    node "$CLI" timer "$action" "$@" 2>&1
  ) >>"$TOGGL_LOG" 2>&1 &
}

# ── start / stop ──────────────────────────────────────────────────────────────
INPUT=$(cat)

case "$ACTION" in
start)
  toggl_timer start --description "[$(folder)] $(branch)"
  ;;
stop)
  toggl_timer stop
  ;;
esac

exit 0
