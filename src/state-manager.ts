import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { parseSessionLogs } from "./session-log-parser.js";
import type { WorklogState, SessionRecord, SessionStatus, SessionStatusRecord, PersistedSessionStatus } from "./types.js";

// ─── Defaults ─────────────────────────────────────────────────────────

function createDefaultState(): WorklogState {
  return {
    lastPushAt: null,
    sessions: [],
    lastCleanedAt: new Date().toISOString().slice(0, 10),
    lastNudgeAt: null,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getCurrentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getMonthFromDate(dateStr: string): string {
  // Expects YYYY-MM-DD format
  return dateStr.slice(0, 7);
}

function getTodayYMD(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── StateManager ─────────────────────────────────────────────────────

export class StateManager {
  private readonly statePath: string;
  private readonly tmpPath: string;
  private readonly dir: string;
  private readonly logRetentionMonths: number;

  constructor(dir: string, logRetentionMonths = 3) {
    this.dir = dir;
    this.statePath = join(dir, ".state.json");
    this.tmpPath = join(dir, ".state.json.tmp");
    this.logRetentionMonths = logRetentionMonths;
  }

  /**
   * Returns the YYYY-MM-DD of the first day of the retention window:
   * first day of (currentMonth - logRetentionMonths + 1).
   *
   * Public so nudge.ts can consume it without duplicating the formula.
   */
  public retentionStartDate(): string {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (this.logRetentionMonths - 1), 1);
    return start.toISOString().slice(0, 10);
  }

  /**
   * Read state from disk. Returns defaults if file is missing or corrupted.
   * Triggers one-shot migration from legacy pushedSessionIds if present.
   * Triggers cleanup if lastCleanedAt is from a different month.
   */
  load(): WorklogState {
    let state: WorklogState;

    if (!existsSync(this.statePath)) {
      return createDefaultState();
    }

    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw);

      // ─── One-shot migration: pushedSessionIds → sessions[] ────────────
      // Condition: legacy field is present AND new field is absent.
      // No version negotiation per #327 (no-backcompat).
      if (Array.isArray(parsed.pushedSessionIds) && !Array.isArray(parsed.sessions)) {
        const at =
          typeof parsed.lastCleanedAt === "string"
            ? `${parsed.lastCleanedAt}T00:00:00.000Z`
            : new Date().toISOString();
        parsed.sessions = (parsed.pushedSessionIds as unknown[])
          .filter((id): id is string => typeof id === "string")
          .map((id) => ({ id, status: "pushed" as PersistedSessionStatus, at }));
        delete parsed.pushedSessionIds;
        // Save immediately so subsequent loads skip migration.
        writeFileSync(this.tmpPath, JSON.stringify(parsed, null, 2), "utf8");
        renameSync(this.tmpPath, this.statePath);
      }

      // Validate shape — fill in missing fields with defaults
      const defaults = createDefaultState();
      state = {
        lastPushAt: typeof parsed.lastPushAt === "string" ? parsed.lastPushAt : defaults.lastPushAt,
        sessions: Array.isArray(parsed.sessions)
          ? (parsed.sessions as unknown[]).filter(
              (s): s is SessionRecord =>
                typeof s === "object" &&
                s !== null &&
                typeof (s as SessionRecord).id === "string" &&
                ((s as SessionRecord).status === "pushed" || (s as SessionRecord).status === "skipped") &&
                typeof (s as SessionRecord).at === "string"
            )
          : defaults.sessions,
        lastCleanedAt: typeof parsed.lastCleanedAt === "string" ? parsed.lastCleanedAt : defaults.lastCleanedAt,
        lastNudgeAt: typeof parsed.lastNudgeAt === "string" ? parsed.lastNudgeAt : defaults.lastNudgeAt,
      };
    } catch (err) {
      console.error(`[state-manager] Failed to read state file, using defaults: ${err}`);
      return createDefaultState();
    }

    // Cleanup if month changed
    if (getMonthFromDate(state.lastCleanedAt) !== getCurrentMonth()) {
      this.cleanup(state);
    }

    return state;
  }

  /**
   * Atomic write: write to .tmp then rename to prevent corruption on crash.
   */
  save(state: WorklogState): void {
    try {
      const json = JSON.stringify(state, null, 2);
      writeFileSync(this.tmpPath, json, "utf8");
      renameSync(this.tmpPath, this.statePath);
    } catch (err) {
      console.error(`[state-manager] Failed to save state file: ${err}`);
    }
  }

  /**
   * Record a successful push: update lastPushAt, add/update session records.
   * - New id → append { id, status: "pushed", at: now }
   * - Already "pushed" → no-op (idempotent)
   * - Already "skipped" → overwrite to "pushed" (skip-then-push race; push wins per decision #4)
   *   and emit a stderr warning.
   *
   * Does NOT call regenStatusMd — caller (handler in index.ts) is responsible.
   */
  recordPush(sessionIds: string[]): void {
    const state = this.load();
    state.lastPushAt = new Date().toISOString();
    const now = new Date().toISOString();

    for (const id of sessionIds) {
      const existing = state.sessions.find((s) => s.id === id);
      if (!existing) {
        state.sessions.push({ id, status: "pushed", at: now });
      } else if (existing.status === "pushed") {
        // Already pushed — no-op
      } else {
        // status === "skipped" — push wins
        console.error(`[state-manager] Warning: session ${id} was skipped but is now being pushed. Overwriting status.`);
        existing.status = "pushed";
        existing.at = now;
      }
    }

    this.save(state);
  }

  /**
   * Mark a session as skipped.
   * - Already "pushed" → throw (decision #4: pushed↔skipped are mutually exclusive; push wins)
   * - Already "skipped" → no-op (idempotent re-skip)
   * - Not in sessions[] → append { id, status: "skipped", at }
   *
   * Caller (handler in index.ts) is responsible for validating that sessionId
   * exists in logs and for calling regenStatusMd after success.
   */
  recordSkipped(sessionId: string, at: string): void {
    const state = this.load();
    const existing = state.sessions.find((s) => s.id === sessionId);

    if (existing?.status === "pushed") {
      throw new Error(`session already pushed: ${sessionId}`);
    }

    if (existing?.status === "skipped") {
      // Idempotent — already skipped, nothing to do
      return;
    }

    state.sessions.push({ id: sessionId, status: "skipped", at });
    this.save(state);
  }

  /**
   * Get the status of a session.
   * O(N) scan over sessions[]; returns "pending" if not found.
   */
  getSessionStatus(sessionId: string): "pushed" | "skipped" | "pending" {
    const state = this.load();
    const record = state.sessions.find((s) => s.id === sessionId);
    return record?.status ?? "pending";
  }

  /**
   * List sessions by filter. Returns SessionStatusRecord[] (wide union — includes "pending").
   * - "pushed" / "skipped": filter sessions[] by status
   * - "pending": requires caller-supplied logIds (to keep state-manager free of parser dep).
   *   Returns synthetic { id, status: "pending", at: "" } for each logId not in sessions[].
   * - undefined: returns all sessions[] (status is always pushed|skipped for persisted records)
   *
   * Note: "pending" records are synthetic / transient — they are NEVER saved to disk.
   * The persistence boundary in load() rejects any record with status "pending".
   */
  listSessions(filter?: SessionStatus, logIds?: string[]): SessionStatusRecord[] {
    const state = this.load();

    if (filter === "pending") {
      if (!logIds) return [];
      const knownIds = new Set(state.sessions.map((s) => s.id));
      return logIds
        .filter((id) => !knownIds.has(id))
        .map((id): SessionStatusRecord => ({ id, status: "pending", at: "" }));
    }

    if (filter === "pushed" || filter === "skipped") {
      return state.sessions.filter((s) => s.status === filter);
    }

    // No filter — return all persisted records (PersistedSessionStatus ⊆ SessionStatus)
    return state.sessions;
  }

  /**
   * Check if a session was already pushed to Tempo.
   * @deprecated Use getSessionStatus() instead.
   */
  isSessionPushed(sessionId: string): boolean {
    return this.getSessionStatus(sessionId) === "pushed";
  }

  /**
   * Get info for the nudge system: when was the last push and how long ago.
   */
  getUnpushedInfo(): { lastPushAt: string | null; hoursSinceLastPush: number | null } {
    const state = this.load();

    if (state.lastPushAt === null) {
      return { lastPushAt: null, hoursSinceLastPush: null };
    }

    const lastPush = new Date(state.lastPushAt);
    const now = new Date();
    const hoursSinceLastPush = Math.round(((now.getTime() - lastPush.getTime()) / (1000 * 60 * 60)) * 100) / 100;

    return { lastPushAt: state.lastPushAt, hoursSinceLastPush };
  }

  /**
   * Cross-process nudge cooldown check. Returns true if enough time has passed
   * since the last delivered nudge (or if no nudge has ever been delivered).
   */
  canNudge(cooldownMinutes: number): boolean {
    const state = this.load();
    if (state.lastNudgeAt === null) return true;

    const last = new Date(state.lastNudgeAt).getTime();
    const now = Date.now();
    const elapsedMs = now - last;
    return elapsedMs >= cooldownMinutes * 60 * 1000;
  }

  /**
   * Persist that a nudge was just delivered. Used together with canNudge()
   * for cross-process cooldown.
   */
  recordNudge(): void {
    const state = this.load();
    state.lastNudgeAt = new Date().toISOString();
    this.save(state);
  }

  /**
   * Prune sessions[] by intersecting with log IDs parsed over [retentionStart, today].
   * Sessions whose IDs no longer appear in any surviving log file are dropped.
   *
   * Also deletes old monthly log files (session-YYYY-MM.log) that fall
   * outside the retention window. Legacy files without a YYYY-MM suffix
   * (session.log) are never touched.
   */
  cleanup(state?: WorklogState): void {
    const current = state ?? this.load();
    const today = getTodayYMD();
    const retentionStart = this.retentionStartDate();

    let logIds: Set<string>;
    try {
      const entries = parseSessionLogs(this.dir, retentionStart, today);
      logIds = new Set(entries.map((e) => e.sessionId).filter(Boolean));
    } catch {
      logIds = new Set();
    }

    current.sessions = current.sessions.filter((s) => logIds.has(s.id));
    current.lastCleanedAt = today;
    this.save(current);
    this.pruneLogFiles();
  }

  private pruneLogFiles(): void {
    if (!existsSync(this.dir)) return;

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // 1-based

    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }

    const pattern = /^session-(\d{4})-(\d{2})\.log$/;

    for (const entry of entries) {
      const match = pattern.exec(entry);
      if (!match) continue;

      const fileYear = parseInt(match[1], 10);
      const fileMonth = parseInt(match[2], 10);

      // Month delta: positive means the file is older than current month
      const monthsDelta =
        (currentYear - fileYear) * 12 + (currentMonth - fileMonth);

      if (monthsDelta >= this.logRetentionMonths) {
        try {
          rmSync(join(this.dir, entry));
        } catch {
          // Non-fatal — log to stderr and continue
          console.error(`[state-manager] Could not delete log file: ${entry}`);
        }
      }
    }
  }
}
