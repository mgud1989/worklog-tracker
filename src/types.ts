export type DateRange = {
  start: string;
  end: string;
};

export type WorkEntryInput = {
  description: string;
  timeRange: DateRange;
  project?: string;
  tags?: string[];
};

export type SmartTimerControlInput = {
  action: "start" | "stop";
  description?: string;
  time?: string;
  project?: string;
  tags?: string[];
};

export type ReadTrackingDataInput = {
  timeRange: DateRange;
};

export type UpdateWorkEntryInput = {
  entryId: number;
  description?: string;
  start?: string;
  stop?: string;
  project?: string;
  tags?: string[];
};

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

export type SyncTogglRangeToTempoInput = {
  timeRange: DateRange;
  defaultIssueKey?: string;
  defaultWorkAttributes?: Array<{ key: string; value: string }>;
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
  workspaceId: string;
  timezone: string;
  defaultIssueKey?: string;
  defaultWorkAttributes?: Array<{ key: string; value: string }>;
  mode: "toggl" | "tempo" | "both";
  inactivityThresholdMinutes: number;
  nudge: NudgeConfig;
};

export type ToolResultPayload = {
  ok: boolean;
  action: string;
  workspaceId: string;
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
