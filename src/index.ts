import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";
import { loadAndValidateEnv, loadMcpConfig } from "./config.js";
import { TempoJiraAdapter } from "./tempo-jira-adapter.js";
import { TogglTempoAdapter } from "./toggl-tempo-adapter.js";
import {
  buildToolResponse,
  parseLogWorkEntry,
  parseReadTrackingData,
  parseSyncTogglRangeToTempo,
  parseSmartTimerControl,
  parseTempoCreateWorklog,
  parseTempoReadWorklogs,
  parseUpdateWorkEntry
} from "./tools.js";

async function bootstrap() {
  const appConfig = loadMcpConfig(process.env.MCP_CONFIG_PATH);
  const env = loadAndValidateEnv();
  const adapter = await TogglTempoAdapter.create(env.togglApiToken, appConfig);
  const tempoJiraAdapter = env.tempoJiraConfig
    ? new TempoJiraAdapter(env.tempoJiraConfig, appConfig.timezone)
    : undefined;

  const server = new Server(
    {
      name: "toggl-mcp-server",
      version: "0.1.0"
    },
    {
      capabilities: {
        tools: {}
      }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "log_work_entry",
          description:
            "Create a Toggl worklog entry. Inputs are description, timeRange, optional project and tags.",
          inputSchema: {
            type: "object",
            properties: {
              description: { type: "string" },
              timeRange: {
                type: "object",
                properties: {
                  start: { type: "string", format: "date-time" },
                  end: { type: "string", format: "date-time" }
                },
                required: ["start", "end"],
                additionalProperties: false
              },
              project: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["description", "timeRange"],
            additionalProperties: false
          }
        },
        {
          name: "smart_timer_control",
          description:
            "Start or stop a Toggl timer. action=start requires description; action=stop can include optional time.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["start", "stop"]
              },
              description: { type: "string" },
              time: { type: "string", format: "date-time" },
              project: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["action"],
            additionalProperties: false
          }
        },
        {
          name: "read_tracking_data",
          description: "Read Toggl tracked entries in a given timeRange.",
          inputSchema: {
            type: "object",
            properties: {
              timeRange: {
                type: "object",
                properties: {
                  start: { type: "string", format: "date-time" },
                  end: { type: "string", format: "date-time" }
                },
                required: ["start", "end"],
                additionalProperties: false
              }
            },
            required: ["timeRange"],
            additionalProperties: false
          }
        },
        {
          name: "update_work_entry",
          description:
            "Editar un registro existente de Toggl por entryId. Permite editar description, start, stop, project y tags.",
          inputSchema: {
            type: "object",
            properties: {
              entryId: { type: "number" },
              description: { type: "string" },
              start: { type: "string", format: "date-time" },
              stop: { type: "string", format: "date-time" },
              project: { type: "string" },
              tags: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: ["entryId"],
            additionalProperties: false
          }
        },
        {
          name: "tempo_create_worklog",
          description:
            "Create a Tempo worklog in Jira. Requires issueKey, hours, date and optional description/startTime.",
          inputSchema: {
            type: "object",
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
            type: "object",
            properties: {
              startDate: { type: "string" },
              endDate: { type: "string" }
            },
            required: ["startDate", "endDate"],
            additionalProperties: false
          }
        },
        {
          name: "sync_toggl_range_to_tempo",
          description:
            "Sync closed Toggl entries in a time range to Tempo using issue keys from entry descriptions.",
          inputSchema: {
            type: "object",
            properties: {
              timeRange: {
                type: "object",
                properties: {
                  start: { type: "string", format: "date-time" },
                  end: { type: "string", format: "date-time" }
                },
                required: ["start", "end"],
                additionalProperties: false
              },
              defaultIssueKey: { type: "string" },
              defaultWorkAttributes: {
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
            required: ["timeRange"],
            additionalProperties: false
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments;

    try {
      if (name === "log_work_entry") {
        const input = parseLogWorkEntry(args);
        const result = await adapter.logWorkEntry(input);

        return buildToolResponse({
          ok: true,
          action: name,
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "smart_timer_control") {
        const input = parseSmartTimerControl(args);
        const result = await adapter.smartTimerControl(input);

        return buildToolResponse({
          ok: true,
          action: `${name}:${input.action}`,
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "read_tracking_data") {
        const input = parseReadTrackingData(args);
        const result = await adapter.readTrackingData(input);

        return buildToolResponse({
          ok: true,
          action: name,
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "update_work_entry") {
        const input = parseUpdateWorkEntry(args);
        const result = await adapter.updateWorkEntry(input);

        return buildToolResponse({
          ok: true,
          action: name,
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

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
          workspaceId: appConfig.workspaceId,
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
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            providerResult: result
          }
        });
      }

      if (name === "sync_toggl_range_to_tempo") {
        if (!tempoJiraAdapter) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            "Tempo/Jira environment is not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL and JIRA_API_TOKEN."
          );
        }

        const input = parseSyncTogglRangeToTempo(args);
        const effectiveInput = {
          ...input,
          defaultIssueKey: input.defaultIssueKey ?? appConfig.defaultIssueKey,
          defaultWorkAttributes: input.defaultWorkAttributes ?? appConfig.defaultWorkAttributes
        };
        const togglResult = await adapter.readTrackingData({
          timeRange: effectiveInput.timeRange
        });
        const result = await tempoJiraAdapter.syncTogglRangeToTempo(effectiveInput, togglResult);

        return buildToolResponse({
          ok: true,
          action: name,
          workspaceId: appConfig.workspaceId,
          timezone: appConfig.timezone,
          details: {
            input,
            effectiveInput,
            providerResult: result
          }
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
  process.stderr.write(`Failed to start toggl-mcp-server: ${message}\n`);
  process.exit(1);
});
