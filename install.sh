#!/bin/bash
# ── Toggl MCP — Team Install Script ─────────────────────────────────────────
# Idempotent setup: safe to run multiple times.
# Usage: ./install.sh

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}✔${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
fail() { echo -e "${RED}✖${NC} $1" >&2; exit 1; }
info() { echo -e "${CYAN}→${NC} $1"; }

# ── Resolve project root ───────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo -e "${BOLD}Toggl MCP — Install${NC}"
echo "─────────────────────────────────"
echo ""

# ── 1. Check prerequisites ─────────────────────────────────────────────────
info "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  fail "node not found. Install Node.js v20+ first: https://nodejs.org"
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if (( NODE_VERSION < 20 )); then
  fail "Node.js v20+ required (found v${NODE_VERSION}). Please upgrade."
fi
ok "node $(node -v)"

if ! command -v npm &>/dev/null; then
  fail "npm not found. It should come with Node.js."
fi
ok "npm $(npm -v)"

if ! command -v jq &>/dev/null; then
  fail "jq not found. Install with: brew install jq"
fi
ok "jq $(jq --version)"

echo ""

# ── 2. npm install ──────────────────────────────────────────────────────────
info "Installing dependencies..."
npm install --silent
ok "npm install"

# ── 3. npm run build ────────────────────────────────────────────────────────
info "Building project..."
npm run build --silent
ok "npm run build → dist/"

echo ""

# ── 4. Copy .env.example → .env ────────────────────────────────────────────
if [[ -f .env ]]; then
  warn ".env already exists — skipping (won't overwrite)"
else
  cp .env.example .env
  ok ".env created from .env.example"
fi

# ── 5. Copy mcp.config.example.json → mcp.config.json ──────────────────────
if [[ -f mcp.config.json ]]; then
  warn "mcp.config.json already exists — skipping (won't overwrite)"
else
  cp mcp.config.example.json mcp.config.json
  ok "mcp.config.json created from example"
fi

echo ""

# ── 6. Install global Claude Code hooks ─────────────────────────────────────
info "Installing global Claude Code hooks..."
bash scripts/setup-global-hooks.sh
ok "Global hooks installed"

echo ""

# ── 7. Register MCP server in Claude Code ─────────────────────────────────
info "Registering toggl MCP server in Claude Code..."

if ! command -v claude &>/dev/null; then
  warn "claude CLI not found — skipping MCP registration"
  warn "You can register manually later with:"
  warn "  claude mcp add toggl -s user -e MCP_CONFIG_PATH=\"${SCRIPT_DIR}/mcp.config.json\" -- node \"${SCRIPT_DIR}/dist/index.js\""
else
  # Remove existing registration (if any) to ensure clean state
  claude mcp remove toggl -s user 2>/dev/null || true

  claude mcp add toggl \
    -s user \
    -e MCP_CONFIG_PATH="${SCRIPT_DIR}/mcp.config.json" \
    -- node "${SCRIPT_DIR}/dist/index.js"

  ok "MCP server registered (scope: user)"
fi

echo ""

# ── 8. Print next steps ────────────────────────────────────────────────────
echo -e "${BOLD}${GREEN}Install complete!${NC}"
echo ""
echo -e "${BOLD}Next steps:${NC}"
echo ""
echo -e "  ${CYAN}1.${NC} Edit ${BOLD}.env${NC} with your API tokens:"
echo ""
echo -e "     • Toggl   → ${CYAN}https://track.toggl.com/profile${NC}"
echo -e "     • Tempo   → Tempo > Settings > API Integration"
echo -e "     • Jira    → ${CYAN}https://id.atlassian.com/manage-profile/security/api-tokens${NC}"
echo ""
echo -e "  ${CYAN}2.${NC} Edit ${BOLD}mcp.config.json${NC} with your workspaceId"
echo -e "     (find it in Toggl URL: track.toggl.com/{workspaceId}/...)"
echo ""
echo "─────────────────────────────────"
