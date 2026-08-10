import { z } from "zod";

const booleanFromString = (defaultValue: boolean) => z.preprocess(
  (value) => value === undefined ? defaultValue : value === "true" || value === true,
  z.boolean(),
);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    APP_API_KEY: z.string().min(32, "APP_API_KEY must contain at least 32 characters"),
    ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
    ALLOWED_ORIGINS: z.string().default("localhost,127.0.0.1"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    AUTO_MIGRATE: booleanFromString(true),
    RSSHUB_BASE_URL: z.string().url().optional(),
    FETCH_ALLOW_PRIVATE_HOSTS: z.string().default(""),
    FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
    FETCH_MAX_BYTES: z.coerce.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
    FETCH_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(6),
    DEFAULT_FETCH_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(10080).default(30),
    SCHEDULER_TICK_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    USER_AGENT: z.string().default("ai-llm-agent-rss/0.1 (+https://github.com/WesternFastShooters/ai-llm-agent-rss)"),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === "production" && value.APP_API_KEY.toLowerCase().includes("change-me")) {
      context.addIssue({
        code: "custom",
        path: ["APP_API_KEY"],
        message: "APP_API_KEY must be a real random secret in production",
      });
    }
  });

export type AppConfig = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  databaseUrl: string;
  dbPoolMax: number;
  appApiKey: string;
  allowedHosts: string[];
  allowedOrigins: string[];
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  autoMigrate: boolean;
  rsshubBaseUrl?: string;
  fetchAllowPrivateHosts: string[];
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  fetchConcurrency: number;
  defaultFetchIntervalMinutes: number;
  schedulerTickSeconds: number;
  userAgent: string;
};

function csv(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = schema.parse(environment);
  return {
    nodeEnv: value.NODE_ENV,
    host: value.HOST,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    dbPoolMax: value.DB_POOL_MAX,
    appApiKey: value.APP_API_KEY,
    allowedHosts: csv(value.ALLOWED_HOSTS),
    allowedOrigins: csv(value.ALLOWED_ORIGINS),
    logLevel: value.LOG_LEVEL,
    autoMigrate: value.AUTO_MIGRATE,
    ...(value.RSSHUB_BASE_URL === undefined ? {} : { rsshubBaseUrl: value.RSSHUB_BASE_URL }),
    fetchAllowPrivateHosts: csv(value.FETCH_ALLOW_PRIVATE_HOSTS),
    fetchTimeoutMs: value.FETCH_TIMEOUT_MS,
    fetchMaxBytes: value.FETCH_MAX_BYTES,
    fetchConcurrency: value.FETCH_CONCURRENCY,
    defaultFetchIntervalMinutes: value.DEFAULT_FETCH_INTERVAL_MINUTES,
    schedulerTickSeconds: value.SCHEDULER_TICK_SECONDS,
    userAgent: value.USER_AGENT,
  };
}
