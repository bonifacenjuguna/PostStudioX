const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const { subScreenReplyKeyboard, withEmergencyStop, quickNavRow } = require('../../components/navRow');
const { checkChannelPermissions, formatPermissionReport } = require('../../../services/channelPermissions');
const navStack = require('../../navStack');

// Fixed request_id: this bot only ever has one "pick a channel" request in
// flight at a time (single-owner, one flow at a time), so there's no need
// to generate/track a unique id per attempt.
const ADD_CHANNEL_REQUEST_ID = 501;

// Telegram's ChatAdministratorRights is an ALL-OR-NOTHING object: every
// field must be present, not just the ones you care about. Sending only
// { can_post_messages: true } gets the whole sendMessage call rejected by
// Telegram as malformed, which is exactly what caused the "Something went
// wrong" crash on tapping Add Channel - the object below is the complete
// set, with only the rights this bot actually needs turned on.
const REQUIRED_BOT_RIGHTS = {
  is_anonymous: false,
  can_manage_chat: false,
  can_delete_messages: true,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_post_messages: true,
  can_edit_messages: true,
  can_pin_messages: true,
};

function healthSummary(channels) {
  const healthy = channels.filter((c) => c.is_admin).length;
  const flagged = channels.length - healthy;
  return { healthy, flagged, total: channels.length };
}

function sortByHealth(channels) {
  // Unhealthy channels first - the ones needing attention shouldn't be
  // buried at the bottom of a long list.
  return [...channels].sort((a, b) => Number(a.is_admin) - Number(b.is_admin));
}

function listKeyboard(channels) {
  const sorted = sortByHealth(channels);
  const rows = sorted.map((c) => [
    Markup.button.callback(
      `${c.is_admin ? '🟢' : '🔴'}${c.muted ? ' 🔕' : ''} ${c.label || c.title || c.chat_id}`,
      `channels:view:${c.chat_id}`
    ),
  ]);
  rows.push([Markup.button.callback('🤖 Add Bot to Channel', 'channels:add')]);
  if (channels.length > 1) {
    rows.push([
      Markup.button.callback('🔄 Recheck All', 'channels:recheckall'),
      Markup.button.callback('🔕 Mute All', 'channels:muteall'),
    ]);
  }
  rows.push(...quickNavRow('channels'));
  return Markup.inlineKeyboard(withEmergencyStop(rows));
}

function requestChatKeyboard() {
  // Raw Bot API shape built by hand rather than through a Telegraf helper,
  // since this environment can't npm-verify which helper signature the
  // installed Telegraf version exposes - the JSON Telegram itself expects
  // is the one thing guaranteed stable.
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
              bot_administrator_rights: REQUIRED_BOT_RIGHTS,
            },
          },
        ],
        ['✏️ Add Manually'],
        ['❌ Cancel'],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  };
}

async function enter(ctx) {
  ctx.session = { scene: 'channels' };
  const channels = await channelsModel.list();
  const { healthy, flagged, total } = healthSummary(channels);

  const summaryLine = total === 0
    ? `📡 Channels (0 registered)`
    : `📡 Channels — ${total} registered · 🟢 ${healthy} healthy${flagged ? ` · 🔴 ${flagged} need attention` : ''}`;

  await ctx.reply(
    `${summaryLine}\n\nTap "🤖 Add Bot to Channel" to connect one — you'll pick from a native Telegram list pre-filtered to channels where the bot already qualifies.`,
    subScreenReplyKeyboard()
  );
  await ctx.reply(channels.length ? 'Registered channels:' : 'No channels registered yet.', listKeyboard(channels));
}

// Restores exactly the screen described by a popped nav-stack frame.
async function renderFromNavFrame(ctx, frame) {
  if (frame.view === 'list') return enter(ctx);
  if (frame.view === 'detail') return renderChannelView(ctx, frame.chatId, { edit: true });
  return enter(ctx);
}

