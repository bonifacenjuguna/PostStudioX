const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const { subScreenReplyKeyboard, withEmergencyStop, quickNavRow } = require('../../components/navRow');
const { checkChannelPermissions, formatPermissionReport } = require('../../../services/channelPermissions');

// Fixed request_id: this bot only ever has one "pick a channel" request in
// flight at a time (single-owner, one flow at a time), so there's no need
// to generate/track a unique id per attempt.
const ADD_CHANNEL_REQUEST_ID = 501;

function listKeyboard(channels) {
  const rows = channels.map((c) => [
    Markup.button.callback(
      `${c.is_admin ? '🟢' : '🔴'}${c.muted ? ' 🔕' : ''} ${c.label || c.title || c.chat_id}`,
      `channels:view:${c.chat_id}`
    ),
  ]);
  rows.push([Markup.button.callback('➕ Add Channel', 'channels:add')]);
  return Markup.inlineKeyboard(withEmergencyStop(rows));
}

function requestChatKeyboard() {
  // Raw Bot API shape (KeyboardButtonRequestChat) built by hand rather than
  // through a Telegraf helper, since this environment can't npm-verify which
  // helper signature the installed Telegraf version exposes - the JSON
  // Telegram itself expects is the one thing guaranteed stable.
  //
  // bot_is_member + bot_administrator_rights.can_post_messages means the
  // native picker Telegram shows is PRE-FILTERED to only channels where
  // this bot is already an admin that can post - exactly the "pre-select
  // the actual permissions needed" behavior asked for, enforced by Telegram
  // itself rather than by us re-checking after the fact.
  return {
    reply_markup: {
      keyboard: [
        [
          {
            text: '📡 Choose a Channel',
            request_chat: {
              request_id: ADD_CHANNEL_REQUEST_ID,
              chat_is_channel: true,
              bot_is_member: true,
              bot_administrator_rights: { can_post_messages: true },
            },
          },
        ],
        ['❌ Cancel'],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

async function enter(ctx) {
  const channels = await channelsModel.list();
  await ctx.reply(
    `📡 Channels (${channels.length} registered)\n\n` +
      'Register a channel by: forwarding a message from it, sending its @username, its numeric chat ID, its t.me link - or just tap "Add Channel" to pick from a list.',
    subScreenReplyKeyboard()
  );
  await ctx.reply(channels.length ? 'Registered channels:' : 'No channels registered yet.', listKeyboard(channels));
}

// Accepts: forwarded message, @username, numeric chat ID, or a t.me link
// (https://t.me/name, t.me/name, or @name copied as a link). Previously
// only the first three worked - a pasted channel link was silently ignored.
function extractChannelRef(ctx) {
  const text = ctx.message.text?.trim();
  const forwardChat = ctx.message.forward_from_chat;

  if (forwardChat) {
    return { chatId: forwardChat.id };
  }
  if (!text) return null;

  if (text.startsWith('@')) {
    return { chatId: text };
  }
  if (/^-?\d+$/.test(text)) {
    return { chatId: text };
  }

  const linkMatch = text.match(/^(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{5,})\/?$/i);
  if (linkMatch) {
    return { chatId: `@${linkMatch[1]}` };
  }

  return null;
}

async function registerChannel(ctx, chatId) {
  const permResult = await checkChannelPermissions(ctx.telegram, chatId);
  if (!permResult.isAdmin) {
    await ctx.reply("⚠️ I'm in that chat but not an admin there yet. Promote me to admin with post permissions, then try again.");
    return;
  }
  if (!permResult.ok) {
    await ctx.reply(`⚠️ I'm an admin there, but the "Post messages" permission is off, so I still can't send anything:\n\n${formatPermissionReport(permResult)}`);
    return;
  }
  const chat = await ctx.telegram.getChat(chatId);
  const saved = await channelsModel.add({ chatId: chat.id, title: chat.title, username: chat.username });
  await channelsModel.setPermissions(saved.chat_id, permResult);
  await ctx.reply(`✅ Registered: ${saved.title || saved.chat_id}\n\n${formatPermissionReport(permResult)}`, subScreenReplyKeyboard());
  await enter(ctx);
}

async function handleText(ctx) {
  if (ctx.session.step === 'awaiting_label') {
    const chatId = ctx.session.labelingChatId;
    const raw = ctx.message.text.trim();
    await channelsModel.setLabel(chatId, raw === '-' ? null : raw);
    ctx.session.step = null;
    await ctx.reply(raw === '-' ? '✏️ Label cleared.' : '✏️ Label saved.');
    await renderChannelView(ctx, chatId);
    return;
  }

  const ref = extractChannelRef(ctx);
  if (!ref) return; // not a channel reference - ignore, other handlers may process it

  try {
    await registerChannel(ctx, ref.chatId);
  } catch (err) {
    await ctx.reply(`🔴 Couldn't verify that channel: ${err.message}\n\nMake sure the bot has been added to it first.`);
  }
}

// Handles the result of the native chat picker (see requestChatKeyboard).
// Registered generically on 'message' in bot/index.js since chat_shared
// rides on a plain message, not its own update type.
async function handleChatShared(ctx) {
  const shared = ctx.message.chat_shared;
  if (!shared || shared.request_id !== ADD_CHANNEL_REQUEST_ID) return false;

  await ctx.reply('Checking that channel...', subScreenReplyKeyboard());
  try {
    await registerChannel(ctx, shared.chat_id);
  } catch (err) {
    await ctx.reply(`🔴 Couldn't verify that channel: ${err.message}`, subScreenReplyKeyboard());
  }
  return true;
}

function channelViewKeyboard(channel) {
  const rows = [
    [Markup.button.callback('🔄 Re-check Rights', `channels:recheck:${channel.chat_id}`)],
    [Markup.button.callback('📨 Send Test Post', `channels:test:${channel.chat_id}`)],
    [
      Markup.button.callback(channel.muted ? '🔔 Unmute Alerts' : '🔕 Mute Alerts', `channels:mute:${channel.chat_id}`),
      Markup.button.callback('✏️ Rename Label', `channels:label:${channel.chat_id}`),
    ],
    [Markup.button.callback('🗑 Remove Channel', `channels:remove:${channel.chat_id}`)],
  ];
  rows.push(...quickNavRow('channels'));
  return Markup.inlineKeyboard(withEmergencyStop(rows));
}

async function renderChannelView(ctx, chatId, { edit = false } = {}) {
  const channel = await channelsModel.findByChatId(chatId);
  if (!channel) return ctx.reply('Channel not found.');

  const status = channel.is_admin ? '🟢 Can post' : `🔴 Issue: ${channel.admin_issue || 'unknown'}`;
  const text =
    `📡 ${channel.label || channel.title || channel.chat_id}\n` +
    `${status}${channel.muted ? '\n🔕 Alerts muted for this channel' : ''}\n` +
    `Last checked: ${channel.last_checked_at ? new Date(channel.last_checked_at).toLocaleString() : 'never'}`;

  const keyboard = channelViewKeyboard(channel);
  if (edit) {
    try {
      await ctx.editMessageText(text, keyboard);
      return;
    } catch (_) { /* fall through to a fresh message */ }
  }
  await ctx.reply(text, keyboard);
}

async function registerHandlers(bot) {
  bot.action('channels:add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      'Tap below to pick from channels where I\'m already an admin who can post - or just paste a @username, numeric chat ID, t.me link, or forward a message from the channel.',
      requestChatKeyboard()
    );
  });

  bot.action(/^channels:view:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    await renderChannelView(ctx, chatId);
  });

  bot.action(/^channels:recheck:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Checking...');
    const result = await checkChannelPermissions(ctx.telegram, chatId);
    await channelsModel.setPermissions(chatId, result);
    await ctx.reply(formatPermissionReport(result));
    await renderChannelView(ctx, chatId);
  });

  bot.action(/^channels:test:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Sending...');
    try {
      const sent = await ctx.telegram.sendMessage(chatId, '✅ Test post from Post Studio X - this confirms the bot can send here. You can delete this message.');
      await ctx.reply(`🟢 Test post delivered (message ${sent.message_id}).`);
    } catch (err) {
      await ctx.reply(`🔴 Send failed: ${err.message}\n\nRun "Re-check Rights" to see exactly which permission is missing.`);
    }
  });

  bot.action(/^channels:mute:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return;
    await channelsModel.setMuted(chatId, !channel.muted);
    await renderChannelView(ctx, chatId, { edit: true });
  });

  bot.action(/^channels:label:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session = { scene: 'channels', step: 'awaiting_label', labelingChatId: chatId };
    await ctx.reply('Send a custom label for this channel (this is just for your own reference in the bot - it won\'t rename the actual Telegram channel). Send "-" to clear it.');
  });

  bot.action(/^channels:remove:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(
      'Remove this channel from the bot? Past posts stay in the channel itself.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, remove', `channels:removeconfirm:${chatId}`)],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
  });

  bot.action(/^channels:removeconfirm:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Removed');
    await channelsModel.remove(chatId);
    try { await ctx.editMessageText('🗑 Channel removed.'); } catch (_) {}
  });
}

module.exports = { enter, handleText, handleChatShared, registerHandlers };
