import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { checkDatabase, createPool } from "./db/pool.js";
import { FeedScheduler } from "./feed/scheduler.js";
import { FeedService } from "./feed/service.js";
import { createApp } from "./http/app.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config);
const pool = createPool(config.databaseUrl, config.dbPoolMax);

if (config.autoMigrate) {
  const applied = await runMigrations(pool);
  if (applied.length > 0) logger.info({ applied }, "database migrations applied");
}
await checkDatabase(pool);

const service = new FeedService(pool, config, logger);
const scheduler = new FeedScheduler(service, config, logger);
const app = createApp({ config, pool, service, logger });
const server = createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(config.port, config.host, () => {
    server.off("error", reject);
    resolve();
  });
});
scheduler.start();
logger.info({ host: config.host, port: config.port }, "server started");

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  scheduler.stop();
  const forceExit = setTimeout(() => {
    logger.error("graceful shutdown timed out");
    process.exit(1);
  }, 15_000);
  forceExit.unref();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  clearTimeout(forceExit);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal));
}

process.on("unhandledRejection", (error) => logger.error({ err: error }, "unhandled rejection"));
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  void shutdown("uncaughtException").finally(() => process.exit(1));
});
