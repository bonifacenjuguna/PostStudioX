# Changelog

## v2.0.2 — Add Channel actually works now

- **USER_RIGHTS_MISSING on Add Channel, for real this time**: the v2.0.1 fix (adding missing required `ChatAdministratorRights` fields) didn't resolve it on retest. Rather than keep guessing at that field's exact expected shape with no live Telegram connection to verify against, `bot_administrator_rights` has been dropped entirely from the request_chat button. Trade-off: the channel picker no longer shows this bot's needed permissions pre-checked (the "Add Bot to a Channel" feel from the original ask) - but the button itself is now the plain, extremely well-established form that just works. Rights are still checked and shown right after a channel is picked, same as before - that part never depended on the risky field.

## v2.0.1 — first testing-round fixes

Real bugs found by actually testing v2.0.0, fixed:

- **USER_RIGHTS_MISSING on Add Channel**: `ChatAdministratorRights` has required boolean fields (`can_manage_video_chats`, `can_restrict_members`) that were omitted entirely — Telegram rejected the whole request, not just those two rights. Now included explicitly.
- **Native Telegram formatting was silently discarded**: if you used the app's own bold/italic/blockquote toolbar instead of typing this bot's shorthand markers, the formatting never made it into the post — only literal shorthand was ever read. Now real entities on an incoming message are used directly when present.
- **Architectural bug in the formatter**: sequential per-style passes could corrupt each other's entity offsets whenever a message combined more than one format type — this is very likely what caused "some formatting doesn't work" reports (code blocks included). Rewritten as a proper single-pass parser; added a regression test for exactly this case.
- **Caption attached directly to a photo/video/document was being ignored**, and the bot re-asked for it — now read straight off the incoming message when present.
- **No way to turn off the automatic link-preview card** — added a Link Preview toggle in Compose, applied consistently in the live Preview, the real send, and the worker.
- **More live previews**: opening an item in Edit Post, History, or Templates now shows the actual rendered post (real formatting/media), not just a text summary.

## v2.0.0 — the redesign

Ground-up rebuild covering nearly every screen. Highlights:

- **Renamed "New Post" → "Compose"** — same edited-in-place control-panel architecture (kept because it already worked), everything else rebuilt.
- **Natural-language scheduling**: shows your current time in your own timezone, quick-pick buttons (10min/30min/1hr/3hr/tomorrow/week), and free-typed casual input ("friday 6pm", "in 2 hours") — no more typing exact UTC timestamps by hand. Reused in Edit Post's Reschedule too.
- **Loop Mode**: a post can post → stay up → delete → wait a gap → repost, on repeat (infinite or a set number of cycles).
- **Import via forward or link**: bring an existing post into Compose by forwarding it or pasting a t.me link (from a channel the bot manages) — formatting, media, and hyperlinks carry over exactly, since forwarding preserves Telegram's real entity data where copy-paste can't.
- **Replace Links**: swap every link in a post for one new URL in a single action.
- **Full formatting support**: added the previously-missing blockquote implementation, plus expandable_blockquote, custom_emoji, and text_mention. Format buttons now target a specific phrase instead of the whole caption.
- **Channels**: native "pick a channel, rights preselected" add flow, a real Manage Channel hub (mute, remove, rights checklist, custom post signature, Sign Messages toggle).
- **Templates**: merged with the old standalone Folders screen — folder-first browsing, inline folder creation, pick-or-create when saving.
- **History**: 6-per-page, full per-post detail (timestamps, loop/import status), Repost Now, Save as Template, real Clear-one/Clear-all.
- **Scheduled**: separate "Posting Soon" and "Auto-Deleting Soon" sections with live time-remaining, Post Now, Cancel, and outright Delete.
- **Settings**: Defaults/Button Style/Auto-delete sections are no longer cosmetic — found and fixed a bug where Defaults was never actually read anywhere; About now shows live usage stats.
- **Structured error reporting**: every failure now names the scene, the step, what was attempted, and why — logged to a new `action_errors` table — instead of a generic "something went wrong."
- **Fixed a real bug**: stored button colors used `bg_primary`/`bg_danger`/`bg_success`, which don't match Bot API 9.4's actual `primary`/`success`/`danger` values — every colored button would have silently failed before this fix.
- New `smoke-test.js` covering every pure-logic module plus a syntax check across all of `src/`.

## v1.2.2 — rebrand

