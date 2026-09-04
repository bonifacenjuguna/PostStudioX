const { homeReplyKeyboard } = require('../components/navRow');
const { clearSession } = require('../middleware/session');
const emergencyStop = require('../../services/emergencyStop');

async function goHome(ctx, { edit = false } = {}) {
  await clearSession(ctx);
  const text = '🏠 Home — what do you want to do?';
  if (edit && ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text);
    } catch (_) {
      await ctx.reply(text);
    }
  } else {
    await ctx.reply(text, homeReplyKeyboard());
  }
}

async function registerNavHandlers(bot) {
  bot.action('nav:home', async (ctx) => {
    await ctx.answerCbQuery();
    await goHome(ctx, { edit: true });
    await ctx.reply('Use the buttons below to navigate.', homeReplyKeyboard());
  });

  bot.action('nav:cancel', async (ctx) => {
    await ctx.answerCbQuery('Cancelled');
    await clearSession(ctx);
    try {
      await ctx.editMessageText('❌ Cancelled.');
    } catch (_) { /* message may be non-editable, ignore */ }
    await ctx.reply('Back to Home.', homeReplyKeyboard());
  });

  bot.action('nav:noop', async (ctx) => {
    await ctx.answerCbQuery();
  });

  bot.action('nav:emergency_stop', async (ctx) => {
    await ctx.answerCbQuery('Stopping everything...');
    await emergencyStop.activate();
    await clearSession(ctx);
    await ctx.reply(
      '🛑 Emergency Stop activated.\n\nAll scheduled posts, auto-deletes, and auto-reposts are paused.\nResume from ⚙️ Settings → 🛡 Watchdog when ready.',
      homeReplyKeyboard()
    );
  });
}

module.exports = { registerNavHandlers, goHome };
