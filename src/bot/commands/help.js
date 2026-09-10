const { Markup } = require('telegraf');

const TOPICS = {
  how_it_works: {
    title: '🧭 How this bot works',
    body:
      "This bot only responds to you. Almost everything is done through *buttons* — two kinds:\n\n" +
      '• *Reply keyboard* (bottom bar, below where you type) — main navigation: New Post, Channels, Templates, etc. It changes depending on what screen you\'re on.\n' +
      '• *Inline buttons* (attached to a specific message) — choices tied to that exact message: picking a channel, confirming a send, editing a caption. Tapping one usually edits that same message rather than sending a new one, to keep the chat clean.\n\n' +
      'You\'re also not stuck going back to Home to switch sections — most screens carry a row of shortcuts (📡 🗂 📁 ⏰ 📜 ⚙️) straight to any other section.\n\n' +
      'Only /start, /help, /status are typed commands you\'ll normally use — everything else, tap don\'t type.',
  },
  creating_posts: {
    title: '📝 Creating & sending posts',
    body:
      'Tap 📝 New Post — you\'ll first choose how to start: 🆕 From Scratch, 🗂 From a Template, 📋 Duplicate Last Post, or (if you have one) ▶️ Resume an unfinished draft. From scratch, the order is content *first*, destination *last*:\n\n' +
      '1️⃣ Pick a media type (photo/video/document/text/poll/album)\n' +
      '2️⃣ Send the content\n' +
      '3️⃣ Add formatting/buttons (optional)\n' +
      '4️⃣ Preview, then choose where it goes\n\n' +
      "On that final screen you pick channel(s), and can *independently* toggle \"also save as template\" — so a single post can be sent, scheduled, saved as a template, or any combination. You can also give one specific channel a different caption than the rest with 🎯 Customize caption per channel.\n\n" +
      'Every send/schedule ends with a proper summary and next-step buttons (View Stats, Post Another, jump to Scheduled) — never a dead-end confirmation with nothing to tap.',
  },
  formatting_buttons: {
    title: '🎨 Formatting & buttons',
    body:
      'The formatting toolbar lets you apply Bold, Italic, Underline, Strikethrough, Spoiler, Code, a hyperlink, or a blockquote. Tapping a style edits the same message in place and shows a live preview of your text, so you can see exactly what\'s applied so far instead of a wall of near-identical confirmations.\n\n' +
      'Buttons you attach can be URL buttons, colored (Primary/Danger/Success), and edited or deleted anytime from History → Edit. ' +
      'Want links gone entirely? Use 🚫 Remove All Links, or 🧹 Strip Links on an existing post.',
  },
  scheduling: {
    title: '⏰ Scheduling & auto-delete',
    body:
      'Schedule from the destination screen using a quick preset (In 1 hour / Tonight 9pm / Tomorrow 9am) or a custom date/time (your timezone from Settings applies). Pending posts live under ⏰ Scheduled, ' +
      'editable or cancelable anytime before they fire. Right before a scheduled post actually sends, the bot re-checks that it can still post to every target channel — if a permission was pulled in the meantime, it\'ll back off and alert you instead of failing silently.\n\n' +
      'Auto-delete works two ways: channel posts can self-delete after a set time, and the bot\'s own chat messages to you clean up automatically too.',
  },
  channels: {
    title: '📡 Channels & permissions',
    body:
      'Tap 🤖 Add Bot to Channel to connect one — opens Telegram\'s native picker, pre-filtered to channels where the bot already qualifies (or "Add Manually" to paste a @username, chat ID, t.me link, or forward a message).\n\n' +
      'The channel list shows a health summary up top (how many are 🟢 healthy vs 🔴 need attention, unhealthy ones sorted to the top), plus 🔄 Recheck All / 🔕 Mute All for bulk maintenance.\n\n' +
      'Each channel\'s screen shows a full permission breakdown — not just "admin or not," but exactly which specific rights (post, edit, delete, invite, etc.) are actually granted, since Telegram allows an account to stay listed as "administrator" with every individual permission switched off. From there you can also mute alerts for just that channel, send a one-tap test post, or set a custom label for your own reference.',
  },
  templates_recipes: {
    title: '🗂 Templates & folders',
    body:
      'Any post can be saved as a template from the destination screen — either on its own ("Save as Template Only", no channel needed), or alongside actually sending/scheduling it. ' +
      'Tapping ▶️ Use on a saved template jumps straight to its preview with all the content already filled in — no need to redo the formatting.\n\n' +
      '📁 Folders group saved posts/templates together for easier browsing; items can be moved between folders or removed from one without affecting the underlying post.',
  },
  stats: {
    title: '📊 Stats: views & reactions',
    body:
      'Reactions are tracked live via Telegram. Views require a separate connected monitor and update every few minutes. ' +
      'See stats per post from 📜 History → a post → 📊 Stats.',
  },
  watchdog: {
    title: '🛡 Watchdog & self-healing',
    body:
      'Runs quietly in the background — auto-fixes routine issues (reconnects, stale jobs) and alerts you when something needs a decision ' +
      '(lost channel permissions, expired session). Check current status anytime with /status. Watchdog also now uses the same detailed permission check as the Channels screen, so an alert always tells you exactly which right is missing, not just "admin/not admin."',
  },
  emergency_stop: {
    title: '🛑 Emergency Stop',
    body:
      'The 🛑 STOP ALL button appears on every main screen (Channels, Templates, Folders, Scheduled, History, and the New Post destination screen) — you never have to hunt for it. ' +
      'Tapping it instantly pauses all scheduled posts, auto-deletes, and auto-reposts. Resume from ⚙️ Settings → 🛡 Watchdog when you\'re ready.',
  },
  navigation: {
    title: '🧭 Getting around',
    body:
      'Every screen now has a real ⬅️ Back button that returns to wherever you actually came from — a channel\'s detail view Back to the channel list, not straight to Home. Most list/menu screens also carry a row of shortcuts straight to the other sections (📡 Channels, 📝 New Post, 🗂 Templates, 📁 Folders, ⏰ Scheduled, 📜 History, ⚙️ Settings), so you can switch sections without backing out to Home first.\n\n' +
      'Long lists (Templates/Scheduled/History) show a "🔢 Jump to page" button once there are more than a handful of pages.',
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
