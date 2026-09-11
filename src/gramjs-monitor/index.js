// Standalone service (separate Railway process) that polls exact view
// counts for channel posts via MTProto (GramJS), since the regular Bot API
// has no endpoint for this. Writes results into the same Postgres `stats`
// table the main bot reads from - it never touches Telegraf/webhook logic.

const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');
const config = require('../config/env');
const statsModel = require('../db/models/stats');
const { safeRedis } = require('../queue/redisClient');
const { drainCommands } = require('../queue/gramjsCommands');

const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min - deliberately not aggressive, per spec caveat
const COMMAND_INTERVAL_MS = 10 * 1000; // owner-triggered actions should feel responsive, unlike view polling

process.on('unhandledRejection', (reason) => {
  console.error('[gramjs-monitor] Unhandled promise rejection:', reason);
});

async function buildClient() {
  if (!config.gramjsApiId || !config.gramjsApiHash || !config.gramjsSessionString) {
    console.warn('[gramjs-monitor] Not configured (missing TELEGRAM_API_ID/HASH or GRAMJS_SESSION_STRING) - views tracking disabled.');
    await safeRedis.set('gramjs:session_valid', '0').catch(() => {});
    return null;
  }

  const client = new TelegramClient(
    new StringSession(config.gramjsSessionString),
    parseInt(config.gramjsApiId, 10),
    config.gramjsApiHash,
    { connectionRetries: 5 }
  );

  try {
    await client.connect();
    const me = await client.getMe();
    console.log(`[gramjs-monitor] Connected as ${me.username || me.id}`);
    await safeRedis.set('gramjs:session_valid', '1');
    return client;
  } catch (err) {
    console.error('[gramjs-monitor] Failed to connect/authenticate:', err.message);
    await safeRedis.set('gramjs:session_valid', '0');
    return null;
  }
}

async function pollViews(client) {
  const tracked = await statsModel.allTrackedRefs();
  if (tracked.length === 0) return;

  // Group by chat so we can batch getMessages per channel.
  const byChat = {};
  for (const row of tracked) {
    byChat[row.chat_id] = byChat[row.chat_id] || [];
    byChat[row.chat_id].push(row.message_id);
  }

  for (const [chatId, messageIds] of Object.entries(byChat)) {
    try {
      const messages = await client.getMessages(chatId, { ids: messageIds });
      for (const msg of messages) {
        if (msg && msg.views !== undefined && msg.views !== null) {
          await statsModel.updateViews(chatId, msg.id, msg.views);
        }
      }
    } catch (err) {
      console.warn(`[gramjs-monitor] Failed polling views for ${chatId}: ${err.message}`);
    }
  }

  await safeRedis.set('gramjs:last_poll_at', Date.now().toString());
}

// Handles cross-process commands from the main bot that need the MTProto
// user session (things the Bot API simply has no endpoint for). Currently
// just Sign Messages, but built as a switch so more can land here later
// without another cross-process plumbing job.
async function processCommands(client) {
  const commands = await drainCommands().catch((err) => {
    console.warn('[gramjs-monitor] Failed draining command queue:', err.message);
    return [];
  });

  for (const cmd of commands) {
    try {
      if (cmd.type === 'toggle_signatures') {
        const channel = await client.getEntity(cmd.chat_id);
        await client.invoke(new Api.channels.ToggleSignatures({ channel, enabled: !!cmd.enabled }));
        console.log(`[gramjs-monitor] Set sign_messages=${cmd.enabled} on ${cmd.chat_id}`);
      } else {
        console.warn(`[gramjs-monitor] Unknown command type: ${cmd.type}`);
      }
    } catch (err) {
      console.error(`[gramjs-monitor] Command "${cmd.type}" failed for ${cmd.chat_id}:`, err.message);
    }
  }
}

async function start() {
  console.log('[gramjs-monitor] Starting views monitor service...');
  const client = await buildClient();
  if (!client) {
    // Keep the process alive but idle, so Railway doesn't treat a missing
    // config as a crash-loop - /status will show "not configured".
    setInterval(() => {}, 60 * 60 * 1000);
    return;
  }

  await pollViews(client);
  setInterval(() => pollViews(client).catch((err) => console.error('[gramjs-monitor] Poll cycle error:', err.message)), POLL_INTERVAL_MS);
  setInterval(() => processCommands(client).catch((err) => console.error('[gramjs-monitor] Command cycle error:', err.message)), COMMAND_INTERVAL_MS);
}

start().catch((err) => {
  console.error('[gramjs-monitor] Fatal error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => process.exit(0));
