const { homeReplyKeyboard } = require('../components/navRow');
const { clearSession } = require('../middleware/session');

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

  // v1.1.0 enhancement: "note" buttons on posts (see buttonBuilder.js) -
  // tapping shows the note text as a popup instead of opening a link.
  bot.action(/^note:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery(ctx.match[1], { show_alert: true });
  });
}

module.exports = { registerNavHandlers, goHome };
