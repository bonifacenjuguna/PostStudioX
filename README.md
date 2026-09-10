# PostStudioX

@PostStudioXBot — an owner-only Telegram bot for composing, formatting,
scheduling, and managing posts to your Telegram channels — built with
Telegraf, PostgreSQL, Redis/BullMQ, and GramJS, designed to run on Railway.

Only you (the configured `OWNER_ID`) can use this bot. Every other user is
silently ignored.

---

## Architecture — 4 separate processes

This project runs as **four independent processes**, each its own Railway
service, all deployed from this same repo/Dockerfile with a different
**Custom Start Command** per service. This is deliberate: if the stats
monitor or a stuck job crashes something, it doesn't take the whole bot down
with it, and the watchdog keeps reporting even if the main bot process dies.

| Service | Start command | What it does |
|---|---|---|
| **bot** | `node src/index.js` | Webhook server + all Telegram interaction |
| **worker** | `node src/queue/worker.js` | Processes scheduled sends, auto-deletes, auto-reposts |
| **watchdog** | `node src/watchdog/index.js` | Monitors health, self-heals routine issues, DMs you for judgment calls |
| **gramjs-monitor** | `node src/gramjs-monitor/index.js` | Polls exact view counts (optional — bot works without it) |

All four share the same `DATABASE_URL` and `REDIS_URL`.

---

## Setup

