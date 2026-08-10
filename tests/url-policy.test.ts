import { describe, expect, it } from "vitest";
import { assertSafeHttpUrl, isPrivateOrReservedAddress, resolveSubscriptionUrl } from "../src/feed/url-policy.js";

describe("feed URL policy", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "192.168.1.1", "::1", "fd00::1"])(
    "blocks private or reserved address %s",
    (address) => expect(isPrivateOrReservedAddress(address)).toBe(true),
  );

  it("accepts a public host resolved to a public address", async () => {
    const url = await assertSafeHttpUrl(
      "https://feeds.example.com/rss",
      new Set(),
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    expect(url.hostname).toBe("feeds.example.com");
  });

  it("rejects a public-looking host resolved to an internal address", async () => {
    await expect(assertSafeHttpUrl(
      "https://attacker.example/rss",
      new Set(),
      async () => [{ address: "127.0.0.1", family: 4 }],
    )).rejects.toMatchObject({ code: "BLOCKED_FEED_HOST" });
  });

  it("allows an explicitly configured RSSHub container", async () => {
    const url = await assertSafeHttpUrl("http://rsshub:1200/github/trending/daily/any", new Set(["rsshub"]));
    expect(url.hostname).toBe("rsshub");
  });

  it("converts rsshub scheme to the internal service URL", () => {
    expect(resolveSubscriptionUrl("rsshub://twitter/user/example", "http://rsshub:1200")).toEqual({
      url: "rsshub://twitter/user/example",
      fetchUrl: "http://rsshub:1200/twitter/user/example",
    });
  });
});
