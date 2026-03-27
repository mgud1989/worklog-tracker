import type {
  AppConfig,
  ReadTrackingDataInput,
  SmartTimerControlInput,
  UpdateWorkEntryInput,
  WorkEntryInput
} from "./types.js";

type TogglTempoClient = {
  logWorkEntry?: (payload: Record<string, unknown>) => Promise<unknown>;
  startTimer?: (payload: Record<string, unknown>) => Promise<unknown>;
  stopTimer?: (payload: Record<string, unknown>) => Promise<unknown>;
  readTrackingData?: (payload: Record<string, unknown>) => Promise<unknown>;
};

const TOGGL_BASE_URL = "https://api.track.toggl.com/api/v9";

function getBasicAuthToken(apiToken: string): string {
  return Buffer.from(`${apiToken}:api_token`).toString("base64");
}

export class TogglTempoAdapter {
  private constructor(
    private readonly apiToken: string,
    private readonly appConfig: AppConfig,
    private readonly client?: TogglTempoClient
  ) {}

  static async create(token: string, appConfig: AppConfig): Promise<TogglTempoAdapter> {
    const mod = await import("toggl-tempo");
    const record = mod as Record<string, unknown>;
    const defaultExport = record.default as Record<string, unknown> | undefined;

    const maybeClient =
      defaultExport &&
      typeof defaultExport === "object" &&
      ("logWorkEntry" in defaultExport ||
        "startTimer" in defaultExport ||
        "stopTimer" in defaultExport ||
        "readTrackingData" in defaultExport)
        ? (defaultExport as TogglTempoClient)
        : undefined;

    return new TogglTempoAdapter(token, appConfig, maybeClient);
  }

  async logWorkEntry(input: WorkEntryInput): Promise<unknown> {
    if (this.client?.logWorkEntry) {
      return this.client.logWorkEntry({
        description: input.description,
        start: input.timeRange.start,
        end: input.timeRange.end,
        project: input.project,
        tags: input.tags
      });
    }

    const projectId = input.project ? await this.findProjectIdByName(input.project) : undefined;
    return this.request(`/workspaces/${this.appConfig.workspaceId}/time_entries`, {
      method: "POST",
      body: {
        wid: this.workspaceIdAsNumber(),
        created_with: "toggl-mcp-server",
        description: input.description,
        start: input.timeRange.start,
        stop: input.timeRange.end,
        project_id: projectId,
        tags: input.tags ?? []
      }
    });
  }

  async smartTimerControl(input: SmartTimerControlInput): Promise<unknown> {
    if (input.action === "start") {
      if (this.client?.startTimer) {
        return this.client.startTimer({
          description: input.description,
          time: input.time,
          project: input.project,
          tags: input.tags
        });
      }

      const projectId = input.project ? await this.findProjectIdByName(input.project) : undefined;
      return this.request(`/workspaces/${this.appConfig.workspaceId}/time_entries`, {
        method: "POST",
        body: {
          wid: this.workspaceIdAsNumber(),
          created_with: "toggl-mcp-server",
          description: input.description,
          start: input.time ?? new Date().toISOString(),
          duration: -1,
          project_id: projectId,
          tags: input.tags ?? []
        }
      });
    }

    if (this.client?.stopTimer) {
      return this.client.stopTimer({
        time: input.time
      });
    }

    const current = await this.request<{ id?: number } | null>("/me/time_entries/current", {
      method: "GET"
    });

    if (!current?.id) {
      throw new Error("No running timer found to stop");
    }

    return this.request(
      `/workspaces/${this.appConfig.workspaceId}/time_entries/${current.id}/stop`,
      {
        method: "PATCH"
      }
    );
  }

  async readTrackingData(input: ReadTrackingDataInput): Promise<unknown> {
    if (this.client?.readTrackingData) {
      return this.client.readTrackingData({
        start: input.timeRange.start,
        end: input.timeRange.end
      });
    }

    const query = new URLSearchParams({
      start_date: input.timeRange.start,
      end_date: input.timeRange.end
    });

    return this.request(`/me/time_entries?${query.toString()}`, {
      method: "GET"
    });
  }

  async updateWorkEntry(input: UpdateWorkEntryInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      wid: this.workspaceIdAsNumber()
    };

    if (input.description !== undefined) {
      body.description = input.description;
    }
    if (input.start !== undefined) {
      body.start = input.start;
    }
    if (input.stop !== undefined) {
      body.stop = input.stop;
    }
    if (input.tags !== undefined) {
      body.tags = input.tags;
    }
    if (input.project !== undefined) {
      body.project_id = await this.findProjectIdByName(input.project);
    }

    return this.request(
      `/workspaces/${this.appConfig.workspaceId}/time_entries/${input.entryId}`,
      {
        method: "PUT",
        body
      }
    );
  }

  private async findProjectIdByName(projectName: string): Promise<number> {
    const query = new URLSearchParams({ active: "true" });

    const projects = await this.request<Array<{ id: number; name: string }>>(
      `/workspaces/${this.appConfig.workspaceId}/projects?${query.toString()}`,
      { method: "GET" }
    );

    const found = projects.find(
      (project) => project.name.toLowerCase() === projectName.toLowerCase()
    );

    if (!found) {
      throw new Error(`Project not found in workspace: ${projectName}`);
    }

    return found.id;
  }

  private async request<T = unknown>(
    path: string,
    options: { method: "GET" | "POST" | "PATCH" | "PUT"; body?: Record<string, unknown> }
  ): Promise<T> {
    const response = await fetch(`${TOGGL_BASE_URL}${path}`, {
      method: options.method,
      headers: {
        Authorization: `Basic ${getBasicAuthToken(this.apiToken)}`,
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(
        `Toggl API error (${response.status} ${response.statusText}): ${bodyText}`
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  private workspaceIdAsNumber(): number {
    const wid = Number(this.appConfig.workspaceId);
    if (!Number.isFinite(wid) || wid <= 0) {
      throw new Error(`Invalid workspaceId in config: ${this.appConfig.workspaceId}`);
    }
    return wid;
  }
}
