const { Markup } = require('telegraf');

const TOPICS = {
  how_it_works: {
    title: '🧭 How this bot works',
    body:
      "This bot only responds to you. Almost everything is done through *buttons* — two kinds:\n\n" +
      '• *Reply keyboard* (bottom bar, below where you type) — main navigation: New Post, Channels, Templates, etc. It changes depending on what screen you\'re on.\n' +
      '• *Inline buttons* (attached to a specific message) — choices tied to that exact message: picking a channel, confirming a send, editing a caption. Tapping one usually edits that same message rather than sending a new one, to keep the chat clean.\n\n' +
      'Only /start, /help, /status are typed commands you\'ll normally use — everything else, tap don\'t type.',
  },
  creating_posts: {
    title: '📝 Creating & sending posts',
    body:
      'Tap 📝 New Post, pick a channel, pick a media type (photo/video/document/text/poll/album), send the content, then add formatting/buttons. ' +
      'You\'ll always see a full preview before anything goes out, with Send Now, Schedule, or Save as Template options.',
  },
  formatting_buttons: {
    title: '🎨 Formatting & buttons',
    body:
      'The formatting toolbar lets you apply Bold, Italic, Underline, Strikethrough, Spoiler, Code, Code Block, Hyperlink, Blockquote, Expandable Blockquote.\n\n' +
      'Buttons you attach can be URL buttons, colored (Primary/Danger/Success), edited or deleted anytime from History. ' +
      'Want links gone entirely? Use 🚫 Remove All Links, or 🧹 Strip Links on an existing post.',
  },
  scheduling: {
    title: '⏰ Scheduling & auto-delete',
    body:
      'Schedule a post for later — pick a time (your timezone from Settings applies). Pending posts live under ⏰ Scheduled, ' +
      'editable or cancelable anytime before they fire.\n\n' +
      'Auto-delete works two ways: channel posts can self-delete after a set time, and the bot\'s own chat messages to you clean up automatically too.',
  },
  channels: {
    title: '📡 Channels & permissions',
    body:
      'Register channels under 📡 Channels — the bot needs to be an admin with post rights there. ' +
      'If it ever loses those rights, you\'ll get an alert rather than silent failures.',
  },
  templates_recipes: {
    title: '🗂 Templates & recipes',
    body:
      'Any post can be saved as a template (its format) via 💾 Save as Template, or filed into a 📁 Folder for later reuse. ' +
      'A "recipe" is a saved bundle of settings (channels + toggles) independent of content.',
  },
  stats: {
    title: '📊 Stats: views & reactions',
    body:
      'Reactions are tracked live via Telegram. Views require a separate connected monitor and update every few minutes. ' +
      'See stats per post from 📜 History.',
  },
  watchdog: {
    title: '🛡 Watchdog & self-healing',
    body:
      'Runs quietly in the background — auto-fixes routine issues (reconnects, stale jobs) and alerts you when something needs a decision ' +
      '(lost channel permissions, expired session). Check current status anytime with /status.',
  },
  emergency_stop: {
    title: '🛑 Emergency Stop',
    body:
      'Available anytime, even mid-flow — instantly pauses all scheduled posts, auto-deletes, and auto-reposts. ' +
      'Use it if something looks wrong and you need everything to freeze immediately.',
  },
  settings: {
    title: '⚙️ Settings explained',
    body:
      'Defaults, timezone, notification preferences, button colors, auto-delete defaults, storage management, and watchdog controls all live here.',
  },
};

function topicsKeyboard() {
  const rows = Object.entries(TOPICS).map(([key, t]) => [Markup.button.callback(t.title, `help:topic:${key}`)]);
  rows.push([Markup.button.callback('🏠 Back to Home', 'nav:home')]);
  return Markup.inlineKeyboard(rows);
}

async function helpCommand(ctx) {
  await ctx.reply('❓ Help & FAQ\n\nPick a topic below.', topicsKeyboard());
}

async function registerHelpHandlers(bot) {
  bot.action(/^help:topic:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    const topic = TOPICS[key];
    await ctx.answerCbQuery();
    if (!topic) return;
    try {
      await ctx.editMessageText(`${topic.title}\n\n${topic.body}`, {
        parse_mode: 'Markdown',
        reply_markup: Markup.inlineKeyboard([
          [Markup.button.callback('⬅️ Back to Topics', 'help:topics')],
          [Markup.button.callback('🏠 Back to Home', 'nav:home')],
        ]).reply_markup,
      });
    } catch (_) {
      await ctx.reply(`${topic.title}\n\n${topic.body}`, { parse_mode: 'Markdown' });
    }
  });

  bot.action('help:topics', async (ctx) => {
    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText('❓ Help & FAQ\n\nPick a topic below.', topicsKeyboard());
    } catch (_) {
      await ctx.reply('❓ Help & FAQ\n\nPick a topic below.', topicsKeyboard());
    }
  });
}

module.exports = { helpCommand, registerHelpHandlers };
