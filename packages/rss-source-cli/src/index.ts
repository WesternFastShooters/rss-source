#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { CliError, RssSourceClient } from "./client.js";
import { discoverFoloSubscriptions, syncFoloSubscriptions } from "./folo.js";

const VERSION = "0.1.0";

type GlobalOptions = {
  args: string[];
  url?: string;
  apiKey?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
};

function extractGlobalOptions(args: readonly string[]): GlobalOptions {
  const remaining: string[] = [];
  let url: string | undefined;
  let apiKey: string | undefined;
  let cfAccessClientId: string | undefined;
  let cfAccessClientSecret: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (["--url", "--api-key", "--cf-access-client-id", "--cf-access-client-secret"].includes(value)) {
      const next = args[index + 1];
      if (next === undefined) throw new CliError("INVALID_ARGUMENT", `${value} requires a value.`);
      if (value === "--url") url = next;
      else if (value === "--api-key") apiKey = next;
      else if (value === "--cf-access-client-id") cfAccessClientId = next;
      else cfAccessClientSecret = next;
      index += 1;
    } else if (value.startsWith("--url=")) {
      url = value.slice("--url=".length);
    } else if (value.startsWith("--api-key=")) {
      apiKey = value.slice("--api-key=".length);
    } else if (value.startsWith("--cf-access-client-id=")) {
      cfAccessClientId = value.slice("--cf-access-client-id=".length);
    } else if (value.startsWith("--cf-access-client-secret=")) {
      cfAccessClientSecret = value.slice("--cf-access-client-secret=".length);
    } else {
      remaining.push(value);
    }
  }
  return {
    args: remaining,
    ...(url === undefined ? {} : { url }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(cfAccessClientId === undefined ? {} : { cfAccessClientId }),
    ...(cfAccessClientSecret === undefined ? {} : { cfAccessClientSecret }),
  };
}

