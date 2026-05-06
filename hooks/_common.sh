#!/bin/bash

# ── _common.sh ────────────────────────────────────────────────────────────────
# Shared helpers for hooks/session-logger.sh and hooks/toggl-timer-hook.sh.
# Source this file — do NOT execute it directly.
#
# Usage (in each hook script):
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/_common.sh"

timestamp() { date +"%d-%m-%Y %H:%M:%S"; }

branch() { git branch --show-current 2>/dev/null || echo "no-branch"; }

# Folder = basename of the repo root. Falls back to basename of cwd when not
# inside a git repo. This is the caller's cwd (the dev's project), not the
# worklog-tracker directory, because Claude Code invokes hooks from the session cwd.
folder() {
  local root
  root="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [[ -n "$root" ]]; then
    basename "$root"
  else
    basename "$(pwd)"
  fi
}

log_entry() {
  local label="$1"
  local session="$2"
  local log_file="$3"
  echo "$(timestamp) - [${label}] - Folder: $(folder) - Branch: $(branch) - session: ${session}" >>"$log_file"
}
