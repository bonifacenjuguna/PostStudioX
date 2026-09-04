const { Markup } = require('telegraf');
const settingsModel = require('../../../db/models/settings');
const savedItems = require('../../../db/models/savedItems');
const watchdogLog = require('../../../db/models/watchdogLog');
const emergencyStop = require('../../../services/emergencyStop');
const exportImport = require('../../../services/exportImport');
const db = require('../../../db/pool');
const { getRedis } = require('../../../queue/redisClient');
const { subScreenReplyKeyboard } = require('../../components/navRow');
const fs = require('fs');
const path = require('path');
const os = require('os');

function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎛 Defaults', 'set:defaults')],
    [Markup.button.callback('🕐 Timezone', 'set:timezone')],
    [Markup.button.callback('🔔 Notifications', 'set:notifications')],
    [Markup.button.callback('🎨 Button Style Defaults', 'set:buttonstyle')],
    [Markup.button.callback('🗑 Auto-delete Defaults', 'set:autodelete')],
    [Markup.button.callback('💽 Storage', 'set:storage')],
    [Markup.button.callback('🛡 Watchdog', 'set:watchdog')],
    [Markup.button.callback('💾 Backup/Export', 'set:backup')],
    [Markup.button.callback('ℹ️ About', 'set:about')],
    [Markup.button.callback('🏠 Home', 'nav:home')],
  ]);
}

async function enter(ctx) {
  ctx.session = { scene: 'settings' };
  await ctx.reply('⚙️ Settings & System Status', subScreenReplyKeyboard());
  await ctx.reply('Pick a section:', menuKeyboard());
}

async function handleText(ctx) {
  const step = ctx.session.step;
  if (step === 'awaiting_timezone') {
    const tz = ctx.message.text.trim();
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch (_) {
      return ctx.reply('That doesn\'t look like a valid IANA timezone (e.g. Africa/Nairobi, Europe/London). Try again.');
    }
    await settingsModel.set('timezone', tz);
    ctx.session.step = null;
    await ctx.reply(`🕐 Timezone set to ${tz}.`);
    await enter(ctx);
  }
}

