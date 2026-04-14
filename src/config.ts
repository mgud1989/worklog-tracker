import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { AppConfig, TempoJiraConfig } from "./types.js";

/**
 * Resolve the worklog-tracker repo root based on where THIS compiled module
 * lives (dist/config.js → project root is one level up from dist/).
 *
 * Why this matters: hooks (SessionStart/UserPromptSubmit/etc.) invoke the CLI
 * from an arbitrary cwd (whatever directory Claude Code was launched in). If
 * we used process.cwd() to locate mcp.config.json or .env, the CLI would fail
 * silently whenever the user works outside this repo.
 */
function resolveProjectRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return dirname(__dirname);
}

/**
 * Resolve the MCP config path. Priority:
 *   1. MCP_CONFIG_PATH env var (absolute or cwd-relative — backward compatible)
 *   2. <projectRoot>/mcp.config.json  ← makes the CLI cwd-independent
 */
export function resolveConfigPath(): string {
  const fromEnv = process.env.MCP_CONFIG_PATH;
  if (fromEnv) return resolve(process.cwd(), fromEnv);
  return resolve(resolveProjectRoot(), "mcp.config.json");
}

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

  // Project-root fallback BEFORE cwd: hooks run from arbitrary directories,
  // and the canonical .env lives next to mcp.config.json in the repo root.
  const projectRootDotenv = resolve(resolveProjectRoot(), ".env");
  if (existsSync(projectRootDotenv)) {
    return projectRootDotenv;
  }

  return resolve(process.cwd(), ".env");
}

loadDotenv({ path: resolveDotenvPath() });

const nudgeConfigSchema = z.object({
  enabled: z.boolean().optional().default(true),
  cooldownMinutes: z.number().int().positive().optional().default(30),
  pushReminderAfterHours: z.number().positive().optional().default(4),
  endOfDayHour: z.number().int().min(0).max(23).optional().default(17)
}).optional().default({});

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
    .optional(),
  mode: z.enum(["toggl", "tempo", "both"]).optional().default("toggl"),
  inactivityThresholdMinutes: z.number().int().positive().optional().default(10),
  nudge: nudgeConfigSchema
});

const envSchema = z
  .object({
    TOGGL_API_TOKEN: z.string().optional(),
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
    defaultWorkAttributes,
    mode: rawConfig.mode,
    inactivityThresholdMinutes: rawConfig.inactivityThresholdMinutes,
    nudge: {
      enabled: rawConfig.nudge.enabled,
      cooldownMinutes: rawConfig.nudge.cooldownMinutes,
      pushReminderAfterHours: rawConfig.nudge.pushReminderAfterHours,
      endOfDayHour: rawConfig.nudge.endOfDayHour,
    }
  };
}

export function loadAndValidateEnv(): {
  togglApiToken?: string;
  tempoJiraConfig?: TempoJiraConfig;
} {
  const env = envSchema.parse(process.env);

  const hasTempoJira = [env.TEMPO_API_TOKEN, env.JIRA_BASE_URL, env.JIRA_API_TOKEN].every(Boolean);

  const result: { togglApiToken?: string; tempoJiraConfig?: TempoJiraConfig } = {};

  if (env.TOGGL_API_TOKEN) {
    result.togglApiToken = env.TOGGL_API_TOKEN;
  }

  if (hasTempoJira) {
    result.tempoJiraConfig = {
      tempoApiToken: env.TEMPO_API_TOKEN!,
      jiraBaseUrl: env.JIRA_BASE_URL!,
      jiraApiToken: env.JIRA_API_TOKEN!,
      jiraAuthType: env.JIRA_AUTH_TYPE,
      jiraEmail: env.JIRA_EMAIL,
      jiraTempoAccountCustomFieldId: env.JIRA_TEMPO_ACCOUNT_CUSTOM_FIELD_ID
    };
  }

  return result;
}
