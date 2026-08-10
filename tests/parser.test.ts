import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { entryItemKey, parseFeed } from "../src/feed/parser.js";

describe("feed parser", () => {
  it("parses and sanitizes RSS 2.0", async () => {
    const body = await readFile(new URL("./fixtures/rss.xml", import.meta.url), "utf8");
    const feed = parseFeed(body, "application/rss+xml", "https://example.com/feed.xml");
    expect(feed.title).toBe("Example AI News");
    expect(feed.siteUrl).toBe("https://example.com/");
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]?.url).toBe("https://example.com/posts/model");
    expect(feed.items[0]?.content).toContain("<strong>model</strong>");
    expect(feed.items[0]?.content).not.toContain("script");
    expect(entryItemKey(feed.items[0]!)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("parses Atom", async () => {
    const body = await readFile(new URL("./fixtures/atom.xml", import.meta.url), "utf8");
    const feed = parseFeed(body, "application/atom+xml", "https://example.org/feed.atom");
    expect(feed.title).toBe("Agent Releases");
    expect(feed.items[0]).toMatchObject({
      guid: "tag:example.org,2026:release-1",
      url: "https://example.org/release/2",
      title: "Agent SDK 2.0",
      author: "Ada",
    });
  });

  it("parses JSON Feed", () => {
    const feed = parseFeed(JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "LLM Notes",
      home_page_url: "https://notes.example/",
      items: [{ id: "42", url: "/42", title: "Reasoning", content_text: "Details", date_published: "2026-08-10T00:00:00Z" }],
    }), "application/feed+json", "https://notes.example/feed.json");
    expect(feed.items[0]?.url).toBe("https://notes.example/42");
    expect(feed.items[0]?.content).toBe("Details");
  });
});
