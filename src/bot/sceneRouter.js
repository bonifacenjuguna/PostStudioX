// Routes free-text and media messages to the currently active scene, based
// on ctx.session.scene. This is a deliberately lightweight alternative to
// Telegraf's built-in Scenes/session (which assumes its own session store) -
// ours is Redis-backed with a Postgres durability mirror, so we drive
// dispatch manually here instead.

function registerSceneRouter(bot, scenes) {
  bot.on('text', async (ctx, next) => {
    if (!ctx.session?.scene) return next();
    if (ctx.message.text?.startsWith('/')) return next(); // let commands through

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
