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
const { registerChannelPostHandlers } = require('./handlers/channelPostHandlers');
const { registerMainMenu } = require('./handlers/mainMenu');
const { registerSceneRouter } = require('./sceneRouter');
const { registerJumpHandler } = require('./components/pagination');

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

  registerHelpHandlers(bot);
  registerStatusHandlers(bot);
  registerResetHandlers(bot);
  registerFactoryResetTextHandler(bot);
  registerNavHandlers(bot, scenes);
  registerWatchdogAlertHandlers(bot);
  registerReactionHandlers(bot);
  registerChannelPostHandlers(bot);
  registerJumpHandler(bot);

  // The native "choose a channel" picker (channels:add) replies via a
  // chat_shared field on an otherwise-plain message, not its own update
  // type - has to be checked generically before the text/media routers,
  // and must fall through untouched for every other message.
  bot.on('message', async (ctx, next) => {
    if (ctx.message.chat_shared && channels.handleChatShared) {
      const handled = await channels.handleChatShared(ctx);
      if (handled) return;
    }
    return next();
  });

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
