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
    }
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
