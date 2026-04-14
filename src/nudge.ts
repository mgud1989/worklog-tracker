import type { ActivityTracker } from "./activity-tracker.js";
import type { StateManager } from "./state-manager.js";
import type { NudgeConfig } from "./types.js";
import { parseSessionLogs } from "./session-log-parser.js";

// ─── Types ────────────────────────────────────────────────────────────

export interface NudgeContext {
  sessionId: string;
  tracker: ActivityTracker;
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
 * Count unpushed sessions from today by parsing session logs
 * and filtering out already-pushed session IDs.
 */
function countUnpushedSessions(
  sessionLogDir: string,
  timezone: string,
  pushedSessionIds: string[],
): number {
  const today = getTodayInTimezone(timezone);

  let entries;
  try {
    entries = parseSessionLogs(sessionLogDir, today, today);
  } catch {
    return 0;
  }

  // Extract unique session IDs from today's log entries
  const todaySessionIds = new Set<string>();
  for (const entry of entries) {
    if (entry.sessionId) {
      todaySessionIds.add(entry.sessionId);
    }
  }

  // Filter out already-pushed sessions
  const pushedSet = new Set(pushedSessionIds);
  let unpushedCount = 0;
  for (const id of todaySessionIds) {
    if (!pushedSet.has(id)) {
      unpushedCount++;
    }
  }

  return unpushedCount;
}

// ─── Main ─────────────────────────────────────────────────────────────

/**
 * Check nudge conditions IN ORDER and return the first matching message.
 * Returns null if no conditions match.
 *
 * Conditions (checked in priority order):
 * 1. Unpushed sessions + hours since last push > pushReminderAfterHours
 * 2. End of workday + any unpushed sessions
 */
export function buildNudge(ctx: NudgeContext): string | null {
  const { stateManager, timezone, sessionLogDir, nudgeConfig } = ctx;

  if (!nudgeConfig.enabled) return null;

  const state = stateManager.load();
  const unpushedCount = countUnpushedSessions(
    sessionLogDir,
    timezone,
    state.pushedSessionIds,
  );

  if (unpushedCount === 0) return null;

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
    return `\n\n\u23F0 You have ${unpushedCount} unpushed ${sessionLabel} from today. Last push: ${lastPushText}. Consider running preview_tempo_push to review and push.`;
  }

  // Condition 2: End of workday + any unpushed sessions
  const localHour = getLocalHour(timezone);
  if (localHour >= nudgeConfig.endOfDayHour) {
    const sessionLabel = unpushedCount === 1 ? "session" : "sessions";
    return `\n\n\uD83D\uDD50 End of workday \u2014 you have ${unpushedCount} unpushed ${sessionLabel} from today. Run preview_tempo_push before wrapping up.`;
  }

  return null;
}
