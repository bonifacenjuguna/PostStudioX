const { Markup } = require('telegraf');

const TOPICS = {
  how_it_works: {
    title: '🧭 How this bot works',
    body:
      "This is PostStudioX (@PostStudioXBot) — it only responds to you. Almost everything is done through *buttons* — two kinds:\n\n" +
      '• *Reply keyboard* (bottom bar, below where you type) — main navigation: New Post, Channels, Templates, etc. It changes depending on what screen you\'re on.\n' +
      '• *Inline buttons* (attached to a specific message) — choices tied to that exact message: picking a channel, confirming a send, editing a caption. Tapping one usually edits that same message rather than sending a new one, to keep the chat clean.\n\n' +
      'Only /start, /help, /status are typed commands you\'ll normally use — everything else, tap don\'t type.',
  },
  creating_posts: {
    title: '📝 Creating & sending posts',
    body:
      'Tap 📝 New Post — the whole flow runs as one evolving control-panel message with a "Step X/5" header, ' +
      'not a new chat message per tap. Pick a media type (photo/video/document/text/poll/album — or 📚 From Library to reuse media you\'ve sent before), send the content, add formatting/buttons, then preview it.\n\n' +
      'Channel selection happens *last*, only once you choose how to finish: 🚀 Send Now, ⏰ Schedule, 💾 Save as Template, 📝 Save as Draft (no channel yet), or 🚀+💾 Send & Save as Template. ' +
      'Every step has a real "⬅️ Back" to the previous step — backing out of channel-picking or scheduling returns to your Preview with everything intact, it never discards the post.',
  },
  formatting_buttons: {
    title: '🎨 Formatting & buttons',
    body:
      'The formatting toolbar lets you apply Bold, Italic, Underline, Strikethrough, Spoiler, Code, Link, and Blockquote.\n\n' +
      'Buttons you attach can be:\n' +
      '• *Link buttons* — open a URL\n' +
      '• *Note buttons* — type `NOTE: your message` instead of a URL when asked; tapping shows a popup instead of opening a link (good for extra context, credits, disclaimers)\n\n' +
      'Both kinds can be colored (Primary/Danger/Success), edited or deleted anytime from an existing post\'s edit menu. ' +
      'Want links gone entirely? Use 🚫 Remove All Links, or 🧹 Strip Links on an existing post.',
  },
  polls: {
    title: '📊 Polls',
    body:
      'Send a question, then comma-separated answers (at least 2). Then choose: Anonymous (on by default), Allow multiple answers, and Quiz mode (marks one answer correct). ' +
      'The preview shows a real, tappable poll — not just the question text.',
  },
  scheduling: {
    title: '⏰ Scheduling & auto-delete',
    body:
      'Schedule a post for later — pick a time (your timezone from Settings applies), always in the future. Pending posts live under ⏰ Scheduled, ' +
      'editable or cancelable anytime before they fire.\n\n' +
      'Auto-delete works two ways: channel posts can self-delete after a set time, and the bot\'s own chat messages to you clean up automatically too.',
  },
  channels: {
    title: '📡 Channels & permissions',
    body:
      'Register a channel under 📡 Channels → ➕ Add Channel, any of: tap "Choose a Channel" to pick it natively, forward a message from it, send its @username, a t.me/ link, or its numeric chat ID. ' +
      'The bot needs to already be an admin there with "Post Messages" rights.\n\n' +
      '🔄 Re-check Rights shows exactly which permissions the bot has or is missing (post, edit, delete, pin, invite, etc.), not just a yes/no. ' +
      'If it ever loses rights, you\'ll get an alert — unless you\'ve muted that specific channel with 🔕 Mute Alerts.',
  },
  templates_folders: {
    title: '🗂 Templates & folders',
    body:
      'Any post can be saved as a template (its format, no channels attached) via 💾 Save as Template. Tapping ▶️ Use on a template jumps straight to its preview — no need to redo content or media type.\n\n' +
      '📁 Folders group templates/posts for your own organization; items can be moved between folders, or used directly as a new post from inside a folder.',
  },
  media_library: {
    title: '📚 Media Library',
    body:
      'Photos, videos, and documents you actually send get remembered automatically. Next time, pick 📚 From Library at the media-type step in New Post instead of re-uploading.',
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
      'Emergency Stop lives in ⚙️ Settings → 🛡 Watchdog. It always shows the current status first (🟢 Normal or 🛑 Active) before you act, so you always know exactly what state it\'s in. ' +
      'Activating it pauses all scheduled posts, auto-deletes, and auto-reposts; the same screen has a clear "▶️ Resume Everything" button when it\'s active.',
  },
  navigation: {
    title: '🧭 Navigation tips',
    body:
      'Lists longer than a few pages (Templates, History, Scheduled) show a 🔢 Jump to page button once there are more than 4 pages — tap it, then send a page number.\n\n' +
      'Every screen has a real "⬅️ Back" to the previous screen, not just "🏠 Home" — Home is still there as a fast exit, but you don\'t have to use it just to go one step back.',
  },
  settings: {
    title: '⚙️ Settings explained',
    body:
      'Defaults, timezone, notification preferences, button colors, auto-delete defaults, storage management (including manually purging old trash), and watchdog controls all live here.',
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
