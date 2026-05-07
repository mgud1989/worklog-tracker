import type {
  TempoCreateWorklogInput,
  TempoJiraConfig,
  TempoReadWorklogsInput
} from "./types.js";

const TEMPO_BASE_URL = "https://api.tempo.io/4";

type JiraIssue = {
  id: string;
  key: string;
  fields: Record<string, unknown>;
};

type TempoWorklog = {
  tempoWorklogId: number;
  issue?: { id?: number };
  startDate: string;
  startTime?: string;
  timeSpentSeconds: number;
  description?: string;
};

export class TempoJiraAdapter {
  private jiraAccountIdCache?: string;
  private workAttributesCache?: Array<{
    key: string;
    type?: string;
    values?: string[];
    names?: Record<string, string>;
  }>;

  constructor(
    private readonly config: TempoJiraConfig,
    private readonly timezone: string
  ) {}

  async createWorklog(input: TempoCreateWorklogInput): Promise<unknown> {
    const issue = await this.getIssue(input.issueKey);
    const authorAccountId = await this.getCurrentUserAccountId();
    const accountAttribute = await this.getTempoAccountAttribute(issue);
    const resolvedInputAttributes = await this.resolveWorkAttributes(input.workAttributes ?? []);
    const attributes = this.mergeAttributes(resolvedInputAttributes, accountAttribute);

    return this.tempoRequest("/worklogs", {
      method: "POST",
      body: {
        issueId: Number(issue.id),
        authorAccountId,
        timeSpentSeconds: Math.round(input.timeSpentHours * 3600),
        startDate: input.date,
        description: input.description ?? "",
        ...(input.startTime ? { startTime: `${input.startTime}:00` } : {}),
        ...(attributes.length > 0 ? { attributes } : {})
      }
    });
  }

  async readWorklogs(input: TempoReadWorklogsInput): Promise<unknown> {
    const accountId = await this.getCurrentUserAccountId();
    const worklogs = await this.readTempoWorklogsByUser(accountId, input.startDate, input.endDate);
    const issueIdToKey = await this.getIssueIdToKeyMap(worklogs);

    return worklogs.map((worklog) => ({
      tempoWorklogId: worklog.tempoWorklogId,
      issueId: worklog.issue?.id,
      issueKey: worklog.issue?.id ? issueIdToKey[String(worklog.issue.id)] : undefined,
      startDate: worklog.startDate,
      startTime: worklog.startTime,
      timeSpentSeconds: worklog.timeSpentSeconds,
      description: worklog.description ?? ""
    }));
  }

  async deleteWorklog(tempoWorklogId: number): Promise<void> {
    await this.tempoRequest(`/worklogs/${tempoWorklogId}`, {
      method: "DELETE",
    });
  }

  private async readTempoWorklogsByUser(
    accountId: string,
    startDate: string,
    endDate: string
  ): Promise<TempoWorklog[]> {
    let next: string | null = `${TEMPO_BASE_URL}/worklogs/user/${accountId}?from=${encodeURIComponent(startDate)}&to=${encodeURIComponent(endDate)}`;
    const allWorklogs: TempoWorklog[] = [];

    while (next) {
      const response = await this.tempoRequestUrl(next, { method: "GET" });
      const pageResults = Array.isArray(response.results) ? response.results : [];
      allWorklogs.push(...pageResults);
      next = response.metadata?.next ?? null;
    }

    return allWorklogs;
  }

  private async getCurrentUserAccountId(): Promise<string> {
    if (this.jiraAccountIdCache) {
      return this.jiraAccountIdCache;
    }

    let accountId: string;
    if (this.config.jiraAuthType === "bearer") {
      const me = await this.jiraRequest("/rest/api/3/myself", { method: "GET" });
      accountId = String(me.accountId);
    } else {
      const users = await this.jiraRequest("/rest/api/3/user/search", {
        method: "GET",
        query: {
          query: this.config.jiraEmail ?? ""
        }
      });
      const user = Array.isArray(users)
        ? users.find((candidate) => candidate.emailAddress === this.config.jiraEmail)
        : undefined;

      if (!user?.accountId) {
        throw new Error(`No Jira user found for email ${this.config.jiraEmail}`);
      }
      accountId = String(user.accountId);
    }

    this.jiraAccountIdCache = accountId;
    return accountId;
  }

  private async getIssue(issueKey: string): Promise<JiraIssue> {
    const issue = await this.jiraRequest(`/rest/api/3/issue/${issueKey}`, { method: "GET" });
    return issue as JiraIssue;
  }

