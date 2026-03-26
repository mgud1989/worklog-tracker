import type {
  LogEntry,
  WorkWindow,
  ConsolidatedWorklog,
  PushPreview,
} from "./types.js";

const ISSUE_KEY_REGEX = /([A-Z][A-Z0-9]+-\d+)/;
const MINIMUM_WINDOW_MINUTES = 1;

type ConsolidateOptions = {
  inactivityThresholdMinutes: number;
  defaultIssueKey?: string;
};

// ─── Issue Key Extraction ──────────────────────────────────────────────

/**
 * Extract a Jira issue key from a branch name.
 * e.g. "feat/HORAS-42-session-push" => "HORAS-42"
 * Falls back to defaultIssueKey if no match.
 */
export function extractIssueKey(branch: string, defaultIssueKey?: string): string | undefined {
  const match = branch.match(ISSUE_KEY_REGEX);
  return match ? match[1] : defaultIssueKey;
}

// ─── Work Window Calculation ───────────────────────────────────────────

/**
 * Given sorted entries for a single session, compute work windows.
 *
 * Algorithm:
 * - Only ACTIVITY and START entries can open/extend windows.
 * - START is treated as the first activity point IF followed by ACTIVITY within threshold.
 * - For consecutive ACTIVITY entries, gap <= threshold => extend window. Gap > threshold => close + open new.
 * - STOP closes current window if within threshold of last activity.
 * - Each window tracks its branch (supports mid-session branch switches).
 * - Windows < MINIMUM_WINDOW_MINUTES are discarded.
 */
function computeWorkWindows(
  entries: LogEntry[],
  thresholdMinutes: number,
  sessionId: string,
): WorkWindow[] {
  // Only care about ACTIVITY entries for duration calculation
  const activityEntries = entries.filter(
    (e) => e.label === "ACTIVITY" || e.label === "START" || e.label === "STOP"
  );

  if (activityEntries.length === 0) return [];

  // Check if there are any ACTIVITY entries — sessions with no ACTIVITY = 0 work time
  const hasActivity = entries.some((e) => e.label === "ACTIVITY");
  if (!hasActivity) return [];

  const thresholdMs = thresholdMinutes * 60 * 1000;
  const windows: WorkWindow[] = [];

  let windowStart: Date | null = null;
  let windowEnd: Date | null = null;
  let windowBranch: string | null = null;

  for (const entry of activityEntries) {
    if (entry.label === "STOP") {
      // STOP closes current window if one is open
      if (windowStart !== null && windowEnd !== null) {
        const gap = entry.timestamp.getTime() - windowEnd.getTime();
        if (gap <= thresholdMs) {
          // STOP is within threshold — extend to STOP
          windowEnd = entry.timestamp;
        }
        // Emit the window either way
        const durationMinutes =
          (windowEnd.getTime() - windowStart.getTime()) / (60 * 1000);
        if (durationMinutes >= MINIMUM_WINDOW_MINUTES) {
          windows.push({
            start: windowStart,
            end: windowEnd,
            branch: windowBranch!,
            sessionId,
            durationMinutes: Math.round(durationMinutes * 100) / 100,
          });
        }
        windowStart = null;
        windowEnd = null;
        windowBranch = null;
      }
      continue;
    }

    if (entry.label === "START") {
      // START can open a pending window — but only counts if ACTIVITY follows within threshold
      // We just record it as potential start; next ACTIVITY will confirm or discard
      if (windowStart === null) {
        windowStart = entry.timestamp;
        windowEnd = entry.timestamp;
        windowBranch = entry.branch;
      }
      continue;
    }

    // entry.label === "ACTIVITY"
    if (windowStart === null) {
      // First activity — open a new window
      windowStart = entry.timestamp;
      windowEnd = entry.timestamp;
      windowBranch = entry.branch;
      continue;
    }

    const gap = entry.timestamp.getTime() - windowEnd!.getTime();

    // Branch switch: close current window, open new one
    if (entry.branch !== windowBranch) {
      const durationMinutes =
        (windowEnd!.getTime() - windowStart.getTime()) / (60 * 1000);
      if (durationMinutes >= MINIMUM_WINDOW_MINUTES) {
        windows.push({
          start: windowStart,
          end: windowEnd!,
          branch: windowBranch!,
          sessionId,
          durationMinutes: Math.round(durationMinutes * 100) / 100,
        });
      }
      windowStart = entry.timestamp;
      windowEnd = entry.timestamp;
      windowBranch = entry.branch;
      continue;
    }

    if (gap <= thresholdMs) {
      // Within threshold — extend window
      windowEnd = entry.timestamp;
    } else {
      // Gap exceeds threshold — close current window, open new one
      const durationMinutes =
        (windowEnd!.getTime() - windowStart.getTime()) / (60 * 1000);
      if (durationMinutes >= MINIMUM_WINDOW_MINUTES) {
        windows.push({
          start: windowStart,
          end: windowEnd!,
          branch: windowBranch!,
          sessionId,
          durationMinutes: Math.round(durationMinutes * 100) / 100,
        });
      }
      windowStart = entry.timestamp;
      windowEnd = entry.timestamp;
      windowBranch = entry.branch;
    }
  }

  // Emit trailing open window (orphaned session — no STOP)
  if (windowStart !== null && windowEnd !== null) {
    const durationMinutes =
      (windowEnd.getTime() - windowStart.getTime()) / (60 * 1000);
    if (durationMinutes >= MINIMUM_WINDOW_MINUTES) {
      windows.push({
        start: windowStart,
        end: windowEnd,
        branch: windowBranch!,
        sessionId,
        durationMinutes: Math.round(durationMinutes * 100) / 100,
      });
    }
  }

  return windows;
}

