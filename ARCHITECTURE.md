# Architecture and Maintenance Guide

## Scope

Worklog Tracker is a hybrid system that combines:

- **Bash hooks** in Claude Code (session-logger + nudge-check) that observe coding sessions
- **An MCP server** (`toggl`) that exposes time-tracking and worklog tools to AI agents
- **A CLI** (`dist/cli.js`) for headless timer / push operations and for the hook integration

It centralizes:
- Time tracking operations in Toggl
- Worklog operations in Tempo/Jira
- Session-log → Tempo consolidation (the system's own native flow)
- Toggl → Tempo synchronization (legacy/external Toggl entries)

It is intended for engineering teams where worklog integrity affects billing and reporting.

## Stack

- Runtime: Node.js 20+
- Language: TypeScript (ESM, NodeNext)
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Env loading: `dotenv`
- Hooks: bash + `jq` (Claude Code SessionStart / Stop / SessionEnd / UserPromptSubmit)
- External APIs:
  - Toggl Track API v9 (`https://api.track.toggl.com/api/v9`)
  - Tempo API v4 (`https://api.tempo.io/4`)
  - Jira REST API v3 (`/rest/api/3/...`)

## High-level Components

### MCP / CLI runtime

- `src/index.ts`
  - MCP bootstrap (stdio transport)
  - Tool catalog definition gated by `mode` and available adapters
  - Tool routing, error mapping (Zod → `McpError`)

- `src/cli.ts`
  - Subcommands: `timer start|stop|status`, `tempo push`, `nudge-check`
  - Used by hooks (timer, nudge-check) and by the dev directly (tempo push)

- `src/config.ts`
  - Loads `.env` (project-root-aware: works regardless of cwd)
  - Loads + validates `mcp.config.json` with Zod
  - Normalizes `defaultWorkAttributes` (string → `[{key,value}]`)
  - Resolves project root from compiled module location → CLI works from any cwd

- `src/tools.ts`
  - Input schemas and parser functions for every MCP tool

### Adapters

- `src/toggl-tempo-adapter.ts`
  - Toggl: create entry, start/stop/get-current timer, read entries, update entry
  - Resolves project name by id (used in CLI status output)

- `src/tempo-jira-adapter.ts`
  - Tempo: create / read / delete worklog
  - Jira: resolve current user accountId, resolve issue key/id, optional Tempo Account custom field
  - Sync logic Toggl → Tempo with `[toggl:<entryId>]` duplicate marker

### Session-log pipeline

- `src/session-log-parser.ts`
  - Reads `session-logger/.session-logs/session-YYYY-MM.log`
  - Filters by date range, parses `START / ACTIVITY / STOP / INACTIVITY` lines into typed entries

- `src/session-consolidator.ts`
  - Groups entries by session id and branch
  - Splits into "work windows" using `inactivityThresholdMinutes`
  - Aggregates windows into worklogs (`branch`, `folder`, `date`, `startTime`, `durationHours`, `sessionIds`)
  - Extracts issue key from branch via regex (e.g. `feature/PROJ-123-foo` → `PROJ-123`); falls back to `defaultIssueKey`
  - `filterAlreadyPushed()` matches against existing Tempo descriptions by `[session:id]` markers

- `src/state-manager.ts`
  - Persists `session-logger/.session-logs/.state.json` with pushed sessionIds + last nudge timestamp
  - Cross-process — used by both the MCP server and the `nudge-check` hook (which is a fresh process every prompt)

### Nudge

- `src/nudge.ts`
  - Builds nudge text from state + config (`pushReminderAfterHours`, `endOfDayHour`)
  - Returns `null` when nothing should be nudged
  - Used by `nudge-check` CLI in the UserPromptSubmit hook

### Hooks layer

- `session-logger/session-logger.sh`
  - SessionStart → log `START` + fire-and-forget `node dist/cli.js timer start --description "[folder] branch"`
  - Stop → log `ACTIVITY`
  - SessionEnd → log `STOP` + fire-and-forget `node dist/cli.js timer stop`
  - Watchdog `check` mode evaluates git activity and emits `INACTIVITY` log entry when idle
  - Toggl CLI stdout/stderr go to `session-logger/.session-logs/toggl-errors.log`

- `scripts/setup-global-hooks.sh`
  - Installs / removes the four hooks in `~/.claude/settings.json` via `jq`
  - Removal is selective: only deletes commands referencing `session-logger.sh` or `dist/cli.js nudge-check`, preserves other hooks

## Tool Inventory

The catalog exposed to MCP clients depends on `mode` (in `mcp.config.json`) and the credentials available in `.env`.

### Always available (session-log based, no API token)

- `preview_tempo_push`

### Toggl (when `mode ∈ {toggl, both}` and `TOGGL_API_TOKEN` is set)

- `log_work_entry`
- `smart_timer_control`
- `read_tracking_data`
- `update_work_entry`

### Tempo (when `mode ∈ {tempo, both}` and Tempo+Jira credentials are set)

- `tempo_create_worklog`
- `tempo_read_worklogs`
- `tempo_delete_worklog`
- `push_tempo_worklogs`

### Sync (requires both adapters)

- `sync_toggl_range_to_tempo`

## Core Data Concepts

- **Session log entry**
  - `timestamp - [LABEL] - Folder: F - Branch: B - session: SID`
  - Labels: `START`, `ACTIVITY`, `STOP`, `INACTIVITY`

- **Work window**
  - Contiguous run of activity for one (session, branch) pair, split when gap > `inactivityThresholdMinutes`

- **Consolidated worklog**
  - One per (branch, date) — aggregates all windows for that pair into a single Tempo worklog
  - Fields: `issueKey`, `branch`, `folder`, `date`, `startTime`, `durationHours`, `sessionIds[]`, `windowCount`, `description`

- **Toggl entry**
  - `id`, `description`, `start`, `stop`, `duration`, `tags`, `project_id`

- **Tempo worklog**
  - `tempoWorklogId`, `issueId`, `startDate`, `startTime`, `timeSpentSeconds`, `description`, `attributes`

- **Duplicate markers**
  - `[session:<sessionId>]` — appended to Tempo description by `push_tempo_worklogs`. Used by `filterAlreadyPushed` to skip already-pushed sessions
  - `[toggl:<entryId>]` — appended by `sync_toggl_range_to_tempo`. Used to skip already-synced Toggl entries

- **Default routing values**
  - `defaultIssueKey` — fallback when no key extracted from branch / description
  - `defaultWorkAttributes` — fallback work attributes for Tempo (string is auto-wrapped as `[{key:"_Tipotarea_", value: ...}]`)

## Main Flows

### 1) Auto Toggl timer per session

1. Dev launches Claude Code → `SessionStart` hook fires
2. `session-logger.sh start` logs the START line
3. Fire-and-forget `node dist/cli.js timer start --description "[folder] branch"`
4. CLI checks for an already-running timer with the same description → idempotent skip if match
5. Otherwise calls Toggl `start` via the adapter
6. SessionEnd → mirror flow with `timer stop`

### 2) Push session logs to Tempo

1. Dev: "subir worklogs de hoy" → agent calls `preview_tempo_push`
2. Server parses session logs for the date range (`session-log-parser`)
3. Consolidates into worklogs (`session-consolidator`) — splits by inactivity, extracts issue keys
4. Reads existing Tempo worklogs in the same range → filters out already-pushed (by `[session:id]` marker)
5. Returns preview table with `toPush` worklogs + `alreadyPushedCount`
6. Dev confirms → agent calls `push_tempo_worklogs` with the worklog list
7. Server creates each worklog via Tempo, records sessionIds in `state-manager`, returns success/fail summary

### 3) Sync Toggl range → Tempo (legacy / external entries)

1. Read Toggl entries in range
2. Keep closed entries (`stop` present, positive duration)
3. Read existing Tempo worklogs in the date window
4. Build set of existing `[toggl:<id>]` markers
5. For each eligible entry: extract issue key from description or fallback to `defaultIssueKey`
6. Create Tempo worklog with description + sync marker + default attributes
7. Return per-entry result (`synced`, `skipped`, `failed`)

### 4) Nudge delivery

- **UserPromptSubmit hook**: every user prompt triggers `node dist/cli.js nudge-check`. Its stdout is injected into the agent's context for that turn. Cross-process cooldown via `state-manager` (persisted in `.state.json`) prevents double-nudging.
- This is the only delivery path: the hook guarantees delivery even when the agent never calls a worklog-tracker MCP tool that turn, so MCP tool responses are not wrapped.

## Configuration Model

### `.env`

- Optional (gates which tools are exposed):
  - `TOGGL_API_TOKEN` — required for Toggl tools
  - `TEMPO_API_TOKEN`, `JIRA_BASE_URL`, `JIRA_API_TOKEN` — all three required together for Tempo tools
  - `JIRA_EMAIL` — required when `JIRA_AUTH_TYPE=basic`
- Other:
  - `JIRA_AUTH_TYPE` (`basic` default, or `bearer`)
  - `JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID`
  - `DOTENV_PATH` — explicit override for `.env` location

### `mcp.config.json`

- Required:
  - `workspaceId`
  - `timezone`
- Optional:
  - `mode` (`toggl` | `tempo` | `both`, default `toggl`)
  - `defaultIssueKey`
  - `defaultWorkAttributes` (string or array)
  - `inactivityThresholdMinutes` (default 10)
  - `nudge.enabled` (default true)
  - `nudge.cooldownMinutes` (default 30)
  - `nudge.pushReminderAfterHours` (default 4)
  - `nudge.endOfDayHour` (default 17)

## Reliability and Billing Integrity Considerations

- Strong input validation with Zod for every tool
- Explicit timezone handling to reduce date drift
- Duplicate prevention via session/sync markers
- Cross-process state file (`.state.json`) for nudge cooldown across hook invocations
- Structured responses for auditable agent output
- Fail-fast startup for invalid config; missing credentials degrade tool catalog instead of crashing
- Hooks are non-blocking: timer + nudge-check are fire-and-forget / silent-on-failure to never block the dev's workflow

## Known Limitations

- Sync duplicate protection is marker-based; external/manual edits to descriptions can weaken detection
- `tempo_read_worklogs` resolves issue keys by calling the Jira issue endpoint per unique issue id
- No persistent local sync ledger yet (`togglEntryId → tempoWorklogId`) — idempotency is not fully durable
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
3. Edit `mcp.config.json` (`workspaceId`, `mode`, etc.)
4. Restart Claude Code
5. Smoke checks:
   - Open a session → verify Toggl timer appears with `[folder] branch`
   - `read_tracking_data` for today
   - `tempo_read_worklogs` for today
   - `preview_tempo_push --date today` (CLI: `node dist/cli.js tempo push --dry-run`)
   - `tempo_create_worklog` on a safe issue, then `tempo_delete_worklog` to clean up

## Ownership Notes

- This service should be treated as a billing-critical integration
- Changes to mapping, defaults, sync behavior, or duplicate markers must be peer-reviewed
- Touching the consolidator's window-splitting logic affects historical worklog totals
