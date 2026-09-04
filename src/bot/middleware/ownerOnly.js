const config = require('../../config/env');

// Every single update must pass this check. Anyone who isn't the configured
// OWNER_ID is silently ignored - no error message, no hint the bot exists,
// since this is a single-owner personal tool, not a public bot.
function ownerOnly() {
  const ownerId = config.ownerId();
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== ownerId) {
      return; // silently drop
    }
    return next();
  };
}

module.exports = { ownerOnly };
