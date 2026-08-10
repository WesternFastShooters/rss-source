export type Feed = {
  id: string;
  url: string;
  title: string;
  category: string;
  status: "active" | "paused" | "error";
  [key: string]: unknown;
};

type ErrorBody = {
  code?: string;
  message?: string;
  details?: unknown;
};

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: ErrorBody | null;
};

export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type ClientOptions = {
  baseUrl: string;
  apiKey?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  fetch?: typeof fetch;
};

function queryString(values: Record<string, string | number | boolean | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const output = query.toString();
  return output === "" ? "" : `?${output}`;
}

export class RssSourceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly cfAccessClientId: string | undefined;
  private readonly cfAccessClientSecret: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new CliError("INVALID_URL", "RSS Source URL must be an absolute http or https URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError("INVALID_URL", "RSS Source URL must use http or https.");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.apiKey = options.apiKey;
    if ((options.cfAccessClientId === undefined) !== (options.cfAccessClientSecret === undefined)) {
      throw new CliError("INCOMPLETE_CF_ACCESS", "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.");
    }
    this.cfAccessClientId = options.cfAccessClientId;
    this.cfAccessClientSecret = options.cfAccessClientSecret;
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    if (authenticated && (this.apiKey === undefined || this.apiKey === "")) {
      throw new CliError("MISSING_API_KEY", "Set RSS_SOURCE_API_KEY or pass --api-key.");
    }

    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (authenticated) headers.set("authorization", `Bearer ${this.apiKey}`);
    if (this.cfAccessClientId !== undefined && this.cfAccessClientSecret !== undefined) {
      headers.set("cf-access-client-id", this.cfAccessClientId);
      headers.set("cf-access-client-secret", this.cfAccessClientSecret);
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const bodyText = await response.text();
    let body: Envelope<T> | null = null;
    if (bodyText !== "") {
      try {
        body = JSON.parse(bodyText) as Envelope<T>;
      } catch {
        if (response.ok) return bodyText as T;
      }
    }

    if (!response.ok || body?.ok === false) {
      const error = body?.error;
      throw new CliError(
        error?.code ?? `HTTP_${response.status}`,
        error?.message ?? `RSS Source returned HTTP ${response.status}.`,
        error?.details,
      );
    }
    if (body !== null && Object.prototype.hasOwnProperty.call(body, "data")) return (body.data ?? null) as T;
    return body as T;
  }

  private async json<T>(path: string, method: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method,
      ...(body === undefined ? {} : {
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    });
  }

  health(): Promise<unknown> {
    return this.request("/health", {}, false);
  }

  ready(): Promise<unknown> {
    return this.request("/ready", {}, false);
  }

  async listFeeds(input: { limit?: number; offset?: number; category?: string; status?: string } = {}): Promise<Feed[]> {
    const data = await this.request<{ feeds: Feed[] }>(`/api/feeds${queryString(input)}`);
    return data.feeds;
  }

  async listAllFeeds(): Promise<Feed[]> {
    const feeds: Feed[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await this.listFeeds({ limit: 500, offset });
      feeds.push(...page);
      if (page.length < 500) return feeds;
    }
  }

  async addFeed(input: { url: string; title?: string; category?: string; fetchIntervalMinutes?: number; refreshNow?: boolean }): Promise<Feed> {
    const data = await this.json<{ feed: Feed }>("/api/feeds", "POST", input);
    return data.feed;
  }

  async getFeed(id: string): Promise<Feed> {
    const data = await this.request<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}`);
    return data.feed;
  }

  async updateFeed(id: string, input: Record<string, unknown>): Promise<Feed> {
    const data = await this.json<{ feed: Feed }>(`/api/feeds/${encodeURIComponent(id)}`, "PATCH", input);
    return data.feed;
  }

  async removeFeed(id: string): Promise<{ removed: true; id: string }> {
    await this.request(`/api/feeds/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { removed: true, id };
  }

  refreshFeed(id: string): Promise<unknown> {
    return this.json(`/api/feeds/${encodeURIComponent(id)}/refresh`, "POST");
  }

  async listEntries(input: Record<string, string | number | boolean | undefined>): Promise<unknown> {
    return this.request(`/api/entries${queryString(input)}`);
  }

  async getEntry(id: string): Promise<unknown> {
    return this.request(`/api/entries/${encodeURIComponent(id)}`);
  }

  async updateEntry(id: string, input: Record<string, boolean>): Promise<unknown> {
    return this.json(`/api/entries/${encodeURIComponent(id)}`, "PATCH", input);
  }

  async unreadCount(): Promise<unknown> {
    return this.request("/api/unread/count");
  }

  async importOpml(opml: string, refresh = false): Promise<unknown> {
    return this.request(`/api/opml/import${refresh ? "?refresh=true" : ""}`, {
      method: "POST",
      body: opml,
      headers: { "content-type": "application/xml" },
    });
  }

  async exportOpml(): Promise<string> {
    return this.request<string>("/api/opml/export");
  }
}
