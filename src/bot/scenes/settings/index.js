const { Markup } = require('telegraf');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');
const savedItems = require('../../../db/models/savedItems');
const watchdogLog = require('../../../db/models/watchdogLog');
const emergencyStop = require('../../../services/emergencyStop');
const exportImport = require('../../../services/exportImport');
const db = require('../../../db/pool');
const { safeRedis } = require('../../../queue/redisClient');
const { subScreenReplyKeyboard, backHomeRow } = require('../../components/navRow');

// v1.2.0: Emergency Stop no longer gets its own row wrapped around every
// menu (withEmergencyStop) - it lives in exactly one place, the Watchdog
// panel below, per feedback that having it "everywhere" made it unclear
// whether it was already on or off.
function menuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎛 Defaults', 'set:defaults')],
    [Markup.button.callback('🕐 Timezone', 'set:timezone')],
    [Markup.button.callback('🔔 Notifications', 'set:notifications')],
    [Markup.button.callback('🎨 Button Style Defaults', 'set:buttonstyle')],
    [Markup.button.callback('🗑 Auto-delete Defaults', 'set:autodelete')],
    [Markup.button.callback('💽 Storage', 'set:storage')],
    [Markup.button.callback('🛡 Watchdog & Emergency Stop', 'set:watchdog')],
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

// --- Timezone picker ------------------------------------------------------

const TIMEZONES = [
  ['UTC', 'UTC'], ['New York', 'America/New_York'],
  ['Chicago', 'America/Chicago'], ['Denver', 'America/Denver'],
  ['Los Angeles', 'America/Los_Angeles'], ['São Paulo', 'America/Sao_Paulo'],
  ['London', 'Europe/London'], ['Berlin', 'Europe/Berlin'],
  ['Moscow', 'Europe/Moscow'], ['Lagos', 'Africa/Lagos'],
  ['Nairobi', 'Africa/Nairobi'], ['Cairo', 'Africa/Cairo'],
  ['Dubai', 'Asia/Dubai'], ['Mumbai/Delhi', 'Asia/Kolkata'],
  ['Shanghai', 'Asia/Shanghai'], ['Tokyo', 'Asia/Tokyo'],
];

async function timezonePanelText() {
  const tz = await settingsModel.get('timezone', 'UTC');
  const clockFormat = await settingsModel.get('clock_format', '24');
  const now = DateTime.now().setZone(tz);
  const nowStr = now.toFormat(clockFormat === '12' ? 'd MMM yyyy, h:mm a' : 'd MMM yyyy, HH:mm');
  return (
    `🌍 Timezone\n\n` +
    `Current: ${tz}\n` +
    `Right now there: ${nowStr}\n` +
    `Clock format: ${clockFormat === '12' ? '12-hour' : '24-hour'}\n\n` +
    `Used by ⏰ Scheduled posts and 🗑 auto-delete timers to understand what you mean by a time — ` +
    `pick a zone below, or send an IANA zone name as text (e.g. Asia/Kolkata) if yours isn't listed.`
  );
}

async function timezoneKeyboard() {
  const tz = await settingsModel.get('timezone', 'UTC');
  const clockFormat = await settingsModel.get('clock_format', '24');
  const rows = [];
  for (let i = 0; i < TIMEZONES.length; i += 2) {
    const row = TIMEZONES.slice(i, i + 2).map(([label, iana]) =>
      Markup.button.callback(`${tz === iana ? '✅ ' : ''}${label}`, `set:tz:${iana}`)
    );
    rows.push(row);
  }
  rows.push([Markup.button.callback(`${tz === 'Australia/Sydney' ? '✅ ' : ''}Sydney`, 'set:tz:Australia/Sydney')]);
  rows.push([Markup.button.callback('⌨️ Type a Zone Name', 'set:tz:custom')]);
  rows.push([Markup.button.callback(clockFormat === '24' ? '🕐 Switch to 12-hour' : '🕐 Switch to 24-hour', 'set:tz:toggleformat')]);
  rows.push(backHomeRow('set:list'));
  return Markup.inlineKeyboard(rows);
}

async function showTimezonePanel(ctx, { edit = false } = {}) {
  const text = await timezonePanelText();
  const keyboard = await timezoneKeyboard();
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
}

// --- Handlers --------------------------------------------------------------

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
    await showTimezonePanel(ctx);
  }
}

