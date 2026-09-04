// Standalone watchdog process. Runs as its own Railway service so it keeps
// reporting even if the main bot process gets OOM-killed or crashes.
// Tiered response: self-heal silently for routine/safe fixes, self-heal +
// notify for consequential-but-recoverable fixes, alert-only for anything
// needing a judgment call. Never takes irreversible action without the
// owner's explicit confirmation via the alert's inline buttons.

const { Telegraf, Markup } = require('telegraf');
const config = require('../config/env');
const db = require('../db/pool');
const { getRedis } = require('../queue/redisClient');
const channelsModel = require('../db/models/channels');
const watchdogLog = require('../db/models/watchdogLog');
const settingsModel = require('../db/models/settings');
const emergencyStop = require('../services/emergencyStop');
const { scheduledPostQueue, autoDeleteQueue } = require('../queue/queues');

const bot = new Telegraf(config.botToken());
const OWNER_ID = config.ownerId();

const recentAlerts = new Map(); // dedupe key -> last alert timestamp

async function alertOwner(text, extraButtons = []) {
  const dedupeKey = text.slice(0, 60);
  const last = recentAlerts.get(dedupeKey);
  const now = Date.now();
  if (last && now - last < 30 * 60 * 1000) return; // don't re-alert the same unresolved issue within 30 min
  recentAlerts.set(dedupeKey, now);

  try {
    const inQuietHours = await isQuietHours();
    if (inQuietHours && !text.startsWith('🚨')) return; // critical alerts (🚨) bypass quiet hours

    await bot.telegram.sendMessage(OWNER_ID, `⚠️ Watchdog Alert\n\n${text}`, extraButtons.length ? Markup.inlineKeyboard(extraButtons) : undefined);
  } catch (err) {
    console.error('[watchdog] Failed to DM owner:', err.message);
  }
}

async function isQuietHours() {
  const notif = await settingsModel.get('notifications', {});
  if (!notif.quiet_hours_enabled) return false;
  const hours = await settingsModel.get('quiet_hours', { start: 23, end: 7 });
  const currentHour = new Date().getHours();
  if (hours.start < hours.end) {
    return currentHour >= hours.start && currentHour < hours.end;
  }
  return currentHour >= hours.start || currentHour < hours.end;
}

async function checkMemory() {
  const mem = process.memoryUsage();
  const rssMb = mem.rss / 1024 / 1024;

  if (rssMb >= config.watchdogMemoryCriticalMb) {
    await selfHealMemory();
    await watchdogLog.record({ level: 'critical', category: 'memory', message: `Memory at ${Math.round(rssMb)}MB (critical threshold ${config.watchdogMemoryCriticalMb}MB)`, selfHealed: true });
    await alertOwner(`🚨 Memory at ${Math.round(rssMb)}MB — auto-cleanup attempted, still high. Consider checking /status.`);
  } else if (rssMb >= config.watchdogMemoryWarnMb) {
    await selfHealMemory();
    await watchdogLog.record({ level: 'warning', category: 'memory', message: `Memory at ${Math.round(rssMb)}MB (warn threshold ${config.watchdogMemoryWarnMb}MB)`, selfHealed: true, resolved: true });
    // Silent - routine self-heal, no owner DM unless it recurs and hits critical.
  }
}

async function selfHealMemory() {
  try {
    await scheduledPostQueue.clean(0, 100, 'completed');
    await autoDeleteQueue.clean(0, 100, 'completed');
    if (global.gc) global.gc();
  } catch (err) {
    console.error('[watchdog] Self-heal memory cleanup failed:', err.message);
  }
}

async function checkDatabase() {
  try {
    await db.healthCheck();
  } catch (err) {
    await watchdogLog.record({ level: 'critical', category: 'db', message: `Postgres unreachable: ${err.message}` });
    await alertOwner(`🚨 Database connection lost: ${err.message}`);
  }
}

async function checkRedis() {
  try {
    await getRedis().ping();
  } catch (err) {
    await watchdogLog.record({ level: 'critical', category: 'redis', message: `Redis unreachable: ${err.message}` });
    await alertOwner(`🚨 Redis connection lost: ${err.message}`);
  }
}

async function checkChannels() {
  const channels = await channelsModel.list();
  const me = await bot.telegram.getMe();
  for (const ch of channels) {
    try {
      const member = await bot.telegram.getChatMember(ch.chat_id, me.id);
      const isAdmin = ['administrator', 'creator'].includes(member.status);
      if (!isAdmin && ch.is_admin) {
        // Just transitioned to broken - pause its scheduled posts and alert.
        await channelsModel.setAdminStatus(ch.chat_id, false, `status: ${member.status}`);
        await watchdogLog.record({ level: 'warning', category: 'channel', message: `Lost admin rights in ${ch.title || ch.chat_id}`, selfHealed: true });
        await alertOwner(
          `📡 ${ch.title || ch.chat_id} lost admin rights.`,
          [
            [Markup.button.callback('🔄 Retry Check', `wd:recheck:${ch.chat_id}`)],
            [Markup.button.callback('🗑 Remove Channel', `wd:removechannel:${ch.chat_id}`)],
          ]
        );
      } else if (isAdmin && !ch.is_admin) {
        await channelsModel.setAdminStatus(ch.chat_id, true, null);
      }
    } catch (err) {
      await channelsModel.setAdminStatus(ch.chat_id, false, err.message);
    }
  }
}

