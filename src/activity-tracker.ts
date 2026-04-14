/**
 * In-memory activity tracker for MCP session monitoring.
 *
 * Tracks tool usage per session so the nudge system can make informed decisions
 * about when to remind users about unpushed worklogs, long timers, etc.
 *
 * Pure in-memory — no persistence. Dies with the MCP server process.
 * This is intentional: session activity is ephemeral by nature.
 */

export interface SessionState {
  startedAt: Date;
  lastToolCallAt: Date;
  toolCallCount: number;
  lastNudgeAt: Date | null;
}

const SESSION_MIN_AGE_MINUTES = 5;

export class ActivityTracker {
  private sessions: Map<string, SessionState> = new Map();
  private nudgeCooldownMs: number;
  private now: () => Date;

  /**
   * @param nudgeCooldownMinutes Minimum time between nudges for the same session (default 30).
   * @param clock Injectable clock for testing. Defaults to `() => new Date()`.
   */
  constructor(nudgeCooldownMinutes: number = 30, clock?: () => Date) {
    this.nudgeCooldownMs = nudgeCooldownMinutes * 60 * 1000;
    this.now = clock ?? (() => new Date());
  }

  /**
   * Record a tool call for the given session.
   * Creates the session if it doesn't exist yet.
   */
  recordToolCall(sessionId: string): void {
    const now = this.now();
    const session = this.sessions.get(sessionId);

    if (session) {
      session.toolCallCount++;
      session.lastToolCallAt = now;
    } else {
      this.sessions.set(sessionId, {
        startedAt: now,
        lastToolCallAt: now,
        toolCallCount: 1,
        lastNudgeAt: null,
      });
    }
  }

  /**
   * Get the current state for a session, or undefined if not tracked.
   */
  getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Check if a nudge is allowed for this session.
   *
   * Returns true when ALL conditions are met:
   * 1. Session exists
   * 2. Session is older than 5 minutes (don't nag on fresh sessions)
   * 3. Last nudge was more than `nudgeCooldownMinutes` ago, or never nudged
   */
  canNudge(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const now = this.now();

    // Don't nudge fresh sessions
    const sessionAgeMs = now.getTime() - session.startedAt.getTime();
    if (sessionAgeMs < SESSION_MIN_AGE_MINUTES * 60 * 1000) {
      return false;
    }

    // Check cooldown since last nudge
    if (session.lastNudgeAt !== null) {
      const sinceLast = now.getTime() - session.lastNudgeAt.getTime();
      if (sinceLast < this.nudgeCooldownMs) {
        return false;
      }
    }

    return true;
  }

  /**
   * Record that a nudge was sent, resetting the cooldown timer.
   */
  recordNudge(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastNudgeAt = this.now();
    }
  }

  /**
   * Get a human-readable activity summary for the session.
   * Returns a string like "Session active for 2h 15m, 42 tool calls".
   */
  getActivitySummary(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return "No active session";

    const now = this.now();
    const elapsedMs = now.getTime() - session.startedAt.getTime();
    const totalMinutes = Math.floor(elapsedMs / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const duration = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
    const callLabel = session.toolCallCount === 1 ? "tool call" : "tool calls";

    return `Session active for ${duration}, ${session.toolCallCount} ${callLabel}`;
  }

  /**
   * Remove a session from tracking. Call on session end to free memory.
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}
