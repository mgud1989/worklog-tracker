import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEnv, loadMcpConfig } from "./config.js";
import { parseSessionLogs } from "./session-log-parser.js";
import {
  consolidateSessions,
  buildPushPreview,
  filterAlreadyPushed,
} from "./session-consolidator.js";
import { TempoJiraAdapter } from "./tempo-jira-adapter.js";
import { TogglTempoAdapter } from "./toggl-tempo-adapter.js";
import type { SmartTimerControlInput, TempoPushResult } from "./types.js";

const USAGE = `Usage:
  node dist/cli.js timer start --description "PROJ-123 working" [--project NAME] [--tags tag1,tag2]
  node dist/cli.js timer stop
  node dist/cli.js tempo push [--date today|YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run]`;

// ─── Timer Command ──────────────────────────────────────────────────────

function parseTimerArgs(flags: string[]): SmartTimerControlInput {
  const action = flags[0];
  if (action !== "start" && action !== "stop") {
    process.stderr.write(`Unknown action: ${action ?? "(none)"}\n\n${USAGE}\n`);
    process.exit(1);
  }

  const input: SmartTimerControlInput = { action };
  const rest = flags.slice(1);

  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];

    if (flag === "--description" && value) {
      input.description = value;
      i++;
    } else if (flag === "--project" && value) {
      input.project = value;
      i++;
    } else if (flag === "--tags" && value) {
      input.tags = value.split(",").map((t) => t.trim());
      i++;
    } else {
      process.stderr.write(`Unknown flag: ${flag}\n\n${USAGE}\n`);
      process.exit(1);
    }
  }

  if (action === "start" && !input.description) {
    process.stderr.write(`--description is required for timer start\n\n${USAGE}\n`);
    process.exit(1);
  }

  return input;
}