async function checkGramjsSession() {
  const valid = await getRedis().get('gramjs:session_valid');
  if (valid === '0') {
    await alertOwner('👁 Views tracking is down — the GramJS session needs manual re-login. Run `npm run gramjs-login` and update GRAMJS_SESSION_STRING.');
  }
}

async function checkWebhookLiveness() {
  const last = await getRedis().get('webhook:last_update_at');
  if (!last) return; // fresh boot, nothing to compare yet
  const minutesAgo = (Date.now() - parseInt(last, 10)) / 60000;
  if (minutesAgo > 60) {
    // Try to self-heal by re-verifying/re-registering the webhook.
    try {
      const info = await bot.telegram.getWebhookInfo();
      if (!info.url) {
        await bot.telegram.setWebhook(`${config.webhookUrl()}/webhook/${config.webhookSecretToken()}`, {
          secret_token: config.webhookSecretToken(),
          allowed_updates: [
            'message', 'edited_message', 'callback_query', 'channel_post',
            'edited_channel_post', 'message_reaction', 'message_reaction_count',
          ],
        });
        await watchdogLog.record({ level: 'warning', category: 'webhook', message: 'Webhook was unregistered - re-registered automatically.', selfHealed: true });
      }
    } catch (err) {
      await alertOwner(`🚨 Webhook has been silent for over an hour and re-registration failed: ${err.message}`);
    }
  }
}

async function checkFailureSpike() {
  const threshold = config.watchdogAlertThreshold;
  const window = config.watchdogWindowMinutes;
  const failures = await watchdogLog.recentFailures('queue', window);
  if (failures.length >= threshold) {
    const paused = await settingsModel.get('watchdog_paused', false);
    if (!paused) {
      await scheduledPostQueue.pause();
      await settingsModel.set('watchdog_paused', true);
      await watchdogLog.record({ level: 'critical', category: 'queue', message: `${failures.length} failures in ${window}min - queue auto-paused (circuit breaker)`, selfHealed: true });
      await alertOwner(
        `⏸ Queue paused after error spike (${failures.length} failures in ${window}min).`,
        [[Markup.button.callback('▶️ Resume', 'wd:resumequeue')], [Markup.button.callback('🔍 View Errors', 'wd:viewerrors')]]
      );
    }
  }
}

async function runAllChecks() {
  const stopActive = await emergencyStop.isActive();
  const paused = await settingsModel.get('watchdog_paused', false);
  if (stopActive || paused) {
    console.log('[watchdog] Skipping checks - watchdog paused or emergency stop active.');
    return;
  }

  await Promise.allSettled([
    checkMemory(),
    checkDatabase(),
    checkRedis(),
    checkChannels(),
    checkGramjsSession(),
    checkWebhookLiveness(),
    checkFailureSpike(),
  ]);
}

// Judgment-call callback handlers (channel removal, queue resume) for
// watchdog alert buttons live in the MAIN bot process (src/bot/handlers/
// watchdogAlertHandlers.js), not here - a Telegram bot can only have one
// active update target (webhook XOR long-polling) per token, and the main
// bot already owns the webhook. This process only ever calls
// bot.telegram.sendMessage (no bot.launch()), so there's no conflict.

async function runDailyCleanup() {
  try {
    const cleanup = await settingsModel.get('cleanup_rules', {});
    if (cleanup.auto_prune_enabled) {
      const savedItems = require('../db/models/savedItems');
      const versionsPruned = await savedItems.pruneOldVersions(cleanup.keep_versions || 10);
      const logsPruned = await watchdogLog.pruneOld(cleanup.keep_watchdog_days || 30);
      const trashPurged = await savedItems.purgeOldTrash(30);
      if (versionsPruned || logsPruned || trashPurged) {
        await watchdogLog.record({
          level: 'info', category: 'cleanup',
          message: `Auto-cleanup: ${versionsPruned} versions, ${logsPruned} logs, ${trashPurged} trashed items purged.`,
          selfHealed: true, resolved: true,
        });
      }
    } else {
      // Trash purge (30-day retention) runs regardless of the auto-prune
      // toggle, since it's a hard product guarantee, not an optional cleanup.
      const savedItems = require('../db/models/savedItems');
      await savedItems.purgeOldTrash(30);
    }
  } catch (err) {
    console.error('[watchdog] Daily cleanup failed:', err.message);
  }
}

async function start() {
  console.log('[watchdog] Starting watchdog service (alert-sender only, no update polling)...');
  const intervalMs = config.watchdogPollIntervalMinutes * 60 * 1000;
  await runAllChecks();
  setInterval(runAllChecks, intervalMs);
  setInterval(runDailyCleanup, 24 * 60 * 60 * 1000);
  runDailyCleanup();
  console.log(`[watchdog] Running checks every ${config.watchdogPollIntervalMinutes} minute(s).`);
}

start().catch((err) => {
  console.error('[watchdog] Fatal error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => {
  process.exit(0);
});
