import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFeedDocument } from "../src/feed/fetcher.js";

const config = {
  fetchAllowPrivateHosts: ["feed.test"],
  fetchMaxBytes: 1024,
  fetchTimeoutMs: 1000,
  userAgent: "test-agent",
};

describe("feed fetcher", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses conditional headers and returns feed metadata", async () => {
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("if-none-match")).toBe('"old"');
      expect(headers.get("user-agent")).toBe("test-agent");
      return new Response("<rss><channel><title>Test</title></channel></rss>", {
        status: 200,
        headers: { "content-type": "application/rss+xml", etag: '"new"' },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchFeedDocument("https://feed.test/rss", config, { etag: '"old"' });
    expect(result).toMatchObject({ notModified: false, etag: '"new"' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("handles 304 responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 304 })));
    await expect(fetchFeedDocument("https://feed.test/rss", config)).resolves.toMatchObject({ notModified: true });
  });

  it("rejects redirects to private metadata addresses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    })));
    await expect(fetchFeedDocument("https://feed.test/rss", config)).rejects.toMatchObject({ code: "BLOCKED_FEED_HOST" });
  });

  it("enforces the response size limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(1025), { status: 200 })));
    await expect(fetchFeedDocument("https://feed.test/rss", config)).rejects.toMatchObject({ code: "FEED_TOO_LARGE" });
  });
});
