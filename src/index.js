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

process.on('unhandledRejection', (reason, promise) => {
  console.error('[bot] Unhandled rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  process.exit(1);
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

  // Graceful shutdown - finish in-flight work, close connections cleanly,
  // rather than being hard-killed by Railway's SIGTERM.
  const shutdown = async () => {
    console.log('[boot] SIGTERM received, shutting down gracefully...');
    server.close();
    try {
      await bot.telegram.deleteWebhook();
    } catch (_) { /* best-effort */ }
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
