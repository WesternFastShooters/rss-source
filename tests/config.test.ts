import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("loads explicit production-safe configuration", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://app:secret@postgres/app",
      APP_API_KEY: "0123456789abcdef0123456789abcdef",
      ALLOWED_HOSTS: "rss.example.com,127.0.0.1",
      AUTO_MIGRATE: "false",
    });
    expect(config.nodeEnv).toBe("production");
    expect(config.autoMigrate).toBe(false);
    expect(config.allowedHosts).toEqual(["rss.example.com", "127.0.0.1"]);
  });

  it("rejects short API keys", () => {
    expect(() => loadConfig({ DATABASE_URL: "postgresql://localhost/app", APP_API_KEY: "short" })).toThrow();
  });
});