async function registerHandlers(bot) {
  bot.action('set:list', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText('⚙️ Settings & System Status', menuKeyboard()); } catch (_) { await enter(ctx); }
  });

  bot.action('set:defaults', async (ctx) => {
    await ctx.answerCbQuery();
    const defaults = await settingsModel.get('defaults', {});
    await ctx.reply(
      `🎛 Defaults\n\nProtect content: ${defaults.protect_content ? 'ON' : 'OFF'}\nSilent send: ${defaults.disable_notification ? 'ON' : 'OFF'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Toggle Protect Content`, 'set:toggle:protect_content')],
        [Markup.button.callback(`Toggle Silent Send`, 'set:toggle:disable_notification')],
        backHomeRow('set:list'),
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
    await showTimezonePanel(ctx);
  });

  bot.action(/^set:tz:(.+)$/, async (ctx) => {
    const val = ctx.match[1];
    await ctx.answerCbQuery();
    if (val === 'custom') {
      ctx.session.step = 'awaiting_timezone';
      await ctx.reply('Send an IANA timezone name, e.g. Africa/Nairobi or Asia/Kolkata:');
      return;
    }
    if (val === 'toggleformat') {
      const current = await settingsModel.get('clock_format', '24');
      await settingsModel.set('clock_format', current === '24' ? '12' : '24');
      await showTimezonePanel(ctx, { edit: true });
      return;
    }
    await settingsModel.set('timezone', val);
    await showTimezonePanel(ctx, { edit: true });
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
        backHomeRow('set:list'),
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
      backHomeRow('set:list'),
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
      backHomeRow('set:list'),
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
      [Markup.button.callback('🧹 Purge Old Trash Now', 'set:cleantrash')],
      backHomeRow('set:list'),
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

  bot.action('set:cleantrash', async (ctx) => {
    await ctx.answerCbQuery('Cleaning...');
    const cleanup = await settingsModel.get('cleanup_rules', {});
    const n = await savedItems.purgeOldTrash(cleanup.keep_trash_days || 30);
    await ctx.reply(`🧹 Permanently removed ${n} old trashed post(s).`);
  });

  // v1.2.0: Watchdog & Emergency Stop panel - two separate, clearly
  // labeled concepts that used to be blurred together:
  //   1. Watchdog monitoring (self-healing / alerting) - pause/resume
  //   2. Emergency Stop (pauses the actual send/auto-delete/auto-repost
  //      pipeline) - now lives ONLY here, always shows real current state
  //      before offering an action, and requires a confirm tap to activate
  //      since it affects everything scheduled.
  bot.action('set:watchdog', async (ctx) => {
    await ctx.answerCbQuery();
    await showWatchdogPanel(ctx);
  });

  bot.action('set:togglewatchdog', async (ctx) => {
    await ctx.answerCbQuery('Toggled');
    const paused = await settingsModel.get('watchdog_paused', false);
    await settingsModel.set('watchdog_paused', !paused);
    await showWatchdogPanel(ctx, { edit: true });
  });

  bot.action('set:stopactivate', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      '🛑 Activate Emergency Stop?\n\nThis immediately pauses ALL scheduled posts, auto-deletes, and auto-reposts until you resume it.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, stop everything', 'set:stopactivateconfirm')],
        backHomeRow('set:watchdog'),
      ])
    );
  });

  bot.action('set:stopactivateconfirm', async (ctx) => {
    await ctx.answerCbQuery('Stopping everything...');
    await emergencyStop.activate();
    await showWatchdogPanel(ctx, { edit: true });
  });

  bot.action('set:resumestop', async (ctx) => {
    await ctx.answerCbQuery('Resumed');
    await emergencyStop.deactivate();
    await showWatchdogPanel(ctx, { edit: true });
  });

  bot.action('set:watchdoglog', async (ctx) => {
    await ctx.answerCbQuery();
    const logs = await watchdogLog.listRecent({ limit: 8 });
    if (logs.length === 0) return ctx.reply('No watchdog events recorded yet.', Markup.inlineKeyboard([backHomeRow('set:watchdog')]));
    const lines = logs.map((l) => `${l.level === 'critical' ? '🔴' : l.level === 'warning' ? '🟡' : '⚪'} [${l.category}] ${l.message} (${new Date(l.created_at).toLocaleString()})`);
    await ctx.reply(`📜 Recent Watchdog Events\n\n${lines.join('\n')}`, Markup.inlineKeyboard([backHomeRow('set:watchdog')]));
  });

  bot.action('set:backup', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('💾 Backup/Export', Markup.inlineKeyboard([
      [Markup.button.callback('📤 Export Everything', 'set:export:everything')],
      [Markup.button.callback('📤 Export Templates Only', 'set:export:templates')],
      [Markup.button.callback('📤 Export Settings Only', 'set:export:settings')],
      [Markup.button.callback('📥 Import', 'set:import')],
      backHomeRow('set:list'),
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
    await ctx.reply(`ℹ️ About\n\nPostStudioX (@PostStudioXBot)\nVersion: v${config.botVersion}\nEnvironment: ${config.nodeEnv}`, Markup.inlineKeyboard([backHomeRow('set:list')]));
  });
}

async function showWatchdogPanel(ctx, { edit = false } = {}) {
  const paused = await settingsModel.get('watchdog_paused', false);
  const stopActive = await emergencyStop.isActive();

  const text =
    `🛡 Watchdog & Emergency Stop\n\n` +
    `Watchdog monitoring: ${paused ? '⏸ Paused' : '🟢 Active'}\n` +
    `Emergency Stop: ${stopActive ? '🛑 ACTIVE — sends/deletes/reposts are paused' : '🟢 Normal — nothing is paused'}`;

  const rows = [
    [Markup.button.callback(paused ? '▶️ Resume Watchdog Monitoring' : '⏸ Pause Watchdog Monitoring', 'set:togglewatchdog')],
    stopActive
      ? [Markup.button.callback('▶️ Resume Everything', 'set:resumestop')]
      : [Markup.button.callback('🛑 Activate Emergency Stop', 'set:stopactivate')],
    [Markup.button.callback('📜 Recent Events', 'set:watchdoglog')],
    backHomeRow('set:list'),
  ];

  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
}

async function buildStorageText() {
  const dbSize = await db.query(`SELECT pg_size_pretty(pg_database_size(current_database())) AS size`);
  const tableSizes = await db.query(`
    SELECT relname AS table, pg_size_pretty(pg_total_relation_size(relid)) AS size
    FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 3
  `);
  let redisInfo = 'unknown';
  try {
    const info = await safeRedis.info('memory');
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
