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

const channels = require('./scenes/channels');
const createPost = require('./scenes/create-post');
const editPost = require('./scenes/edit-post');
const templates = require('./scenes/templates');
const folders = require('./scenes/folders');
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

  const scenes = {
    channels,
    createPost,
    editPost,
    templates,
    folders,
    scheduled,
    history,
    settings,
  };

  registerMainMenu(bot, scenes);
  registerSceneRouter(bot, scenes);

  channels.registerHandlers(bot);
  createPost.registerHandlers(bot);
  editPost.registerHandlers(bot);
  templates.registerHandlers(bot, scenes);
  folders.registerHandlers(bot);
  scheduled.registerHandlers(bot);
  history.registerHandlers(bot);
  settings.registerHandlers(bot);

  bot.catch((err, ctx) => {
    console.error(`[bot] Unhandled error for update ${ctx.update.update_id}:`, err);
    const watchdogLog = require('../db/models/watchdogLog');
    watchdogLog
      .record({ level: 'warning', category: 'bot', message: `Unhandled error: ${err.message}` })
      .catch(() => {});
    ctx.reply('🔴 Something went wrong handling that. The error has been logged.').catch(() => {});
  });

  return bot;
}

module.exports = { buildBot };
