import type { StateManager } from "./state-manager.js";
import type { NudgeConfig } from "./types.js";
import { parseSessionLogs } from "./session-log-parser.js";
import type { LogEntry } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface NudgeContext {
  stateManager: StateManager;
  timezone: string;
  sessionLogDir: string;
  nudgeConfig: NudgeConfig;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Get the current local hour in the given timezone.
 */
function getLocalHour(timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  return Number(formatter.format(new Date()));
}

/**
 * Get today's date string (YYYY-MM-DD) in the given timezone.
 */
function getTodayInTimezone(timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

/**
 * Find the oldest pending session's date string (YYYY-MM-DD), or null if none.
 * "Pending" = sessionId appears in logs AND has no entry in sessions[] with
 * status "pushed" or "skipped".
 *
 * Entries are already sorted chronologically by parseSessionLogs, so the
 * first pending session ID we encounter corresponds to the oldest pending date.
 */
export function findOldestPending(
  entries: LogEntry[],
  stateManager: StateManager,
): string | null {
  for (const entry of entries) {
    const sid = entry.sessionId;
    if (!sid) continue;
    if (stateManager.getSessionStatus(sid) === "pending") {
      return entry.timestamp.toISOString().slice(0, 10);
    }
  }
  return null;
}

/**
 * Count unpushed sessions within the full retention window by parsing session logs
 * and filtering out sessions already pushed or skipped.
 *
 * Returns { count, oldestPendingDate } where oldestPendingDate is null if no pending sessions.
 */
function countUnpushedSessions(
  sessionLogDir: string,
  stateManager: StateManager,
): { count: number; oldestPendingDate: string | null } {
  const retentionStart = stateManager.retentionStartDate();
  const today = new Date().toISOString().slice(0, 10);

  let entries: LogEntry[];
  try {
    entries = parseSessionLogs(sessionLogDir, retentionStart, today);
  } catch {
    return { count: 0, oldestPendingDate: null };
  }

  // Extract unique session IDs within retention window
  const windowSessionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId) {
      windowSessionIds.add(entry.sessionId);
    }
  }

  // Count pending sessions (not pushed, not skipped)
  let pendingCount = 0;
  for (const id of windowSessionIds) {
    if (stateManager.getSessionStatus(id) === "pending") {
      pendingCount++;
    }
  }

  const oldestPendingDate = pendingCount > 0 ? findOldestPending(entries, stateManager) : null;

  return { count: pendingCount, oldestPendingDate };
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Check nudge conditions IN ORDER and return the first matching message.
 * Returns null if no conditions match.
 *
 * Conditions (checked in priority order):
 * 1. Unpushed sessions + hours since last push > pushReminderAfterHours
 * 2. End of workday + any unpushed sessions
 *
 * Nudge message includes "oldest pending: YYYY-MM-DD" when pending sessions exist.
 */
export function buildNudge(ctx: NudgeContext): string | null {
  const { stateManager, timezone, sessionLogDir, nudgeConfig } = ctx;

  if (!nudgeConfig.enabled) return null;

  const { count: unpushedCount, oldestPendingDate } = countUnpushedSessions(
    sessionLogDir,
    stateManager,
  );

  if (unpushedCount === 0) return null;

  const oldestLine = oldestPendingDate ? `\noldest pending: ${oldestPendingDate}` : "";

  // Condition 1: Unpushed sessions AND hours since last push > threshold (or never pushed)
  const { lastPushAt, hoursSinceLastPush } = stateManager.getUnpushedInfo();
  const pushOverdue =
    lastPushAt === null || (hoursSinceLastPush !== null && hoursSinceLastPush > nudgeConfig.pushReminderAfterHours);

  if (pushOverdue) {
    const lastPushText =
      lastPushAt === null
        ? "never"
        : `${hoursSinceLastPush} hours ago`;
    const sessionLabel = unpushedCount === 1 ? "session" : "sessions";
    return `\n\n⏰ You have ${unpushedCount} unpushed ${sessionLabel}. Last push: ${lastPushText}. Consider running preview_tempo_push to review and push.${oldestLine}`;
  }

  // Condition 2: End of workday + any unpushed sessions
  const localHour = getLocalHour(timezone);
  if (localHour >= nudgeConfig.endOfDayHour) {
    const sessionLabel = unpushedCount === 1 ? "session" : "sessions";
    return `\n\n🕐 End of workday — you have ${unpushedCount} unpushed ${sessionLabel}. Run preview_tempo_push before wrapping up.${oldestLine}`;
  }

  return null;
}
