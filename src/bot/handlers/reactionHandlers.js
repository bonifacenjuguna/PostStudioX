const statsModel = require('../../db/models/stats');
const db = require('../../db/pool');

// Telegram pushes message_reaction_count updates (Bot API 7.0+) whenever
// reactions change on a channel post the bot administers - no MTProto
// needed for this, unlike view counts.
function registerReactionHandlers(bot) {
  bot.on('message_reaction_count', async (ctx) => {
    const update = ctx.update.message_reaction_count;
    if (!update) return;

    const chatId = String(update.chat.id);
    const messageId = update.message_id;

    const reactions = {};
    for (const r of update.reactions || []) {
      const key = r.type.emoji || r.type.custom_emoji_id || 'unknown';
      reactions[key] = r.total_count;
    }

    try {
      await statsModel.updateReactions(chatId, messageId, reactions);
    } catch (err) {
      // Row may not exist yet if this post wasn't sent through the bot
      // (e.g. a forwarded/manual post) - safe to ignore.
      console.warn(`[reactions] Could not update stats for ${chatId}/${messageId}: ${err.message}`);
    }
  });
}

module.exports = { registerReactionHandlers };
