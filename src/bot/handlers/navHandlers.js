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

async function triggerEmergencyStop(ctx) {
  await emergencyStop.activate();
  await clearSession(ctx);
  await ctx.reply(
    '🛑 Emergency Stop activated.\n\nAll scheduled posts, auto-deletes, and auto-reposts are paused.\nResume from ⚙️ Settings → 🛡 Watchdog when ready.',
    homeReplyKeyboard()
  );
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
    await triggerEmergencyStop(ctx);
  });

  // v1.1.0 (#6): the persistent reply-keyboard version of Emergency Stop -
  // always visible regardless of navigation depth, unlike the inline
  // button variant above which only exists on screens that attach it.
  // v1.1.0 enhancement: "note" buttons on posts (see buttonBuilder.js) -
  // tapping shows the note text as a popup instead of opening a link.
  bot.action(/^note:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery(ctx.match[1], { show_alert: true });
  });

  bot.hears('🛑 STOP ALL', async (ctx) => {
    await triggerEmergencyStop(ctx);
  });
}

module.exports = { registerNavHandlers, goHome, triggerEmergencyStop };
