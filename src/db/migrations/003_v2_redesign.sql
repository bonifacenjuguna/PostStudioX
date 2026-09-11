-- v2.0.0 redesign: loop mode, channel admin-rights tracking + custom
-- signature, and provenance for the forward/link-import + replace-message
-- features. See CHANGELOG v2.0.0 for the full feature list this supports.

-- --- Loop mode -------------------------------------------------------
-- A saved_item can be flagged to loop: post -> stay up -> delete -> wait a
-- gap -> repost, either forever or for a fixed number of cycles. The worker
-- reads this JSONB to decide whether to re-queue itself after a delete.
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS loop_config JSONB DEFAULT NULL;
-- Shape: {
--   "enabled": true,
--   "stay_seconds": 3600,
--   "gap_seconds": 300,
--   "max_cycles": null,        -- null = infinite until stopped
--   "cycles_done": 0,
--   "active": true             -- flips to false when stopped/exhausted
-- }

-- --- Channel admin-rights tracking ------------------------------------
-- Snapshot of which admin rights the bot actually holds in each channel,
-- refreshed via getChatMember whenever we check (native add flow, Manage
-- Channels screen, or the watchdog's periodic sweep). Lets Manage Channels
-- show "granted vs missing" without an extra API round trip on every view.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS admin_rights JSONB DEFAULT '{}';
-- Shape: { "can_post_messages": true, "can_edit_messages": true, ... }
ALTER TABLE channels ADD COLUMN IF NOT EXISTS rights_checked_at TIMESTAMPTZ;

-- --- Custom post signature ---------------------------------------------
-- The custom admin title the bot sets for itself in a channel via
-- setChatAdministratorCustomTitle, which is what shows as the post
-- signature when the channel has "Sign messages" enabled. Per-channel,
-- since different channels may want different signatures.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS post_signature TEXT;
ALTER TABLE channels ADD COLUMN IF NOT EXISTS sign_messages BOOLEAN NOT NULL DEFAULT false;

-- --- Import / link-edit provenance --------------------------------------
-- When a post is brought in via forward or a t.me link (rather than
-- composed from scratch), we keep where it came from so "Replace Links"
-- and "Edit via link" can find their way back to the live channel message
-- without the user re-typing anything.
ALTER TABLE saved_items ADD COLUMN IF NOT EXISTS imported_from JSONB DEFAULT NULL;
-- Shape: { "chat_id": "-100...", "message_id": 123, "via": "forward" | "link" }

-- --- Structured error log ------------------------------------------------
-- Complements watchdog_log (which is for system health) with per-action
-- errors surfaced back to the owner: which scene/step, what was attempted,
-- and the raw Telegram/DB error, so an error message can point at the
-- exact spot instead of a bare "something went wrong".
CREATE TABLE IF NOT EXISTS action_errors (
  id SERIAL PRIMARY KEY,
  scene TEXT NOT NULL,             -- e.g. 'new-post', 'edit-post', 'channels'
  step TEXT,                       -- e.g. 'send', 'replace_links', 'add_button'
  attempted TEXT NOT NULL,         -- plain-English: what the bot was trying to do
  reason TEXT,                     -- Telegram/DB error description
  error_code TEXT,                 -- Telegram error_code or DB error code, if any
  saved_item_id INTEGER REFERENCES saved_items(id) ON DELETE SET NULL,
  chat_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_action_errors_created ON action_errors(created_at);
CREATE INDEX IF NOT EXISTS idx_action_errors_scene ON action_errors(scene);
