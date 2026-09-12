const { Telegraf } = require('telegraf');
const config = require('../config/env');
const { ownerOnly } = require('./middleware/ownerOnly');
const { sessionMiddleware } = require('./middleware/session');
const { debounce } = require('./middleware/debounce');

const { startCommand } = require('./commands/start');
const { helpCommand, registerHelpHandlers } = require('./commands/help');
const { statusCommand, registerStatusHandlers } = require('./commands/status');
const { resetCommand, registerResetHandlers, registerFactoryResetTextHandler } = require('./commands/reset');

const { registerNavHandlers } = require('./handlers/navHandlers');
const { registerWatchdogAlertHandlers } = require('./handlers/watchdogAlertHandlers');
const { registerReactionHandlers } = require('./handlers/reactionHandlers');
const { registerMainMenu } = require('./handlers/mainMenu');
const { registerSceneRouter } = require('./sceneRouter');
const { registerHandlers: registerReplaceLive } = require('./handlers/replaceLive');
const { registerPaginationJump } = require('./components/pagination');

const channels = require('./scenes/channels');
const createPost = require('./scenes/create-post');
const editPost = require('./scenes/edit-post');
const templates = require('./scenes/templates');
const scheduled = require('./scenes/scheduled');
const history = require('./scenes/history');
const settings = require('./scenes/settings');

function buildBot() {
  const bot = new Telegraf(config.botToken());

  bot.use(ownerOnly());
  bot.use(sessionMiddleware());
  bot.use(debounce());

  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('status', statusCommand);
  bot.command('reset', resetCommand); // hidden - not registered with setMyCommands

  registerHelpHandlers(bot);
  registerStatusHandlers(bot);
  registerResetHandlers(bot);
  registerFactoryResetTextHandler(bot);
  registerNavHandlers(bot);
  registerWatchdogAlertHandlers(bot);
  registerReactionHandlers(bot);

  // v1.1.0 (#6): "🔢 Jump to page" on Templates/History/Scheduled was
  // rendered but had no handler anywhere - wired up here, registered before
  // the scene router so a pending jump always takes priority over whatever
  // scene happens to be active.
  registerPaginationJump(bot, {
    tpl: (ctx, page) => templates.enter(ctx, page),
    sch: (ctx, page) => scheduled.enter(ctx, page),
    hist: (ctx, page) => history.enter(ctx, page, ctx.session.statusFilter || null),
  });

  const scenes = {
    channels,
    createPost,
    editPost,
    templates,
    scheduled,
    history,
    settings,
  };

  registerMainMenu(bot, scenes);
  registerSceneRouter(bot, scenes);
  // Registered right after the scene router, which already calls next()
  // for idle-session text/media - this only ever fires on genuinely idle
  // messages (a forward or t.me link with no active flow), by design.
  registerReplaceLive(bot);

  channels.registerHandlers(bot);
  createPost.registerHandlers(bot);
  editPost.registerHandlers(bot);
  templates.registerHandlers(bot, scenes);
  scheduled.registerHandlers(bot);
  history.registerHandlers(bot);
  settings.registerHandlers(bot);

  bot.catch((err, ctx) => {
    const scene = ctx.session?.scene || ctx.updateType || 'unknown';
    console.error(`[bot] Unhandled error for update ${ctx.update.update_id} (scene: ${scene}):`, err);
    const watchdogLog = require('../db/models/watchdogLog');
    watchdogLog
      .record({ level: 'warning', category: 'bot', message: `Unhandled error in ${scene}: ${err.message}` })
      .catch(() => {});
    const { logAction } = require('../services/actionErrors');
    logAction({ scene, step: 'unhandled', attempted: `process a ${ctx.updateType} update`, error: err, chatId: ctx.chat?.id })
      .then((msg) => ctx.reply(`${msg}\n\n(Also logged - Settings → Watchdog → Recent Events.)`).catch(() => {}))
      .catch(() => {
        ctx.reply(`🔴 Error in ${scene}\nTried to: process a ${ctx.updateType} update\nReason: ${err.message}`).catch(() => {});
      });
  });

  return bot;
}

module.exports = { buildBot };
