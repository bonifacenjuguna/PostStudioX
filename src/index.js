const express = require('express');
const config = require('./config/env');
const { buildBot } = require('./bot');
const { runMigrations } = require('./db/migrate');
const { safeRedis } = require('./queue/redisClient');

// ─────────────────────────────────────────────────────────────────────────
// ROOT CAUSE (v3 - the actual one): `bot.handleUpdate(req.body, res)` below
// used to be called bare - no await, no .catch(). It returns a promise.
//
// Telegram delivers webhook updates to a given bot SEQUENTIALLY: it won't
// send you the next update until the current one gets an HTTP response.
// Any error inside handleUpdate that Telegraf's own internal bot.catch()
// doesn't fully absorb (a Postgres hiccup, a Telegram API error, a bug in
// any scene handler - not just Redis) meant `res` might never get sent.
// That one stuck request was enough to jam Telegram's entire delivery
// queue for this bot - every later message, including a fresh /start,
// would just sit undelivered, which looks exactly like "the bot went
// offline". Worse: an unhandled promise rejection here (nothing in this
// codebase ever caught process-level unhandledRejection) crashes the
// whole Node process outright - which, chained a few times in a row,
// burns through Railway's restart budget and leaves the service well and
// truly down until a manual redeploy resets it.
//
// This was the actual bug behind every round of this issue - earlier
// Redis hardening fixed one possible trigger of it, not the missing
// safety net itself. Fixed below two ways: (1) the webhook handler now
// guarantees a response is always sent and never lets handleUpdate's
// promise go unhandled, and (2) process-level unhandledRejection /
// uncaughtException handlers log loudly instead of silently crashing this
// long-running web service over a single bad update.
// ─────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[boot] Unhandled promise rejection (bot process staying alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[boot] Uncaught exception (bot process staying alive):', err);
});

