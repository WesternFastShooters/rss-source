import { createServer, type Server } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});

describe("MCP endpoint", () => {
  let server: Server;
  let endpoint: URL;

  beforeAll(async () => {
    const app = createApp(fakeDependencies());
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Test server has no TCP address");
    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  });

  it("negotiates MCP and exposes RSS tools", async () => {
    const client = new Client({ name: "integration-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(endpoint, {
      authProvider: { token: async () => API_KEY },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
        "list_feeds",
        "add_feed",
        "list_entries",
        "import_opml",
      ]));
    } finally {
      await client.close();
    }
  });
});
