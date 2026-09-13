// Shared "which live channel message does this forward/link refer to"
// resolver. Used by the Replace-Live ambient trigger AND by Edit Post's
// "Re-link Live Message" repair tool (for fixing a saved_item whose
// current_message_refs already point at the wrong message - e.g. one
// adopted before the forward_origin fix below existed, which is exactly
// the kind of bad data this file's earlier version could produce and that
// no later code fix can retroactively repair on its own).

const { parseTmeLink } = require('./telegramLinks');

// BUGFIX: Bot API 7.0+ replaced the legacy forward_from_chat /
// forward_from_message_id fields with a single forward_origin object.
// Modern Telegram clients no longer send the legacy fields AT ALL for
// channel-post forwards, so a naive `forward_from_message_id ||
// message.message_id` fallback silently lands on the id of the WRAPPER
// message in the current chat (an unrelated per-chat numbering space)
// instead of throwing - which is how a saved_item can end up quietly
// tracking the wrong message with no error ever surfacing: edits "succeed"
// because that other message id is real, just not the one on screen.
function extractForwardOrigin(message) {
  const origin = message.forward_origin;
  if (origin && origin.type === 'channel' && origin.chat) {
    return { chatId: String(origin.chat.id), messageId: origin.message_id };
  }
  // Kept for any older client/bridge that still sends the legacy pair
  // intact (both fields present together, never mixed with the wrapper's
  // own id).
  if (message.forward_from_chat && message.forward_from_message_id) {
    return { chatId: String(message.forward_from_chat.id), messageId: message.forward_from_message_id };
  }
  return null;
}

// Returns { chatId, messageId, message } | { error } | null (not a
// forward/link at all - let the caller try something else).
async function resolveLiveMessageRef(ctx, { channelsModel } = {}) {
  const origin = extractForwardOrigin(ctx.message || {});
  if (origin) {
    return { chatId: origin.chatId, messageId: origin.messageId, message: ctx.message };
  }

  const text = ctx.message?.text?.trim();
  const parsed = text ? parseTmeLink(text) : null;
  if (!parsed) return null;

  let chatId = parsed.chatId;
  if (!chatId) {
    if (!channelsModel) return { error: `"${parsed.username}" can't be resolved without a channel registry.` };
    const channel = await channelsModel.list().then((list) => list.find((c) => c.username?.toLowerCase() === parsed.username.toLowerCase()));
    if (!channel) return { error: `"${parsed.username}" isn't one of your registered channels — only channels the bot manages can be resolved this way.` };
    chatId = channel.chat_id;
  }

  try {
    const fetched = await ctx.telegram.forwardMessage(ctx.chat.id, chatId, parsed.messageId);
    await ctx.telegram.deleteMessage(ctx.chat.id, fetched.message_id).catch(() => {});
    return { chatId: String(chatId), messageId: parsed.messageId, message: fetched };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

module.exports = { resolveLiveMessageRef, extractForwardOrigin };
