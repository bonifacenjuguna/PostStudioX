// Routes free-text and media messages to the currently active scene, based
// on ctx.session.scene. This is a deliberately lightweight alternative to
// Telegraf's built-in Scenes/session (which assumes its own session store) -
// ours is Redis-backed with a Postgres durability mirror, so we drive
// dispatch manually here instead.

// Only these are real, globally-registered commands that should always
// escape whatever flow you're in. Everything else starting with "/" -
// including in-flow pseudo-commands like /skip - must still reach the
// active scene, or it's silently swallowed (this was the /skip bug: it
// was being treated as an unknown command and dropped before ever
// reaching the scene that knows what to do with it).
const GLOBAL_COMMANDS = /^\/(start|help|status)(\s|$)/i;

function registerSceneRouter(bot, scenes) {
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.scene) return next();
    if (GLOBAL_COMMANDS.test(ctx.message.text || '')) return next();

    const scene = scenes[toCamel(ctx.session.scene)];
    if (scene?.handleText) {
      await scene.handleText(ctx);
      return;
    }
    // v1.1.0 FIX: previously this silently swallowed the message with no
    // fallback whenever the active scene had no handleText (e.g. Scheduled,
    // History, Templates) - the update just vanished, no reply, no error.
    // Falling through to next() lets later handlers (pagination "jump to
    // page", etc.) still get a chance instead of text going nowhere.
    return next();
  });

  bot.on(['photo', 'video', 'document'], async (ctx, next) => {
    if (!ctx.session?.scene) return next();

    const scene = scenes[toCamel(ctx.session.scene)];
    if (scene?.handleMedia) {
      await scene.handleMedia(ctx);
      return;
    }
    if (scene?.handleDocument && ctx.message.document) {
      await scene.handleDocument(ctx);
      return;
    }
    return next();
  });
}

function toCamel(str) {
  return str.replace(/-([a-z])/g, (_, l) => l.toUpperCase());
}

module.exports = { registerSceneRouter };
