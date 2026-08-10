CREATE TABLE IF NOT EXISTS feeds (
  id uuid PRIMARY KEY,
  url text NOT NULL UNIQUE,
  fetch_url text NOT NULL,
  site_url text,
  title text NOT NULL,
  custom_title boolean NOT NULL DEFAULT false,
  description text,
  category text NOT NULL DEFAULT 'Uncategorized',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  fetch_interval_minutes integer NOT NULL DEFAULT 30 CHECK (fetch_interval_minutes BETWEEN 5 AND 10080),
  etag text,
  last_modified text,
  last_fetched_at timestamptz,
  next_fetch_at timestamptz NOT NULL DEFAULT now(),
  error_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS feeds_due_idx
  ON feeds (next_fetch_at)
  WHERE status IN ('active', 'error');
CREATE INDEX IF NOT EXISTS feeds_category_idx ON feeds (category);

CREATE TABLE IF NOT EXISTS entries (
  id uuid PRIMARY KEY,
  feed_id uuid NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
  item_key char(64) NOT NULL,
  guid text,
  url text,
  title text NOT NULL,
  author text,
  summary text,
  content text,
  published_at timestamptz NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_read boolean NOT NULL DEFAULT false,
  is_starred boolean NOT NULL DEFAULT false,
  UNIQUE (feed_id, item_key)
);

CREATE INDEX IF NOT EXISTS entries_timeline_idx ON entries (published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS entries_feed_timeline_idx ON entries (feed_id, published_at DESC);
CREATE INDEX IF NOT EXISTS entries_unread_idx ON entries (published_at DESC) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS entries_starred_idx ON entries (published_at DESC) WHERE is_starred = true;
