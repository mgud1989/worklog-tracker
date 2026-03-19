import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { AppConfig, TempoJiraConfig } from "./types.js";

function resolveDotenvPath(): string {
  const explicitPath = process.env.DOTENV_PATH;
  if (explicitPath) {
    return resolve(process.cwd(), explicitPath);
  }

  const mcpConfigPath = process.env.MCP_CONFIG_PATH;
  if (mcpConfigPath) {
    const absoluteMcpConfigPath = resolve(process.cwd(), mcpConfigPath);
    const dotenvNearMcpConfig = resolve(dirname(absoluteMcpConfigPath), ".env");
    if (existsSync(dotenvNearMcpConfig)) {
      return dotenvNearMcpConfig;
    }
  }

  return resolve(process.cwd(), ".env");
}

loadDotenv({ path: resolveDotenvPath() });

const configSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  timezone: z.string().min(1, "timezone is required"),
  defaultIssueKey: z.string().min(1).optional(),
  defaultWorkAttributes: z
    .union([
      z.string().min(1),
      z.array(
        z.object({
          key: z.string().min(1),
          value: z.string().min(1)
        })
      )
    ])
    .optional()
});

const envSchema = z
  .object({
    TOGGL_API_TOKEN: z.string().min(1, "TOGGL_API_TOKEN is required"),
    TEMPO_API_TOKEN: z.string().optional(),
    JIRA_BASE_URL: z.string().optional(),
    JIRA_API_TOKEN: z.string().optional(),
    JIRA_EMAIL: z.string().optional(),
    JIRA_AUTH_TYPE: z.enum(["basic", "bearer"]).optional().default("basic"),
    JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID: z.string().optional()
  })
  .superRefine((env, ctx) => {
    const hasAnyTempoJira = [env.TEMPO_API_TOKEN, env.JIRA_BASE_URL, env.JIRA_API_TOKEN].some(
      Boolean
    );

    if (!hasAnyTempoJira) {
      return;
    }

    if (!env.TEMPO_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "TEMPO_API_TOKEN is required for Tempo tools",
        path: ["TEMPO_API_TOKEN"]
      });
    }

    if (!env.JIRA_BASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JIRA_BASE_URL is required for Tempo tools",
        path: ["JIRA_BASE_URL"]
      });
    }

    if (!env.JIRA_API_TOKEN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JIRA_API_TOKEN is required for Tempo tools",
        path: ["JIRA_API_TOKEN"]
      });
    }

    if (env.JIRA_AUTH_TYPE === "basic" && !env.JIRA_EMAIL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "JIRA_EMAIL is required when JIRA_AUTH_TYPE=basic",
        path: ["JIRA_EMAIL"]
      });
    }
  });

function validateTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Invalid timezone in MCP config: ${timezone}`);
  }
}

export function loadMcpConfig(configPathFromEnv?: string): AppConfig {
  const configPath = resolve(process.cwd(), configPathFromEnv ?? "mcp.config.json");

  if (!existsSync(configPath)) {
    throw new Error(
      `MCP config file not found at ${configPath}. Create it from mcp.config.example.json`
    );
  }

  const parsedRaw = JSON.parse(readFileSync(configPath, "utf8"));
  const rawConfig = configSchema.parse(parsedRaw);
  validateTimezone(rawConfig.timezone);

  const defaultWorkAttributes =
    typeof rawConfig.defaultWorkAttributes === "string"
      ? [{ key: "_Tipotarea_", value: rawConfig.defaultWorkAttributes }]
      : rawConfig.defaultWorkAttributes;

  return {
    workspaceId: rawConfig.workspaceId,
    timezone: rawConfig.timezone,
    defaultIssueKey: rawConfig.defaultIssueKey,
    defaultWorkAttributes
  };
}

export function loadAndValidateEnv(): {
  togglApiToken: string;
  tempoJiraConfig?: TempoJiraConfig;
} {
  const env = envSchema.parse(process.env);

  const hasTempoJira = [env.TEMPO_API_TOKEN, env.JIRA_BASE_URL, env.JIRA_API_TOKEN].every(Boolean);

  if (!hasTempoJira) {
    return { togglApiToken: env.TOGGL_API_TOKEN };
  }

  return {
    togglApiToken: env.TOGGL_API_TOKEN,
    tempoJiraConfig: {
      tempoApiToken: env.TEMPO_API_TOKEN!,
      jiraBaseUrl: env.JIRA_BASE_URL!,
      jiraApiToken: env.JIRA_API_TOKEN!,
      jiraAuthType: env.JIRA_AUTH_TYPE,
      jiraEmail: env.JIRA_EMAIL,
      jiraTempoAccountCustomFieldId: env.JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID
    }
  };
}
