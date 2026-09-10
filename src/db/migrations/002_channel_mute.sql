-- v1.1.0: per-channel alert muting (#3 / #5 enhancement).
-- When muted, the watchdog won't DM the owner about this channel losing
-- admin rights etc. The channel itself is still fully usable for posting.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS muted BOOLEAN NOT NULL DEFAULT false;
