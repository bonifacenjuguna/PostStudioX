const { Markup } = require('telegraf');
const { subScreenReplyKeyboard } = require('../components/navRow');

function registerMainMenu(bot, scenes) {
  bot.hears('🎨 Compose', async (ctx) => {
    ctx.session = {};
    await scenes.createPost.enter(ctx);
  });

  bot.hears('✏️ Edit/Replace', async (ctx) => {
    ctx.session = {};
    await ctx.reply(
      '✏️ EDIT/REPLACE A LIVE POST\n\n' +
        'Forward the post here, or send its t.me link (only works for channels this bot manages).\n\n' +
        'You\'ll get the choice to edit it in place, or replace it entirely with a brand-new post.',
      Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'nav:cancel')]])
    );
  });

  bot.hears('🗂 Templates', async (ctx) => {
    ctx.session = { scene: 'templates' };
    await scenes.templates.enter(ctx);
  });

  bot.hears('⏰ Scheduled', async (ctx) => {
    ctx.session = { scene: 'scheduled' };
    await scenes.scheduled.enter(ctx);
  });

  bot.hears('📜 History', async (ctx) => {
    ctx.session = { scene: 'history' };
    await scenes.history.enter(ctx);
  });

  bot.hears('⚙️ Settings', async (ctx) => {
    ctx.session = { scene: 'settings' };
    await scenes.settings.enter(ctx);
  });

  bot.hears('⬅️ Back to Home', async (ctx) => {
    const { goHome } = require('./navHandlers');
    await goHome(ctx);
  });

  bot.hears('❌ Cancel', async (ctx) => {
    const { goHome } = require('./navHandlers');
    await goHome(ctx);
  });

  bot.hears('⬅️ Back', async (ctx) => {
    // Granular step-back within a wizard is handled by each scene's own
    // inline "⬅️ Back" buttons (cp:back:*, etc). The persistent reply-keyboard
    // Back button is a coarser safety net - rather than silently doing
    // nothing when there's no scene-specific handling for it, it always
    // falls back to Home so the button is never a dead end.
    const { goHome } = require('./navHandlers');
    await goHome(ctx);
  });
}

module.exports = { registerMainMenu };
