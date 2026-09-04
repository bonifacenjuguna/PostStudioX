const express = require('express');
const config = require('./config/env');
const { buildBot } = require('./bot');
const { runMigrations } = require('./db/migrate');
const { getRedis } = require('./queue/redisClient');

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

  app.post(secretPath, (req, res) => {
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
    getRedis().set('webhook:last_update_at', Date.now().toString()).catch(() => {});
    bot.handleUpdate(req.body, res);
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
