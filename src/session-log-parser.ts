import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, SessionLogLabel } from "./types.js";

const LOG_LINE_REGEX =
  /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) - \[(START|STOP|ACTIVITY|INACTIVITY)\] - Branch: (.+) - session: (.*)$/;

const VALID_LABELS = new Set<SessionLogLabel>(["START", "STOP", "ACTIVITY", "INACTIVITY"]);

function isTestSessionId(sessionId: string): boolean {
  return sessionId === "" || sessionId.startsWith("test-");
}

/**
 * Parse a single log line into a LogEntry, or return null if malformed/invalid.
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  const match = trimmed.match(LOG_LINE_REGEX);
  if (!match) {
    console.warn(`[session-log-parser] Skipping malformed line: ${trimmed}`);
    return null;
  }

  const [, day, month, year, hours, minutes, seconds, label, branch, sessionId] = match;

  if (!VALID_LABELS.has(label as SessionLogLabel)) return null;

  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds)
  );

  if (Number.isNaN(timestamp.getTime())) {
    console.warn(`[session-log-parser] Invalid date in line: ${trimmed}`);
    return null;
  }

  return {
    timestamp,
    label: label as SessionLogLabel,
    branch: branch.trim(),
    sessionId: sessionId.trim(),
    rawLine: trimmed,
  };
}

/**
 * Parse an entire log file into LogEntry[].
 */
export function parseLogFile(filePath: string): LogEntry[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, "utf8");
  const entries: LogEntry[] = [];

  for (const line of content.split("\n")) {
    const entry = parseLogLine(line);
    if (entry !== null) {
      entries.push(entry);
    }
  }

  return entries;
}

/**
 * Get the log file name for a given year/month: session-YYYY-MM.log
 * Also includes the legacy session.log file for entries that predate rotation.
 */
function getMonthlyLogFileName(year: number, month: number): string {
  const mm = String(month).padStart(2, "0");
  return `session-${year}-${mm}.log`;
}

/**
 * Get all log file paths that could contain entries in the given date range.
 * Includes the main session.log (legacy/current) + monthly rotated files.
 */
export function getLogFilesForRange(logDir: string, from: Date, to: Date): string[] {
  const files: string[] = [];

  // Always include legacy session.log — it may contain entries for any period
  const legacyPath = join(logDir, "session.log");
  if (existsSync(legacyPath)) {
    files.push(legacyPath);
  }

  // Add monthly files for each month in the range
  const startYear = from.getFullYear();
  const startMonth = from.getMonth() + 1;
  const endYear = to.getFullYear();
  const endMonth = to.getMonth() + 1;

  let year = startYear;
  let month = startMonth;

  while (year < endYear || (year === endYear && month <= endMonth)) {
    const fileName = getMonthlyLogFileName(year, month);
    const filePath = join(logDir, fileName);
    if (existsSync(filePath)) {
      files.push(filePath);
    }

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return files;
}

/**
 * Parse all log files for a date range and return filtered, deduplicated entries.
 * Filters out test/empty session IDs and entries outside the date range.
 *
 * @param logDir - Path to the .session-logs directory
 * @param from - Start date (inclusive, YYYY-MM-DD string)
 * @param to - End date (inclusive, YYYY-MM-DD string)
 */
export function getEntriesForRange(logDir: string, from: Date, to: Date): LogEntry[] {
  const files = getLogFilesForRange(logDir, from, to);

  // Build date boundaries: from start-of-day to end-of-day (inclusive)
  const fromStart = new Date(from.getFullYear(), from.getMonth(), from.getDate(), 0, 0, 0);
  const toEnd = new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59, 999);

  // Deduplicate by rawLine across files (session.log and monthly may overlap)
  const seen = new Set<string>();
  const entries: LogEntry[] = [];

  for (const file of files) {
    const fileEntries = parseLogFile(file);
    for (const entry of fileEntries) {
      // Skip test/empty session IDs
      if (isTestSessionId(entry.sessionId)) continue;

      // Filter by date range
      if (entry.timestamp < fromStart || entry.timestamp > toEnd) continue;

      // Deduplicate
      if (seen.has(entry.rawLine)) continue;
      seen.add(entry.rawLine);

      entries.push(entry);
    }
  }

  // Sort chronologically
  entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return entries;
}

/**
 * Convenience: parse session logs for a date range given string dates.
 */
/**
 * Parse a YYYY-MM-DD string as local time (not UTC).
 * new Date("2026-03-26") parses as UTC midnight, which shifts the day in negative UTC offsets.
 */
function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) throw new Error(`Invalid date: ${dateStr}`);
  return new Date(year, month - 1, day);
}

export function parseSessionLogs(logDir: string, from: string, to: string): LogEntry[] {
  const fromDate = parseLocalDate(from);
  const toDate = parseLocalDate(to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    throw new Error(`Invalid date range: from=${from}, to=${to}`);
  }

  return getEntriesForRange(logDir, fromDate, toDate);
}
