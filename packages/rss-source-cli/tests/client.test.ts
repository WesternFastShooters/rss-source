import { describe, expect, it, vi } from "vitest";
import { RssSourceClient } from "../src/client.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("RssSourceClient", () => {
  it("calls public health without an API key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ ok: true, data: { status: "healthy" }, error: null }));
    const client = new RssSourceClient({ baseUrl: "https://rss.example.com/", fetch: fetchMock });
    await expect(client.health()).resolves.toEqual({ status: "healthy" });
    expect(fetchMock).toHaveBeenCalledWith("https://rss.example.com/health", expect.any(Object));
  });

  it("requires a key for protected API calls", async () => {
    const client = new RssSourceClient({ baseUrl: "https://rss.example.com" });
    await expect(client.listFeeds()).rejects.toMatchObject({ code: "MISSING_API_KEY" });
  });

  it("sends the bearer key and returns feeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer secret");
      expect(headers.get("cf-access-client-id")).toBe("access-id");
      expect(headers.get("cf-access-client-secret")).toBe("access-secret");
      return json({ ok: true, data: { feeds: [{ id: "1", url: "https://example.com/feed", title: "Example", category: "Tests", status: "active" }] }, error: null });
    });
    const client = new RssSourceClient({
      baseUrl: "https://rss.example.com",
      apiKey: "secret",
      cfAccessClientId: "access-id",
      cfAccessClientSecret: "access-secret",
      fetch: fetchMock,
    });
    await expect(client.listFeeds({ limit: 20 })).resolves.toHaveLength(1);
  });

  it("preserves server error codes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ ok: false, data: null, error: { code: "FEED_NOT_FOUND", message: "Missing" } }, 404));
    const client = new RssSourceClient({ baseUrl: "https://rss.example.com", apiKey: "secret", fetch: fetchMock });
    await expect(client.getFeed("missing")).rejects.toMatchObject({ code: "FEED_NOT_FOUND", message: "Missing" });
  });
});
