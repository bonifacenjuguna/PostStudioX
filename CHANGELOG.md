# Changelog

## v1.1.0 — batch 1 (fixes #1–#12 + enhancements)

### Fixed
- **#1 — "Send Now" / "Clone" crash** (`Cannot read properties of undefined
  (reading 'sendMessage')`). Root cause: `publisher.js` was written
  expecting a full Telegraf bot instance and called
  `bot.telegram.sendMessage(...)` internally, but `create-post`/`edit-post`
  correctly passed `ctx.telegram` (the API client itself). Standardized on
  the API client everywhere — `publisher.js` now takes `telegram` directly;
  the scheduled-post worker now passes `bot.telegram` instead of `bot`.
- **#2 — "Add Channel" dead-end.** Now offers a native Telegram chat picker
  (`request_chat`), plus @username, t.me/ links, numeric chat ID, or
  forwarding a message — all four register the channel the same way.
- **#3 — "Re-check Rights" was a blunt yes/no.** Now shows a full permission
  breakdown (post/edit/delete/pin/invite/etc.) via a shared
  `channelPermissions.js` helper used consistently by the channels scene,
  watchdog, watchdog alert DMs, and the worker's live pre-send check. Also
  redefines "admin" to require `can_post_messages` specifically — a channel
  admin with that permission stripped no longer reports as fine.
- **#4 — New Post asked for a channel before any content existed.** Channel
  selection now happens at the very end, gated behind Send/Schedule/Send &
  Save as Template. Save as Draft / Save as Template need no channel at all.
- **#5 — Channel screen was missing actions.** Added 🔕/🔔 Mute Alerts
  per channel (new `channels.muted` column).
- **#6 — Dead "Jump to page" button; Emergency Stop not actually global;
  easy-to-miss toast on "pick a channel first."** Jump-to-page now works
  (`registerPaginationJump`). Emergency Stop moved onto the persistent
  reply keyboard (`🛑 STOP ALL`), reachable from literally anywhere, not
  just screens that happened to attach the inline version. The "pick a
  channel first" toast is now a real chat message.
- **#7 — "Clear Temp Files" was a no-op** (nothing in this codebase ever
  wrote local temp files). Replaced with "🧹 Purge Old Trash Now," a real
  action.
- **#8 — Poll drafts had no real preview**, just their question echoed as
  plain text. `previewRenderer.js` now renders an actual poll.
- **#9 — "Use" on a template re-ran the whole compose wizard.** Now jumps
  straight to the preview/finish screen.
- **#10 — Folder name text input hardened**, full session reset instead of
  in-place mutation, empty names rejected with a re-prompt instead of
  silently creating a blank folder.
- **#11 — Version rollback didn't restore `channel_ids`/`media_type`.**
  Fixed — rollback now restores every field a version snapshot covers.
- **#12 — `updateWithVersion()` required every caller to manually
  `JSON.stringify()` JSONB fields.** Centralized in `savedItems.js`.
- **Related, found during this pass:**
  - `sceneRouter.js` swallowed text/media silently (no `next()`) whenever
    the active scene had no `handleText`/`handleMedia` — affected
    Scheduled/History/Templates.
  - `folders.js`: "🔀 Move to another folder" button had no handler at all.
    Implemented for real.
  - Reschedule (`create-post`, `edit-post`) now rejects past date/times
    instead of silently scheduling something that already passed.

### Added
- 📚 Media Library browser in New Post — media you actually send gets
  remembered automatically and can be reused without re-uploading.
- Non-blocking duplicate-post warning at the preview step (uses the
  existing `dedupeChecker.js`, previously built but unused).
- "Note" buttons — a button that shows a popup instead of opening a link
  (type `NOTE: ...` instead of a URL when adding a button).
- Poll settings: anonymous/multiple-answers/quiz-mode toggles, applied to
  both the live preview and the real send.
- "📝 Save as Draft" and "🚀 Send & 💾 Save as Template" finish options.
- Channel names (not raw chat IDs) shown in send/schedule confirmations.
- Deeper `/help` — more topics, updated to describe the new flow.

### Known gaps carried over (see README "Known simplifications")
- Recipes (saved settings bundles) still have no compose-time picker UI.
- Auto-repost-on-threshold still has no rule-creation UI.
