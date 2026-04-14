import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

// ─── Types ────────────────────────────────────────────────────────────

export interface WorklogState {
  lastPushAt: string | null;       // ISO datetime of last Tempo push
  pushedSessionIds: string[];      // Session IDs already pushed to Tempo
  lastCleanedAt: string;           // ISO date (YYYY-MM-DD) of last cleanup
  lastNudgeAt: string | null;      // ISO datetime of last hook-delivered nudge (cross-process cooldown)
}

// ─── Defaults ─────────────────────────────────────────────────────────

function createDefaultState(): WorklogState {
  return {
    lastPushAt: null,
    pushedSessionIds: [],
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

// ─── StateManager ─────────────────────────────────────────────────────

export class StateManager {
  private readonly statePath: string;
  private readonly tmpPath: string;

  constructor(stateDir: string) {
    this.statePath = join(stateDir, ".state.json");
    this.tmpPath = join(stateDir, ".state.json.tmp");
  }

  /**
   * Read state from disk. Returns defaults if file is missing or corrupted.
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

      // Validate shape — fill in missing fields with defaults
      const defaults = createDefaultState();
      state = {
        lastPushAt: typeof parsed.lastPushAt === "string" ? parsed.lastPushAt : defaults.lastPushAt,
        pushedSessionIds: Array.isArray(parsed.pushedSessionIds)
          ? parsed.pushedSessionIds.filter((id: unknown) => typeof id === "string")
          : defaults.pushedSessionIds,
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
   * Record a successful push: update lastPushAt, add session IDs, persist.
   */
  recordPush(sessionIds: string[]): void {
    const state = this.load();
    state.lastPushAt = new Date().toISOString();

    // Add only new session IDs (avoid duplicates)
    const existing = new Set(state.pushedSessionIds);
    for (const id of sessionIds) {
      if (!existing.has(id)) {
        state.pushedSessionIds.push(id);
      }
    }

    this.save(state);
  }

  /**
   * Check if a session was already pushed to Tempo.
   */
  isSessionPushed(sessionId: string): boolean {
    const state = this.load();
    return state.pushedSessionIds.includes(sessionId);
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
   *
   * Used by the UserPromptSubmit hook CLI path, where each invocation is a fresh
   * process — so the in-memory ActivityTracker cooldown can't apply.
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
   * Prune pushedSessionIds when the month changes.
   * Since individual session IDs don't carry timestamps, we prune ALL
   * and reset. Worst case: a duplicate push attempt that Tempo rejects
   * via the [session:id] marker check.
   */
  cleanup(state?: WorklogState): void {
    const current = state ?? this.load();
    current.pushedSessionIds = [];
    current.lastCleanedAt = new Date().toISOString().slice(0, 10);
    this.save(current);
  }
}
