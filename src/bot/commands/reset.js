const { Markup } = require('telegraf');
const db = require('../../db/pool');
const settingsModel = require('../../db/models/settings');
const watchdogLog = require('../../db/models/watchdogLog');

function resetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Reset Settings to Defaults', 'reset:settings')],
    [Markup.button.callback('🗑 Clear Templates', 'reset:templates')],
    [Markup.button.callback('🗑 Clear Scheduled Queue', 'reset:scheduled')],
    [Markup.button.callback('🗑 Wipe History', 'reset:history')],
    [Markup.button.callback('☢️ Full Factory Reset', 'reset:factory')],
    [Markup.button.callback('❌ Exit', 'reset:exit')],
  ]);
}

async function resetCommand(ctx) {
  // Not registered via setMyCommands - only reachable if typed directly.
  // Owner-check middleware already applies to this like every other handler.
  await ctx.reply(
    '⚠️ Reset Center\n\nThis is a destructive-actions area, hidden from normal navigation. Choose carefully.',
    resetKeyboard()
  );
}

async function registerResetHandlers(bot) {
  bot.action('reset:exit', async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText('Exited Reset Center. No changes made.'); } catch (_) {}
  });

  bot.action('reset:settings', async (ctx) => {
    await ctx.answerCbQuery();
    await confirmThen(ctx, 'reset all Settings to defaults', async () => {
      await db.query('DELETE FROM settings');
      await settingsModel.set('defaults', { parse_mode: 'entities', protect_content: false, disable_notification: false, button_style: 'default' });
      await settingsModel.set('timezone', 'UTC');
      await settingsModel.set('notifications', { watchdog_silent_logs: true, watchdog_alerts: true, quiet_hours_enabled: false });
      await watchdogLog.record({ level: 'info', category: 'reset', message: 'Settings reset to defaults via /reset' });
    });
  });

  bot.action('reset:templates', async (ctx) => {
    await ctx.answerCbQuery();
    await confirmThen(ctx, 'delete ALL templates', async () => {
      await db.query(`DELETE FROM saved_items WHERE kind = 'template'`);
      await watchdogLog.record({ level: 'info', category: 'reset', message: 'All templates cleared via /reset' });
    });
  });

  bot.action('reset:scheduled', async (ctx) => {
    await ctx.answerCbQuery();
    await confirmThen(ctx, 'clear the entire scheduled queue', async () => {
      const { scheduledPostQueue } = require('../../queue/queues');
      await scheduledPostQueue.drain();
      await db.query(`UPDATE saved_items SET status = 'draft' WHERE status = 'scheduled'`);
      await watchdogLog.record({ level: 'info', category: 'reset', message: 'Scheduled queue cleared via /reset' });
    });
  });

  bot.action('reset:history', async (ctx) => {
    await ctx.answerCbQuery();
    await confirmThen(ctx, 'wipe History (posts stay live in channels, just untracked)', async () => {
      await db.query(`DELETE FROM saved_items WHERE kind = 'post' AND status IN ('sent','deleted')`);
      await watchdogLog.record({ level: 'info', category: 'reset', message: 'History wiped via /reset' });
    });
  });

  bot.action('reset:factory', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText(
        '☢️ Full Factory Reset\n\nThis deletes EVERYTHING: posts, templates, folders, channels, settings, history, watchdog logs. This cannot be undone.\n\nType CONFIRM to proceed, or tap Cancel.',
        Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'reset:exit')]])
      );
    } catch (_) {}
    ctx.session.awaitingFactoryResetConfirm = true;
  });

  bot.action(/^resetconfirm:(.+)$/, async (ctx) => {
    const token = ctx.match[1];
    const action = pendingActions.get(token);
    await ctx.answerCbQuery();
    if (!action) {
      try { await ctx.editMessageText('This confirmation expired. Nothing was changed.'); } catch (_) {}
      return;
    }
    pendingActions.delete(token);
    try {
      await action();
      await ctx.editMessageText('✅ Done.');
    } catch (err) {
      await ctx.editMessageText(`🔴 Action failed: ${err.message}`);
    }
  });
}

// In-memory map from a one-time confirm token to the action to run. Fine for
// a single-owner bot with no horizontal scaling; the token also carries a
// timestamp so stale/replayed taps past a short window are rejected.
const pendingActions = new Map();

async function confirmThen(ctx, description, action) {
  const token = `${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  pendingActions.set(token, action);
  try {
    await ctx.editMessageText(
      `Are you sure you want to ${description}?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, proceed', `resetconfirm:${token}`)],
        [Markup.button.callback('❌ Cancel', 'reset:exit')],
      ])
    );
  } catch (_) {}
}

async function registerFactoryResetTextHandler(bot) {
  bot.hears(/^CONFIRM$/, async (ctx) => {
    if (!ctx.session?.awaitingFactoryResetConfirm) return;
    ctx.session.awaitingFactoryResetConfirm = false;
    await db.query(`
      TRUNCATE saved_items, post_versions, folders, folder_items, stats,
      watchdog_log, media_library, sessions RESTART IDENTITY CASCADE;
    `);
    await db.query('DELETE FROM channels');
    await db.query('DELETE FROM settings');
    await require('../../db/migrate').runMigrations();
    await ctx.reply('☢️ Full factory reset complete. All data cleared and defaults restored.');
  });
}

module.exports = { resetCommand, registerResetHandlers, registerFactoryResetTextHandler, pendingActions };
