# Architecture and Maintenance Guide

## Scope

Worklog Tracker is a hybrid system that combines:

- **Bash hooks** in Claude Code (hooks/session-logger + nudge-check) that observe coding sessions
- **An MCP server** (`worklog-tracker`) that exposes worklog tools to AI agents
- **A CLI** (`dist/cli.js`) for headless push operations and for the hook integration

It centralizes:
- Worklog operations in Tempo/Jira
- Session-log → Tempo consolidation (the system's native push flow)

It is intended for engineering teams where worklog integrity affects billing and reporting.

## Stack

- Runtime: Node.js 20+
- Language: TypeScript (ESM, NodeNext)
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Env loading: `dotenv`
- Hooks: bash + `jq` (Claude Code SessionStart / Stop / SessionEnd / UserPromptSubmit)
- External APIs:
  - Tempo API v4 (`https://api.tempo.io/4`)
  - Jira REST API v3 (`/rest/api/3/...`)

## High-level Components

### MCP / CLI runtime

- `src/index.ts`
  - MCP bootstrap (stdio transport)
  - Tool catalog definition gated by available adapters
  - Tool routing, error mapping (Zod → `McpError`)

- `src/cli.ts`
  - Subcommands: `tempo push`, `nudge-check`
  - Used by the nudge-check hook and by the dev directly (tempo push)
  - Resolves log dir from project root: `<root>/.logs/`

- `src/config.ts`
  - Loads `.env` (project-root-aware: works regardless of cwd)
  - Loads + validates `mcp.config.json` with Zod (strict schema — unknown keys fail)
  - Normalizes `defaultWorkAttributes` (string → `[{key,value}]`)
  - Resolves project root from compiled module location → CLI works from any cwd

- `src/tools.ts`
  - Input schemas and parser functions for every MCP tool

### Adapters

- `src/tempo-jira-adapter.ts`
  - Tempo: create / read / delete worklog
  - Jira: resolve current user accountId, resolve issue key/id, optional Tempo Account custom field

### Session-log pipeline

- `src/session-log-parser.ts`
  - Reads `.logs/session-YYYY-MM.log`
  - Filters by date range, parses `START / ACTIVITY / STOP / INACTIVITY` lines into typed entries

- `src/session-consolidator.ts`
  - Groups entries by session id and branch
  - Splits into "work windows" using `inactivityThresholdMinutes`
  - Aggregates windows into worklogs (`branch`, `folder`, `date`, `startTime`, `durationHours`, `sessionIds`)
  - Extracts issue key from branch via regex (e.g. `feature/PROJ-123-foo` → `PROJ-123`); falls back to `defaultIssueKey`
  - `filterAlreadyPushed()` matches against existing Tempo descriptions by `[session:id]` markers

- `src/state-manager.ts`
  - Persists `.logs/.state.json` with pushed sessionIds + last nudge timestamp
  - Cross-process — used by both the MCP server and the `nudge-check` hook (which is a fresh process every prompt)

### Nudge

- `src/nudge.ts`
  - Builds nudge text from state + config (`pushReminderAfterHours`)
  - Morning greeting on first prompt of the calendar day (in `timezone`); after that, push-overdue when unpushed sessions exceed `pushReminderAfterHours` since last push
  - Returns `null` when nothing should be nudged
  - Used by `nudge-check` CLI in the UserPromptSubmit hook

### Hooks layer

All hook scripts live in `hooks/`. Each sources `hooks/_common.sh` for shared helpers (`timestamp()`, `folder()`, `branch()`, `log_entry()`).

- `hooks/_common.sh`
  - Shared helpers sourced by hook scripts
  - `folder()`: basename of git repo root (falls back to basename of cwd)
  - `branch()`: current git branch
  - `timestamp()`, `log_entry()`

- `hooks/session-logger.sh`
  - SessionStart → logs `START` entry to `.logs/session-YYYY-MM.log`
  - Stop (activity hook) → logs `ACTIVITY` entry
  - SessionEnd → logs `STOP` entry
  - Watchdog `check` mode evaluates git activity and emits `INACTIVITY` log entry when idle
  - Single responsibility: session log writes

- `scripts/setup-global-hooks.sh`
  - Installs / removes hooks in `~/.claude/settings.json` via `jq`
  - Removal is selective: only deletes commands referencing `hooks/session-logger.sh` or `dist/cli.js nudge-check`, preserves other hooks

## Tool Inventory

The catalog exposed to MCP clients depends on the credentials available in `.env`.

### Always available (session-log based, no API token)

- `preview_tempo_push`

### Tempo (when Tempo+Jira credentials are set)

- `tempo_create_worklog`
- `tempo_read_worklogs`
- `tempo_delete_worklog`
- `push_tempo_worklogs`

## Core Data Concepts

- **Session log entry**
  - `timestamp - [LABEL] - Folder: F - Branch: B - session: SID`
  - Labels: `START`, `ACTIVITY`, `STOP`, `INACTIVITY`

- **Work window**
  - Contiguous run of activity for one (session, branch) pair, split when gap > `inactivityThresholdMinutes`

- **Consolidated worklog**
  - One per (branch, date) — aggregates all windows for that pair into a single Tempo worklog
  - Fields: `issueKey`, `branch`, `folder`, `date`, `startTime`, `durationHours`, `sessionIds[]`, `windowCount`, `description`

- **Tempo worklog**
  - `tempoWorklogId`, `issueId`, `startDate`, `startTime`, `timeSpentSeconds`, `description`, `attributes`

- **Duplicate marker**
  - `[session:<sessionId>]` — appended to Tempo description by `push_tempo_worklogs`. Used by `filterAlreadyPushed` to skip already-pushed sessions

- **Default routing values**
  - `defaultIssueKey` — fallback when no key extracted from branch / description
  - `defaultWorkAttributes` — fallback work attributes for Tempo (string is auto-wrapped as `[{key:"_Tipotarea_", value: ...}]`)

## Main Flows

### 1) Push session logs to Tempo

1. Dev: "subir worklogs de hoy" → agent calls `preview_tempo_push`
2. Server parses session logs for the date range (`session-log-parser`)
3. Consolidates into worklogs (`session-consolidator`) — splits by inactivity, extracts issue keys
4. Reads existing Tempo worklogs in the same range → filters out already-pushed (by `[session:id]` marker)
5. Returns preview table with `toPush` worklogs + `alreadyPushedCount`
6. Dev confirms → agent calls `push_tempo_worklogs` with the worklog list
7. Server creates each worklog via Tempo, records sessionIds in `state-manager`, returns success/fail summary

### 2) Nudge delivery

- **UserPromptSubmit hook**: every user prompt triggers `node dist/cli.js nudge-check`. Its stdout is injected into the agent's context for that turn. Cross-process cooldown via `state-manager` (persisted in `.state.json`) prevents double-nudging.
- This is the only delivery path: the hook guarantees delivery even when the agent never calls a worklog-tracker MCP tool that turn, so MCP tool responses are not wrapped.

## Configuration Model

### `.env`

- Optional (gates which tools are exposed):
  - `TEMPO_API_TOKEN`, `JIRA_BASE_URL`, `JIRA_API_TOKEN` — all three required together for Tempo tools
  - `JIRA_EMAIL` — required when `JIRA_AUTH_TYPE=basic`
- Other:
  - `JIRA_AUTH_TYPE` (`basic` default, or `bearer`)
  - `JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID`
  - `DOTENV_PATH` — explicit override for `.env` location

### `mcp.config.json`

- Required:
  - `timezone`
- Optional:
  - `defaultIssueKey`
  - `defaultWorkAttributes` (string or array)
  - `inactivityThresholdMinutes` (default 10)
  - `logRetentionMonths` (default 3)
  - `nudge.enabled` (default true)
  - `nudge.cooldownMinutes` (default 30)
  - `nudge.pushReminderAfterHours` (default 4)

Note: the schema is **strict** — any unknown field (e.g. a stale `mode`, `workspaceId`, or `endOfDayHour` from a pre-`8557ec7` checkout) causes startup to fail with a Zod validation error. This is intentional.

## Reliability and Billing Integrity Considerations

- Strong input validation with Zod for every tool
- Explicit timezone handling to reduce date drift
- Duplicate prevention via session markers
- Cross-process state file (`.state.json`) for nudge cooldown across hook invocations
- Structured responses for auditable agent output
- Fail-fast startup for invalid config; missing credentials degrade tool catalog instead of crashing
- Hooks are non-blocking: nudge-check is fire-and-forget / silent-on-failure to never block the dev's workflow

## Known Limitations

- Duplicate protection is marker-based; external/manual edits to descriptions can weaken detection
- `tempo_read_worklogs` resolves issue keys by calling the Jira issue endpoint per unique issue id
- No persistent local sync ledger yet — idempotency is not fully durable
- No retry/backoff policy for transient API failures
- No automated tests — adapters and parsers are validated by manual smoke checks

## Suggested Next Hardening Steps

1. Add retry policy with exponential backoff for 429/5xx responses
2. Add persistent sync ledger in SQLite
3. Add structured logging correlation id per tool call
4. Add unit tests for `session-log-parser`, `session-consolidator` and tool parsers
5. Add integration tests for adapters with mocked APIs

## Runbook (Quick)

1. `./install.sh`
2. Edit `.env` with API tokens
3. Edit `mcp.config.json` (`timezone`, etc.)
4. Restart Claude Code
5. Smoke checks:
   - Open a session → verify `.logs/session-YYYY-MM.log` has a `START` line
   - `tempo_read_worklogs` for today
   - `preview_tempo_push --date today` (CLI: `node dist/cli.js tempo push --dry-run`)
   - `tempo_create_worklog` on a safe issue, then `tempo_delete_worklog` to clean up

## Ownership Notes

- This service should be treated as a billing-critical integration
- Changes to mapping, defaults, sync behavior, or duplicate markers must be peer-reviewed
- Touching the consolidator's window-splitting logic affects historical worklog totals
