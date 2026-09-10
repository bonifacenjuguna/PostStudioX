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

function registerNavHandlers(bot, scenes) {
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

  // Lets any screen jump sideways to another section (quickNavRow) without
  // backing out to Home first. This is the same entry logic mainMenu.js
  // uses for the reply-keyboard buttons, just reachable from anywhere.
  bot.action(/^nav:goto:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const scene = scenes[key];
    await ctx.answerCbQuery();
    if (!scene?.enter) {
      await ctx.reply("That section isn't available right now.");
      return;
    }
    ctx.session = { scene: sceneKeyToName(key) };
    await scene.enter(ctx);
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

// scenes object keys are camelCase ("createPost"); ctx.session.scene is
// kebab-case for multi-word scenes ("create-post") to match sceneRouter's
// toCamel() convention. This is the inverse mapping, used only here.
function sceneKeyToName(key) {
  return key.replace(/[A-Z]/g, (l) => `-${l.toLowerCase()}`);
}

module.exports = { registerNavHandlers, goHome };
