#!/bin/bash
# ── Worklog Tracker — Team Install Script ──────────────────────────────────
# Idempotent setup: safe to run multiple times.
# Usage: ./install.sh

set -uo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}  [✔]${NC} $1"; }
warn() { echo -e "${YELLOW}  [⚠]${NC} $1"; }
fail() { echo -e "${RED}  [✖]${NC} $1"; }
info() { echo -e "${CYAN}  [→]${NC} $1"; }
step() { echo -e "\n${BOLD}Step $1: $2${NC}"; }

ERRORS=0

# ── Resolve project root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Worklog Tracker — Full Install & Configuration${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"

# ── Step 1: Check prerequisites ───────────────────────────────────────────
step 1 "Checking prerequisites"

if ! command -v node &>/dev/null; then
  fail "node not found. Install Node.js v20+ first: https://nodejs.org"
  ERRORS=$((ERRORS + 1))
else
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if (( NODE_VERSION < 20 )); then
    fail "Node.js v20+ required (found v${NODE_VERSION}). Please upgrade."
    ERRORS=$((ERRORS + 1))
  else
    ok "node $(node -v)"
  fi
fi

if ! command -v npm &>/dev/null; then
  fail "npm not found. It should come with Node.js."
  ERRORS=$((ERRORS + 1))
else
  ok "npm $(npm -v)"
fi

if ! command -v jq &>/dev/null; then
  fail "jq not found. Install with: brew install jq"
  ERRORS=$((ERRORS + 1))
else
  ok "jq $(jq --version)"
fi

if (( ERRORS > 0 )); then
  echo ""
  fail "Prerequisites missing. Fix the errors above and re-run."
  exit 1
fi

# ── Step 2: Install npm dependencies ──────────────────────────────────────
step 2 "Installing npm dependencies"

if npm install --silent 2>/dev/null; then
  ok "npm install"
else
  fail "npm install failed"
  ERRORS=$((ERRORS + 1))
fi

# ── Step 3: Build the project ─────────────────────────────────────────────
step 3 "Building project"

if npm run build --silent 2>/dev/null; then
  ok "npm run build -> dist/"
else
  fail "npm run build failed"
  ERRORS=$((ERRORS + 1))
fi

# ── Step 4: Create .env from .env.example ─────────────────────────────────
step 4 "Configuring environment files"

if [[ -f .env ]]; then
  warn ".env already exists -- skipping (won't overwrite)"
else
  if [[ -f .env.example ]]; then
    cp .env.example .env
    ok ".env created from .env.example"
  else
    fail ".env.example not found -- cannot create .env"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── Step 5: Create mcp.config.json from example ──────────────────────────
step 5 "Configuring MCP config"

if [[ -f mcp.config.json ]]; then
  warn "mcp.config.json already exists -- skipping (won't overwrite)"
else
  if [[ -f mcp.config.example.json ]]; then
    cp mcp.config.example.json mcp.config.json
    ok "mcp.config.json created from example"
  else
    fail "mcp.config.example.json not found -- cannot create config"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── Step 6: Install global Claude Code hooks ──────────────────────────────
step 6 "Installing global Claude Code hooks"

if [[ -x scripts/setup-global-hooks.sh ]]; then
  if bash scripts/setup-global-hooks.sh; then
    ok "Global hooks installed (SessionStart/Stop/Activity)"
  else
    fail "Hook installation failed"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "scripts/setup-global-hooks.sh not found or not executable"
  ERRORS=$((ERRORS + 1))
fi

# ── Step 7: Install Claude Code skill (via symlink) ──────────────────────
# Symlink (not copy) so future `git pull` updates the skill without re-running
# install.sh. The skill itself is auto-discovered by Claude Code from
# ~/.claude/skills/<name>/SKILL.md — no edits to ~/.claude/CLAUDE.md needed.
step 7 "Installing Claude Code skill (symlink)"

SKILL_SRC="${SCRIPT_DIR}/skills/worklog-tracker/SKILL.md"
SKILL_DST_DIR="${HOME}/.claude/skills/worklog-tracker"
SKILL_DST="${SKILL_DST_DIR}/SKILL.md"

if [[ ! -f "$SKILL_SRC" ]]; then
  fail "Source skill not found at $SKILL_SRC"
  ERRORS=$((ERRORS + 1))
else
  mkdir -p "$SKILL_DST_DIR"

  if [[ -L "$SKILL_DST" ]]; then
    # Existing symlink — refresh in case the source path changed.
    rm -f "$SKILL_DST"
    ln -s "$SKILL_SRC" "$SKILL_DST"
    ok "Skill symlink refreshed -> $SKILL_DST"
  elif [[ -e "$SKILL_DST" ]]; then
    # Real file in the way — back it up before symlinking, never overwrite.
    BACKUP="${SKILL_DST}.bak.$(date +%Y%m%d-%H%M%S)"
    mv "$SKILL_DST" "$BACKUP"
    ln -s "$SKILL_SRC" "$SKILL_DST"
    ok "Skill installed (existing file backed up to $(basename "$BACKUP"))"
  else
    ln -s "$SKILL_SRC" "$SKILL_DST"
    ok "Skill symlinked -> $SKILL_DST"
  fi
fi

# ── Step 8: Initialize state file directory ───────────────────────────────
step 8 "Initializing state and log directories"

