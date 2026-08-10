import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { AppConfig } from "../config.js";
import { AppError, errorMessage } from "../errors.js";
import type { AppLogger } from "../logger.js";
import type { EntryRecord, FeedRecord, FeedStatus, ParsedFeedItem } from "../types.js";
import { fetchFeedDocument } from "./fetcher.js";
import { entryItemKey, parseFeed } from "./parser.js";
import { resolveSubscriptionUrl } from "./url-policy.js";

type FeedRow = {
  id: string;
  url: string;
  fetch_url: string;
  site_url: string | null;
  title: string;
  custom_title: boolean;
  description: string | null;
  category: string;
  status: FeedStatus;
  fetch_interval_minutes: number;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: Date | null;
  next_fetch_at: Date;
  error_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type EntryRow = {
  id: string;
  feed_id: string;
  feed_title?: string;
  feed_category?: string;
  guid: string | null;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  published_at: Date;
  discovered_at: Date;
  updated_at: Date;
  is_read: boolean;
  is_starred: boolean;
};

export type AddFeedInput = {
  url: string;
  title?: string | undefined;
  category?: string | undefined;
  fetchIntervalMinutes?: number | undefined;
  refreshNow?: boolean | undefined;
};

export type UpdateFeedInput = {
  title?: string | undefined;
  category?: string | undefined;
  status?: "active" | "paused" | undefined;
  fetchIntervalMinutes?: number | undefined;
};

export type ListEntryInput = {
  limit?: number | undefined;
  before?: Date | undefined;
  feedId?: string | undefined;
  category?: string | undefined;
  unreadOnly?: boolean | undefined;
  starredOnly?: boolean | undefined;
  search?: string | undefined;
};

export type RefreshResult = {
  feed: FeedRecord;
  notModified: boolean;
  discovered: number;
};

function mapFeed(row: FeedRow): FeedRecord {
  return {
    id: row.id,
    url: row.url,
    fetchUrl: row.fetch_url,
    siteUrl: row.site_url,
    title: row.title,
    description: row.description,
    category: row.category,
    status: row.status,
    fetchIntervalMinutes: row.fetch_interval_minutes,
    etag: row.etag,
    lastModified: row.last_modified,
    lastFetchedAt: row.last_fetched_at,
    nextFetchAt: row.next_fetch_at,
    errorCount: row.error_count,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEntry(row: EntryRow): EntryRecord {
  return {
    id: row.id,
    feedId: row.feed_id,
    ...(row.feed_title === undefined ? {} : { feedTitle: row.feed_title }),
    ...(row.feed_category === undefined ? {} : { feedCategory: row.feed_category }),
    guid: row.guid,
    url: row.url,
    title: row.title,
    author: row.author,
    summary: row.summary,
    content: row.content,
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
    isRead: row.is_read,
    isStarred: row.is_starred,
  };
}

function validateInterval(value: number): number {
  if (!Number.isInteger(value) || value < 5 || value > 10_080) {
    throw new AppError(400, "INVALID_FETCH_INTERVAL", "fetchIntervalMinutes must be between 5 and 10080");
  }
  return value;
}

function initialTitle(url: string, requested?: string): string {
  const title = requested?.trim();
  if (title !== undefined && title !== "") return title;
  if (url.startsWith("rsshub://")) return url.slice("rsshub://".length);
  return new URL(url).hostname;
}

export class FeedService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {}

  async listFeeds(input: { limit?: number | undefined; offset?: number | undefined; category?: string | undefined; status?: FeedStatus | undefined } = {}): Promise<FeedRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const offset = Math.max(input.offset ?? 0, 0);
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.category !== undefined) {
      values.push(input.category);
      where.push(`category = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      where.push(`status = $${values.length}`);
    }
    values.push(limit, offset);
    const result = await this.pool.query<FeedRow>(
      `SELECT * FROM feeds ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY category ASC, title ASC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map(mapFeed);
  }

  async getFeed(id: string): Promise<FeedRecord> {
    const result = await this.pool.query<FeedRow>("SELECT * FROM feeds WHERE id = $1", [id]);
    const row = result.rows[0];
    if (row === undefined) throw new AppError(404, "FEED_NOT_FOUND", "Feed not found");
    return mapFeed(row);
  }

  async addFeed(input: AddFeedInput): Promise<FeedRecord> {
    let resolved: { url: string; fetchUrl: string };
    try {
      resolved = resolveSubscriptionUrl(input.url, this.config.rsshubBaseUrl);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, "INVALID_FEED_URL", "Feed URL is invalid");
    }
    const interval = validateInterval(input.fetchIntervalMinutes ?? this.config.defaultFetchIntervalMinutes);
    const id = randomUUID();
    const result = await this.pool.query<FeedRow>(
      `INSERT INTO feeds(id, url, fetch_url, title, custom_title, category, fetch_interval_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT(url) DO NOTHING
       RETURNING *`,
      [
        id,
        resolved.url,
        resolved.fetchUrl,
        initialTitle(resolved.url, input.title),
        input.title?.trim() !== undefined && input.title.trim() !== "",
        input.category?.trim() || "Uncategorized",
        interval,
      ],
    );

    let feed = result.rows[0] === undefined
      ? await this.getFeedByUrl(resolved.url)
      : mapFeed(result.rows[0]);

    if (input.refreshNow !== false) {
      try {
        feed = (await this.refreshFeed(feed.id)).feed;
      } catch (error) {
        this.logger.warn({ err: error, feedId: feed.id, url: feed.url }, "initial feed refresh failed");
        feed = await this.getFeed(feed.id);
      }
    }
    return feed;
  }

  private async getFeedByUrl(url: string): Promise<FeedRecord> {
    const result = await this.pool.query<FeedRow>("SELECT * FROM feeds WHERE url = $1", [url]);
    const row = result.rows[0];
    if (row === undefined) throw new AppError(404, "FEED_NOT_FOUND", "Feed not found");
    return mapFeed(row);
  }

  async updateFeed(id: string, input: UpdateFeedInput): Promise<FeedRecord> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (title === "") throw new AppError(400, "INVALID_TITLE", "Feed title cannot be empty");
      values.push(title);
      assignments.push(`title = $${values.length}`);
      assignments.push("custom_title = true");
    }
    if (input.category !== undefined) {
      values.push(input.category.trim() || "Uncategorized");
      assignments.push(`category = $${values.length}`);
    }
    if (input.status !== undefined) {
      values.push(input.status);
      assignments.push(`status = $${values.length}`);
      if (input.status === "active") assignments.push("next_fetch_at = LEAST(next_fetch_at, now())");
    }
    if (input.fetchIntervalMinutes !== undefined) {
      values.push(validateInterval(input.fetchIntervalMinutes));
      assignments.push(`fetch_interval_minutes = $${values.length}`);
    }
    if (assignments.length === 0) return this.getFeed(id);
    values.push(id);
    const result = await this.pool.query<FeedRow>(
      `UPDATE feeds SET ${assignments.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
      values,
    );
    const row = result.rows[0];
    if (row === undefined) throw new AppError(404, "FEED_NOT_FOUND", "Feed not found");
    return mapFeed(row);
  }

  async deleteFeed(id: string): Promise<void> {
    const result = await this.pool.query("DELETE FROM feeds WHERE id = $1", [id]);
    if (result.rowCount === 0) throw new AppError(404, "FEED_NOT_FOUND", "Feed not found");
  }

  async refreshFeed(id: string): Promise<RefreshResult> {
    const feed = await this.getFeed(id);
    if (feed.status === "paused") throw new AppError(409, "FEED_PAUSED", "Paused feeds cannot be refreshed");
    try {
      const fetched = await fetchFeedDocument(feed.fetchUrl, this.config, {
        etag: feed.etag,
        lastModified: feed.lastModified,
      });
      if (fetched.notModified) {
        const updated = await this.pool.query<FeedRow>(
          `UPDATE feeds SET status = 'active', etag = COALESCE($2, etag), last_modified = COALESCE($3, last_modified),
            last_fetched_at = now(), next_fetch_at = now() + make_interval(mins => fetch_interval_minutes),
            error_count = 0, last_error = NULL, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, fetched.etag, fetched.lastModified],
        );
        return { feed: mapFeed(updated.rows[0]!), notModified: true, discovered: 0 };
      }

      const parsed = parseFeed(fetched.body, fetched.contentType, fetched.finalUrl);
      const client = await this.pool.connect();
      let discovered = 0;
      try {
        await client.query("BEGIN");
        for (const item of parsed.items) {
          discovered += await this.upsertEntry(client, id, item);
        }
        const updated = await client.query<FeedRow>(
          `UPDATE feeds SET fetch_url = $2, site_url = $3, title = CASE WHEN custom_title THEN title ELSE $4 END, description = $5, status = 'active',
            etag = $6, last_modified = $7, last_fetched_at = now(),
            next_fetch_at = now() + make_interval(mins => fetch_interval_minutes),
            error_count = 0, last_error = NULL, updated_at = now()
           WHERE id = $1 RETURNING *`,
          [id, fetched.finalUrl, parsed.siteUrl, parsed.title, parsed.description, fetched.etag, fetched.lastModified],
        );
        await client.query("COMMIT");
        this.logger.info({ feedId: id, discovered, itemCount: parsed.items.length }, "feed refreshed");
        return { feed: mapFeed(updated.rows[0]!), notModified: false, discovered };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = errorMessage(error).slice(0, 2000);
      await this.pool.query(
        `UPDATE feeds SET status = 'error', error_count = error_count + 1, last_error = $2,
          last_fetched_at = now(),
          next_fetch_at = now() + make_interval(mins => LEAST(1440, fetch_interval_minutes * power(2, LEAST(error_count + 1, 6))::integer)),
          updated_at = now() WHERE id = $1`,
        [id, message],
      );
      throw error;
    }
  }

  private async upsertEntry(client: pg.PoolClient, feedId: string, item: ParsedFeedItem): Promise<number> {
    const result = await client.query(
      `INSERT INTO entries(id, feed_id, item_key, guid, url, title, author, summary, content, published_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT(feed_id, item_key) DO UPDATE SET
         guid = EXCLUDED.guid, url = EXCLUDED.url, title = EXCLUDED.title, author = EXCLUDED.author,
         summary = EXCLUDED.summary, content = EXCLUDED.content, published_at = EXCLUDED.published_at,
         updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      [randomUUID(), feedId, entryItemKey(item), item.guid, item.url, item.title, item.author, item.summary, item.content, item.publishedAt],
    );
    return result.rows[0]?.inserted === true ? 1 : 0;
  }

  async claimDueFeedIds(limit: number): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `UPDATE feeds SET next_fetch_at = now() + interval '5 minutes', updated_at = now()
       WHERE id IN (
         SELECT id FROM feeds WHERE status IN ('active', 'error') AND next_fetch_at <= now()
         ORDER BY next_fetch_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
       ) RETURNING id`,
      [limit],
    );
    return result.rows.map((row) => row.id);
  }

  async listEntries(input: ListEntryInput = {}): Promise<EntryRecord[]> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.before !== undefined) {
      values.push(input.before);
      where.push(`e.published_at < $${values.length}`);
    }
    if (input.feedId !== undefined) {
      values.push(input.feedId);
      where.push(`e.feed_id = $${values.length}`);
    }
    if (input.category !== undefined) {
      values.push(input.category);
      where.push(`f.category = $${values.length}`);
    }
    if (input.unreadOnly === true) where.push("e.is_read = false");
    if (input.starredOnly === true) where.push("e.is_starred = true");
    if (input.search !== undefined && input.search.trim() !== "") {
      values.push(`%${input.search.trim()}%`);
      where.push(`(e.title ILIKE $${values.length} OR e.summary ILIKE $${values.length})`);
    }
    values.push(limit);
    const result = await this.pool.query<EntryRow>(
      `SELECT e.*, f.title AS feed_title, f.category AS feed_category
       FROM entries e JOIN feeds f ON f.id = e.feed_id
       ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
       ORDER BY e.published_at DESC, e.id DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapEntry);
  }

  async getEntry(id: string): Promise<EntryRecord> {
    const result = await this.pool.query<EntryRow>(
      `SELECT e.*, f.title AS feed_title, f.category AS feed_category
       FROM entries e JOIN feeds f ON f.id = e.feed_id WHERE e.id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AppError(404, "ENTRY_NOT_FOUND", "Entry not found");
    return mapEntry(row);
  }

  async updateEntry(id: string, input: { isRead?: boolean | undefined; isStarred?: boolean | undefined }): Promise<EntryRecord> {
    const values: unknown[] = [];
    const assignments: string[] = [];
    if (input.isRead !== undefined) {
      values.push(input.isRead);
      assignments.push(`is_read = $${values.length}`);
    }
    if (input.isStarred !== undefined) {
      values.push(input.isStarred);
      assignments.push(`is_starred = $${values.length}`);
    }
    if (assignments.length === 0) return this.getEntry(id);
    values.push(id);
    const result = await this.pool.query<{ id: string }>(
      `UPDATE entries SET ${assignments.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING id`,
      values,
    );
    if (result.rows[0] === undefined) throw new AppError(404, "ENTRY_NOT_FOUND", "Entry not found");
    return this.getEntry(id);
  }

  async unreadCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM entries WHERE is_read = false");
    return Number(result.rows[0]?.count ?? 0);
  }
}