async function registerHandlers(bot) {
  bot.action('set:defaults', async (ctx) => {
    await ctx.answerCbQuery();
    const defaults = await settingsModel.get('defaults', {});
    await ctx.reply(
      `🎛 Defaults\n\nProtect content: ${defaults.protect_content ? 'ON' : 'OFF'}\nSilent send: ${defaults.disable_notification ? 'ON' : 'OFF'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Toggle Protect Content`, 'set:toggle:protect_content')],
        [Markup.button.callback(`Toggle Silent Send`, 'set:toggle:disable_notification')],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action(/^set:toggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCbQuery('Toggled');
    const defaults = await settingsModel.get('defaults', {});
    defaults[key] = !defaults[key];
    await settingsModel.set('defaults', defaults);
    try { await ctx.editMessageText(`✅ ${key} is now ${defaults[key] ? 'ON' : 'OFF'}.`); } catch (_) {}
  });

  bot.action('set:timezone', async (ctx) => {
    await ctx.answerCbQuery();
    const tz = await settingsModel.get('timezone', 'UTC');
    ctx.session.step = 'awaiting_timezone';
    await ctx.reply(`Current timezone: ${tz}\n\nSend a new IANA timezone name (e.g. Africa/Nairobi):`);
  });

  bot.action('set:notifications', async (ctx) => {
    await ctx.answerCbQuery();
    const notif = await settingsModel.get('notifications', {});
    await ctx.reply(
      `🔔 Notifications\n\nWatchdog silent-log DMs muted: ${notif.watchdog_silent_logs ? 'YES' : 'NO'}\nQuiet hours enabled: ${notif.quiet_hours_enabled ? 'YES' : 'NO'}\nClean chat mode: ${notif.clean_chat_mode !== false ? 'ON' : 'OFF'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Toggle Silent-Log Muting', 'set:notiftoggle:watchdog_silent_logs')],
        [Markup.button.callback('Toggle Quiet Hours', 'set:notiftoggle:quiet_hours_enabled')],
        [Markup.button.callback('Toggle Clean Chat Mode', 'set:notiftoggle:clean_chat_mode')],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action(/^set:notiftoggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCbQuery('Toggled');
    const notif = await settingsModel.get('notifications', {});
    notif[key] = key === 'clean_chat_mode' ? !(notif[key] !== false) : !notif[key];
    await settingsModel.set('notifications', notif);
    try { await ctx.editMessageText(`✅ ${key} updated.`); } catch (_) {}
  });

  bot.action('set:buttonstyle', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Pick the default color for new buttons:', Markup.inlineKeyboard([
      [Markup.button.callback('🔵 Primary', 'set:btnstyleset:bg_primary'), Markup.button.callback('🔴 Danger', 'set:btnstyleset:bg_danger')],
      [Markup.button.callback('🟢 Success', 'set:btnstyleset:bg_success'), Markup.button.callback('⚪ Default', 'set:btnstyleset:default')],
    ]));
  });

  bot.action(/^set:btnstyleset:(.+)$/, async (ctx) => {
    const style = ctx.match[1];
    await ctx.answerCbQuery('Saved');
    const defaults = await settingsModel.get('defaults', {});
    defaults.button_style = style;
    await settingsModel.set('defaults', defaults);
    try { await ctx.editMessageText(`✅ Default button style set.`); } catch (_) {}
  });

  bot.action('set:autodelete', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Default auto-delete TTL for new posts:', Markup.inlineKeyboard([
      [Markup.button.callback('Off', 'set:autodeleteset:0'), Markup.button.callback('10 min', 'set:autodeleteset:10')],
      [Markup.button.callback('1 hr', 'set:autodeleteset:60'), Markup.button.callback('24 hr', 'set:autodeleteset:1440')],
    ]));
  });

  bot.action(/^set:autodeleteset:(\d+)$/, async (ctx) => {
    const minutes = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Saved');
    await settingsModel.set('auto_delete_defaults', { enabled: minutes > 0, ttl_minutes: minutes || null });
    try { await ctx.editMessageText(`✅ Default auto-delete set to ${minutes ? minutes + ' min' : 'off'}.`); } catch (_) {}
  });

  bot.action('set:storage', async (ctx) => {
    await ctx.answerCbQuery();
    const text = await buildStorageText();
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback('🧹 Clean Old Versions', 'set:cleanversions')],
      [Markup.button.callback('🧹 Clean Old Watchdog Logs', 'set:cleanlogs')],
      [Markup.button.callback('🧹 Clear Temp Files', 'set:cleantemp')],
      [Markup.button.callback('🏠 Home', 'nav:home')],
    ]));
  });

  bot.action('set:cleanversions', async (ctx) => {
    await ctx.answerCbQuery('Cleaning...');
    const cleanup = await settingsModel.get('cleanup_rules', {});
    const n = await savedItems.pruneOldVersions(cleanup.keep_versions || 10);
    await ctx.reply(`🧹 Removed ${n} old version snapshot(s).`);
  });

  bot.action('set:cleanlogs', async (ctx) => {
    await ctx.answerCbQuery('Cleaning...');
    const cleanup = await settingsModel.get('cleanup_rules', {});
    const n = await watchdogLog.pruneOld(cleanup.keep_watchdog_days || 30);
    await ctx.reply(`🧹 Removed ${n} old watchdog log entries.`);
  });

  bot.action('set:cleantemp', async (ctx) => {
    await ctx.answerCbQuery('Cleaning...');
    const tmpDir = path.join(os.tmpdir(), 'bot-media-cache');
    let count = 0;
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        fs.unlinkSync(path.join(tmpDir, f));
        count += 1;
      }
    }
    await ctx.reply(`🧹 Cleared ${count} temp file(s).`);
  });

  bot.action('set:watchdog', async (ctx) => {
    await ctx.answerCbQuery();
    const paused = await settingsModel.get('watchdog_paused', false);
    const stopActive = await emergencyStop.isActive();
    await ctx.reply(
      `🛡 Watchdog\n\nStatus: ${stopActive ? '🛑 Emergency Stop active' : paused ? '⏸ Paused' : '🟢 Active'}`,
      Markup.inlineKeyboard([
        stopActive
          ? [Markup.button.callback('▶️ Resume Everything', 'set:resumestop')]
          : [Markup.button.callback(paused ? '▶️ Resume Watchdog' : '⏸ Pause Watchdog', 'set:togglewatchdog')],
        [Markup.button.callback('📜 Recent Events', 'set:watchdoglog')],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action('set:resumestop', async (ctx) => {
    await ctx.answerCbQuery('Resumed');
    await emergencyStop.deactivate();
    try { await ctx.editMessageText('▶️ Emergency Stop lifted. Everything resumed.'); } catch (_) {}
  });

  bot.action('set:togglewatchdog', async (ctx) => {
    await ctx.answerCbQuery('Toggled');
    const paused = await settingsModel.get('watchdog_paused', false);
    await settingsModel.set('watchdog_paused', !paused);
    try { await ctx.editMessageText(`🛡 Watchdog is now ${!paused ? 'paused' : 'active'}.`); } catch (_) {}
  });

  bot.action('set:watchdoglog', async (ctx) => {
    await ctx.answerCbQuery();
    const logs = await watchdogLog.listRecent({ limit: 8 });
    if (logs.length === 0) return ctx.reply('No watchdog events recorded yet.');
    const lines = logs.map((l) => `${l.level === 'critical' ? '🔴' : l.level === 'warning' ? '🟡' : '⚪'} [${l.category}] ${l.message} (${new Date(l.created_at).toLocaleString()})`);
    await ctx.reply(`📜 Recent Watchdog Events\n\n${lines.join('\n')}`);
  });

  bot.action('set:backup', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('💾 Backup/Export', Markup.inlineKeyboard([
      [Markup.button.callback('📤 Export Everything', 'set:export:everything')],
      [Markup.button.callback('📤 Export Templates Only', 'set:export:templates')],
      [Markup.button.callback('📤 Export Settings Only', 'set:export:settings')],
      [Markup.button.callback('📥 Import', 'set:import')],
      [Markup.button.callback('🏠 Home', 'nav:home')],
    ]));
  });

  bot.action(/^set:export:(.+)$/, async (ctx) => {
    const scope = ctx.match[1];
    await ctx.answerCbQuery('Exporting...');
    const payload = await exportImport.exportData(scope);
    const buffer = Buffer.from(JSON.stringify(payload, null, 2));
    await ctx.replyWithDocument({ source: buffer, filename: `bot-export-${scope}-${Date.now()}.json` });
  });

  bot.action('set:import', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_import_file';
    await ctx.reply('Send the export JSON file to import.');
  });

  bot.action(/^set:importmode:(.+)$/, async (ctx) => {
    const mode = ctx.match[1];
    await ctx.answerCbQuery('Importing...');
    const payload = ctx.session.importPayload;
    if (!payload) return ctx.reply('Import session expired, please resend the file.');
    const result = await exportImport.importData(payload, { mode });
    delete ctx.session.importPayload;
    ctx.session.step = null;
    await ctx.reply(`✅ Imported: ${result.templates} templates, ${result.settings} settings, ${result.recipes} recipes, ${result.folders} folders.`);
  });

  bot.action('set:about', async (ctx) => {
    await ctx.answerCbQuery();
    const config = require('../../../config/env');
    await ctx.reply(`ℹ️ About\n\nBot version: v${config.botVersion}\nEnvironment: ${config.nodeEnv}`);
  });
}

async function buildStorageText() {
  const dbSize = await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
  const tableSizes = await db.query(`
    SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 3
  `);
  let redisInfo = 'unknown';
  try {
    const info = await getRedis().info('memory');
    const match = info.match(/used_memory_human:(\S+)/);
    redisInfo = match ? match[1] : 'unknown';
  } catch (_) {}

  const lines = ['💽 Storage', '', '📦 Postgres', `└ Total size: ${dbSize.rows[0].size}`];
  for (const t of tableSizes.rows) lines.push(`└ ${t.table}: ${t.size}`);
  lines.push('', '🗂 Redis', `└ Memory used: ${redisInfo}`);
  return lines.join('\n');
}

async function handleDocument(ctx) {
  if (ctx.session.step !== 'awaiting_import_file') return;
  try {
    const file = await ctx.telegram.getFileLink(ctx.message.document.file_id);
    const res = await fetch(file.href || file.toString());
    const payload = await res.json();
    const validation = exportImport.validateImportShape(payload);
    if (!validation.valid) {
      await ctx.reply(`🔴 Invalid file:\n${validation.errors.join('\n')}`);
      return;
    }
    const summary = exportImport.summarize(payload);
    ctx.session.importPayload = payload;
    ctx.session.step = 'awaiting_import_mode';
    await ctx.reply(
      `📥 Import Preview\n• ${summary.templates} templates\n• ${summary.settings} settings\n• ${summary.recipes} recipes\n• ${summary.folders} folders`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Import All (overwrite)', 'set:importmode:overwrite')],
        [Markup.button.callback('🔀 Merge (skip conflicts)', 'set:importmode:merge')],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
  } catch (err) {
    await ctx.reply(`🔴 Couldn't read that file: ${err.message}`);
  }
}

module.exports = { enter, handleText, handleDocument, registerHandlers, buildStorageText };
