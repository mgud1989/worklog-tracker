#!/bin/bash

# ── Session Logger ────────────────────────────────────────────────────────────
# Registra inicio, fin e inactividad de sesiones de Claude Code.
# Todo va a un único archivo de log.
#
# Uso:
#   echo '{"session_id":"abc"}' | ./session-logger.sh start
#   echo '{"session_id":"abc"}' | ./session-logger.sh stop
#   echo '{"session_id":"abc"}' | ./session-logger.sh activity   # hook Stop
#   ./session-logger.sh check            # no requiere stdin

set -euo pipefail

ACTION="${1:-}"
if [[ "$ACTION" != "start" && "$ACTION" != "stop" && "$ACTION" != "check" && "$ACTION" != "activity" ]]; then
  echo "Uso: session-logger.sh <start|stop|activity|check>" >&2
  exit 1
fi

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${SCRIPT_DIR}/.session-logs"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_DIR}/session-$(date +%Y-%m).log"

# ── Helpers ───────────────────────────────────────────────────────────────────
timestamp() { date +"%d-%m-%Y %H:%M:%S"; }

branch() { git branch --show-current 2>/dev/null || echo "no-branch"; }

log_entry() {
  local label="$1"
  local session="$2"
  echo "$(timestamp) - [${label}] - Branch: $(branch) - session: ${session}" >>"$LOG_FILE"
}

# ── start / stop / activity ───────────────────────────────────────────────────
if [[ "$ACTION" == "start" || "$ACTION" == "stop" || "$ACTION" == "activity" ]]; then
  INPUT=$(cat)
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
  case "$ACTION" in
  start) LABEL="START" ;;
  stop) LABEL="STOP" ;;
  activity) LABEL="ACTIVITY" ;;
  esac
  log_entry "$LABEL" "$SESSION_ID"
  exit 0
fi

# ── check (watchdog) ─────────────────────────────────────────────────────────
# Evalúa actividad en el repo. Solo loggea si detecta INACTIVIDAD.
# Exit codes: 0 = activo, 1 = inactivo (loggeado)

THRESHOLD_MINUTES=10
THRESHOLD_SECONDS=$((THRESHOLD_MINUTES * 60))
NOW=$(date +%s)

# Último commit
LAST_COMMIT_TS=$(git log -1 --pretty=format:"%ct" 2>/dev/null || echo "0")
SECONDS_SINCE_COMMIT=$((NOW - LAST_COMMIT_TS))

# Archivos sin commitear
UNCOMMITTED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Fecha de modificación más reciente entre archivos sin commitear
LAST_MODIFIED_TS=0
if [ "$UNCOMMITTED" -gt 0 ]; then
  while IFS= read -r file; do
    if stat --version >/dev/null 2>&1; then
      TS=$(stat -c '%Y' "$file" 2>/dev/null) # Linux
    else
      TS=$(stat -f '%m' "$file" 2>/dev/null) # macOS
    fi
    [ "${TS:-0}" -gt "$LAST_MODIFIED_TS" ] && LAST_MODIFIED_TS=$TS
  done < <(git status --porcelain | awk '{print $2}')
fi

SECONDS_SINCE_MODIFIED=$((NOW - LAST_MODIFIED_TS))

# ── Evaluación ────────────────────────────────────────────────────────────────
RECENT_COMMIT=false
RECENT_CHANGES=false

[ "$SECONDS_SINCE_COMMIT" -lt "$THRESHOLD_SECONDS" ] && RECENT_COMMIT=true
[ "$LAST_MODIFIED_TS" -gt 0 ] &&
  [ "$SECONDS_SINCE_MODIFIED" -lt "$THRESHOLD_SECONDS" ] && RECENT_CHANGES=true

if $RECENT_COMMIT || $RECENT_CHANGES; then
  # Activo — no loggear nada
  exit 0
fi

# Inactivo — loggear y salir con 1
log_entry "INACTIVITY" "n/a (git-watchdog)"
exit 1