// ─── Cross-Midnight Splitting ──────────────────────────────────────────

/**
 * If a work window spans midnight, split it into two windows at 00:00.
 */
function splitCrossMidnightWindows(windows: WorkWindow[]): WorkWindow[] {
  const result: WorkWindow[] = [];

  for (const w of windows) {
    const startDay = getDateString(w.start);
    const endDay = getDateString(w.end);

    if (startDay === endDay) {
      result.push(w);
      continue;
    }

    // Split at midnight: first part ends at 23:59:59.999, second starts at 00:00:00
    const midnight = new Date(w.end.getFullYear(), w.end.getMonth(), w.end.getDate(), 0, 0, 0);

    const firstDuration = (midnight.getTime() - w.start.getTime()) / (60 * 1000);
    const secondDuration = (w.end.getTime() - midnight.getTime()) / (60 * 1000);

    if (firstDuration >= MINIMUM_WINDOW_MINUTES) {
      result.push({
        ...w,
        end: midnight,
        durationMinutes: Math.round(firstDuration * 100) / 100,
      });
    }

    if (secondDuration >= MINIMUM_WINDOW_MINUTES) {
      result.push({
        ...w,
        start: midnight,
        durationMinutes: Math.round(secondDuration * 100) / 100,
      });
    }
  }

  return result;
}

// ─── Consolidation ─────────────────────────────────────────────────────

/**
 * Group entries by sessionId, compute work windows, then consolidate by (date, branch).
 */
