const channelsModel = require('../../db/models/channels');
const settingsModel = require('../../db/models/settings');
const watchdogLog = require('../../db/models/watchdogLog');
const { scheduledPostQueue } = require('../../queue/queues');

// Handles taps on buttons attached to watchdog alert DMs. The watchdog
// service itself only ever sends messages (via bot.telegram.sendMessage) -
// it never polls for updates - so the resulting button taps arrive here,
// in the one process that owns the webhook.
function registerWatchdogAlertHandlers(bot) {
  bot.action(/^wd:recheck:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Checking...');
    try {
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chatId, me.id);
      const isAdmin = ['administrator', 'creator'].includes(member.status);
      await channelsModel.setAdminStatus(chatId, isAdmin, isAdmin ? null : `status: ${member.status}`);
      await ctx.reply(isAdmin ? '🟢 Admin rights confirmed.' : '🔴 Still not an admin.');
    } catch (err) {
      await ctx.reply(`🔴 Check failed: ${err.message}`);
    }
  });

  bot.action(/^wd:removechannel:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery('Removed');
    await channelsModel.remove(ctx.match[1]);
    await ctx.reply('🗑 Channel removed.');
  });

  bot.action('wd:resumequeue', async (ctx) => {
    await ctx.answerCbQuery('Resumed');
    await scheduledPostQueue.resume();
    await settingsModel.set('watchdog_paused', false);
    await ctx.reply('▶️ Queue resumed.');
  });

  bot.action('wd:viewerrors', async (ctx) => {
    await ctx.answerCbQuery();
    const logs = await watchdogLog.listRecent({ limit: 5 });
    await ctx.reply(logs.map((l) => `[${l.category}] ${l.message}`).join('\n') || 'No recent errors.');
  });
}

module.exports = { registerWatchdogAlertHandlers };
