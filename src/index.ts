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
  parseTempoReadWorklogs
} from "./tools.js";

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
        "Preview session-based worklogs before pushing to Tempo. Parses session logs, consolidates by branch/day, and returns a preview with issue keys, hours, and duplicate detection.",
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
        const { from, to } = resolveDateInput(input);
        const logDir = resolveSessionLogDir();
        const entries = parseSessionLogs(logDir, from, to);
        const worklogs = consolidateSessions(entries, {
          inactivityThresholdMinutes: appConfig.inactivityThresholdMinutes,
          defaultIssueKey: appConfig.defaultIssueKey,
        });

        // Filter out already-pushed worklogs
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

        // Record successful pushes in state manager
        if (pushed > 0) {
          try {
            const successSessionIds = input.worklogs
              .filter((_, i) => results[i].status === "success")
              .flatMap((w) => w.sessionIds);
            stateManager.recordPush(successSessionIds);
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
