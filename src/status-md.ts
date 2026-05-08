import { writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { SessionStatusEntry, SessionStatusRecord, LogEntry } from "./types.js";
import type { StateManager } from "./state-manager.js";
import { parseSessionLogs } from "./session-log-parser.js";

// ─── Render ────────────────────────────────────────────────────────────

/**
 * Render a SessionStatusEntry[] into the .logs/status.md markdown string.
 *
 * Format (spec § Status Markdown View — spec overrides design sketch):
 *   Last regenerated: <ISO>
 *
 *   | Date | Branch | Hours | Status | Session ID |
 *   |---|---|---|---|---|
 *   | 2026-05-07 | main | 2.5 | ✓ pushed | abc-123 |
 *
 * Rules:
 *   - Rows sorted date DESC, then branch ASC.
 *   - Status icon: ✓ pushed / ✗ skipped / · pending
 *   - NO footer, NO totals row.
 */
export function renderStatusMd(entries: SessionStatusEntry[]): string {
  const now = new Date().toISOString();

  const sorted = [...entries].sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date); // desc by date
    if (dateCmp !== 0) return dateCmp;
    return a.branch.localeCompare(b.branch);       // asc by branch
  });

  const statusLabel = (status: SessionStatusEntry["status"]): string => {
    switch (status) {
      case "pushed": return "✓ pushed";
      case "skipped": return "✗ skipped";
      case "pending": return "· pending";
    }
  };

  const tableHeader = "| Date | Branch | Hours | Status | Session ID |";
  const tableSep   = "|---|---|---|---|---|";

  const rows = sorted.map(
    (e) => `| ${e.date} | ${e.branch} | ${e.hours} | ${statusLabel(e.status)} | ${e.id} |`
  );

  return [`Last regenerated: ${now}`, "", tableHeader, tableSep, ...rows].join("\n") + "\n";
}

// ─── Build entries ────────────────────────────────────────────────────

/**
 * Build the full SessionStatusEntry[] for the retention window:
 *   - Parse log files over [retentionStartDate, today]
 *   - Group log entries by sessionId to derive branch, date, and hours
 *   - Cross-reference stateManager.sessions[] to enrich with pushed/skipped status
 *   - Sessions found in logs but not in state are marked "pending"
 *
 * Dates are formatted in the configured timezone so status.md and the
 * consolidator/preview agree on which day a session belongs to.
 *
 * Hours = (lastTimestamp - firstTimestamp) / 3600000, rounded to 2 decimals.
 * Best-effort approximation — session-consolidator.ts handles accurate
 * inactivity-aware calculation for push previews.
 */
export function buildSessionStatusEntries(
  stateManager: StateManager,
  sessionLogDir: string,
  retentionStartDate: string,
  today: string,
  timezone: string,
): SessionStatusEntry[] {
  let logEntries: LogEntry[];
  try {
    logEntries = parseSessionLogs(sessionLogDir, retentionStartDate, today);
  } catch {
    logEntries = [];
  }

  const sessionRecords = stateManager.listSessions();
  const sessionMap = new Map<string, SessionStatusRecord>();
  for (const s of sessionRecords) {
    sessionMap.set(s.id, s);
  }

  // en-CA renders ISO-style YYYY-MM-DD; pinning timeZone makes the result
  // independent of the Node process's local TZ.
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  type SessionAccum = { branch: string; date: string; firstMs: number; lastMs: number };
  const accumMap = new Map<string, SessionAccum>();

  for (const entry of logEntries) {
    const sid = entry.sessionId;
    if (!sid) continue;
    const dateStr = dateFmt.format(entry.timestamp);
    const ms = entry.timestamp.getTime();
    const existing = accumMap.get(sid);
    if (!existing) {
      accumMap.set(sid, { branch: entry.branch, date: dateStr, firstMs: ms, lastMs: ms });
    } else {
      existing.branch = entry.branch; // last seen branch wins
      if (ms < existing.firstMs) {
        existing.firstMs = ms;
        existing.date = dateStr; // date from earliest entry
      }
      if (ms > existing.lastMs) existing.lastMs = ms;
    }
  }

  const entries: SessionStatusEntry[] = [];
  for (const [id, accum] of accumMap) {
    const record = sessionMap.get(id);
    const status: SessionStatusEntry["status"] = record?.status ?? "pending";
    const hours = Math.round(((accum.lastMs - accum.firstMs) / (1000 * 60 * 60)) * 100) / 100;
    const entry: SessionStatusEntry = {
      id,
      branch: accum.branch,
      hours,
      date: accum.date,
      status,
    };
    if (record) {
      entry.at = record.at;
    }
    entries.push(entry);
  }

  return entries;
}

// ─── Regen ────────────────────────────────────────────────────────────

/**
 * Regenerate .logs/status.md atomically.
 * Non-existence on first run is not an error — creates the file.
 */
export function regenStatusMd(
  stateManager: StateManager,
  sessionLogDir: string,
  retentionStartDate: string,
  today: string,
  timezone: string,
): void {
  const entries = buildSessionStatusEntries(stateManager, sessionLogDir, retentionStartDate, today, timezone);
  const md = renderStatusMd(entries);

  // Atomic write: tmp + rename (matches state-manager pattern)
  const statusPath = join(sessionLogDir, "status.md");
  const tmpPath = join(sessionLogDir, "status.md.tmp");
  try {
    writeFileSync(tmpPath, md, "utf8");
    renameSync(tmpPath, statusPath);
  } catch (err) {
    console.error(`[status-md] Failed to write status.md: ${err}`);
  }
}
