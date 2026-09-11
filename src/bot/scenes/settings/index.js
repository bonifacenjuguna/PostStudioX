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

  if (step === 'awaiting_autodelete_custom') {
    const { parseDurationMinutes } = require('../../../services/naturalTime');
    const { minutes, error } = parseDurationMinutes(ctx.message.text);
    if (error) return ctx.reply(error);
    await settingsModel.set('auto_delete_defaults', { enabled: true, ttl_minutes: minutes });
    ctx.session.step = null;
    await showAutoDeletePanel(ctx);
  }
}

async function registerHandlers(bot) {
  bot.action('set:list', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText('⚙️ Settings & System Status', menuKeyboard()); } catch (_) { await enter(ctx); }
  });

  bot.action('set:defaults', async (ctx) => {
    await ctx.answerCbQuery();
    await showDefaultsPanel(ctx);
  });

  bot.action(/^set:toggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCbQuery('Toggled');
    const defaults = await settingsModel.get('defaults', {});
    defaults[key] = !defaults[key];
    await settingsModel.set('defaults', defaults);
    await showDefaultsPanel(ctx, { edit: true });
  });

  bot.action('set:defaultchannels', async (ctx) => {
    await ctx.answerCbQuery();
    await showDefaultChannelsPanel(ctx);
  });

  bot.action(/^set:defaultchtoggle:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const defaults = await settingsModel.get('defaults', {});
    const selected = new Set(defaults.default_channel_ids || []);
    if (selected.has(chatId)) selected.delete(chatId); else selected.add(chatId);
    defaults.default_channel_ids = Array.from(selected);
    await settingsModel.set('defaults', defaults);
    await showDefaultChannelsPanel(ctx, { edit: true });
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
    await showButtonStylePanel(ctx);
  });

  bot.action(/^set:btnstyleset:(.+)$/, async (ctx) => {
    const style = ctx.match[1];
    await ctx.answerCbQuery('Saved');
    const defaults = await settingsModel.get('defaults', {});
    defaults.button_style = style;
    await settingsModel.set('defaults', defaults);
    await showButtonStylePanel(ctx, { edit: true });
  });

  bot.action('set:autodelete', async (ctx) => {
    await ctx.answerCbQuery();
    await showAutoDeletePanel(ctx);
  });

  bot.action(/^set:autodeleteset:(\d+)$/, async (ctx) => {
    const minutes = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Saved');
    await settingsModel.set('auto_delete_defaults', { enabled: minutes > 0, ttl_minutes: minutes || null });
    await showAutoDeletePanel(ctx, { edit: true });
  });

  bot.action('set:autodeletecustom', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_autodelete_custom';
    await ctx.reply('Type a duration, e.g. "45m", "2h", "3 days":', Markup.inlineKeyboard([backHomeRow('set:autodelete')]));
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
    const channelsModel = require('../../../db/models/channels');
    const [channels, sentCount, scheduledCount, templateCount] = await Promise.all([
      channelsModel.list(),
      savedItems.countByKind('post', 'sent'),
      savedItems.countByKind('post', 'scheduled'),
      savedItems.countByKind('template'),
    ]);
    const text =
      `ℹ️ About PostStudioX\n\n` +
      `Version: v${config.botVersion}\n` +
      `Environment: ${config.nodeEnv}\n\n` +
      `📊 YOUR USAGE\n` +
      `📡 Channels connected: ${channels.length}\n` +
      `🟢 Posts sent: ${sentCount}\n` +
      `🕐 Currently scheduled: ${scheduledCount}\n` +
      `🗂 Templates saved: ${templateCount}\n\n` +
      `✨ FEATURES IN THIS VERSION\n` +
      `Full formatting (bold, italic, blockquotes, expandable quotes, custom emoji, links, colored buttons) · ` +
      `Loop Mode · Import via forward/link · Replace Links · Protect Content · Custom post signatures · ` +
      `Natural-language scheduling · Structured error reporting`;
    await ctx.reply(text, Markup.inlineKeyboard([
      [Markup.button.callback('💽 Storage Details', 'set:storage')],
      backHomeRow('set:list'),
    ]));
  });
}

