const { homeReplyKeyboard } = require('../components/navRow');
const { clearSession } = require('../middleware/session');
const channelsModel = require('../../db/models/channels');
const savedItems = require('../../db/models/savedItems');

// v2.0.0 (#10): the old greeting was the same generic paragraph every time,
// whether this was your first message ever or your hundredth this week.
// Now it actually looks at your setup and says something true about it.
async function startCommand(ctx) {
  await clearSession(ctx);

  const channels = await channelsModel.list();

  if (channels.length === 0) {
    await ctx.reply(
      '🎬 Welcome to PostStudioX.\n\n' +
        "I post, schedule, format, and clean up after myself in your Telegram channels — you tell me what and when, I handle the rest.\n\n" +
        "First thing: I'll need admin rights in a channel before I can do anything there. Tap 📡 Channels to add one — it takes one tap to confirm, the permissions I ask for are already picked for you.\n\n" +
        'Everything else runs on buttons. /help, /status, and this /start are the only typed commands.',
      homeReplyKeyboard()
    );
    return;
  }

  const [scheduledCount, sentCount] = await Promise.all([
    savedItems.countByKind('post', 'scheduled'),
    savedItems.countByKind('post', 'sent'),
  ]);

  const statusLine = scheduledCount > 0
    ? `You've got ${scheduledCount} post${scheduledCount === 1 ? '' : 's'} on deck in ⏰ Scheduled.`
    : sentCount > 0
      ? `${sentCount} post${sentCount === 1 ? '' : 's'} sent so far — nothing waiting in the queue right now.`
      : "Channels are connected — whenever you're ready, 🎨 Compose is where a post starts.";

  await ctx.reply(
    `👋 Welcome back to PostStudioX.\n\n${statusLine}\n\n` +
      'Buttons handle everything below — /help and /status stay one tap away if you need them.',
    homeReplyKeyboard()
  );
}

module.exports = { startCommand };
