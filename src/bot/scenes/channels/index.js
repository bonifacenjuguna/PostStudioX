const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const { subScreenReplyKeyboard } = require('../../components/navRow');
const { isEffectivelyAdmin, describeIssue, formatPermissions } = require('../../../services/channelPermissions');

const CHAT_REQUEST_ID = 9001; // arbitrary constant id for the one request_chat button we use

function listKeyboard(channels) {
  const rows = channels.map((c) => [
    Markup.button.callback(`${c.is_admin ? '🟢' : '🔴'}${c.muted ? ' 🔕' : ''} ${c.title || c.chat_id}`, `channels:view:${c.chat_id}`),
  ]);
  rows.push([Markup.button.callback('➕ Add Channel', 'channels:add')]);
  return Markup.inlineKeyboard(rows);
}

// Reply keyboard used only while "waiting to register a channel" - offers
// Telegram's native chat picker (filtered to channels the owner can grant
// the bot access to) alongside the existing text-based methods.
function addChannelReplyKeyboard() {
  return Markup.keyboard([
    [{ text: '📡 Choose a Channel', request_chat: { request_id: CHAT_REQUEST_ID, chat_is_channel: true, bot_is_member: false } }],
    ['⬅️ Back to Home'],
  ]).resize();
}

async function enter(ctx) {
  ctx.session = { scene: 'channels' };
  const channels = await channelsModel.list();
  await ctx.reply(
    `📡 Channels (${channels.length} registered)\n\n` +
      'Registered channels show 🟢 (can post) or 🔴 (an issue) plus 🔕 if alerts are muted for it.',
    subScreenReplyKeyboard()
  );
  await ctx.reply(channels.length ? 'Registered channels:' : 'No channels registered yet.', listKeyboard(channels));
}

function extractChannelRef(text) {
  const trimmed = text.trim();
  // t.me/xxxx or https://t.me/xxxx or @xxxx
  const linkMatch = trimmed.match(/^(?:https?:\/\/)?t\.me\/(?:c\/)?([A-Za-z0-9_]+)/i);
  if (linkMatch) return { username: linkMatch[1] };
  if (trimmed.startsWith('@')) return { username: trimmed.slice(1) };
  if (/^-?\d+$/.test(trimmed)) return { chatId: trimmed };
  return null;
}

async function registerChannelFromChatId(ctx, chatIdOrUsername) {
  const target = typeof chatIdOrUsername === 'string' && chatIdOrUsername.startsWith('@')
    ? chatIdOrUsername
    : chatIdOrUsername;
  try {
    const me = await ctx.telegram.getMe();
    const member = await ctx.telegram.getChatMember(target, me.id);
    if (!isEffectivelyAdmin(member)) {
      await ctx.reply(
        `⚠️ I'm in that chat, but ${describeIssue(member)}.\n\nPromote me to admin with "Post Messages" rights, then try again.`
      );
      return;
    }
    const chat = await ctx.telegram.getChat(target);
    const saved = await channelsModel.add({ chatId: chat.id, title: chat.title, username: chat.username });
    await ctx.reply(`✅ Registered: ${saved.title || saved.chat_id}`, subScreenReplyKeyboard());
    await enter(ctx);
  } catch (err) {
    await ctx.reply(`🔴 Couldn't verify that channel: ${err.message}\n\nMake sure the bot has been added to it first.`);
  }
}

async function handleText(ctx) {
  const text = ctx.message.text?.trim();
  const forwardChat = ctx.message.forward_from_chat;

  if (forwardChat) {
    await registerChannelFromChatId(ctx, forwardChat.id);
    return;
  }

  const ref = text ? extractChannelRef(text) : null;
  if (!ref) return; // not a channel reference - ignore, other handlers may process it

  await registerChannelFromChatId(ctx, ref.username ? `@${ref.username}` : ref.chatId);
}

// Handles Telegram's native "chat picker" result (request_chat button tap).
// Arrives as an ordinary message with a `chat_shared` field, not text - so
// it needs its own listener rather than going through handleText.
async function handleChatShared(ctx) {
  const shared = ctx.message.chat_shared;
  if (!shared || shared.request_id !== CHAT_REQUEST_ID) return;
  await registerChannelFromChatId(ctx, shared.chat_id);
}

function channelViewKeyboard(channel) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Re-check Rights', `channels:recheck:${channel.chat_id}`)],
    [Markup.button.callback(channel.muted ? '🔔 Unmute Alerts' : '🔕 Mute Alerts', `channels:mute:${channel.chat_id}`)],
    [Markup.button.callback('🗑 Remove Channel', `channels:remove:${channel.chat_id}`)],
    [Markup.button.callback('🏠 Home', 'nav:home')],
  ]);
}

async function registerHandlers(bot) {
  bot.action('channels:add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      'Register a channel any of these ways:\n\n' +
        '• Tap "📡 Choose a Channel" below to pick it from your chat list\n' +
        '• Forward any message from the channel\n' +
        '• Send its @username\n' +
        '• Send a t.me/ link\n' +
        '• Send its numeric chat ID\n\n' +
        'The bot must already be added to the channel as admin with "Post Messages" rights.',
      addChannelReplyKeyboard()
    );
  });

  // Native chat picker result - not text, needs its own generic message
  // listener. Always calls next() when it's not a chat_shared update so it
  // never interferes with any other message handler in the chain.
  bot.on('message', async (ctx, next) => {
    if (ctx.message?.chat_shared) {
      await handleChatShared(ctx);
      return;
    }
    return next();
  });

  bot.action(/^channels:view:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return ctx.reply('Channel not found.');
    const status = channel.is_admin ? '🟢 Can post' : `🔴 Issue: ${channel.admin_issue || 'unknown'}`;
    await ctx.reply(
      `📡 ${channel.title || channel.chat_id}\n${status}${channel.muted ? '\n🔕 Alerts muted' : ''}\n` +
        `Last checked: ${channel.last_checked_at ? new Date(channel.last_checked_at).toLocaleString() : 'never'}`,
      channelViewKeyboard(channel)
    );
  });

  bot.action(/^channels:recheck:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Checking...');
    try {
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chatId, me.id);
      const isAdmin = isEffectivelyAdmin(member);
      await channelsModel.setAdminStatus(chatId, isAdmin, isAdmin ? null : describeIssue(member));
      await ctx.reply(formatPermissions(member));
    } catch (err) {
      await channelsModel.setAdminStatus(chatId, false, err.message);
      await ctx.reply(`🔴 Check failed: ${err.message}`);
    }
  });

  bot.action(/^channels:mute:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return ctx.reply('Channel not found.');
    const updated = await channelsModel.setMuted(chatId, !channel.muted);
    try {
      await ctx.editMessageText(
        `📡 ${updated.title || updated.chat_id}\n${updated.is_admin ? '🟢 Can post' : '🔴 Issue: ' + (updated.admin_issue || 'unknown')}${updated.muted ? '\n🔕 Alerts muted' : ''}`,
        channelViewKeyboard(updated)
      );
    } catch (_) {
      await ctx.reply(updated.muted ? '🔕 Alerts muted for this channel.' : '🔔 Alerts unmuted for this channel.');
    }
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

module.exports = { enter, handleText, registerHandlers };