async function showDefaultsPanel(ctx, { edit = false } = {}) {
  const defaults = await settingsModel.get('defaults', {});
  const text =
    `🎛 Defaults\n\n` +
    'Applied automatically to every new post in 🎨 Compose, so you don\'t have to set them each time - still overridable per post.\n\n' +
    `🔒 Protect content (block forward/save): ${defaults.protect_content ? 'ON' : 'OFF'}\n` +
    `🔕 Silent send (no notification sound): ${defaults.disable_notification ? 'ON' : 'OFF'}\n` +
    `🚫 Strip links automatically: ${defaults.strip_links ? 'ON' : 'OFF'}\n` +
    `📡 Default channels pre-selected: ${defaults.default_channel_ids?.length ? defaults.default_channel_ids.length : 'none'}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`${defaults.protect_content ? '✅' : '⬜'} Protect Content`, 'set:toggle:protect_content')],
    [Markup.button.callback(`${defaults.disable_notification ? '✅' : '⬜'} Silent Send`, 'set:toggle:disable_notification')],
    [Markup.button.callback(`${defaults.strip_links ? '✅' : '⬜'} Strip Links`, 'set:toggle:strip_links')],
    [Markup.button.callback('📡 Choose Default Channels', 'set:defaultchannels')],
    backHomeRow('set:list'),
  ]);
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
}

async function showDefaultChannelsPanel(ctx, { edit = false } = {}) {
  const channelsModel = require('../../../db/models/channels');
  const channels = await channelsModel.list();
  if (channels.length === 0) {
    return ctx.reply('No channels registered yet — add one from 📡 Channels first.', Markup.inlineKeyboard([backHomeRow('set:defaults')]));
  }
  const defaults = await settingsModel.get('defaults', {});
  const selected = new Set(defaults.default_channel_ids || []);
  const rows = channels.map((c) => [
    Markup.button.callback(`${selected.has(c.chat_id) ? '✅' : '⬜'} ${c.title || c.chat_id}`, `set:defaultchtoggle:${c.chat_id}`),
  ]);
  rows.push(backHomeRow('set:defaults'));
  const text = 'Pre-select these channels every time you start 🎨 Compose (tap to toggle — still changeable per post):';
  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
}

function styleLabel(style) {
  return { primary: '🔵 Primary', danger: '🔴 Danger', success: '🟢 Success' }[style] || '⚪ Default (no color)';
}

async function showButtonStylePanel(ctx, { edit = false } = {}) {
  const defaults = await settingsModel.get('defaults', {});
  const current = defaults.button_style || 'default';
  const text =
    `🎨 Button Style Defaults\n\n` +
    `Current default: ${styleLabel(current)}\n\n` +
    'This is the color new buttons in 🎨 Compose start with (Bot API 9.4\'s button color feature) - ' +
    'still changeable per button when you build a post, this just sets the starting pick so you don\'t re-tap it every time.';
  const rows = ['primary', 'danger', 'success', 'default'].map((s) => [
    Markup.button.callback(`${current === s ? '✅ ' : ''}${styleLabel(s)}`, `set:btnstyleset:${s}`),
  ]);
  rows.push(backHomeRow('set:list'));
  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
}

async function showAutoDeletePanel(ctx, { edit = false } = {}) {
  const ad = await settingsModel.get('auto_delete_defaults', {});
  const currentLabel = ad.enabled && ad.ttl_minutes
    ? (ad.ttl_minutes < 60 ? `${ad.ttl_minutes} min` : ad.ttl_minutes < 1440 ? `${(ad.ttl_minutes / 60).toFixed(1)} hr` : `${(ad.ttl_minutes / 1440).toFixed(1)} day(s)`)
    : 'Off';
  const text =
    `🗑 Auto-delete Defaults\n\n` +
    `Current default: ${currentLabel}\n\n` +
    'New posts in 🎨 Compose start with this auto-delete timer already set (still adjustable per post). ' +
    'Doesn\'t affect 🔁 Loop Mode posts - those manage their own delete timing per-post.';
  const presets = [[0, 'Off'], [10, '10 min'], [60, '1 hr'], [1440, '24 hr'], [10080, '1 week']];
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(presets.slice(i, i + 2).map(([mins, label]) => Markup.button.callback(`${(ad.enabled ? ad.ttl_minutes : 0) === mins ? '✅ ' : ''}${label}`, `set:autodeleteset:${mins}`)));
  }
  rows.push([Markup.button.callback('⌨️ Custom Duration', 'set:autodeletecustom')]);
  rows.push(backHomeRow('set:list'));
  const keyboard = Markup.inlineKeyboard(rows);
  if (edit) {
    try { return await ctx.editMessageText(text, keyboard); } catch (_) { /* fall through */ }
  }
  return ctx.reply(text, keyboard);
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
