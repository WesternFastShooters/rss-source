import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.js";

export function createLogger(config: Pick<AppConfig, "logLevel" | "nodeEnv">): Logger {
  return pino({
    level: config.logLevel,
    base: {
      service: "ai-llm-agent-rss",
      environment: config.nodeEnv,
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "request.headers.authorization",
        "headers.authorization",
        "databaseUrl",
        "appApiKey",
      ],
      censor: "[REDACTED]",
    },
  });
}

export type AppLogger = Logger;