async function main() {
  console.log(`[boot] Starting bot v${config.botVersion} in ${config.nodeEnv} mode...`);

  // Never accept webhook traffic against a half-migrated schema.
  await runMigrations();

  const bot = buildBot();

  // Only /start, /help, /status show in Telegram's command menu.
  // /reset is intentionally NOT registered here, per spec.
  await bot.telegram.setMyCommands([
    { command: 'start', description: 'Open the main menu' },
    { command: 'help', description: 'Help & FAQ' },
    { command: 'status', description: 'View bot system status' },
  ]);

  // v2.0.3: registers this bot's default admin rights with Telegram once
  // per startup (idempotent - safe to repeat every boot) so channels'
  // request_chat picker and any manual "add as admin" flow both suggest the
  // same rights automatically. Non-blocking: a failure here (e.g. an older
  // Bot API server not yet supporting one of the newer right fields) must
  // never stop the bot from starting.
  const { syncDefaultAdministratorRights } = require('./services/channelPermissions');
  syncDefaultAdministratorRights(bot.telegram)
    .then(() => console.log('[startup] Default administrator rights synced.'))
    .catch((err) => console.warn('[startup] Failed to sync default administrator rights (non-fatal):', err.message));

  const app = express();
  app.use(express.json());

  const secretPath = `/webhook/${config.webhookSecretToken()}`;

  app.post(secretPath, async (req, res) => {
    // Verify Telegram is really the sender - the secret_token configured on
    // setWebhook is echoed back in this header on every real request.
    // Without this check, anyone who discovers the Railway URL could POST
    // fake updates straight into the bot.
    const headerToken = req.get('X-Telegram-Bot-Api-Secret-Token');
    if (headerToken !== config.webhookSecretToken()) {
      console.warn('[webhook] Rejected request with invalid/missing secret token header.');
      return res.status(401).send('Unauthorized');
    }
    // Track webhook liveness for /status - independent of whether the
    // update handling itself succeeds.
    safeRedis.set('webhook:last_update_at', Date.now().toString()).catch(() => {});

    // Always resolve this request, no matter what happens inside. A
    // response Telegram never receives is what jams its delivery queue -
    // so on any failure we still send *something* rather than letting the
    // request (and everything queued behind it) hang.
    try {
      await bot.handleUpdate(req.body, res);
    } catch (err) {
      console.error(`[webhook] handleUpdate failed for update ${req.body?.update_id}:`, err);
    } finally {
      if (!res.headersSent) {
        res.sendStatus(200);
      }
    }
  });

  app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', version: config.botVersion });
  });

  const port = config.port;
  const server = app.listen(port, async () => {
    console.log(`[boot] HTTP server listening on port ${port}`);
    try {
      await bot.telegram.setWebhook(`${config.webhookUrl()}${secretPath}`, {
        secret_token: config.webhookSecretToken(),
        allowed_updates: [
          'message', 'edited_message', 'callback_query', 'channel_post',
          'edited_channel_post', 'message_reaction', 'message_reaction_count',
        ],
      });
      console.log('[boot] Webhook registered with Telegram.');
    } catch (err) {
      console.error('[boot] Failed to register webhook:', err.message);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // ROOT CAUSE (v5 - the real one): everything patched in v3/v4 only runs
  // once a request reaches Express. This one sits a layer below that.
  //
  // Node's http.Server defaults keepAliveTimeout to 5000ms. Railway's edge
  // proxy in front of this service reuses keep-alive connections to us for
  // much longer than that (as basically every L7 proxy does - this is the
  // same well-documented race that hits Node behind AWS ALB, nginx, Caddy,
  // etc: https://shuheikagawa.com/blog/2019/04/25/keep-alive-timeout/).
  // When the proxy forwards Telegram's next webhook POST onto a connection
  // it still considers reusable, right as Node is independently tearing
  // that same socket down for being "idle" past 5s, the request can be
  // dropped before it ever reaches Express - no middleware runs, no route
  // handler runs, so NOTHING we log ever fires. From Telegram's side: sent
  // the update, got nothing back, sequential delivery jams exactly as
  // described. This is why the freeze produced zero application logs no
  // matter how much we hardened the DB/Redis/Telegram-API call sites -
  // this failure happens beneath all of that.
  //
  // Fix: keep our keepAliveTimeout comfortably above the proxy's idle
  // timeout, and headersTimeout above that (Node requires headersTimeout >
  // keepAliveTimeout or it's silently ignored).
  // ─────────────────────────────────────────────────────────────────────
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;

  // ─────────────────────────────────────────────────────────────────────
  // ROOT CAUSE (v6 - confirmed via getWebhookInfo, url was "" with updates
  // stuck in pending_update_count): every previous round patched code that
  // never actually ran. Nothing was hanging - the webhook registration
  // itself was getting wiped out.
  //
  // Railway sends SIGTERM to the OLD container as part of every routine
  // redeploy, after the NEW container is already up and has registered
  // this same webhook URL in its own app.listen callback. This handler
  // used to call bot.telegram.deleteWebhook() on that SIGTERM - which
  // doesn't care which container registered the webhook, it just deletes
  // it. So the sequence on basically every deploy was: new container
  // registers -> old container's shutdown fires -> deleteWebhook() wipes
  // out what the new container just set. Telegram then has nowhere to
  // deliver updates (pending_update_count climbs, url goes empty), no
  // request ever reaches this app again, and there's nothing to log
  // because nothing here ever runs. Only a *second* deploy would
  // temporarily fix it (new registration), until the next SIGTERM deleted
  // it again.
  //
  // The webhook URL doesn't change between deploys - there's no reason to
  // tear it down on a routine restart. deleteWebhook is for an actual
  // decommission (switching to polling, retiring the bot), which never
  // happens in normal operation, so it's simply not called here anymore.
  // ─────────────────────────────────────────────────────────────────────
  const shutdown = async () => {
    console.log('[boot] SIGTERM received, shutting down gracefully...');
    server.close();
    const { closePool } = require('./db/pool');
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[boot] Fatal error during startup:', err);
  process.exit(1);
});