// Accepts: forwarded message, @username, numeric chat ID, or a t.me link.
function extractChannelRef(ctx) {
  const text = ctx.message.text?.trim();
  const forwardChat = ctx.message.forward_from_chat;

  if (forwardChat) return { chatId: forwardChat.id };
  if (!text) return null;
  if (text.startsWith('@')) return { chatId: text };
  if (/^-?\d+$/.test(text)) return { chatId: text };

  const linkMatch = text.match(/^(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{5,})\/?$/i);
  if (linkMatch) return { chatId: `@${linkMatch[1]}` };

  return null;
}

async function registerChannel(ctx, chatId) {
  const permResult = await checkChannelPermissions(ctx.telegram, chatId);
  if (!permResult.isAdmin) {
    await ctx.reply("⚠️ I'm in that chat but not an admin there yet. Promote me to admin with post permissions, then try again.", subScreenReplyKeyboard());
    return;
  }
  if (!permResult.ok) {
    await ctx.reply(`⚠️ I'm an admin there, but the "Post messages" permission is off, so I still can't send anything:\n\n${formatPermissionReport(permResult)}`, subScreenReplyKeyboard());
    return;
  }
  const chat = await ctx.telegram.getChat(chatId);
  const saved = await channelsModel.add({ chatId: chat.id, title: chat.title, username: chat.username });
  await channelsModel.setPermissions(saved.chat_id, permResult);
  await ctx.reply(`✅ Registered: ${saved.title || saved.chat_id}\n\n${formatPermissionReport(permResult)}`, subScreenReplyKeyboard());
  await enter(ctx);
}

async function handleText(ctx) {
  if (ctx.message.text === '✏️ Add Manually') {
    await ctx.reply(
      'Send the channel\'s @username, numeric chat ID, t.me link, or forward a message from it.',
      subScreenReplyKeyboard()
    );
    return;
  }

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
    await ctx.reply(`🔴 Couldn't verify that channel: ${err.message}\n\nMake sure the bot has been added to it first.`, subScreenReplyKeyboard());
  }
}

// Handles the result of the native chat picker. Registered generically on
// 'message' in bot/index.js since chat_shared rides on a plain message,
// not its own update type.
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
    [Markup.button.callback('⬅️ Back', 'nav:back')],
  ];
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
      'Tap below to pick from channels where I\'m already an admin who can post.',
      requestChatKeyboard()
    );
  });

  bot.action(/^channels:view:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    navStack.push(ctx, { scene: 'channels', view: 'list' });
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

  bot.action('channels:recheckall', async (ctx) => {
    await ctx.answerCbQuery('Checking all channels...');
    const channels = await channelsModel.list();
    for (const ch of channels) {
      const result = await checkChannelPermissions(ctx.telegram, ch.chat_id);
      await channelsModel.setPermissions(ch.chat_id, result);
    }
    await ctx.reply(`🔄 Rechecked ${channels.length} channel(s).`);
    await enter(ctx);
  });

  bot.action('channels:muteall', async (ctx) => {
    await ctx.answerCbQuery();
    const channels = await channelsModel.list();
    const shouldMute = channels.some((c) => !c.muted);
    for (const ch of channels) {
      await channelsModel.setMuted(ch.chat_id, shouldMute);
    }
    await ctx.reply(shouldMute ? '🔕 Muted alerts for all channels.' : '🔔 Unmuted alerts for all channels.');
    await enter(ctx);
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
    await ctx.reply('Send a custom label for this channel (for your own reference only - won\'t rename the actual Telegram channel). Send "-" to clear it.');
  });

  bot.action(/^channels:remove:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(
      'Remove this channel from the bot? Past posts stay in the channel itself.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, remove', `channels:removeconfirm:${chatId}`)],
        [Markup.button.callback('⬅️ Back', 'nav:back')],
      ])
    );
  });

  bot.action(/^channels:removeconfirm:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Removed');
    await channelsModel.remove(chatId);
    await ctx.reply('🗑 Channel removed.');
    await enter(ctx);
  });
}

module.exports = { enter, handleText, handleChatShared, registerHandlers, renderFromNavFrame };
