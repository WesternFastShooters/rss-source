import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import type pg from "pg";
import { pinoHttp } from "pino-http";
import { ZodError, z } from "zod";
import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import type { FeedService } from "../feed/service.js";
import type { AppLogger } from "../logger.js";
import { generateOpml, parseOpml } from "../opml.js";
import { apiKeyAuth } from "./auth.js";
import { requestTargetValidation } from "./security.js";

const feedIdParams = z.object({ id: z.uuid() });
const addFeedBody = z.object({
  url: z.string().min(1),
  title: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  fetchIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
  refreshNow: z.boolean().optional(),
});
const updateFeedBody = z.object({
  title: z.string().max(500).optional(),
  category: z.string().max(200).optional(),
  status: z.enum(["active", "paused"]).optional(),
  fetchIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
});
const entryUpdateBody = z.object({
  isRead: z.boolean().optional(),
  isStarred: z.boolean().optional(),
});

async function mapConcurrent<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let cursor = 0;
  async function runner(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await worker(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return output;
}

export type AppDependencies = {
  config: AppConfig;
  pool: pg.Pool;
  service: FeedService;
  logger: AppLogger;
};

export function createApp({ config, pool, service, logger }: AppDependencies) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(requestTargetValidation(config.allowedHosts, config.allowedOrigins));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/", (_request, response) => {
    response.json({
      name: "rss-source",
      version: "0.2.0",
      endpoints: { health: "/health", readiness: "/ready", api: "/api" },
    });
  });

  app.get("/health", (_request, response) => {
    response.json({ ok: true, status: "healthy", uptimeSeconds: Math.floor(process.uptime()) });
  });

  app.get("/ready", async (_request, response, next) => {
    try {
      await pool.query("SELECT 1");
      response.json({ ok: true, status: "ready" });
    } catch (error) {
      next(new AppError(503, "DATABASE_UNAVAILABLE", "Database is unavailable", error));
    }
  });

  const auth = apiKeyAuth(config.appApiKey);
  const api = express.Router();
  api.use(auth);

  api.get("/feeds", async (request, response) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      category: z.string().optional(),
      status: z.enum(["active", "paused", "error"]).optional(),
    }).parse(request.query);
    response.json({ ok: true, data: { feeds: await service.listFeeds(query) } });
  });

  api.post("/feeds", async (request, response) => {
    const input = addFeedBody.parse(request.body);
    response.status(201).json({ ok: true, data: { feed: await service.addFeed(input) } });
  });

  api.get("/feeds/:id", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    response.json({ ok: true, data: { feed: await service.getFeed(id) } });
  });

  api.patch("/feeds/:id", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    response.json({ ok: true, data: { feed: await service.updateFeed(id, updateFeedBody.parse(request.body)) } });
  });

  api.delete("/feeds/:id", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    await service.deleteFeed(id);
    response.status(204).end();
  });

  api.post("/feeds/:id/refresh", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    response.json({ ok: true, data: await service.refreshFeed(id) });
  });

  api.get("/entries", async (request, response) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      before: z.iso.datetime().optional(),
      feedId: z.uuid().optional(),
      category: z.string().optional(),
      unreadOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
      starredOnly: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
      search: z.string().max(200).optional(),
    }).parse(request.query);
    const { before, ...input } = query;
    const entries = await service.listEntries({ ...input, ...(before === undefined ? {} : { before: new Date(before) }) });
    response.json({ ok: true, data: { entries, nextCursor: entries.at(-1)?.publishedAt ?? null } });
  });

  api.get("/entries/:id", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    response.json({ ok: true, data: { entry: await service.getEntry(id) } });
  });

  api.patch("/entries/:id", async (request, response) => {
    const { id } = feedIdParams.parse(request.params);
    response.json({ ok: true, data: { entry: await service.updateEntry(id, entryUpdateBody.parse(request.body)) } });
  });

  api.get("/unread/count", async (_request, response) => {
    response.json({ ok: true, data: { count: await service.unreadCount() } });
  });

  api.get("/opml/export", async (_request, response) => {
    const feeds = [];
    for (let offset = 0; ; offset += 500) {
      const batch = await service.listFeeds({ limit: 500, offset });
      feeds.push(...batch);
      if (batch.length < 500) break;
    }
    response.type("application/xml").send(generateOpml(feeds));
  });

  api.post(
    "/opml/import",
    express.text({ type: ["application/xml", "text/xml", "text/plain", "application/opml+xml"], limit: "5mb" }),
    async (request, response) => {
      if (typeof request.body !== "string") throw new AppError(400, "INVALID_OPML", "Request body must be an OPML document");
      const refreshNow = request.query["refresh"] === "true";
      const subscriptions = parseOpml(request.body);
      const results = await mapConcurrent(subscriptions, Math.min(config.fetchConcurrency, 4), async (subscription) => {
        try {
          const feed = await service.addFeed({ ...subscription, refreshNow });
          return { ok: true as const, feed };
        } catch (error) {
          return { ok: false as const, url: subscription.url, error: error instanceof Error ? error.message : String(error) };
        }
      });
      response.status(201).json({
        ok: true,
        data: {
          total: results.length,
          imported: results.filter((item) => item.ok).length,
          failures: results.filter((item) => !item.ok),
        },
      });
    },
  );

  app.use("/api", api);

  app.use((_request, _response, next) => next(new AppError(404, "NOT_FOUND", "Route not found")));

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    if (response.headersSent) return;
    if (error instanceof ZodError) {
      response.status(400).json({ ok: false, error: { code: "INVALID_ARGUMENT", message: "Request validation failed", details: error.issues } });
      return;
    }
    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, error.message);
      response.status(error.statusCode).json({ ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
      return;
    }
    request.log.error({ err: error }, "unhandled request error");
    response.status(500).json({ ok: false, error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
  app.use(errorHandler);
  return app;
}