### 1. Create the bot
Talk to [@BotFather](https://t.me/BotFather), create a bot, grab the token.

### 2. Get your numeric Telegram user ID
Message [@userinfobot](https://t.me/userinfobot) — it replies with your ID.
This is your `OWNER_ID`.

### 3. Deploy to Railway
- Push this repo to GitHub, create a new Railway project from it.
- Add a **PostgreSQL** and a **Redis** plugin to the project — Railway
  auto-populates `DATABASE_URL` and `REDIS_URL` for services in the same
  project.
- Create **four services** from this same repo (Railway lets you deploy the
  same repo multiple times with different start commands). Set each
  service's **Custom Start Command** per the table above.
- Copy `.env.example` → fill in real values → paste into each service's
  Railway environment variables (all four need `BOT_TOKEN`, `OWNER_ID`,
  `DATABASE_URL`, `REDIS_URL`; only the `bot` service needs `WEBHOOK_URL` /
  `WEBHOOK_SECRET_TOKEN` / `PORT`).
- Generate `WEBHOOK_SECRET_TOKEN` yourself: `openssl rand -hex 32`.
- `WEBHOOK_URL` is your **bot** service's public Railway URL, e.g.
  `https://your-bot.up.railway.app` (no trailing slash, no path).

### 3b. Pre-filling variables for future fresh deployments
`BOT_VERSION` no longer needs to be set anywhere — it's read straight from
`package.json` at boot, so it can never go stale on Railway again.

For everything else, Railway won't auto-fill secrets into a brand-new
service (that's deliberate — they're secrets), but you can get most of the
way there so a fresh deploy only needs a couple of blanks filled in:

- **Project-level "Shared Variables"** (Railway dashboard → your project →
  Settings → Shared Variables): put anything that's the *same* across all
  four services and isn't secret here — `NODE_ENV`, `DEFAULT_TIMEZONE`,
  the `WATCHDOG_*` thresholds. Any service (existing or newly created) in
  the project can then reference them (`${{shared.NODE_ENV}}` etc. via the
  Raw Editor, or just tick "use shared" in the UI) instead of you retyping
  them per service.
- **`DATABASE_URL` / `REDIS_URL`** are already auto-populated for any
  service in the project once the Postgres/Redis plugins are attached —
  nothing to do here, this already works today.
- **True per-deploy secrets** (`BOT_TOKEN`, `OWNER_ID`, `WEBHOOK_URL`,
  `WEBHOOK_SECRET_TOKEN`, `TELEGRAM_API_ID/HASH`, `GRAMJS_SESSION_STRING`,
  `GRAMJS_ENCRYPTION_KEY`) still need to be entered by hand on a fresh
  deploy — there's no safe way to bake real secrets into the repo, but
  each service's **Variables → Raw Editor** lets you paste all of them for
  that service in one go instead of one field at a time. `.env.example` in
  this repo is written to be pasted straight into that Raw Editor as your
  starting template.

### 4. (Optional) Enable exact view-count tracking
View counts require a real Telegram **user account** logged in via MTProto
(GramJS) — the regular Bot API has no endpoint for this. Reactions work
without this step; only precise view numbers need it.

1. Get `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from https://my.telegram.org
2. Run **locally** (not on Railway — it needs an interactive terminal):
   ```
   npm install
   TELEGRAM_API_ID=xxx TELEGRAM_API_HASH=xxx npm run gramjs-login
   ```
3. Follow the prompts (phone number, login code, 2FA if enabled).
4. Copy the printed session string into `GRAMJS_SESSION_STRING` on the
   `gramjs-monitor` (and ideally `watchdog`) Railway services.

This session string is equivalent to a login credential for that Telegram
account — treat it like a password. If it ever gets logged out/revoked,
`/status` and the watchdog will flag it; re-run the login script to refresh.

### 5. First run
On boot, the `bot` service automatically runs database migrations before
accepting any webhook traffic, registers `/start`, `/help`, `/status` as
visible commands, and sets the Telegram webhook. Message your bot with
`/start` to confirm it's alive.

---

## Command surface

Only **three commands are visible** in Telegram's command menu:
- `/start` — opens the main menu
- `/help` — FAQ hub
- `/status` — live system status

One hidden command exists — **`/reset`** — a destructive-actions center. It
does **not** appear in any menu or in `/help`; it only works if you type it
directly. Use with care.

Everything else — composing posts, managing channels, templates, folders,
scheduling, settings — is entirely button-driven (reply keyboard + inline
buttons), by design.

---

## Key design decisions worth knowing

- **Formatting is stored as Telegram message entities** (offset/length/type),
  not raw Markdown strings. A lightweight shorthand (`**bold**`, `__italic__`,
  `[text](url)`, etc.) is parsed into entities at input time. This is what
  makes link replacement/stripping and caption editing simple — it's an
  array operation, not a re-parse of escaped Markdown.
- **Posts, templates, and recipes share one table** (`saved_items`), with a
  `kind` column as a UI hint. A "template" is conceptually just a saved post
  reused for its format — this mirrors the product decision made during
  design rather than maintaining two parallel schemas.
- **Every edit versions the row** (`post_versions` table) before applying
  the change, enabling rollback from History → any post → 🕓 Version
  History.
- **BullMQ job history is capped** (`removeOnComplete`/`removeOnFail` limits)
  deliberately, since unbounded job history in Redis is a known slow
  memory-creep cause — relevant given Railway's free tier 512MB ceiling.
- **The watchdog never polls Telegram updates** (`bot.launch()`) — only the
  main `bot` service holds the webhook. The watchdog only ever calls
  `bot.telegram.sendMessage(...)` for alerts; the resulting button taps are
  handled back in the main bot process (`src/bot/handlers/
  watchdogAlertHandlers.js`), since a bot token can only have one active
  update target (webhook *or* long-polling) at a time.
- **Webhook requests are verified** via the `X-Telegram-Bot-Api-Secret-Token`
  header against `WEBHOOK_SECRET_TOKEN` — anything else is rejected with 401.

---

## Known simplifications / things to know before relying on this fully

This spec grew very large over the course of design. Everything listed as
"locked in" is implemented and functional, but a few areas are intentionally
lighter-weight than a fully mature version would be — noted here rather than
silently glossed over:

- **Formatting toolbar applies bold/italic/etc. to the whole current caption**,
  not an arbitrary selected substring (Telegram bots have no concept of text
  selection — this is a real platform constraint, not a shortcut). Precise
  per-substring formatting requires typing the shorthand syntax directly
  (`**this part only**`), which *does* work at any position.
- **Recipes** (saved settings bundles independent of content) have schema
  support (`kind = 'recipe'`) and export/import support, but no dedicated
  compose-time UI yet for picking a recipe at the start of New Post.
- **Auto-repost-on-threshold** (view-count-triggered cross-posting) has a
  working queue processor (`autoRepostQueue`/worker) but the rule-creation
  UI (deciding *when* to trigger it) isn't built — currently it'd need to be
  triggered by inserting a job manually or extending the watchdog/stats
  poller to call it based on a rule you define.

As of v1.1.0: duplicate detection is wired into New Post as a non-blocking
warning at the preview step, and the media library now has a real "📚 From
Library" browser in New Post (media you actually send gets remembered there
automatically).

None of the above are bugs — they're the honest edges of a very large scope,
included so you know exactly what's fully wired versus what has the
foundation laid but needs a UI pass.

---

## Two documented risks (not built features — operational awareness)

**Owner/token recovery.** This bot is hardcoded to a single `OWNER_ID` and
`BOT_TOKEN`. If you lose access to your Telegram account, or the bot token
leaks:
- **Rotate a leaked token**: message @BotFather → `/revoke` → generate a new
  token → update `BOT_TOKEN` on the `bot`, `worker`, `watchdog` services →
  redeploy. The old token stops working immediately.
- **Lost Telegram account access**: there is no bot-side recovery for this —
  it depends entirely on Telegram's own account recovery (phone number
  access, linked email if set). Once you regain your account, `OWNER_ID`
  stays the same (it's tied to your Telegram user ID, not the session), so
  the bot works again immediately.

**Spam-policy exposure.** Telegram's rate limits (`429` + `retry_after`) are
handled with proper backoff, but broadcast-style scheduled posting to
multiple channels can, in rare cases, trigger anti-spam heuristics beyond
simple rate limiting (e.g. a quieter shadow-restriction) that don't surface
as a clean error code. The watchdog logs failures by category, so a pattern
of unusual failures across channels (rather than one-off `429`s) is visible
in `/status` and the watchdog log — but this is a genuine platform risk
inherent to this kind of bot, not something fully engineer-able away.

---

## Local development

```bash
npm install
cp .env.example .env   # fill in values
npm run migrate         # apply DB schema
npm start                # runs the bot (needs a public URL for webhooks —
                          # use ngrok or similar for local webhook testing)
```

To test without a public webhook URL, you'd need to adapt `src/index.js` to
use `bot.launch()` (long polling) instead of webhook mode for local dev —
not included by default since production is webhook-based throughout.

---

## Project structure

```
src/
├── bot/            Telegraf bot: commands, scenes, middleware, components
├── db/             Postgres pool, migrations, models
├── queue/          BullMQ queues + worker process
├── services/       Formatting, buttons, link-checking, publishing, etc.
├── watchdog/        Self-healing monitor service
├── gramjs-monitor/  MTProto view-count poller + one-time login script
├── config/          Centralized env var loading
└── index.js         Main webhook server entry point
```
