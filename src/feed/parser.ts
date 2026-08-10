import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import sanitizeHtml from "sanitize-html";
import { AppError } from "../errors.js";
import type { ParsedFeed, ParsedFeedItem } from "../types.js";

type UnknownRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

const contentSanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "figure",
    "figcaption",
    "picture",
    "source",
    "video",
    "audio",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    source: ["src", "type", "media"],
    video: ["src", "controls", "poster", "width", "height"],
    audio: ["src", "controls"],
    code: ["class"],
    pre: ["class"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
  },
  transformTags: {
    a: (_tagName, attributes) => ({
      tagName: "a",
      attribs: { ...attributes, rel: "noopener noreferrer" },
    }),
  },
};

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const output = String(value)
      .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&")
      .trim();
    return output === "" ? null : output;
  }
  const object = record(value);
  if (object === null) return null;
  return text(object["#text"] ?? object["text"] ?? object["_"]);
}

function cleanText(value: unknown, fallback = "Untitled"): string {
  const source = text(value) ?? fallback;
  const output = sanitizeHtml(source, { allowedTags: [], allowedAttributes: {} }).trim();
  return output === "" ? fallback : output;
}

function cleanContent(value: unknown): string | null {
  const source = text(value);
  if (source === null) return null;
  const output = sanitizeHtml(source, contentSanitizeOptions).trim();
  return output === "" ? null : output;
}

function absoluteUrl(value: unknown, baseUrl: string): string | null {
  const source = text(value);
  if (source === null) return null;
  try {
    const url = new URL(source, baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parsedDate(value: unknown, fallback: Date): Date {
  const source = text(value);
  if (source === null) return fallback;
  const date = new Date(source);
  return Number.isNaN(date.valueOf()) ? fallback : date;
}

function atomLink(value: unknown, baseUrl: string, preferredRel = "alternate"): string | null {
  const links = array(value);
  const objects = links.map(record).filter((item): item is UnknownRecord => item !== null);
  const preferred = objects.find((item) => (text(item["@rel"]) ?? "alternate") === preferredRel) ?? objects[0];
  return absoluteUrl(preferred?.["@href"] ?? text(value), baseUrl);
}

function rssItem(value: unknown, sourceUrl: string, now: Date): ParsedFeedItem | null {
  const item = record(value);
  if (item === null) return null;
  const url = absoluteUrl(item["link"], sourceUrl);
  const guid = text(item["guid"]);
  const content = cleanContent(item["encoded"] ?? item["content"] ?? item["description"]);
  const summary = cleanContent(item["description"] ?? item["summary"]);
  return {
    guid,
    url,
    title: cleanText(item["title"], url ?? guid ?? "Untitled"),
    author: cleanTextOrNull(item["creator"] ?? item["author"]),
    summary,
    content,
    publishedAt: parsedDate(item["pubDate"] ?? item["date"] ?? item["published"] ?? item["updated"], now),
  };
}

function atomItem(value: unknown, sourceUrl: string, now: Date): ParsedFeedItem | null {
  const item = record(value);
  if (item === null) return null;
  const authorObject = record(item["author"]);
  const url = atomLink(item["link"], sourceUrl);
  const guid = text(item["id"]);
  return {
    guid,
    url,
    title: cleanText(item["title"], url ?? guid ?? "Untitled"),
    author: cleanTextOrNull(authorObject?.["name"] ?? item["author"]),
    summary: cleanContent(item["summary"]),
    content: cleanContent(item["content"] ?? item["summary"]),
    publishedAt: parsedDate(item["published"] ?? item["updated"], now),
  };
}

function cleanTextOrNull(value: unknown): string | null {
  const source = text(value);
  if (source === null) return null;
  const output = sanitizeHtml(source, { allowedTags: [], allowedAttributes: {} }).trim();
  return output === "" ? null : output;
}

function parseJsonFeed(body: string, sourceUrl: string, now: Date): ParsedFeed {
  let root: UnknownRecord;
  try {
    const parsed = JSON.parse(body) as unknown;
    const object = record(parsed);
    if (object === null) throw new Error("JSON feed root must be an object");
    root = object;
  } catch (error) {
    throw new AppError(422, "INVALID_FEED", `Invalid JSON feed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const items = array(root["items"])
    .map((value): ParsedFeedItem | null => {
      const item = record(value);
      if (item === null) return null;
      const url = absoluteUrl(item["url"] ?? item["external_url"], sourceUrl);
      const guid = text(item["id"]);
      return {
        guid,
        url,
        title: cleanText(item["title"], url ?? guid ?? "Untitled"),
        author: cleanTextOrNull(
          record(item["author"])?.["name"] ?? record(array(item["authors"])[0])?.["name"] ?? array(item["authors"])[0],
        ),
        summary: cleanContent(item["summary"]),
        content: cleanContent(item["content_html"] ?? item["content_text"] ?? item["summary"]),
        publishedAt: parsedDate(item["date_published"] ?? item["date_modified"], now),
      };
    })
    .filter((item): item is ParsedFeedItem => item !== null);

  return {
    title: cleanText(root["title"], new URL(sourceUrl).hostname),
    description: cleanContent(root["description"]),
    siteUrl: absoluteUrl(root["home_page_url"], sourceUrl),
    items,
  };
}

function parseXmlFeed(body: string, sourceUrl: string, now: Date): ParsedFeed {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(body) as unknown;
  } catch (error) {
    throw new AppError(422, "INVALID_FEED", `Invalid XML feed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = record(parsed);
  if (root === null) throw new AppError(422, "INVALID_FEED", "XML feed has no document root");

  const rssRoot = record(root["rss"]);
  const rdfRoot = record(root["RDF"]);
  const channel = record(rssRoot?.["channel"] ?? rdfRoot?.["channel"]);
  if (channel !== null) {
    const rawItems = rssRoot === null ? array(rdfRoot?.["item"]) : array(channel["item"]);
    return {
      title: cleanText(channel["title"], new URL(sourceUrl).hostname),
      description: cleanContent(channel["description"]),
      siteUrl: absoluteUrl(channel["link"], sourceUrl),
      items: rawItems
        .map((item) => rssItem(item, sourceUrl, now))
        .filter((item): item is ParsedFeedItem => item !== null),
    };
  }

  const feed = record(root["feed"]);
  if (feed !== null) {
    return {
      title: cleanText(feed["title"], new URL(sourceUrl).hostname),
      description: cleanContent(feed["subtitle"]),
      siteUrl: atomLink(feed["link"], sourceUrl),
      items: array(feed["entry"])
        .map((item) => atomItem(item, sourceUrl, now))
        .filter((item): item is ParsedFeedItem => item !== null),
    };
  }

  throw new AppError(422, "INVALID_FEED", "Document is not a supported RSS, Atom, RDF, or JSON Feed");
}

export function parseFeed(body: string, contentType: string, sourceUrl: string, now = new Date()): ParsedFeed {
  const trimmed = body.trimStart();
  if (contentType.toLowerCase().includes("json") || trimmed.startsWith("{")) {
    return parseJsonFeed(body, sourceUrl, now);
  }
  return parseXmlFeed(body, sourceUrl, now);
}

export function entryItemKey(item: ParsedFeedItem): string {
  const identity = item.guid ?? item.url ?? `${item.title}\n${item.publishedAt.toISOString()}`;
  return createHash("sha256").update(identity).digest("hex");
}
