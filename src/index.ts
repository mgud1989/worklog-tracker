import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { dirname, resolve } from "node:path";
import { ZodError } from "zod";
import { loadAndValidateEnv, loadMcpConfig } from "./config.js";
import { consolidateSessions, buildPushPreview, filterAlreadyPushed } from "./session-consolidator.js";
import { parseSessionLogs } from "./session-log-parser.js";
import { StateManager } from "./state-manager.js";
import { TempoJiraAdapter } from "./tempo-jira-adapter.js";
import {
  buildToolResponse,
  parsePreviewTempoPush,
  parsePushTempoWorklogs,
  parseTempoCreateWorklog,
  parseTempoReadWorklogs,
  parseMarkSessionSkipped,
  parseListSessionStatus,
} from "./tools.js";
import { regenStatusMd, buildSessionStatusEntries } from "./status-md.js";

/**
 * Resolve the session-logs directory relative to the MCP config file location.
 * Falls back to the project root (dirname of the compiled index.js, one level up).
 */
function resolveSessionLogDir(): string {
  const mcpConfigPath = process.env.MCP_CONFIG_PATH;
  if (mcpConfigPath) {
    const configDir = dirname(resolve(process.cwd(), mcpConfigPath));
    return resolve(configDir, ".logs");
  }
  // Fallback: compiled JS lives in dist/, project root is one level up
  const scriptDir = dirname(new URL(import.meta.url).pathname);
  return resolve(scriptDir, "..", ".logs");
}

/**
 * Resolve "today" or a YYYY-MM-DD date string into { from, to } range.
 */
function resolveDateInput(input: { date?: string; from?: string; to?: string }): {
  from: string;
  to: string;
} {
  if (input.date) {
    const dateStr =
      input.date === "today"
        ? new Date().toISOString().slice(0, 10)
        : input.date;
    return { from: dateStr, to: dateStr };
  }
  return { from: input.from!, to: input.to! };
}