if [[ -f .logs/.gitkeep ]]; then
  ok ".logs/ already exists -- skipping mkdir"
else
  mkdir -p .logs
  ok ".logs/ ready"
fi

if [[ -f .logs/.state.json ]]; then
  warn ".state.json already exists -- preserving push history"
else
  ok ".state.json will be created on first tempo push"
fi

# ── Step 9: Verify the build works ────────────────────────────────────────
# Use `nudge-check` because it's silent-on-success, swallows all errors
# (designed to never block the user prompt) and exits 0 if the bundle loads
# and mcp.config.json is valid. Calling `node dist/cli.js` with no args
# always exits 1 (Unknown command), which would defeat any `pipefail` check.
step 9 "Verifying build"

if [[ -f dist/cli.js ]]; then
  if node dist/cli.js nudge-check >/dev/null 2>&1; then
    ok "dist/cli.js is loadable (nudge-check returned 0)"
  else
    fail "dist/cli.js exists but failed to run nudge-check"
    ERRORS=$((ERRORS + 1))
  fi
else
  fail "dist/cli.js not found -- build may have failed"
  ERRORS=$((ERRORS + 1))
fi

if [[ -f dist/index.js ]]; then
  ok "dist/index.js (MCP server entry) present"
else
  fail "dist/index.js not found -- MCP server won't start"
  ERRORS=$((ERRORS + 1))
fi

# ── Step 10: Register MCP server in Claude Code ──────────────────────────
step 10 "Registering MCP server in Claude Code"

if ! command -v claude &>/dev/null; then
  warn "claude CLI not found -- skipping MCP registration"
  warn "Register manually later with:"
  warn "  claude mcp add worklog-tracker -s user -e MCP_CONFIG_PATH=\"${SCRIPT_DIR}/mcp.config.json\" -- node \"${SCRIPT_DIR}/dist/index.js\""
else
  # Remove existing registration (if any) to ensure clean state
  claude mcp remove worklog-tracker -s user 2>/dev/null || true

  if claude mcp add worklog-tracker \
    -s user \
    -e MCP_CONFIG_PATH="${SCRIPT_DIR}/mcp.config.json" \
    -- node "${SCRIPT_DIR}/dist/index.js"; then
    ok "MCP server registered (scope: user)"
  else
    fail "MCP server registration failed"
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"

if (( ERRORS == 0 )); then
  echo -e "${BOLD}${GREEN}  Install complete! All steps passed.${NC}"
else
  echo -e "${BOLD}${RED}  Install finished with ${ERRORS} error(s).${NC}"
  echo -e "${RED}  Review the failures above and re-run.${NC}"
fi

echo -e "${BOLD}══════════════════════════════════════════${NC}"

echo ""
echo -e "${BOLD}What was configured:${NC}"
echo -e "  ${GREEN}*${NC} npm dependencies installed and project built (dist/)"
echo -e "  ${GREEN}*${NC} Claude Code hooks merged into ~/.claude/settings.json (other hooks preserved)"
echo -e "  ${GREEN}*${NC} Skill symlinked -> ~/.claude/skills/worklog-tracker/SKILL.md (git pull updates it)"
echo -e "  ${GREEN}*${NC} Session logger writes to .logs/session-YYYY-MM.log"
echo -e "  ${GREEN}*${NC} State file (.logs/.state.json) tracks push history + nudge cooldown"
echo -e "  ${GREEN}*${NC} MCP server registered with Claude Code (scope: user)"

echo ""
echo -e "${BOLD}${YELLOW}Action required -- fill in your tokens:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} Edit ${BOLD}.env${NC} with your API tokens:"
echo -e "     ${CYAN}*${NC} Tempo   -> Tempo > Settings > API Integration"
echo -e "     ${CYAN}*${NC} Jira    -> https://id.atlassian.com/manage-profile/security/api-tokens"
echo -e "     ${CYAN}*${NC} Required scopes: see ${BOLD}README.md > Getting API Tokens${NC}"
echo ""
echo -e "  ${CYAN}2.${NC} Edit ${BOLD}mcp.config.json${NC} with your settings:"
echo -e "     ${CYAN}*${NC} ${BOLD}defaultIssueKey${NC}     -> fallback Jira key when branch has no PROJ-123"
echo -e "     ${CYAN}*${NC} ${BOLD}timezone${NC}            -> IANA tz (default America/Argentina/Buenos_Aires)"
echo -e "     ${CYAN}*${NC} ${BOLD}nudge.enabled${NC}       -> set to false to silence push reminders"
echo ""
echo -e "  ${CYAN}3.${NC} Restart Claude Code to pick up hooks, skill, and MCP server"
echo ""
echo -e "${BOLD}To uninstall:${NC}"
echo -e "  ${CYAN}*${NC} Remove hooks:  ${BOLD}scripts/setup-global-hooks.sh --remove${NC}"
echo -e "  ${CYAN}*${NC} Remove skill:  ${BOLD}rm ~/.claude/skills/worklog-tracker/SKILL.md${NC}"
echo -e "  ${CYAN}*${NC} Remove MCP:    ${BOLD}claude mcp remove worklog-tracker -s user${NC}"
echo -e "  ${CYAN}*${NC} ${BOLD}.env${NC}, ${BOLD}mcp.config.json${NC}, and ${BOLD}.logs/${NC} are preserved (delete manually if desired)"
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
