const config = require('../../config/env');

// Update types Telegram sends WITHOUT a `from` field, because they describe
// something happening in a channel rather than an action taken by a
// specific user talking to the bot. These can only ever arrive for chats
// the bot is already a member/admin of - a stranger can't manufacture one
// by messaging the bot - so gating them on ctx.from is both wrong (ctx.from
// is always undefined for these) and, previously, silently dropped every
// one of them. Every handler for these types independently re-checks the
// chat_id against our own registered-channels table before doing anything
// consequential, so letting them through here doesn't weaken the
// owner-only guarantee for anything that actually matters (commands,
// buttons, typed input).
const FROM_LESS_UPDATE_TYPES = new Set([
  'channel_post',
  'edited_channel_post',
  'message_reaction_count',
]);

// Every single update must pass this check. Anyone who isn't the configured
// OWNER_ID is silently ignored - no error message, no hint the bot exists,
// since this is a single-owner personal tool, not a public bot.
function ownerOnly() {
  const ownerId = config.ownerId();
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === ownerId) {
      return next();
    }
    if (fromId === undefined && FROM_LESS_UPDATE_TYPES.has(ctx.updateType)) {
      return next();
    }
    return; // silently drop
  };
}

module.exports = { ownerOnly, FROM_LESS_UPDATE_TYPES };
