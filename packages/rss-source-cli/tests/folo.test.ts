import { describe, expect, it, vi } from "vitest";
import type { Feed } from "../src/client.js";
import { discoverFoloSubscriptions, syncFoloSubscriptions, type FoloRunner } from "../src/folo.js";

function runner(): FoloRunner {
  return async (args) => {
    if (args[0] === "subscription") {
      return {
        subscriptions: [
          { title: "Direct custom", category: "Direct", feeds: { url: "https://example.com/direct.xml", title: "Direct" } },
          { lists: { id: "list-1", title: "AI list" } },
        ],
      };
    }
    if (args[0] === "list") {
      return {
        list: {
          id: "list-1",
          title: "AI list",
          feeds: [
            { url: "https://example.com/list.xml", title: "Listed" },
            { url: "https://example.com/direct.xml", title: "Duplicate" },
          ],
        },
      };
    }
    throw new Error(`Unexpected Folo command: ${args.join(" ")}`);
  };
}

describe("Folo synchronization", () => {
  it("expands lists and deduplicates feed URLs", async () => {
    await expect(discoverFoloSubscriptions(runner())).resolves.toEqual([
      { url: "https://example.com/direct.xml", title: "Direct custom", category: "Direct" },
      { url: "https://example.com/list.xml", title: "Listed", category: "AI list" },
    ]);
  });

  it("adds only subscriptions missing from RSS Source", async () => {
    const addFeed = vi.fn(async (input): Promise<Feed> => ({
      id: "new",
      url: input.url,
      title: input.title ?? "",
      category: input.category ?? "Uncategorized",
      status: "active",
    }));
    const result = await syncFoloSubscriptions({
      listAllFeeds: async () => [{ id: "old", url: "https://example.com/direct.xml", title: "Direct", category: "Direct", status: "active" }],
      addFeed,
    }, { runner: runner(), concurrency: 2 });

    expect(result).toMatchObject({ discovered: 2, alreadyPresent: 1, added: 1, failed: [] });
    expect(addFeed).toHaveBeenCalledWith(expect.objectContaining({ url: "https://example.com/list.xml", refreshNow: false }));
  });

  it("supports a dry run", async () => {
    const addFeed = vi.fn();
    const result = await syncFoloSubscriptions({ listAllFeeds: async () => [], addFeed }, { runner: runner(), dryRun: true });
    expect(result).toMatchObject({ discovered: 2, alreadyPresent: 0, added: 0, dryRun: true });
    expect(addFeed).not.toHaveBeenCalled();
  });
});
