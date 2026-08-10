import type pg from "pg";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { FeedService } from "../src/feed/service.js";
import { createApp } from "../src/http/app.js";
import { createLogger } from "../src/logger.js";

const API_KEY = "0123456789abcdef0123456789abcdef";

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://unused/unused",
    APP_API_KEY: API_KEY,
    ALLOWED_HOSTS: "localhost,127.0.0.1",
    ALLOWED_ORIGINS: "localhost,127.0.0.1",
    LOG_LEVEL: "silent",
  });
}

function fakeDependencies() {
  const service = {
    listFeeds: async () => [],
    unreadCount: async () => 0,
  } as unknown as FeedService;
  const pool = { query: async () => ({ rows: [{ "?column?": 1 }] }) } as unknown as pg.Pool;
  const config = testConfig();
  return { config, service, pool, logger: createLogger(config) };
}

describe("HTTP application", () => {
  const dependencies = fakeDependencies();
  const app = createApp(dependencies);

  it("serves unauthenticated liveness and readiness checks", async () => {
    await request(app).get("/health").set("Host", "127.0.0.1").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ ok: true, status: "healthy" });
    });
    await request(app).get("/ready").set("Host", "127.0.0.1").expect(200);
  });

  it("identifies as rss-source and no longer exposes MCP", async () => {
    await request(app).get("/").set("Host", "127.0.0.1").expect(200).expect(({ body }) => {
      expect(body).toMatchObject({ name: "rss-source", version: "0.2.0" });
      expect(body.endpoints).not.toHaveProperty("mcp");
    });
    await request(app)
      .post("/mcp")
      .set("Host", "127.0.0.1")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({})
      .expect(404);
  });

  it("protects API routes with a bearer key", async () => {
    await request(app).get("/api/feeds").set("Host", "127.0.0.1").expect(401);
    await request(app)
      .get("/api/feeds")
      .set("Host", "127.0.0.1")
      .set("Authorization", `Bearer ${API_KEY}`)
      .expect(200)
      .expect(({ body }) => expect(body.data.feeds).toEqual([]));
  });

  it("rejects unexpected Host headers", async () => {
    await request(app).get("/health").set("Host", "attacker.invalid").expect(403);
  });

  it("rejects unexpected browser Origin headers", async () => {
    await request(app)
      .get("/health")
      .set("Host", "127.0.0.1")
      .set("Origin", "https://attacker.invalid")
      .expect(403);
    await request(app)
      .get("/health")
      .set("Host", "127.0.0.1")
      .set("Origin", "http://localhost:5173")
      .expect(200);
  });
});
