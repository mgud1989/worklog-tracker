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

export type AppConfig = {
  workspaceId: string;
  timezone: string;
  defaultIssueKey?: string;
  defaultWorkAttributes?: Array<{ key: string; value: string }>;
};

export type ToolResultPayload = {
  ok: boolean;
  action: string;
  workspaceId: string;
  timezone: string;
  details: Record<string, unknown>;
};
