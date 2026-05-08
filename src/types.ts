export type TempoCreateWorklogInput = {
  issueKey: string;
  timeSpentHours: number;
  date: string;
  description?: string;
  startTime?: string;
  workAttributes?: Array<{ key: string; value: string }>;
};

export type TempoReadWorklogsInput = {
  startDate: string;
  endDate: string;
};

export type JiraAuthType = "basic" | "bearer";

export type TempoJiraConfig = {
  tempoApiToken: string;
  jiraBaseUrl: string;
  jiraApiToken: string;
  jiraAuthType: JiraAuthType;
  jiraEmail?: string;
  jiraTempoAccountCustomFieldId?: string;
};

export type NudgeConfig = {
  enabled: boolean;
  cooldownMinutes: number;
  pushReminderAfterHours: number;
  endOfDayHour: number;
};

export type AppConfig = {
  timezone: string;
  defaultIssueKey?: string;
  defaultWorkAttributes?: Array<{ key: string; value: string }>;
  inactivityThresholdMinutes: number;
  logRetentionMonths: number;
  nudge: NudgeConfig;
};

export type ToolResultPayload = {
  ok: boolean;
  action: string;
  timezone: string;
  details: Record<string, unknown>;
};

// --- Tempo Push types ---

export type SessionLogLabel = "START" | "STOP" | "ACTIVITY" | "INACTIVITY";

export type LogEntry = {
  timestamp: Date;
  label: SessionLogLabel;
  branch: string;
  sessionId: string;
  rawLine: string;
  /** Repo folder name captured at hook-fire time. Undefined for pre-feature logs. */
  folder?: string;
};

export type WorkWindow = {
  start: Date;
  end: Date;
  branch: string;
  sessionId: string;
  durationMinutes: number;
  /** Repo folder name propagated from entries. Undefined if the contributing entries had none. */
  folder?: string;
};

export type ConsolidatedWorklog = {
  issueKey: string;
  branch: string;
  date: string;
  startTime: string; // HH:MM — earliest activity window start
  durationHours: number;
  sessionIds: string[];
  windowCount: number;
  description: string;
  /** Repo folder name (basename of git toplevel). Undefined for pre-feature logs. */
  folder?: string;
};

export type PushPreview = {
  worklogs: ConsolidatedWorklog[];
  totalHours: number;
  dateRange: { from: string; to: string };
  unmappedBranches: string[];
};

export type TempoPushResult = {
  pushed: number;
  skipped: number;
  failed: number;
  details: Array<{ issueKey: string; status: string; error?: string }>;
};

// --- Session status tracking ---

/**
 * Persisted status — only "pushed" or "skipped" are ever written to disk.
 * "pending" is implicit (absent from sessions[]) and is a DERIVED/TRANSIENT value only.
 */
export type PersistedSessionStatus = "pushed" | "skipped";

/**
 * Wider union that includes the derived "pending" state.
 * Use this as the return type wherever callers receive session status values,
 * including listSessions() and the MCP tool responses.
 * Never persist "pending" — it must not appear in SessionRecord.status on disk.
 */
export type SessionStatus = "pushed" | "skipped" | "pending";

export interface SessionRecord {
  id: string;
  /**
   * Persisted status only. Use PersistedSessionStatus to be explicit at the
   * persistence boundary; callers that return derived/pending state use SessionStatus.
   */
  status: PersistedSessionStatus;
  at: string; // ISO datetime — push-time or skip-time
}

/**
 * Wide session record for derived / return-type contexts.
 * Same shape as SessionRecord but status includes "pending".
 * Never serialized to disk — use SessionRecord (with PersistedSessionStatus) for that.
 */
export interface SessionStatusRecord {
  id: string;
  status: SessionStatus;
  at: string;
}

export interface SessionStatusEntry {
  id: string;
  branch: string;
  hours: number;
  date: string;   // YYYY-MM-DD from log line
  status: SessionStatus;
  at?: string;    // present only for pushed/skipped
}

export interface WorklogState {
  lastPushAt: string | null;       // ISO datetime of last Tempo push
  sessions: SessionRecord[];       // replaces pushedSessionIds
  lastCleanedAt: string;           // ISO date (YYYY-MM-DD) of last cleanup
  lastNudgeAt: string | null;      // ISO datetime of last hook-delivered nudge (cross-process cooldown)
}