- Bot is now referred to as **PostStudioX** (@PostStudioXBot) throughout:
  `/start` welcome message, `/help` intro, Settings → About, `README.md`,
  and `package.json`. No functional changes.

## v1.2.1 — batch 3 (bug reports from live use)

### Fixed
- **"🔴 Something went wrong" when sending.** Root cause: after a timed
  "Send Now" actually completed, the code cleared the session with
  `ctx.session = {}` *inside a `setTimeout`* - which runs long after the
  original request already finished and the session middleware already
  saved state to Redis. That assignment was a no-op against real storage,
  so the session stayed stuck on `send_grace_period` indefinitely. Tapping
  any New Post button afterward (especially an old one still sitting in
  the chat) hit a handler that assumed a draft existed, and crashed with a
  raw TypeError trying to read a property off `undefined`. Fixed at the
  root - the timed callback now calls the real `clearSession()` - and
  defensively everywhere else: every New Post action handler, plus
  `handleText`/`handleMedia`, now check the draft actually exists first
  and reply with a clear "this session expired, start a new one" message
  instead of crashing if it doesn't.
- **`/skip` didn't work.** `sceneRouter.js` treated *any* text starting
  with `/` as an escape hatch out of the current flow and never handed it
  to the active scene - so `/skip` during a caption prompt was silently
  dropped before the code that actually understands `/skip` ever saw it.
  Narrowed that escape hatch to the three real global commands
  (`/start`, `/help`, `/status`); everything else, including in-flow
  pseudo-commands like `/skip`, now reaches the scene.
- **Generic error messages were actually hiding the bug.** The global
  error handler said "Something went wrong. The error has been logged."
  with no detail - unhelpful on a single-owner bot where the owner is also
  the one who has to debug it. It now shows the real error message
  directly in the chat reply.

## v1.2.0 — batch 2

### Fixed
- **Emergency Stop was a blind toggle.** Tapping it always called `activate()`
  unconditionally, whether or not it was already active, with no way to see
  current state from the button itself - tapping twice just looked like it
  "did nothing" the second time. It also lived on the persistent reply
  keyboard, visible on every single screen. Moved to exactly one place -
  ⚙️ Settings → 🛡 Watchdog & Emergency Stop - which always shows the real
  current status (🟢 Normal / 🛑 Active) before offering an action, and now
  requires a confirm tap to activate since it pauses everything scheduled.
- **`/reset` removed from the visible `/start` and `/help` text.** The
  command itself is untouched and still fully functional - it was always
  meant to be hidden, the welcome text just hadn't caught up.
- **Timezone setting was a bare text prompt.** Replaced with a real picker:
  16 common zones in a two-column grid plus Sydney, a checkmark on the
  current zone, "⌨️ Type a Zone Name" for anything unlisted, and a working
  12-hour/24-hour display toggle.
- **Most screens only had a "🏠 Home" button, no real "previous screen"
  Back.** Added genuine Back navigation (not just Home) across Channels,
  Templates, History, Scheduled, Folders, and every Settings sub-panel.
  Edit Post's menu now takes an optional `returnTo` so its Back button
  goes to the specific post you were looking at, not just Home.
- **New Post: "Back" during channel-picking/scheduling/naming used to only
  offer "❌ Cancel," which discarded the entire post.** Now "⬅️ Back"
  returns to Preview with the draft fully intact.

### Redesigned
- **New Post flow, top to bottom.** Previously every step sent a new chat
  message - a single post could leave 10-15 messages scattered through the
  chat by the time you were done. The whole wizard now lives in one
  "control panel" message that's edited in place step to step, with a
  "Step X/5 — Name" header throughout so you always know where you are.
  Only the things Telegram itself requires to be real messages (the media
  you send, the actual post preview) appear as themselves; the control
  panel picks back up right after. The finish screen groups Save actions
  and Send actions into clearly separated sections instead of one flat
  button pile.
  - Caught and fixed during this rewrite: an early draft used Markdown
    formatting on the control panel, but channel names and checked URLs
    flowing into it can contain unescaped `*`/`_` and would have broken
    Telegram's parser mid-flow - removed before it shipped.
  - Also caught: "Back to Preview" was initially wired to resend the
    actual preview media every time, which would've spammed duplicate
    photos/polls into the chat on repeated Back taps - split into a
    separate "redraw the panel, don't resend" path.

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
