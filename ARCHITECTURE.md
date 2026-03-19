# Architecture and Maintenance Guide

## Scope

This service is a Model Context Protocol (MCP) server that centralizes:
- Time tracking operations in Toggl.
- Worklog operations in Tempo/Jira.
- Synchronization from Toggl entries to Tempo worklogs.

It is intended for engineering teams where worklog integrity affects billing and reporting.

## Stack

- Runtime: Node.js 20+
- Language: TypeScript
- MCP SDK: `@modelcontextprotocol/sdk`
- Validation: `zod`
- Env loading: `dotenv`
- External APIs:
  - Toggl Track API v9 (`https://api.track.toggl.com/api/v9`)
  - Tempo API v4 (`https://api.tempo.io/4`)
  - Jira REST API v3 (`/rest/api/3/...`)

## High-level Components

- `src/index.ts`
  - MCP bootstrap.
  - Tool catalog definition.
  - Tool routing and error mapping.

- `src/config.ts`
  - Loads `.env` and validates environment variables.
  - Loads and validates `mcp.config.json`.
  - Normalizes sync defaults (`defaultIssueKey`, `defaultWorkAttributes`).

- `src/tools.ts`
  - Input schemas and parser functions for all tools.

- `src/toggl-tempo-adapter.ts`
  - Toggl operations:
    - create entry
    - start/stop timer
    - read entries
    - update entry
  - Uses `toggl-tempo` if compatible exports are present.
  - Falls back to direct Toggl API v9 calls.

- `src/tempo-jira-adapter.ts`
  - Tempo operations:
    - create worklog
    - read worklogs by current user
  - Jira operations:
    - resolve current user account id
    - resolve issue key/id and optional account field
  - Sync logic Toggl -> Tempo with duplicate protection marker.

## Tool Inventory

### Toggl tools

- `log_work_entry`
- `smart_timer_control`
- `read_tracking_data`
- `update_work_entry`

### Tempo tools

- `tempo_create_worklog`
- `tempo_read_worklogs`

### Sync tool

- `sync_toggl_range_to_tempo`

## Core Data Concepts

- Toggl entry
  - `id`, `description`, `start`, `stop`, `duration`, `tags`

- Tempo worklog
  - `tempoWorklogId`, `issueId`, `startDate`, `startTime`, `timeSpentSeconds`, `description`, `attributes`

- Sync marker
  - Description suffix in Tempo: `[toggl:<entryId>]`
  - Used for idempotency-like duplicate avoidance.

- Default routing values
  - `defaultIssueKey`: fallback issue if none found in description.
  - `defaultWorkAttributes`: fallback attributes for required Tempo fields.

## Main Flows

### 1) Create/Update Toggl entries

1. MCP tool receives validated input.
2. `TogglTempoAdapter` maps fields to Toggl payload.
3. Toggl API returns created/updated entry.
4. MCP responds with structured payload.

### 2) Create Tempo worklog directly

1. Resolve Jira issue by `issueKey`.
2. Resolve Jira current user `accountId`.
3. Resolve optional Tempo account attribute from Jira custom field.
4. Resolve and normalize provided work attributes.
5. Create worklog via Tempo API.

### 3) Sync Toggl range to Tempo

1. Read Toggl entries in time range.
2. Keep closed entries only (`stop` present, positive duration).
3. Read existing Tempo worklogs in the corresponding date window.
4. Build set of existing `[toggl:<id>]` markers.
5. For each eligible Toggl entry:
   - Issue key from description if available.
   - Else fallback to `defaultIssueKey`.
   - Build description + sync marker.
   - Create Tempo worklog with default attributes.
6. Return per-entry sync result (`synced`, `skipped`, `failed`).

## Configuration Model

### `.env`

- Required always:
  - `TOGGL_API_TOKEN`
- Required for Tempo tools:
  - `TEMPO_API_TOKEN`
  - `JIRA_BASE_URL`
  - `JIRA_API_TOKEN`
  - `JIRA_EMAIL` (when `JIRA_AUTH_TYPE=basic`)
- Optional:
  - `JIRA_AUTH_TYPE` (`basic` or `bearer`)
  - `JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID`
  - `DOTENV_PATH`

### `mcp.config.json`

- Required:
  - `workspaceId`
  - `timezone`
- Optional:
  - `defaultIssueKey`
  - `defaultWorkAttributes`

## Reliability and Billing Integrity Considerations

- Strong input validation with Zod for every tool.
- Explicit timezone handling to reduce date drift.
- Duplicate prevention via sync markers.
- Structured responses for auditable agent output.
- Fail-fast startup for invalid config or missing credentials.

## Known Limitations

- Sync duplicate protection is marker-based; external/manual edits to descriptions can weaken detection.
- `readTempoWorklogs` resolves issue keys by calling Jira issue endpoint per unique issue id.
- No persistent local sync ledger yet (idempotency is not fully durable).
- No retry/backoff policy yet for transient API failures.

## Suggested Next Hardening Steps

1. Add retry policy with exponential backoff for 429/5xx responses.
2. Add persistent sync ledger (`togglEntryId -> tempoWorklogId`) in SQLite.
3. Add structured logging correlation id per tool call.
4. Add unit tests for parsers and mapping logic.
5. Add integration tests for adapters with mocked APIs.

## Runbook (Quick)

1. `npm install`
2. Create `.env` from `.env.example`
3. Create `mcp.config.json` from example
4. `npm run build`
5. Configure MCP client to run `node /absolute/path/dist/index.js`
6. Run smoke checks:
   - `read_tracking_data`
   - `tempo_read_worklogs`
   - `tempo_create_worklog` on a safe issue
   - `sync_toggl_range_to_tempo` on a short range

## Ownership Notes

- This service should be treated as billing-critical integration.
- Changes to mapping, defaults, and sync behavior should be peer-reviewed.
