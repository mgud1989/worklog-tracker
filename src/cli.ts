import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAndValidateEnv, loadMcpConfig, resolveConfigPath } from "./config.js";
import { buildNudge } from "./nudge.js";
import { parseSessionLogs } from "./session-log-parser.js";
import {
  consolidateSessions,
  buildPushPreview,
  filterAlreadyPushed,
} from "./session-consolidator.js";
import { StateManager } from "./state-manager.js";
import { regenStatusMd } from "./status-md.js";
import { TempoJiraAdapter } from "./tempo-jira-adapter.js";
import type { TempoPushResult } from "./types.js";

const USAGE = `Usage:
  node dist/cli.js tempo push [--date today|YYYY-MM-DD] [--from YYYY-MM-DD --to YYYY-MM-DD] [--dry-run]
  node dist/cli.js nudge-check`;

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

  // No default applied here: the MCP handler (index.ts) resolves
  // all-empty input to the retention window. CLI passes flags through as-is.
  // (Removed "today" default per spec § preview_tempo_push Default Window)

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
  return join(projectRoot, ".logs");
}

function resolveDateRange(flags: TempoPushFlags, stateManager: StateManager): { from: string; to: string } {
  if (flags.from && flags.to) {
    return { from: flags.from, to: flags.to };
  }

  // --date given explicitly
  if (flags.date) {
    let resolved: string;
    if (flags.date === "today") {
      resolved = formatDateYMD(new Date());
    } else {
      // Validate YYYY-MM-DD
      const parsed = new Date(flags.date);
      if (Number.isNaN(parsed.getTime())) {
        process.stderr.write(`Invalid date: ${flags.date}. Use YYYY-MM-DD or "today"\n`);
        process.exit(1);
      }
      resolved = flags.date;
    }
    return { from: resolved, to: resolved };
  }

  // No --date / --from / --to: default to the full retention window (mirrors MCP preview_tempo_push
  // empty-input behavior per spec § preview_tempo_push Default Window, decision #8).
  const today = formatDateYMD(new Date());
  const retentionStart = stateManager.retentionStartDate();
  return { from: retentionStart, to: today };
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
  const header = padRow("Date", "Issue", "Folder", "Branch", "Duration", "Sessions");
  const separator = "-".repeat(header.length);
  process.stdout.write(`${header}\n${separator}\n`);

  for (const w of preview.worklogs) {
    const row = padRow(
      w.date,
      w.issueKey || "(unmapped)",
      truncate(w.folder ?? "-", 18),
      truncate(w.branch, 30),
      formatHours(w.durationHours),
      String(w.sessionIds.length),
    );
    process.stdout.write(`${row}\n`);
  }

  process.stdout.write("\n");
}

function padRow(
  date: string,
  issue: string,
  folder: string,
  branch: string,
  duration: string,
  sessions: string,
): string {
  return `${date.padEnd(12)}${issue.padEnd(14)}${folder.padEnd(20)}${branch.padEnd(32)}${duration.padEnd(12)}${sessions}`;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 1) + "…" : str;
}

async function runTempoPushCommand(flags: string[]): Promise<void> {
  const pushFlags = parseTempoPushFlags(flags);

  const logDir = resolveLogDir();
  const appConfig = loadMcpConfig(resolveConfigPath());
  const env = loadAndValidateEnv();

  // StateManager must be initialized before resolveDateRange so that the
  // no-flags default can use the retention window (W2.1 fix).
  const stateManager = new StateManager(logDir, appConfig.logRetentionMonths);

  const { from, to } = resolveDateRange(pushFlags, stateManager);

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
    timezone: appConfig.timezone,
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

  // Track which session IDs were successfully pushed so we can update local state.
  const successfulSessionIds: string[] = [];

  for (const worklog of pushable) {
    try {
      await tempoAdapter.createWorklog({
        issueKey: worklog.issueKey,
        timeSpentHours: worklog.durationHours,
        date: worklog.date,
        startTime: worklog.startTime,
        description: worklog.description,
        workAttributes: appConfig.defaultWorkAttributes,
      });

      result.pushed += 1;
      result.details.push({ issueKey: worklog.issueKey, status: "pushed" });
      // Collect session IDs for state recording (mirrors MCP push_tempo_worklogs handler).
      successfulSessionIds.push(...worklog.sessionIds);
      process.stdout.write(`  ✓ ${worklog.issueKey} — ${worklog.date} — ${formatHours(worklog.durationHours)}\n`);
    } catch (error) {
      result.failed += 1;
      const errorMsg = error instanceof Error ? error.message : String(error);
      result.details.push({ issueKey: worklog.issueKey, status: "failed", error: errorMsg });
      process.stderr.write(`  ✗ ${worklog.issueKey} — ${worklog.date} — ${errorMsg}\n`);
    }
  }

  // Step 7: Record successful session IDs in state and regenerate status.md.
  // Mirrors the MCP push_tempo_worklogs handler post-push state update (index.ts:444-456).
  if (successfulSessionIds.length > 0) {
    try {
      stateManager.recordPush(successfulSessionIds);
      const pushToday = formatDateYMD(new Date());
      regenStatusMd(stateManager, logDir, stateManager.retentionStartDate(), pushToday, appConfig.timezone);
    } catch {
      // Don't fail the CLI on state recording errors — push already succeeded.
      process.stderr.write("Warning: Could not update local session state after push.\n");
    }
  }

  // Step 8: Print summary
  process.stdout.write("\n");
  process.stdout.write(`Done: ${result.pushed} pushed, ${result.skipped} skipped, ${result.failed} failed\n`);

  if (result.failed > 0) {
    process.exit(1);
  }
}

// ─── Nudge Check Command ────────────────────────────────────────────────
// Invoked from the UserPromptSubmit Claude Code hook. Whatever this writes to
// stdout is injected into the agent's context for the current user turn.
//
// Design rules:
//   - Fast and silent on the common path (no nudge → no stdout).
//   - Never throws / never exits non-zero: a broken nudge must NEVER block the
//     user's prompt from reaching the agent.
//   - Cooldown is persisted via StateManager because each hook invocation is a
//     fresh process and in-memory state would not survive between prompts.

async function runNudgeCheckCommand(): Promise<void> {
  try {
    const appConfig = loadMcpConfig(resolveConfigPath());

    if (!appConfig.nudge.enabled) return;

    const stateDir = resolveLogDir();
    const stateManager = new StateManager(stateDir, appConfig.logRetentionMonths);

    if (!stateManager.canNudge(appConfig.nudge.cooldownMinutes)) return;

    const nudge = buildNudge({
      stateManager,
      timezone: appConfig.timezone,
      sessionLogDir: stateDir,
      nudgeConfig: appConfig.nudge,
    });

    if (nudge) {
      process.stdout.write(`${nudge.trimStart()}\n`);
      stateManager.recordNudge();
    }
  } catch {
    // Swallow everything. The hook must never block the user's prompt.
  }
}

// ─── Main Routing ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "tempo" && args[1] === "push") {
    await runTempoPushCommand(args.slice(2));
  } else if (command === "nudge-check") {
    await runNudgeCheckCommand();
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
