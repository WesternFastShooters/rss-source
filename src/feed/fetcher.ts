import type { AppConfig } from "../config.js";
import { AppError } from "../errors.js";
import { assertSafeHttpUrl } from "./url-policy.js";

export type FeedFetchOptions = {
  etag?: string | null;
  lastModified?: string | null;
};

export type FeedFetchResult =
  | { notModified: true; etag: string | null; lastModified: string | null; finalUrl: string }
  | {
      notModified: false;
      body: string;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
      finalUrl: string;
    };

type FetchConfig = Pick<AppConfig, "fetchAllowPrivateHosts" | "fetchMaxBytes" | "fetchTimeoutMs" | "userAgent">;

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new AppError(422, "FEED_TOO_LARGE", `Feed exceeds the ${maxBytes} byte limit`);
  }
  if (response.body === null) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AppError(422, "FEED_TOO_LARGE", `Feed exceeds the ${maxBytes} byte limit`);
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export async function fetchFeedDocument(
  inputUrl: string,
  config: FetchConfig,
  options: FeedFetchOptions = {},
): Promise<FeedFetchResult> {
  const allowedPrivateHosts = new Set(config.fetchAllowPrivateHosts.map((host) => host.toLowerCase()));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Feed request timed out")), config.fetchTimeoutMs);
  let currentUrl = await assertSafeHttpUrl(inputUrl, allowedPrivateHosts);

  try {
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const headers = new Headers({
        accept: "application/atom+xml, application/rss+xml, application/feed+json, application/json, application/xml, text/xml;q=0.9, */*;q=0.5",
        "user-agent": config.userAgent,
      });
      if (options.etag !== undefined && options.etag !== null) headers.set("if-none-match", options.etag);
      if (options.lastModified !== undefined && options.lastModified !== null) {
        headers.set("if-modified-since", options.lastModified);
      }

      const response = await fetch(currentUrl, {
        method: "GET",
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      if (response.status === 304) {
        return { notModified: true, etag, lastModified, finalUrl: currentUrl.toString() };
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) throw new AppError(422, "INVALID_REDIRECT", "Feed returned a redirect without a location");
        if (redirects === 5) throw new AppError(422, "TOO_MANY_REDIRECTS", "Feed returned too many redirects");
        currentUrl = await assertSafeHttpUrl(new URL(location, currentUrl), allowedPrivateHosts);
        continue;
      }

      if (!response.ok) {
        throw new AppError(422, "FEED_FETCH_FAILED", `Feed returned HTTP ${response.status}`);
      }

      const body = await readLimitedBody(response, config.fetchMaxBytes);
      if (body.trim() === "") throw new AppError(422, "EMPTY_FEED", "Feed returned an empty body");
      return {
        notModified: false,
        body,
        contentType: response.headers.get("content-type") ?? "",
        etag,
        lastModified,
        finalUrl: currentUrl.toString(),
      };
    }
    throw new AppError(422, "TOO_MANY_REDIRECTS", "Feed returned too many redirects");
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError(422, "FEED_TIMEOUT", "Feed request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