async function bootstrap() {
  const appConfig = loadMcpConfig(process.env.MCP_CONFIG_PATH);
  const env = loadAndValidateEnv();
  const tempoJiraAdapter = env.tempoJiraConfig
    ? new TempoJiraAdapter(env.tempoJiraConfig, appConfig.timezone)
    : null;

  const sessionLogDir = resolveSessionLogDir();
  const stateManager = new StateManager(sessionLogDir, appConfig.logRetentionMonths);
  stateManager.load(); // Initial load to validate/create state file

  const server = new Server(
    {
      name: "worklog-tracker",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  // ─── Tool definitions by category ─────────────────────────────────────
  const tempoTools = [
    {
      name: "tempo_create_worklog",
      description:
        "Create a Tempo worklog in Jira. Requires issueKey, hours, date and optional description/startTime.",
      inputSchema: {
        type: "object" as const,
        properties: {
          issueKey: { type: "string" },
          timeSpentHours: { type: "number" },
          date: { type: "string" },
          description: { type: "string" },
          startTime: { type: "string" },
          workAttributes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" }
              },
              required: ["key", "value"],
              additionalProperties: false
            }
          }
        },
        required: ["issueKey", "timeSpentHours", "date"],
        additionalProperties: false
      }
    },
    {
      name: "tempo_read_worklogs",
      description: "Read Tempo worklogs for current user in a date range.",
      inputSchema: {
        type: "object" as const,
        properties: {
          startDate: { type: "string" },
          endDate: { type: "string" }
        },
        required: ["startDate", "endDate"],
        additionalProperties: false
      }
    },
    {
      name: "push_tempo_worklogs",
      description:
        "Push confirmed session-based worklogs to Tempo. Accepts worklogs from preview_tempo_push output. Includes [session:id] markers in descriptions for duplicate protection.",
      inputSchema: {
        type: "object" as const,
        properties: {
          worklogs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                issueKey: { type: "string" },
                branch: { type: "string" },
                folder: {
                  type: "string",
                  description: "Optional repo folder name, captured at session-start. Used only for context."
                },
                date: { type: "string" },
                startTime: { type: "string", description: "HH:MM — start time for the worklog" },
                durationHours: { type: "number" },
                sessionIds: {
                  type: "array",
                  items: { type: "string" }
                },
                windowCount: { type: "number" },
                description: { type: "string" }
              },
              required: [
                "issueKey",
                "branch",
                "date",
                "startTime",
                "durationHours",
                "sessionIds",
                "windowCount",
                "description"
              ],
              additionalProperties: false
            }
          }
        },
        required: ["worklogs"],
        additionalProperties: false
      }
    },
    {
      name: "tempo_delete_worklog",
      description:
        "Delete a Tempo worklog by its tempoWorklogId. Use tempo_read_worklogs to find IDs first.",
      inputSchema: {
        type: "object" as const,
        properties: {
          tempoWorklogId: {
            type: "number",
            description: "The Tempo worklog ID to delete"
          }
        },
        required: ["tempoWorklogId"],
        additionalProperties: false
      }
    },
  ];

  // Tools that work without any API tokens (session-log based)
  const sessionLogTools = [
    {
      name: "preview_tempo_push",
      description:
        "Preview session-based worklogs before pushing to Tempo. Parses session logs, consolidates by branch/day, and returns a preview with issue keys, hours, and duplicate detection. When called with no arguments, defaults to the full retention window excluding already-pushed or skipped sessions.",
      inputSchema: {
        type: "object" as const,
        properties: {
          date: {
            type: "string",
            description: "Single date: 'today' or 'YYYY-MM-DD'"
          },
          from: {
            type: "string",
            description: "Range start: 'YYYY-MM-DD'"
          },
          to: {
            type: "string",
            description: "Range end: 'YYYY-MM-DD'"
          }
        },
        additionalProperties: false
      }
    },
    {
      name: "mark_session_skipped",
      description:
        "Mark a session as intentionally skipped (not pushed to Tempo). The session must exist in log files within the retention window and must not have been already pushed. Idempotent: re-skipping an already-skipped session succeeds with no change. Regenerates .logs/status.md.",
      inputSchema: {
        type: "object" as const,
        properties: {
          sessionId: {
            type: "string",
            description: "Session ID to mark as skipped"
          }
        },
        required: ["sessionId"],
        additionalProperties: false
      }
    },
    {
      name: "list_session_status",
      description:
        "List per-session push status for sessions in the retention window. Optionally filter by status: pushed, skipped, or pending. Regenerates .logs/status.md as a side effect and returns its path.",
      inputSchema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["pushed", "skipped", "pending"],
            description: "Optional status filter"
          }
        },
        additionalProperties: false
      }
    },
  ];

  // ─── Assemble tools ────────────────────────────────────────────────────
  type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> };
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools: ToolDef[] = [...sessionLogTools]; // Always available

    if (tempoJiraAdapter) {
      tools.push(...tempoTools);
    }

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments;

    try {
      if (name === "tempo_create_worklog") {
        if (!tempoJiraAdapter) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Tempo/Jira environment is not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL and JIRA_API_TOKEN."
          );
        }

        const input = parseTempoCreateWorklog(args);
        const result = await tempoJiraAdapter.createWorklog(input);

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "tempo_read_worklogs") {
        if (!tempoJiraAdapter) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Tempo/Jira environment is not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL and JIRA_API_TOKEN."
          );
        }

        const input = parseTempoReadWorklogs(args);
        const result = await tempoJiraAdapter.readWorklogs(input);

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "preview_tempo_push") {
        const input = parsePreviewTempoPush(args);

        // Handler-side cross-field validation (moved from superRefine per design D6)
        const hasDate = input.date !== undefined;
        const hasFrom = input.from !== undefined;
        const hasTo = input.to !== undefined;

        if (hasDate && (hasFrom || hasTo)) {
          throw new McpError(ErrorCode.InvalidParams, "Cannot specify both 'date' and 'from'/'to' range");
        }
        if (hasFrom !== hasTo) {
          throw new McpError(ErrorCode.InvalidParams, "Both 'from' and 'to' are required when using a date range");
        }
        if (hasFrom && hasTo && input.to! < input.from!) {
          throw new McpError(ErrorCode.InvalidParams, "'to' must be greater than or equal to 'from'");
        }

        // Resolve date range: if all empty → retention window default (spec scenario 8)
        let from: string;
        let to: string;
        const today = new Date().toISOString().slice(0, 10);

        if (!hasDate && !hasFrom && !hasTo) {
          from = stateManager.retentionStartDate();
          to = today;
        } else {
          ({ from, to } = resolveDateInput(input));
        }

        const logDir = resolveSessionLogDir();
        const entries = parseSessionLogs(logDir, from, to);

        // When using retention window default: filter out sessions already pushed/skipped
        // locally. This gives a clean "what do I still need to push?" view (spec scenario 8).
        let filteredEntries = entries;
        const isDefaultWindow = !hasDate && !hasFrom && !hasTo;
        if (isDefaultWindow) {
          const logIds = [...new Set(entries.map((e) => e.sessionId).filter(Boolean))];
          const pendingIds = new Set(
            logIds.filter((id) => stateManager.getSessionStatus(id) === "pending")
          );
          filteredEntries = entries.filter((e) => !e.sessionId || pendingIds.has(e.sessionId));
        }

        const worklogs = consolidateSessions(filteredEntries, {
          inactivityThresholdMinutes: appConfig.inactivityThresholdMinutes,
          defaultIssueKey: appConfig.defaultIssueKey,
        });

        // Filter out already-pushed worklogs via Tempo description markers
        let alreadyPushedCount = 0;
        let toPush = worklogs;
        if (tempoJiraAdapter) {
          try {
            const existing = await tempoJiraAdapter.readWorklogs({
              startDate: from,
              endDate: to,
            });
            const existingDescriptions = (existing as Array<{ description: string }>).map(
              (w) => w.description ?? ""
            );
            const filtered = filterAlreadyPushed(worklogs, existingDescriptions);
            toPush = filtered.toPush;
            alreadyPushedCount = filtered.alreadyPushed.length;
          } catch {
            // If we can't check, show all worklogs
          }
        }

        const preview = buildPushPreview(toPush);

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: {
            input: { from, to },
            logDir,
            alreadyPushedCount,
            preview,
          },
        });
      }

      if (name === "push_tempo_worklogs") {
        if (!tempoJiraAdapter) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Tempo/Jira environment is not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL and JIRA_API_TOKEN."
          );
        }

        const input = parsePushTempoWorklogs(args);
        const results: Array<{
          issueKey: string;
          date: string;
          hours: number;
          status: "success" | "failed";
          error?: string;
        }> = [];

        for (const worklog of input.worklogs) {
          try {
            await tempoJiraAdapter.createWorklog({
              issueKey: worklog.issueKey,
              timeSpentHours: worklog.durationHours,
              date: worklog.date,
              startTime: worklog.startTime,
              description: worklog.description,
              workAttributes: appConfig.defaultWorkAttributes,
            });
            results.push({
              issueKey: worklog.issueKey,
              date: worklog.date,
              hours: worklog.durationHours,
              status: "success",
            });
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            results.push({
              issueKey: worklog.issueKey,
              date: worklog.date,
              hours: worklog.durationHours,
              status: "failed",
              error: errorMessage,
            });
          }
        }

        const pushed = results.filter((r) => r.status === "success").length;
        const failed = results.filter((r) => r.status === "failed").length;

        // Record successful pushes in state manager, then regen status.md
        if (pushed > 0) {
          try {
            const successSessionIds = input.worklogs
              .filter((_, i) => results[i].status === "success")
              .flatMap((w) => w.sessionIds);
            stateManager.recordPush(successSessionIds);
            // Regen status.md after recording push (spec cross-cutting note; design D8)
            const pushLogDir = resolveSessionLogDir();
            const pushToday = new Date().toISOString().slice(0, 10);
            regenStatusMd(stateManager, pushLogDir, stateManager.retentionStartDate(), pushToday, appConfig.timezone);
          } catch {
            // Don't break the response if state recording fails
          }
        }

        return buildToolResponse({
          ok: failed === 0,
          action: name,
          timezone: appConfig.timezone,
          details: {
            pushed,
            failed,
            total: results.length,
            results,
          },
        });
      }

      if (name === "tempo_delete_worklog") {
        if (!tempoJiraAdapter) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Tempo/Jira environment is not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL and JIRA_API_TOKEN."
          );
        }

        const { tempoWorklogId } = args as { tempoWorklogId: number };
        if (!tempoWorklogId || typeof tempoWorklogId !== "number") {
          throw new McpError(ErrorCode.InvalidParams, "tempoWorklogId (number) is required");
        }

        await tempoJiraAdapter.deleteWorklog(tempoWorklogId);

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: {
            deleted: tempoWorklogId,
          },
        });
      }

      if (name === "mark_session_skipped") {
        const input = parseMarkSessionSkipped(args);
        const { sessionId } = input;

        const skipToday = new Date().toISOString().slice(0, 10);
        const skipLogDir = resolveSessionLogDir();
        const retentionStart = stateManager.retentionStartDate();

        // Validate: sessionId must exist in logs within [retentionStart, today] (spec scenario 6)
        const logIds = new Set(
          parseSessionLogs(skipLogDir, retentionStart, skipToday)
            .map((e) => e.sessionId)
            .filter(Boolean)
        );
        if (!logIds.has(sessionId)) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Session not found in log files within retention window: ${sessionId}`
          );
        }

        // Validate: must not already be pushed (spec scenario 5; recordSkipped throws if pushed)
        try {
          stateManager.recordSkipped(sessionId, new Date().toISOString());
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new McpError(ErrorCode.InvalidRequest, msg);
        }

        // Regen status.md (spec scenario 4; design D8)
        regenStatusMd(stateManager, skipLogDir, retentionStart, skipToday, appConfig.timezone);

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: { sessionId, skipped: true },
        });
      }

      if (name === "list_session_status") {
        const input = parseListSessionStatus(args);
        const listToday = new Date().toISOString().slice(0, 10);
        const listLogDir = resolveSessionLogDir();
        const listRetentionStart = stateManager.retentionStartDate();

        const allEntries = buildSessionStatusEntries(
          stateManager,
          listLogDir,
          listRetentionStart,
          listToday,
          appConfig.timezone,
        );
        const entries = input.status
          ? allEntries.filter((e) => e.status === input.status)
          : allEntries;

        // Regen status.md as a side effect (spec requirement; design D8).
        // Always renders the full set, ignoring the response filter.
        regenStatusMd(stateManager, listLogDir, listRetentionStart, listToday, appConfig.timezone);

        const statusFilePath = `${listLogDir}/status.md`;

        return buildToolResponse({
          ok: true,
          action: name,
          timezone: appConfig.timezone,
          details: { entries, statusFilePath },
        });
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Invalid tool input: ${error.issues.map((issue) => issue.message).join("; ")}`
        );
      }

      const message = error instanceof Error ? error.message : "Unknown error";
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Failed to start worklog-tracker: ${message}\n`);
  process.exit(1);
});
