const { Markup } = require('telegraf');
const config = require('../../config/env');
const db = require('../../db/pool');
const { getRedis } = require('../../queue/redisClient');
const channelsModel = require('../../db/models/channels');
const watchdogLog = require('../../db/models/watchdogLog');
const emergencyStop = require('../../services/emergencyStop');
const { scheduledPostQueue, autoDeleteQueue } = require('../../queue/queues');
const settingsModel = require('../../db/models/settings');

const START_TIME = Date.now();

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

async function buildStatusText() {
  const lines = ['⚙️ Bot Status', ''];

  lines.push('👤 ACCESS');
  lines.push(`└ Owner: linked ✅`);
  lines.push(`└ Mode: ${config.nodeEnv}`);
  lines.push('');

  lines.push('📡 CHANNELS');
  try {
    const channels = await channelsModel.list();
    const issues = channels.filter((c) => !c.is_admin).length;
    lines.push(`└ Registered: ${channels.length}`);
    lines.push(`└ Admin OK: ${channels.length - issues} · Issues: ${issues}`);
  } catch (err) {
    lines.push(`└ 🔴 Error reading channels: ${err.message}`);
  }
  lines.push('');

  lines.push('🗄 DATABASE');
  try {
    const ms = await db.healthCheck();
    lines.push(`└ PostgreSQL: 🟢 Connected (${ms}ms)`);
  } catch (err) {
    lines.push(`└ PostgreSQL: 🔴 ${err.message}`);
  }
  try {
    const start = Date.now();
    await getRedis().ping();
    lines.push(`└ Redis: 🟢 Connected (${Date.now() - start}ms)`);
  } catch (err) {
    lines.push(`└ Redis: 🔴 ${err.message}`);
  }
  lines.push('');

  lines.push('📬 TELEGRAM API');
  try {
    const lastUpdate = await getRedis().get('webhook:last_update_at');
    if (lastUpdate) {
      const secondsAgo = Math.floor((Date.now() - parseInt(lastUpdate, 10)) / 1000);
      lines.push(`└ Webhook: 🟢 Live (last update ${secondsAgo}s ago)`);
    } else {
      lines.push('└ Webhook: 🟡 No updates received yet this run');
    }
  } catch (_) {
    lines.push('└ Webhook: ⚪ Unknown');
  }
  lines.push('');

  lines.push('👁 STATS MONITOR');
  try {
    const sessionOk = await getRedis().get('gramjs:session_valid');
    const lastPoll = await getRedis().get('gramjs:last_poll_at');
    lines.push(`└ GramJS session: ${sessionOk === '1' ? '🟢 Valid' : sessionOk === '0' ? '🔴 Invalid/expired' : '⚪ Not configured'}`);
    if (lastPoll) {
      const minutesAgo = Math.floor((Date.now() - parseInt(lastPoll, 10)) / 60000);
      lines.push(`└ Last views poll: ${minutesAgo}m ago`);
    } else {
      lines.push('└ Last views poll: never');
    }
  } catch (_) {
    lines.push('└ ⚪ Unknown');
  }
  lines.push('');

  lines.push('⏰ QUEUE (BullMQ)');
  try {
    const scheduledCounts = await scheduledPostQueue.getJobCounts('waiting', 'delayed', 'failed');
    const deleteCounts = await autoDeleteQueue.getJobCounts('waiting', 'delayed', 'failed');
    lines.push(`└ Scheduled pending: ${(scheduledCounts.waiting || 0) + (scheduledCounts.delayed || 0)}`);
    lines.push(`└ Auto-deletes pending: ${(deleteCounts.waiting || 0) + (deleteCounts.delayed || 0)}`);
    lines.push(`└ Failed (scheduled queue): ${scheduledCounts.failed || 0}`);
  } catch (err) {
    lines.push(`└ 🔴 Error reading queue: ${err.message}`);
  }
  lines.push('');

  lines.push('🛡 WATCHDOG');
  try {
    const paused = await settingsModel.get('watchdog_paused', false);
    const stopActive = await emergencyStop.isActive();
    const recent = await watchdogLog.listRecent({ limit: 1 });
    lines.push(`└ Status: ${stopActive ? '🛑 Emergency Stop active' : paused ? '⏸ Paused' : '🟢 Active'}`);
    if (recent.length > 0) {
      const r = recent[0];
      const minutesAgo = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 60000);
      lines.push(`└ Last event: ${minutesAgo}m ago (${r.category}${r.self_healed ? ', self-healed' : ''})`);
    } else {
      lines.push('└ Last event: none recorded');
    }
  } catch (err) {
    lines.push(`└ 🔴 Error: ${err.message}`);
  }
  lines.push('');

  lines.push('💻 SYSTEM');
  const mem = process.memoryUsage();
  lines.push(`└ Uptime: ${fmtUptime(Date.now() - START_TIME)}`);
  lines.push('└ Host: Railway');
  lines.push(`└ Memory: ${Math.round(mem.rss / 1024 / 1024)}MB`);
  lines.push(`└ Bot version: v${config.botVersion}`);
  lines.push(`└ Env: ${config.nodeEnv}`);

  return lines.join('\n');
}

async function statusCommand(ctx) {
  const text = await buildStatusText();
  await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Status', 'status:refresh')]]));
}

async function registerStatusHandlers(bot) {
  bot.action('status:refresh', async (ctx) => {
    await ctx.answerCbQuery('Refreshed');
    const text = await buildStatusText();
    try {
      await ctx.editMessageText(text, Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh Status', 'status:refresh')]]));
    } catch (err) {
      // "message is not modified" is expected if nothing changed - safe to ignore.
      if (!err.message?.includes('not modified')) throw err;
    }
  });
}

module.exports = { statusCommand, registerStatusHandlers, buildStatusText };
