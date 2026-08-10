import { XMLParser } from "fast-xml-parser";
import { AppError } from "./errors.js";
import type { FeedRecord } from "./types.js";

type UnknownRecord = Record<string, unknown>;

export type OpmlSubscription = {
  url: string;
  title?: string;
  category?: string;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: false,
});

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function string(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const output = String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .trim();
  return output === "" ? undefined : output;
}

function walkOutlines(value: unknown, inheritedCategory: string | undefined, output: OpmlSubscription[]): void {
  for (const candidate of array(value)) {
    const outline = record(candidate);
    if (outline === null) continue;
    const url = string(outline["@xmlUrl"] ?? outline["@xmlurl"]);
    const title = string(outline["@title"] ?? outline["@text"]);
    const category = string(outline["@category"]) ?? inheritedCategory;
    if (url !== undefined) {
      output.push({ url, ...(title === undefined ? {} : { title }), ...(category === undefined ? {} : { category }) });
    }
    const childCategory = url === undefined ? title ?? inheritedCategory : category;
    walkOutlines(outline["outline"], childCategory, output);
  }
}

export function parseOpml(body: string): OpmlSubscription[] {
  let document: unknown;
  try {
    document = parser.parse(body) as unknown;
  } catch (error) {
    throw new AppError(400, "INVALID_OPML", `Invalid OPML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const opml = record(record(document)?.["opml"]);
  const bodyNode = record(opml?.["body"]);
  if (bodyNode === null) throw new AppError(400, "INVALID_OPML", "OPML document has no body");
  const subscriptions: OpmlSubscription[] = [];
  walkOutlines(bodyNode["outline"], undefined, subscriptions);
  if (subscriptions.length === 0) throw new AppError(400, "EMPTY_OPML", "OPML document contains no feed subscriptions");
  const unique = new Map<string, OpmlSubscription>();
  for (const subscription of subscriptions) {
    if (!unique.has(subscription.url)) unique.set(subscription.url, subscription);
  }
  return [...unique.values()];
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function generateOpml(feeds: FeedRecord[], title = "AI LLM Agent RSS subscriptions"): string {
  const categories = new Map<string, FeedRecord[]>();
  for (const feed of feeds) {
    const items = categories.get(feed.category) ?? [];
    items.push(feed);
    categories.set(feed.category, items);
  }
  const outlines = [...categories.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, items]) => {
      const children = items
        .sort((left, right) => left.title.localeCompare(right.title))
        .map((feed) => `      <outline type="rss" text="${escapeXml(feed.title)}" title="${escapeXml(feed.title)}" xmlUrl="${escapeXml(feed.url)}"${feed.siteUrl === null ? "" : ` htmlUrl="${escapeXml(feed.siteUrl)}"`}/>`)
        .join("\n");
      return `    <outline text="${escapeXml(category)}" title="${escapeXml(category)}">\n${children}\n    </outline>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${escapeXml(title)}</title>
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}
