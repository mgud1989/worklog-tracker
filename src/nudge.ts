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

// ─── Nudge format ─────────────────────────────────────────────────────
// Each nudge is "instruction + data": an imperative phrase telling the
// agent what to relay, followed by raw data the agent uses to compose the
// user-facing message. The leading emoji (⏰ or ☕) is a stable anchor for
// the skill's description-based auto-activation. The nudge is injected via
// UserPromptSubmit hook into a <system-reminder>; the dev never sees it
// directly, the agent reformulates it (in the dev's language) and relays it.

// ─── Helpers ──────────────────────────────────────────────────────────

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
 * True iff today (in `timezone`) differs from the calendar day of `lastNudgeAt`,
 * or `lastNudgeAt` is null. Always TZ-pinned via Intl.DateTimeFormat — never
 * uses Date.getDate()/getFullYear() (regression class from #359).
 */
function isFirstPromptOfDay(lastNudgeAt: string | null, timezone: string): boolean {
  if (lastNudgeAt === null) return true;
  const today = getTodayInTimezone(timezone);
  const lastNudgeDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(lastNudgeAt));
  return lastNudgeDay !== today;
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
 * 1. Morning trigger (first prompt of calendar day) — morning ack or morning+pending string
 * 2. Push-overdue — unpushed sessions AND hours since last push > pushReminderAfterHours
 *
 * Morning trigger always fires before push-overdue when both conditions are true.
 */
export function buildNudge(ctx: NudgeContext): string | null {
  const { stateManager, timezone, sessionLogDir, nudgeConfig } = ctx;

  if (!nudgeConfig.enabled) return null;

  const { count: unpushedCount, oldestPendingDate } = countUnpushedSessions(
    sessionLogDir,
    stateManager,
  );

  const morningDue = isFirstPromptOfDay(stateManager.getLastNudgeAt(), timezone);

  // Branch (a): morning + pending → priority over push-overdue
  if (morningDue && unpushedCount > 0) {
    const oldestPart = oldestPendingDate ? `, oldest_pending=${oldestPendingDate}` : "";
    return `\n\n☕ Greet the dev (new day) and inform them they have unpushed sessions from previous work; offer preview_tempo_push. Data: unpushed=${unpushedCount}${oldestPart}.`;
  }

  // Branch (b): morning + nothing pending → warm ack (NEVER null in morning-mode)
  if (morningDue && unpushedCount === 0) {
    return `\n\n☕ Greet the dev (new day) and confirm no pending sessions to push. Data: unpushed=0.`;
  }

  // Branch (c): not morning, nothing pending → null
  if (unpushedCount === 0) return null;

  // Branch (d): not morning, sessions pending → existing push-overdue path
  const { lastPushAt, hoursSinceLastPush } = stateManager.getUnpushedInfo();
  const pushOverdue =
    lastPushAt === null ||
    (hoursSinceLastPush !== null && hoursSinceLastPush > nudgeConfig.pushReminderAfterHours);

  if (pushOverdue) {
    const lastPushPart =
      lastPushAt === null ? "last_push=never" : `last_push_hours_ago=${hoursSinceLastPush}`;
    const oldestPart = oldestPendingDate ? `, oldest_pending=${oldestPendingDate}` : "";
    return `\n\n⏰ Remind the dev they have unpushed sessions; offer preview_tempo_push. Data: unpushed=${unpushedCount}, ${lastPushPart}${oldestPart}.`;
  }

  return null;
}