async function runTimerCommand(flags: string[]): Promise<void> {
  const input = parseTimerArgs(flags);

  const appConfig = loadMcpConfig(process.env.MCP_CONFIG_PATH);
  const env = loadAndValidateEnv();
  const adapter = await TogglTempoAdapter.create(env.togglApiToken, appConfig);

  const result = await adapter.smartTimerControl(input);

  if (input.action === "start") {
    process.stdout.write(`Timer started: ${input.description}\n`);
  } else {
    process.stdout.write("Timer stopped\n");
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ─── Tempo Push Command ─────────────────────────────────────────────────

type TempoPushFlags = {
  date?: string;
  from?: string;
  to?: string;
  dryRun: boolean;
};

function parseTempoPushFlags(flags: string[]): TempoPushFlags {
  const result: TempoPushFlags = { dryRun: false };

  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const value = flags[i + 1];

    if (flag === "--dry-run") {
      result.dryRun = true;
    } else if (flag === "--date" && value) {
      result.date = value;
      i++;
    } else if (flag === "--from" && value) {
      result.from = value;
      i++;
    } else if (flag === "--to" && value) {
      result.to = value;
      i++;
    } else {
      process.stderr.write(`Unknown flag for tempo push: ${flag}\n\n${USAGE}\n`);
      process.exit(1);
    }
  }

  // Validate: --date and --from/--to are mutually exclusive
  if (result.date && (result.from || result.to)) {
    process.stderr.write("Cannot use --date together with --from/--to\n\n" + USAGE + "\n");
    process.exit(1);
  }

  // --from and --to must be used together
  if ((result.from && !result.to) || (!result.from && result.to)) {
    process.stderr.write("--from and --to must be used together\n\n" + USAGE + "\n");
    process.exit(1);
  }

  // Default to today if nothing specified
  if (!result.date && !result.from) {
    result.date = "today";
  }

  return result;
}

function resolveProjectRoot(): string {
  // cli.ts lives at src/cli.ts, compiled to dist/cli.js
  // Project root is one level up from dist/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  return dirname(__dirname);
}

function resolveLogDir(): string {
  const projectRoot = resolveProjectRoot();
  return join(projectRoot, "session-logger", ".session-logs");
}

function resolveDateRange(flags: TempoPushFlags): { from: string; to: string } {
  if (flags.from && flags.to) {
    return { from: flags.from, to: flags.to };
  }

  // --date (or default "today")
  const dateStr = flags.date ?? "today";
  let resolved: string;

  if (dateStr === "today") {
    resolved = formatDateYMD(new Date());
  } else {
    // Validate YYYY-MM-DD
    const parsed = new Date(dateStr);
    if (Number.isNaN(parsed.getTime())) {
      process.stderr.write(`Invalid date: ${dateStr}. Use YYYY-MM-DD or "today"\n`);
      process.exit(1);
    }
    resolved = dateStr;
  }

  return { from: resolved, to: resolved };
}

function formatDateYMD(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function printPreviewTable(
  preview: ReturnType<typeof buildPushPreview>,
  alreadyPushed: number,
): void {
  process.stdout.write("\n");
  process.stdout.write(`Date range: ${preview.dateRange.from} → ${preview.dateRange.to}\n`);
  process.stdout.write(`Total: ${formatHours(preview.totalHours)} across ${preview.worklogs.length} worklog(s)\n`);

  if (alreadyPushed > 0) {
    process.stdout.write(`Skipped: ${alreadyPushed} worklog(s) already pushed\n`);
  }

  if (preview.unmappedBranches.length > 0) {
    process.stdout.write(`Warning: No issue key found for branches: ${preview.unmappedBranches.join(", ")}\n`);
  }

  process.stdout.write("\n");

  // Table header
  const header = padRow("Date", "Issue", "Branch", "Duration", "Sessions");
  const separator = "-".repeat(header.length);
  process.stdout.write(`${header}\n${separator}\n`);

  for (const w of preview.worklogs) {
    const row = padRow(
      w.date,
      w.issueKey || "(unmapped)",
      truncate(w.branch, 30),
      formatHours(w.durationHours),
      String(w.sessionIds.length),
    );
    process.stdout.write(`${row}\n`);
  }

  process.stdout.write("\n");
}

function padRow(date: string, issue: string, branch: string, duration: string, sessions: string): string {
  return `${date.padEnd(12)}${issue.padEnd(14)}${branch.padEnd(32)}${duration.padEnd(12)}${sessions}`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}

async function runTempoPushCommand(flags: string[]): Promise<void> {
  const pushFlags = parseTempoPushFlags(flags);
  const { from, to } = resolveDateRange(pushFlags);

  const logDir = resolveLogDir();
  const appConfig = loadMcpConfig(process.env.MCP_CONFIG_PATH);
  const env = loadAndValidateEnv();

  if (!env.tempoJiraConfig) {
    process.stderr.write(
      "Error: Tempo/Jira credentials not configured. Set TEMPO_API_TOKEN, JIRA_BASE_URL, and JIRA_API_TOKEN in .env\n"
    );
    process.exit(1);
  }

  process.stdout.write(`Parsing session logs for ${from} → ${to}...\n`);

  // Step 1: Parse logs
  const entries = parseSessionLogs(logDir, from, to);
  if (entries.length === 0) {
    process.stdout.write("No session log entries found for the specified date range.\n");
    return;
  }

  // Step 2: Consolidate into worklogs
  const worklogs = consolidateSessions(entries, {
    inactivityThresholdMinutes: appConfig.inactivityThresholdMinutes,
    defaultIssueKey: appConfig.defaultIssueKey,
  });

  if (worklogs.length === 0) {
    process.stdout.write("No work sessions found (all entries were below minimum duration).\n");
    return;
  }

  // Step 3: Check for duplicates against Tempo
  const tempoAdapter = new TempoJiraAdapter(env.tempoJiraConfig, appConfig.timezone);

  let existingDescriptions: string[] = [];
  try {
    const existingWorklogs = await tempoAdapter.readWorklogs({
      startDate: from,
      endDate: to,
    });
    existingDescriptions = (existingWorklogs as Array<{ description: string }>).map(
      (w) => w.description ?? ""
    );
  } catch {
    // If we can't read existing worklogs, proceed without duplicate detection
    process.stderr.write("Warning: Could not read existing Tempo worklogs for duplicate detection.\n");
  }

  const { toPush, alreadyPushed } = filterAlreadyPushed(worklogs, existingDescriptions);

  // Step 4: Build and display preview
  const preview = buildPushPreview(toPush);
  printPreviewTable(preview, alreadyPushed.length);

  if (toPush.length === 0) {
    process.stdout.write("Nothing to push — all sessions already logged in Tempo.\n");
    return;
  }

  // Step 5: Dry run exits here
  if (pushFlags.dryRun) {
    process.stdout.write("[dry-run] No worklogs were pushed.\n");
    return;
  }

  // Step 6: Push to Tempo
  process.stdout.write("Pushing worklogs to Tempo...\n\n");

  const result: TempoPushResult = {
    pushed: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  // Filter out worklogs with no issue key — can't push without one
  const pushable = toPush.filter((w) => w.issueKey !== "");
  const unmappedCount = toPush.length - pushable.length;

  if (unmappedCount > 0) {
    result.skipped += unmappedCount;
    process.stdout.write(`Skipping ${unmappedCount} worklog(s) with no issue key.\n`);
  }

  for (const worklog of pushable) {
    try {
      await tempoAdapter.createWorklog({
        issueKey: worklog.issueKey,
        timeSpentHours: worklog.durationHours,
        date: worklog.date,
        description: worklog.description,
        workAttributes: appConfig.defaultWorkAttributes,
      });

      result.pushed += 1;
      result.details.push({ issueKey: worklog.issueKey, status: "pushed" });
      process.stdout.write(`  ✓ ${worklog.issueKey} — ${worklog.date} — ${formatHours(worklog.durationHours)}\n`);
    } catch (error) {
      result.failed += 1;
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.details.push({ issueKey: worklog.issueKey, status: "failed", error: errorMsg });
      process.stderr.write(`  ✗ ${worklog.issueKey} — ${worklog.date} — ${errorMsg}\n`);
    }
  }

  // Step 7: Print summary
  process.stdout.write("\n");
  process.stdout.write(`Done: ${result.pushed} pushed, ${result.skipped} skipped, ${result.failed} failed\n`);

  if (result.failed > 0) {
    process.exit(1);
  }
}

// ─── Main Routing ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "timer") {
    await runTimerCommand(args.slice(1));
  } else if (command === "tempo" && args[1] === "push") {
    await runTempoPushCommand(args.slice(2));
  } else {
    process.stderr.write(`Unknown command: ${args.join(" ") || "(none)"}\n\n${USAGE}\n`);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
