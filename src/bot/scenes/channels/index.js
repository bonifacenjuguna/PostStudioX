const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const { subScreenReplyKeyboard } = require('../../components/navRow');

function listKeyboard(channels) {
  const rows = channels.map((c) => [
    Markup.button.callback(`${c.is_admin ? '🟢' : '🔴'} ${c.title || c.chat_id}`, `channels:view:${c.chat_id}`),
  ]);
  rows.push([Markup.button.callback('➕ Add Channel', 'channels:add')]);
  return Markup.inlineKeyboard(rows);
}

async function enter(ctx) {
  const channels = await channelsModel.list();
  await ctx.reply(
    `📡 Channels (${channels.length} registered)\n\nForward a message from a channel, or send its @username / chat ID, to register it.`,
    subScreenReplyKeyboard()
  );
  await ctx.reply(channels.length ? 'Registered channels:' : 'No channels registered yet.', listKeyboard(channels));
}

async function handleText(ctx) {
  const text = ctx.message.text?.trim();
  const forwardChat = ctx.message.forward_from_chat;

  let chatId, title, username;

  if (forwardChat) {
    chatId = forwardChat.id;
    title = forwardChat.title;
    username = forwardChat.username;
  } else if (text?.startsWith('@')) {
    username = text.slice(1);
    chatId = text;
  } else if (text?.match(/^-?\d+$/)) {
    chatId = text;
  } else {
    return; // not a channel reference - ignore, other handlers may process it
  }

  try {
    const me = await ctx.telegram.getMe();
    const member = await ctx.telegram.getChatMember(chatId, me.id);
    const isAdmin = ['administrator', 'creator'].includes(member.status);
    if (!isAdmin) {
      await ctx.reply(`⚠️ I'm in that chat but not an admin there yet. Promote me to admin with post permissions, then try again.`);
      return;
    }
    const chat = await ctx.telegram.getChat(chatId);
    const saved = await channelsModel.add({ chatId: chat.id, title: chat.title, username: chat.username });
    await ctx.reply(`✅ Registered: ${saved.title || saved.chat_id}`);
    await enter(ctx);
  } catch (err) {
    await ctx.reply(`🔴 Couldn't verify that channel: ${err.message}\n\nMake sure the bot has been added to it first.`);
  }
}

async function registerHandlers(bot) {
  bot.action('channels:add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Forward a message from the channel, or send its @username / numeric chat ID.');
  });

  bot.action(/^channels:view:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return ctx.reply('Channel not found.');
    const status = channel.is_admin ? '🟢 Admin OK' : `🔴 Issue: ${channel.admin_issue || 'unknown'}`;
    await ctx.reply(
      `📡 ${channel.title || channel.chat_id}\n${status}\nLast checked: ${channel.last_checked_at ? new Date(channel.last_checked_at).toLocaleString() : 'never'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Re-check Rights', `channels:recheck:${chatId}`)],
        [Markup.button.callback('🗑 Remove Channel', `channels:remove:${chatId}`)],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action(/^channels:recheck:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Checking...');
    try {
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chatId, me.id);
      const isAdmin = ['administrator', 'creator'].includes(member.status);
      await channelsModel.setAdminStatus(chatId, isAdmin, isAdmin ? null : `status: ${member.status}`);
      await ctx.reply(isAdmin ? '🟢 Admin rights confirmed.' : `🔴 Not an admin (status: ${member.status})`);
    } catch (err) {
      await channelsModel.setAdminStatus(chatId, false, err.message);
      await ctx.reply(`🔴 Check failed: ${err.message}`);
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
