#!/bin/bash
# ── Toggl MCP — Team Install Script ─────────────────────────────────────────
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
echo -e "${BOLD}  Toggl MCP — Full Install & Configuration${NC}"
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

# ── Step 7: Initialize state file directory ───────────────────────────────
step 7 "Initializing state and log directories"

mkdir -p session-logger/.session-logs
ok "session-logger/.session-logs/ ready"

if [[ -f session-logger/.session-logs/.state.json ]]; then
  warn ".state.json already exists -- preserving push history"
else
  ok ".state.json will be created on first tempo push"
fi

# ── Step 8: Verify the build works ────────────────────────────────────────
step 8 "Verifying build"

if [[ -f dist/cli.js ]]; then
  if node dist/cli.js 2>&1 | head -1 >/dev/null; then
    ok "dist/cli.js is loadable"
  else
    fail "dist/cli.js exists but failed to load"
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

# ── Step 9: Register MCP server in Claude Code ───────────────────────────
step 9 "Registering MCP server in Claude Code"

if ! command -v claude &>/dev/null; then
  warn "claude CLI not found -- skipping MCP registration"
  warn "Register manually later with:"
  warn "  claude mcp add toggl -s user -e MCP_CONFIG_PATH=\"${SCRIPT_DIR}/mcp.config.json\" -- node \"${SCRIPT_DIR}/dist/index.js\""
else
  # Remove existing registration (if any) to ensure clean state
  claude mcp remove toggl -s user 2>/dev/null || true

  if claude mcp add toggl \
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
echo -e "  ${GREEN}*${NC} npm dependencies installed and project built"
echo -e "  ${GREEN}*${NC} Claude Code hooks: auto-start/stop Toggl timer on session start/end"
echo -e "  ${GREEN}*${NC} Session logger: tracks activity in session-logger/.session-logs/"
echo -e "  ${GREEN}*${NC} State file: push history persisted across sessions"
echo -e "  ${GREEN}*${NC} Nudge system: MCP tools remind about unpushed sessions"

echo ""
echo -e "${BOLD}${YELLOW}Action required -- fill in your tokens:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} Edit ${BOLD}.env${NC} with your API tokens:"
echo -e "     ${CYAN}*${NC} Toggl   -> https://track.toggl.com/profile"
echo -e "     ${CYAN}*${NC} Tempo   -> Tempo > Settings > API Integration"
echo -e "     ${CYAN}*${NC} Jira    -> https://id.atlassian.com/manage-profile/security/api-tokens"
echo ""
echo -e "  ${CYAN}2.${NC} Edit ${BOLD}mcp.config.json${NC} with your settings:"
echo -e "     ${CYAN}*${NC} workspaceId  -> find in Toggl URL: track.toggl.com/{workspaceId}/..."
echo -e "     ${CYAN}*${NC} nudge config -> enable/disable push reminders (enabled by default)"
echo ""
echo -e "  ${CYAN}3.${NC} Restart Claude Code to pick up hooks and MCP server"
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
