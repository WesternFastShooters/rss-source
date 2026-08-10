export type FeedStatus = "active" | "paused" | "error";

export type FeedRecord = {
  id: string;
  url: string;
  fetchUrl: string;
  siteUrl: string | null;
  title: string;
  description: string | null;
  category: string;
  status: FeedStatus;
  fetchIntervalMinutes: number;
  etag: string | null;
  lastModified: string | null;
  lastFetchedAt: Date | null;
  nextFetchAt: Date;
  errorCount: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EntryRecord = {
  id: string;
  feedId: string;
  feedTitle?: string;
  feedCategory?: string;
  guid: string | null;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  publishedAt: Date;
  discoveredAt: Date;
  updatedAt: Date;
  isRead: boolean;
  isStarred: boolean;
};

export type ParsedFeedItem = {
  guid: string | null;
  url: string | null;
  title: string;
  author: string | null;
  summary: string | null;
  content: string | null;
  publishedAt: Date;
};

export type ParsedFeed = {
  title: string;
  description: string | null;
  siteUrl: string | null;
  items: ParsedFeedItem[];
};
