-- Adds: per-channel alert muting, a cached detailed permission breakdown
-- (so the channel screen and /status don't need a live getChatMember call
-- just to render), and a display label independent of the Telegram title
-- (channels get renamed on Telegram; a bot-side label should survive that).

ALTER TABLE channels ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS permissions JSONB DEFAULT '{}';
ALTER TABLE channels ADD COLUMN IF NOT EXISTS label TEXT;

-- saved_items: a post can now be saved as a template AND sent/scheduled in
-- the same action (previously mutually exclusive at the flow level). This
-- tracks the template that was spun off from a given post/send, if any -
-- purely informational, doesn't affect existing sends.
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS spawned_template_id INTEGER REFERENCES saved_items(id) ON DELETE SET NULL;
