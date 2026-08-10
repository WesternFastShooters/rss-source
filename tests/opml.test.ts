import { describe, expect, it } from "vitest";
import { generateOpml, parseOpml } from "../src/opml.js";
import type { FeedRecord } from "../src/types.js";

describe("OPML", () => {
  it("parses nested categories and deduplicates URLs", () => {
    const subscriptions = parseOpml(`<?xml version="1.0"?><opml version="2.0"><body>
      <outline text="Official Labs"><outline text="OpenAI" type="rss" xmlUrl="https://openai.com/news/rss.xml"/></outline>
      <outline text="Duplicate" type="rss" xmlUrl="https://openai.com/news/rss.xml"/>
    </body></opml>`);
    expect(subscriptions).toEqual([{ url: "https://openai.com/news/rss.xml", title: "OpenAI", category: "Official Labs" }]);
  });

  it("generates importable OPML", () => {
    const now = new Date("2026-08-11T00:00:00Z");
    const feed: FeedRecord = {
      id: "feed-id",
      url: "https://example.com/feed.xml",
      fetchUrl: "https://example.com/feed.xml",
      siteUrl: "https://example.com/",
      title: "AI & Agents",
      description: null,
      category: "Research",
      status: "active",
      fetchIntervalMinutes: 30,
      etag: null,
      lastModified: null,
      lastFetchedAt: null,
      nextFetchAt: now,
      errorCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    const output = generateOpml([feed]);
    expect(output).toContain("AI &amp; Agents");
    expect(parseOpml(output)[0]).toMatchObject({ url: feed.url, title: feed.title, category: feed.category });
  });
});
