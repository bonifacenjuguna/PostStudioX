-- Core schema for the posting bot.

CREATE TABLE IF NOT EXISTS channels (
  id SERIAL PRIMARY KEY,
  chat_id TEXT UNIQUE NOT NULL,          -- Telegram channel id, e.g. -100xxxxxxxxxx
  title TEXT,
  username TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT true,
  admin_issue TEXT,                       -- last known reason bot lost rights, if any
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- saved_items unifies "posts" and "templates" per the product decision that
-- a template is just a saved post reused for its format. `kind` is a UI hint,
-- not a hard schema split.
CREATE TABLE IF NOT EXISTS saved_items (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'post' CHECK (kind IN ('post', 'template', 'recipe')),
  name TEXT,                              -- display name, mainly for templates/recipes
  status TEXT NOT NULL DEFAULT 'draft'    -- draft | scheduled | sent | deleted | trashed
    CHECK (status IN ('draft', 'scheduled', 'sent', 'deleted', 'trashed', 'failed')),
  channel_ids TEXT[] DEFAULT '{}',        -- target channel chat_ids (may be multiple)
  media_type TEXT,                        -- photo | video | document | text | poll | media_group
  media_items JSONB DEFAULT '[]',         -- [{file_id, type, caption, has_spoiler}]
  caption TEXT,
  entities JSONB DEFAULT '[]',            -- Telegram message entities (offset-based)
  buttons JSONB DEFAULT '[]',             -- [[{text, url, style, callback_data}]]
  options JSONB DEFAULT '{}',             -- protect_content, disable_notification, strip_links, etc.
  recipe_id INTEGER REFERENCES saved_items(id) ON DELETE SET NULL,
  family_id INTEGER,                      -- links related posts (A/B comparisons)
  version INTEGER NOT NULL DEFAULT 1,
  current_message_refs JSONB DEFAULT '[]',-- [{chat_id, message_id}] once actually sent
  scheduled_for TIMESTAMPTZ,
  auto_delete_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  trashed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saved_items_kind ON saved_items(kind);
CREATE INDEX IF NOT EXISTS idx_saved_items_status ON saved_items(status);
CREATE INDEX IF NOT EXISTS idx_saved_items_family ON saved_items(family_id);

CREATE TABLE IF NOT EXISTS post_versions (
  id SERIAL PRIMARY KEY,
  saved_item_id INTEGER NOT NULL REFERENCES saved_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  snapshot JSONB NOT NULL,                -- full copy of the saved_items row at that version
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_post_versions_item ON post_versions(saved_item_id);

CREATE TABLE IF NOT EXISTS folders (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS folder_items (
  folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  saved_item_id INTEGER NOT NULL REFERENCES saved_items(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, saved_item_id)
);

CREATE TABLE IF NOT EXISTS stats (
  id SERIAL PRIMARY KEY,
  saved_item_id INTEGER NOT NULL REFERENCES saved_items(id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  views INTEGER DEFAULT 0,
  reactions JSONB DEFAULT '{}',           -- {"👍": 12, "❤️": 4}
  last_polled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_stats_item ON stats(saved_item_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS watchdog_log (
  id SERIAL PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
  category TEXT NOT NULL,                 -- memory | queue | channel | db | redis | webhook | gramjs
  message TEXT NOT NULL,
  self_healed BOOLEAN NOT NULL DEFAULT false,
  resolved BOOLEAN NOT NULL DEFAULT false,
  bot_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_watchdog_log_created ON watchdog_log(created_at);
CREATE INDEX IF NOT EXISTS idx_watchdog_log_resolved ON watchdog_log(resolved);

CREATE TABLE IF NOT EXISTS media_library (
  id SERIAL PRIMARY KEY,
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  media_type TEXT NOT NULL,               -- photo | video | document
  label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  chat_id TEXT PRIMARY KEY,               -- owner's chat id (single-owner bot, but keyed for clarity)
  scene TEXT,
  state JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed sane defaults so Settings has something to read on first boot.
INSERT INTO settings (key, value) VALUES
  ('defaults', '{"parse_mode": "entities", "protect_content": false, "disable_notification": false, "button_style": "default"}'),
  ('timezone', '"UTC"'),
  ('notifications', '{"watchdog_silent_logs": true, "watchdog_alerts": true, "quiet_hours_enabled": false}'),
  ('auto_delete_defaults', '{"enabled": false, "ttl_minutes": null}'),
  ('cleanup_rules', '{"auto_prune_enabled": false, "keep_versions": 10, "keep_watchdog_days": 30}'),
  ('watchdog_paused', 'false'),
  ('quiet_hours', '{"start": 23, "end": 7}')
ON CONFLICT (key) DO NOTHING;
