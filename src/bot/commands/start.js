const { homeReplyKeyboard } = require('../components/navRow');
const { clearSession } = require('../middleware/session');

async function startCommand(ctx) {
  await clearSession(ctx);
  await ctx.reply(
    "👋 Welcome back to PostStudioX. I'm your personal posting assistant.\n\n" +
    'Everything is done via buttons below — only /start, /help, and /status are typed commands.',
    homeReplyKeyboard()
  );
}

module.exports = { startCommand };
