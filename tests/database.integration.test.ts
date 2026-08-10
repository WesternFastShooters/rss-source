import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runMigrations } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { FeedService } from "../src/feed/service.js";
import { createLogger } from "../src/logger.js";

const databaseUrl = process.env["TEST_DATABASE_URL"];

describe.runIf(databaseUrl !== undefined)("PostgreSQL integration", () => {
  let pool: pg.Pool;
  let service: FeedService;

  beforeAll(async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      APP_API_KEY: "0123456789abcdef0123456789abcdef",
      LOG_LEVEL: "silent",
    });
    pool = createPool(config.databaseUrl, 2);
    await runMigrations(pool);
    await pool.query("TRUNCATE entries, feeds CASCADE");
    service = new FeedService(pool, config, createLogger(config));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists, updates, lists, and removes subscriptions", async () => {
    const feed = await service.addFeed({
      url: "https://example.com/feed.xml",
      title: "Example",
      category: "Tests",
      refreshNow: false,
    });
    expect((await service.listFeeds()).map((item) => item.id)).toContain(feed.id);
    expect((await service.updateFeed(feed.id, { status: "paused" })).status).toBe("paused");
    await service.deleteFeed(feed.id);
    await expect(service.getFeed(feed.id)).rejects.toMatchObject({ code: "FEED_NOT_FOUND" });
  });

  it("runs migrations repeatedly without reapplying them", async () => {
    expect(await runMigrations(pool)).toEqual([]);
  });
});
