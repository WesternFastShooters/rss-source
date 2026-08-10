import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CliError, type Feed, type RssSourceClient } from "./client.js";

const execFileAsync = promisify(execFile);

type UnknownRecord = Record<string, unknown>;

export type FoloSubscription = {
  url: string;
  title?: string;
  category?: string;
};

export type FoloRunner = (args: string[]) => Promise<unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export const runFoloCli: FoloRunner = async (args) => {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("npx", ["--yes", "folocli@latest", ...args, "--format", "json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError("FOLO_CLI_FAILED", `Folo CLI failed: ${message}`);
  }

  let envelope: UnknownRecord | null = null;
  try {
    envelope = record(JSON.parse(stdout));
  } catch {
    throw new CliError("INVALID_FOLO_OUTPUT", "Folo CLI returned invalid JSON.");
  }
  if (envelope?.["ok"] !== true) {
    const error = record(envelope?.["error"]);
    throw new CliError(text(error?.["code"]) ?? "FOLO_ERROR", text(error?.["message"]) ?? "Folo CLI request failed.");
  }
  return envelope["data"];
};

function addSubscription(output: Map<string, FoloSubscription>, feed: UnknownRecord, titleValue: unknown, categoryValue: unknown): void {
  const url = text(feed["url"]);
  if (url === undefined || output.has(url)) return;
  const title = text(titleValue) ?? text(feed["title"]);
  const category = text(categoryValue);
  output.set(url, {
    url,
    ...(title === undefined ? {} : { title }),
    ...(category === undefined ? {} : { category }),
  });
}

export async function discoverFoloSubscriptions(runner: FoloRunner = runFoloCli): Promise<FoloSubscription[]> {
  const subscriptionData = record(await runner(["subscription", "list"]));
  const subscriptions = array(subscriptionData?.["subscriptions"]);
  const output = new Map<string, FoloSubscription>();
  const lists = new Map<string, string>();

  for (const value of subscriptions) {
    const subscription = record(value);
    if (subscription === null) continue;
    const feed = record(subscription["feeds"]);
    if (feed !== null) addSubscription(output, feed, subscription["title"], subscription["category"]);
    const list = record(subscription["lists"]);
    const listId = text(list?.["id"]);
    if (listId !== undefined) lists.set(listId, text(list?.["title"]) ?? "Folo list");
  }

  for (const [listId, fallbackTitle] of lists) {
    const listData = record(await runner(["list", "get", listId]));
    const list = record(listData?.["list"]);
    const category = text(list?.["title"]) ?? fallbackTitle;
    for (const value of array(list?.["feeds"])) {
      const feed = record(value);
      if (feed !== null) addSubscription(output, feed, feed["title"], category);
    }
  }

  return [...output.values()];
}

function urlKey(value: string): string {
  if (value.toLowerCase().startsWith("rsshub://")) return `rsshub://${value.slice("rsshub://".length)}`;
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

async function mapConcurrent<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  async function run(): Promise<void> {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
}

export type SyncClient = Pick<RssSourceClient, "listAllFeeds" | "addFeed">;

export async function syncFoloSubscriptions(
  client: SyncClient,
  options: { dryRun?: boolean; concurrency?: number; runner?: FoloRunner } = {},
): Promise<{
  discovered: number;
  alreadyPresent: number;
  added: number;
  failed: Array<{ url: string; error: string }>;
  dryRun: boolean;
}> {
  const subscriptions = await discoverFoloSubscriptions(options.runner ?? runFoloCli);
  const existingFeeds: Feed[] = await client.listAllFeeds();
  const existing = new Set(existingFeeds.map((feed) => urlKey(feed.url)));
  const missing = subscriptions.filter((subscription) => !existing.has(urlKey(subscription.url)));
  const failed: Array<{ url: string; error: string }> = [];
  let added = 0;
  const dryRun = options.dryRun === true;

  if (!dryRun) {
    await mapConcurrent(missing, options.concurrency ?? 4, async (subscription) => {
      try {
        await client.addFeed({ ...subscription, refreshNow: false });
        added += 1;
      } catch (error) {
        failed.push({ url: subscription.url, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  return {
    discovered: subscriptions.length,
    alreadyPresent: subscriptions.length - missing.length,
    added: dryRun ? 0 : added,
    failed,
    dryRun,
  };
}
