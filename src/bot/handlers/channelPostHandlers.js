// channel_post / edited_channel_post were previously requested in
// allowed_updates but had NO handler anywhere - pure dead subscription.
// Now that ownerOnly() lets these through, this puts them to use: flagging
// when something appears in a registered channel that the bot didn't post
// itself (e.g. a co-admin posted directly, or content was edited outside
// the bot). Purely informational - never blocks or removes anything.

const channelsModel = require('../../db/models/channels');
const statsModel = require('../../db/models/stats');
const watchdogLog = require('../../db/models/watchdogLog');

function registerChannelPostHandlers(bot) {
  bot.on(['channel_post', 'edited_channel_post'], async (ctx) => {
    const chat = ctx.channelPost?.chat || ctx.editedChannelPost?.chat;
    const message = ctx.channelPost || ctx.editedChannelPost;
    if (!chat || !message) return;

    const channel = await channelsModel.findByChatId(chat.id);
    if (!channel) return; // not a channel we're tracking - ignore entirely

    const isOurs = await statsModel.existsForMessage(chat.id, message.message_id);
    if (isOurs) return; // this is the bot's own post/edit - expected, not news

    if (channel.muted) return; // owner asked not to be bothered about this channel

    await watchdogLog.record({
      level: 'info',
      category: 'channel_activity',
      message: `Manual post detected in "${channel.label || channel.title || chat.id}" (message ${message.message_id}) - not sent by the bot.`,
    });
  });
}

module.exports = { registerChannelPostHandlers };