  private async getIssueIdToKeyMap(worklogs: TempoWorklog[]): Promise<Record<string, string>> {
    const issueIds = Array.from(
      new Set(
        worklogs
          .map((worklog) => worklog.issue?.id)
          .filter((issueId): issueId is number => typeof issueId === "number")
          .map(String)
      )
    );

    const output: Record<string, string> = {};
    for (const issueId of issueIds) {
      try {
        const issue = await this.jiraRequest(`/rest/api/3/issue/${issueId}`, { method: "GET" });
        output[issueId] = String(issue.key);
      } catch {
        output[issueId] = "UNKNOWN";
      }
    }

    return output;
  }

  private async getTempoAccountAttribute(
    issue: JiraIssue
  ): Promise<{ key: string; value: string } | undefined> {
    const customFieldId = this.config.jiraTempoAccountCustomFieldId;
    if (!customFieldId) {
      return undefined;
    }

    const fieldValue = issue.fields[`customfield_${customFieldId}`] as
      | { id?: string }
      | undefined;

    if (!fieldValue?.id) {
      return undefined;
    }

    const account = await this.tempoRequest(`/accounts/${fieldValue.id}`, { method: "GET" });
    if (!account?.key) {
      return undefined;
    }

    return {
      key: "_Account_",
      value: String(account.key)
    };
  }

  private mergeAttributes(
    baseAttributes: Array<{ key: string; value: string }>,
    accountAttribute?: { key: string; value: string }
  ): Array<{ key: string; value: string }> {
    const merged = new Map<string, string>();

    for (const item of baseAttributes) {
      merged.set(item.key, item.value);
    }

    if (accountAttribute) {
      merged.set(accountAttribute.key, accountAttribute.value);
    }

    return Array.from(merged.entries()).map(([key, value]) => ({ key, value }));
  }

  private async resolveWorkAttributes(
    attributes: Array<{ key: string; value: string }>
  ): Promise<Array<{ key: string; value: string }>> {
    if (attributes.length === 0) {
      return attributes;
    }

    const catalog = await this.getWorkAttributesCatalog();

    return attributes.map((item) => {
      const definition = catalog.find((attribute) => attribute.key === item.key);
      if (!definition || definition.type !== "STATIC_LIST") {
        return item;
      }

      const values = definition.values ?? [];
      if (values.includes(item.value)) {
        return item;
      }

      const names = definition.names ?? {};
      const normalizedInput = this.normalizeAttributeText(item.value);
      for (const [internalValue, displayName] of Object.entries(names)) {
        if (this.normalizeAttributeText(displayName) === normalizedInput) {
          return {
            key: item.key,
            value: internalValue
          };
        }
      }

      const compactMatch = values.find(
        (candidate) => this.normalizeAttributeText(candidate) === normalizedInput
      );
      if (compactMatch) {
        return {
          key: item.key,
          value: compactMatch
        };
      }

      return item;
    });
  }

  private async getWorkAttributesCatalog(): Promise<
    Array<{ key: string; type?: string; values?: string[]; names?: Record<string, string> }>
  > {
    if (this.workAttributesCache) {
      return this.workAttributesCache;
    }

    const response = await this.tempoRequest("/work-attributes", { method: "GET" });
    const results = Array.isArray(response.results) ? response.results : [];
    this.workAttributesCache = results;
    return results;
  }

  private normalizeAttributeText(value: string): string {
    return value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  private async tempoRequest(
    path: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    }
  ): Promise<any> {
    const queryString = options.query
      ? `?${new URLSearchParams(options.query).toString()}`
      : "";
    return this.tempoRequestUrl(`${TEMPO_BASE_URL}${path}${queryString}`, options);
  }

  private async tempoRequestUrl(
    url: string,
    options: {
      method: "GET" | "POST" | "PUT" | "DELETE";
      body?: Record<string, unknown>;
    }
  ): Promise<any> {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${this.config.tempoApiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Tempo API error (${response.status} ${response.statusText}): ${text}`);
    }

    if (response.status === 204) {
      return {};
    }

    return response.json();
  }

  private async jiraRequest(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    }
  ): Promise<any> {
    const url = new URL(path, this.config.jiraBaseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: options.method,
      headers: {
        Authorization:
          this.config.jiraAuthType === "bearer"
            ? `Bearer ${this.config.jiraApiToken}`
            : `Basic ${Buffer.from(`${this.config.jiraEmail}:${this.config.jiraApiToken}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Jira API error (${response.status} ${response.statusText}): ${text}`);
    }

    return response.json();
  }

  private extractIssueKey(value: string): string | undefined {
    const matched = value.match(/[A-Z][A-Z0-9]+-\d+/i);
    return matched?.[0]?.toUpperCase();
  }

  private toDateInTimezone(isoDateTime: string): string {
    return this.toDateTimeInTimezone(isoDateTime).date;
  }

  private toDateTimeInTimezone(isoDateTime: string): { date: string; time: string } {
    const date = new Date(isoDateTime);
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? "00";

    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour");
    const minute = get("minute");

    return {
      date: `${year}-${month}-${day}`,
      time: `${hour}:${minute}`
    };
  }
}