function numeric(value: string | undefined, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new CliError("INVALID_ARGUMENT", `${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function parse(commandArgs: string[], options: ParseArgsOptionsConfig = {}): {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
} {
  return parseArgs({ args: commandArgs, options, allowPositionals: true, strict: true }) as unknown as {
    values: Record<string, string | boolean | undefined>;
    positionals: string[];
  };
}

function help(): string {
  return `rss-source-cli ${VERSION}

Usage:
  rss-source [--url URL] [--api-key KEY] <command>

Commands:
  health | ready
  config show
  feeds list|add|get|update|remove|refresh
  entries list|get|update
  unread count
  opml import|export
  folo discover|sync

Environment:
  RSS_SOURCE_URL       Server URL (default: http://127.0.0.1:3000)
  RSS_SOURCE_API_KEY   Bearer API key
  CF_ACCESS_CLIENT_ID  Optional Cloudflare Access service-token ID
  CF_ACCESS_CLIENT_SECRET  Optional Cloudflare Access service-token secret

Examples:
  rss-source feeds list --limit 20
  rss-source feeds add https://example.com/feed.xml --category AI
  rss-source entries list --unread-only --limit 20
  rss-source folo sync --dry-run
  rss-source folo sync
`;
}

function createClient(global: GlobalOptions, environment: NodeJS.ProcessEnv): RssSourceClient {
  const apiKey = global.apiKey ?? environment["RSS_SOURCE_API_KEY"];
  const cfAccessClientId = global.cfAccessClientId ?? environment["CF_ACCESS_CLIENT_ID"];
  const cfAccessClientSecret = global.cfAccessClientSecret ?? environment["CF_ACCESS_CLIENT_SECRET"];
  return new RssSourceClient({
    baseUrl: global.url ?? environment["RSS_SOURCE_URL"] ?? "http://127.0.0.1:3000",
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(cfAccessClientId === undefined ? {} : { cfAccessClientId }),
    ...(cfAccessClientSecret === undefined ? {} : { cfAccessClientSecret }),
  });
}

function feedCommands(client: RssSourceClient, args: string[]): Promise<unknown> {
  const operation = args.shift();
  if (operation === "list") {
    const { values } = parse(args, {
      limit: { type: "string" }, offset: { type: "string" }, category: { type: "string" }, status: { type: "string" },
    });
    const limit = numeric(values["limit"] as string | undefined, "--limit", 1, 500);
    const offset = numeric(values["offset"] as string | undefined, "--offset", 0, 1_000_000);
    return client.listFeeds({
      ...(limit === undefined ? {} : { limit }),
      ...(offset === undefined ? {} : { offset }),
      ...(typeof values["category"] !== "string" ? {} : { category: values["category"] }),
      ...(typeof values["status"] !== "string" ? {} : { status: values["status"] }),
    });
  }
  if (operation === "add") {
    const { values, positionals } = parse(args, {
      title: { type: "string" }, category: { type: "string" }, interval: { type: "string" }, "no-refresh": { type: "boolean" },
    });
    const url = positionals[0];
    if (url === undefined) throw new CliError("INVALID_ARGUMENT", "feeds add requires a feed URL.");
    const interval = numeric(values["interval"] as string | undefined, "--interval", 5, 10_080);
    return client.addFeed({
      url,
      ...(typeof values["title"] !== "string" ? {} : { title: values["title"] }),
      ...(typeof values["category"] !== "string" ? {} : { category: values["category"] }),
      ...(interval === undefined ? {} : { fetchIntervalMinutes: interval }),
      refreshNow: values["no-refresh"] !== true,
    });
  }
  const id = args.shift();
  if (id === undefined) throw new CliError("INVALID_ARGUMENT", `feeds ${operation ?? ""} requires a feed ID.`);
  if (operation === "get") return client.getFeed(id);
  if (operation === "refresh") return client.refreshFeed(id);
  if (operation === "remove") {
    const { values } = parse(args, { yes: { type: "boolean" } });
    if (values["yes"] !== true) throw new CliError("CONFIRMATION_REQUIRED", "Pass --yes to remove a feed and its stored entries.");
    return client.removeFeed(id);
  }
  if (operation === "update") {
    const { values } = parse(args, {
      title: { type: "string" }, category: { type: "string" }, status: { type: "string" }, interval: { type: "string" },
    });
    const interval = numeric(values["interval"] as string | undefined, "--interval", 5, 10_080);
    const input: Record<string, unknown> = {
      ...(typeof values["title"] !== "string" ? {} : { title: values["title"] }),
      ...(typeof values["category"] !== "string" ? {} : { category: values["category"] }),
      ...(typeof values["status"] !== "string" ? {} : { status: values["status"] }),
      ...(interval === undefined ? {} : { fetchIntervalMinutes: interval }),
    };
    if (Object.keys(input).length === 0) throw new CliError("INVALID_ARGUMENT", "feeds update requires at least one update option.");
    return client.updateFeed(id, input);
  }
  throw new CliError("INVALID_COMMAND", "Unknown feeds command.");
}

function entryCommands(client: RssSourceClient, args: string[]): Promise<unknown> {
  const operation = args.shift();
  if (operation === "list") {
    const { values } = parse(args, {
      limit: { type: "string" }, before: { type: "string" }, feed: { type: "string" }, category: { type: "string" },
      "unread-only": { type: "boolean" }, "starred-only": { type: "boolean" }, search: { type: "string" },
    });
    return client.listEntries({
      limit: numeric(values["limit"] as string | undefined, "--limit", 1, 200),
      before: typeof values["before"] === "string" ? values["before"] : undefined,
      feedId: typeof values["feed"] === "string" ? values["feed"] : undefined,
      category: typeof values["category"] === "string" ? values["category"] : undefined,
      unreadOnly: values["unread-only"] === true ? true : undefined,
      starredOnly: values["starred-only"] === true ? true : undefined,
      search: typeof values["search"] === "string" ? values["search"] : undefined,
    });
  }
  const id = args.shift();
  if (id === undefined) throw new CliError("INVALID_ARGUMENT", `entries ${operation ?? ""} requires an entry ID.`);
  if (operation === "get") return client.getEntry(id);
  if (operation === "update") {
    const { values } = parse(args, {
      read: { type: "boolean" }, unread: { type: "boolean" }, star: { type: "boolean" }, unstar: { type: "boolean" },
    });
    if (values["read"] === true && values["unread"] === true) throw new CliError("INVALID_ARGUMENT", "Use only one of --read or --unread.");
    if (values["star"] === true && values["unstar"] === true) throw new CliError("INVALID_ARGUMENT", "Use only one of --star or --unstar.");
    const input: Record<string, boolean> = {
      ...(values["read"] === true ? { isRead: true } : {}),
      ...(values["unread"] === true ? { isRead: false } : {}),
      ...(values["star"] === true ? { isStarred: true } : {}),
      ...(values["unstar"] === true ? { isStarred: false } : {}),
    };
    if (Object.keys(input).length === 0) throw new CliError("INVALID_ARGUMENT", "entries update requires a state option.");
    return client.updateEntry(id, input);
  }
  throw new CliError("INVALID_COMMAND", "Unknown entries command.");
}

export async function runCli(rawArgs: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<unknown> {
  const global = extractGlobalOptions(rawArgs);
  const args = [...global.args];
  const command = args.shift();
  if (command === undefined || command === "help" || command === "--help" || command === "-h") return { help: help() };
  if (command === "--version" || command === "-v" || command === "version") return { version: VERSION };

  const client = createClient(global, environment);
  if (command === "health") return client.health();
  if (command === "ready") return client.ready();
  if (command === "config" && args[0] === "show") {
    return {
      url: global.url ?? environment["RSS_SOURCE_URL"] ?? "http://127.0.0.1:3000",
      apiKeyConfigured: (global.apiKey ?? environment["RSS_SOURCE_API_KEY"] ?? "") !== "",
      cloudflareAccessConfigured:
        (global.cfAccessClientId ?? environment["CF_ACCESS_CLIENT_ID"] ?? "") !== "" &&
        (global.cfAccessClientSecret ?? environment["CF_ACCESS_CLIENT_SECRET"] ?? "") !== "",
    };
  }
  if (command === "feeds") return feedCommands(client, args);
  if (command === "entries") return entryCommands(client, args);
  if (command === "unread" && args[0] === "count") return client.unreadCount();
  if (command === "opml") {
    const operation = args.shift();
    if (operation === "import") {
      const { values, positionals } = parse(args, { refresh: { type: "boolean" } });
      const file = positionals[0];
      if (file === undefined) throw new CliError("INVALID_ARGUMENT", "opml import requires a file path.");
      return client.importOpml(await readFile(file, "utf8"), values["refresh"] === true);
    }
    if (operation === "export") {
      const { values } = parse(args, { output: { type: "string", short: "o" } });
      const opml = await client.exportOpml();
      if (typeof values["output"] === "string") {
        await writeFile(values["output"], opml, "utf8");
        return { output: values["output"], bytes: Buffer.byteLength(opml) };
      }
      return { opml };
    }
    throw new CliError("INVALID_COMMAND", "Unknown opml command.");
  }
  if (command === "folo") {
    const operation = args.shift();
    if (operation === "discover") return { subscriptions: await discoverFoloSubscriptions() };
    if (operation === "sync") {
      const { values } = parse(args, { "dry-run": { type: "boolean" }, concurrency: { type: "string" } });
      return syncFoloSubscriptions(client, {
        dryRun: values["dry-run"] === true,
        concurrency: numeric(values["concurrency"] as string | undefined, "--concurrency", 1, 20) ?? 4,
      });
    }
    throw new CliError("INVALID_COMMAND", "Unknown folo command.");
  }
  throw new CliError("INVALID_COMMAND", `Unknown command: ${command}`);
}

function success(data: unknown): void {
  process.stdout.write(`${JSON.stringify({ ok: true, data, error: null }, null, 2)}\n`);
}

function failure(error: unknown): void {
  const value = error instanceof CliError
    ? { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
    : { code: "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error) };
  process.stdout.write(`${JSON.stringify({ ok: false, data: null, error: value }, null, 2)}\n`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv.slice(2)).then(success, failure);
}
