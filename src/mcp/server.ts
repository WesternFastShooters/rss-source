import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { FeedService } from "../feed/service.js";
import { parseOpml } from "../opml.js";

function result(value: unknown) {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}

async function importSubscriptions(service: FeedService, opml: string, refreshNow: boolean) {
  const subscriptions = parseOpml(opml);
  const imported = [];
  const failed = [];
  for (const subscription of subscriptions) {
    try {
      imported.push(await service.addFeed({ ...subscription, refreshNow }));
    } catch (error) {
      failed.push({ url: subscription.url, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { total: subscriptions.length, imported: imported.length, failed };
}

export function createRssMcpServer(service: FeedService): McpServer {
  const server = new McpServer(
    { name: "ai-llm-agent-rss", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "list_feeds",
    {
      title: "List RSS subscriptions",
      description: "List subscribed feeds, optionally filtered by category or status.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
        offset: z.number().int().min(0).default(0),
        category: z.string().optional(),
        status: z.enum(["active", "paused", "error"]).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (input) => result({ feeds: await service.listFeeds(input) }),
  );

  server.registerTool(
    "add_feed",
    {
      title: "Subscribe to an RSS feed",
      description: "Add an RSS, Atom, JSON Feed, or rsshub:// subscription. The operation is idempotent by URL.",
      inputSchema: z.object({
        url: z.string().min(1),
        title: z.string().optional(),
        category: z.string().optional(),
        fetchIntervalMinutes: z.number().int().min(5).max(10_080).optional(),
        refreshNow: z.boolean().default(true),
      }),
    },
    async (input) => result({ feed: await service.addFeed(input) }),
  );

  server.registerTool(
    "remove_feed",
    {
      title: "Remove an RSS subscription",
      description: "Delete a feed and all entries stored for it.",
      inputSchema: z.object({ id: z.uuid() }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      await service.deleteFeed(id);
      return result({ removed: true, id });
    },
  );

  server.registerTool(
    "refresh_feed",
    {
      title: "Refresh an RSS feed",
      description: "Fetch one feed immediately and store new entries.",
      inputSchema: z.object({ id: z.uuid() }),
    },
    async ({ id }) => result(await service.refreshFeed(id)),
  );

  server.registerTool(
    "list_entries",
    {
      title: "List RSS entries",
      description: "Return timeline entries with optional feed, category, unread, starred, date, and text filters.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        before: z.iso.datetime().optional(),
        feedId: z.uuid().optional(),
        category: z.string().optional(),
        unreadOnly: z.boolean().default(false),
        starredOnly: z.boolean().default(false),
        search: z.string().max(200).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ before, ...input }) => result({
      entries: await service.listEntries({ ...input, ...(before === undefined ? {} : { before: new Date(before) }) }),
    }),
  );

  server.registerTool(
    "get_entry",
    {
      title: "Get one RSS entry",
      description: "Get the complete stored content and metadata for an entry.",
      inputSchema: z.object({ id: z.uuid() }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => result({ entry: await service.getEntry(id) }),
  );

  server.registerTool(
    "update_entry",
    {
      title: "Update RSS entry state",
      description: "Mark an entry read/unread or starred/unstarred.",
      inputSchema: z.object({ id: z.uuid(), isRead: z.boolean().optional(), isStarred: z.boolean().optional() }),
    },
    async ({ id, ...input }) => result({ entry: await service.updateEntry(id, input) }),
  );

  server.registerTool(
    "unread_count",
    {
      title: "Get unread entry count",
      description: "Return the total number of unread entries.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => result({ count: await service.unreadCount() }),
  );

  server.registerTool(
    "import_opml",
    {
      title: "Import OPML subscriptions",
      description: "Bulk import RSS subscriptions from an OPML document.",
      inputSchema: z.object({ opml: z.string().min(1), refreshNow: z.boolean().default(false) }),
    },
    async ({ opml, refreshNow }) => result(await importSubscriptions(service, opml, refreshNow)),
  );

  return server;
}