export function consolidateSessions(
  entries: LogEntry[],
  options: ConsolidateOptions,
): ConsolidatedWorklog[] {
  // Group entries by sessionId
  const sessionGroups = new Map<string, LogEntry[]>();
  for (const entry of entries) {
    const group = sessionGroups.get(entry.sessionId) ?? [];
    group.push(entry);
    sessionGroups.set(entry.sessionId, group);
  }

  // Compute work windows for each session
  let allWindows: WorkWindow[] = [];
  for (const [sessionId, sessionEntries] of sessionGroups) {
    // Sort chronologically within session
    sessionEntries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const windows = computeWorkWindows(sessionEntries, options.inactivityThresholdMinutes, sessionId);
    allWindows.push(...windows);
  }

  // Split cross-midnight windows
  allWindows = splitCrossMidnightWindows(allWindows);

  // Consolidate by (date, branch)
  type BucketKey = string; // "YYYY-MM-DD|branch"
  const buckets = new Map<
    BucketKey,
    {
      branch: string;
      date: string;
      totalMinutes: number;
      sessionIds: Set<string>;
      windowCount: number;
    }
  >();

  for (const w of allWindows) {
    const date = getDateString(w.start);
    const key = `${date}|${w.branch}`;

    const bucket = buckets.get(key) ?? {
      branch: w.branch,
      date,
      totalMinutes: 0,
      sessionIds: new Set<string>(),
      windowCount: 0,
    };

    bucket.totalMinutes += w.durationMinutes;
    bucket.sessionIds.add(w.sessionId);
    bucket.windowCount += 1;
    buckets.set(key, bucket);
  }

  // Build ConsolidatedWorklog[]
  const worklogs: ConsolidatedWorklog[] = [];
  for (const bucket of buckets.values()) {
    const sessionIds = Array.from(bucket.sessionIds);
    const issueKey = extractIssueKey(bucket.branch, options.defaultIssueKey);
    const sessionMarkers = sessionIds.map((id) => `[session:${id}]`).join(" ");
    const durationHours = Math.round((bucket.totalMinutes / 60) * 100) / 100;

    worklogs.push({
      issueKey: issueKey ?? "",
      branch: bucket.branch,
      date: bucket.date,
      durationHours,
      sessionIds,
      windowCount: bucket.windowCount,
      description: `${bucket.branch} ${sessionMarkers}`,
    });
  }

  // Sort by date then branch for deterministic output
  worklogs.sort((a, b) => a.date.localeCompare(b.date) || a.branch.localeCompare(b.branch));

  return worklogs;
}

// ─── Push Preview ──────────────────────────────────────────────────────

/**
 * Build a PushPreview from consolidated worklogs.
 */
export function buildPushPreview(worklogs: ConsolidatedWorklog[]): PushPreview {
  const totalHours = Math.round(
    worklogs.reduce((sum, w) => sum + w.durationHours, 0) * 100
  ) / 100;

  const dates = worklogs.map((w) => w.date).sort();
  const from = dates[0] ?? "";
  const to = dates[dates.length - 1] ?? "";

  const unmappedBranches = Array.from(
    new Set(
      worklogs.filter((w) => w.issueKey === "").map((w) => w.branch)
    )
  );

  return {
    worklogs,
    totalHours,
    dateRange: { from, to },
    unmappedBranches,
  };
}

// ─── Duplicate Detection ───────────────────────────────────────────────

const SESSION_MARKER_REGEX = /\[session:([^\]]+)\]/g;

/**
 * Extract session IDs from a Tempo worklog description.
 */
export function extractSessionMarkers(description: string): string[] {
  const markers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = SESSION_MARKER_REGEX.exec(description)) !== null) {
    markers.push(match[1]);
  }
  // Reset lastIndex for stateful regex
  SESSION_MARKER_REGEX.lastIndex = 0;
  return markers;
}

/**
 * Filter out worklogs whose sessions have already been pushed.
 * Returns { toPush, alreadyPushed }.
 */
export function filterAlreadyPushed(
  worklogs: ConsolidatedWorklog[],
  existingDescriptions: string[],
): { toPush: ConsolidatedWorklog[]; alreadyPushed: ConsolidatedWorklog[] } {
  const pushedSessionIds = new Set<string>();
  for (const desc of existingDescriptions) {
    for (const id of extractSessionMarkers(desc)) {
      pushedSessionIds.add(id);
    }
  }

  const toPush: ConsolidatedWorklog[] = [];
  const alreadyPushed: ConsolidatedWorklog[] = [];

  for (const worklog of worklogs) {
    const allSessionsPushed = worklog.sessionIds.every((id) => pushedSessionIds.has(id));
    if (allSessionsPushed) {
      alreadyPushed.push(worklog);
    } else {
      toPush.push(worklog);
    }
  }

  return { toPush, alreadyPushed };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function getDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
