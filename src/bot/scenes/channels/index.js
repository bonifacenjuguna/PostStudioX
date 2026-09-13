const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const { subScreenReplyKeyboard, backHomeRow } = require('../../components/navRow');
const {
  isEffectivelyAdmin,
  describeIssue,
  formatPermissions,
  snapshotRights,
  grantedVsMissing,
} = require('../../../services/channelPermissions');
const { queueToggleSignMessages, queueSetChannelSignature } = require('../../../queue/gramjsCommands');
const { logAction } = require('../../../services/actionErrors');

const CHAT_REQUEST_ID = 9001; // arbitrary constant id for the one request_chat button we use
const MAX_SIGNATURE_LENGTH = 16; // Telegram's own limit on admin custom titles

function listKeyboard(channels) {
  const rows = channels.map((c) => [
    Markup.button.callback(`${c.is_admin ? '🟢' : '🔴'}${c.muted ? ' 🔕' : ''} ${c.title || c.chat_id}`, `channels:view:${c.chat_id}`),
  ]);
  rows.push([Markup.button.callback('➕ Add Channel', 'channels:add')]);
  return Markup.inlineKeyboard(rows);
}

// Reply keyboard used only while "waiting to register a channel" - the
// request_chat button opens Telegram's native chat picker, filtered to
// channels the owner administers.
//
// v2.0.2 FIX: this used to also set `bot_administrator_rights` to preselect
// this bot's needed permissions in the picker (the "Add Bot to a Channel"
// feel from the original request). That field kept causing
// USER_RIGHTS_MISSING even after correcting it to include every required
// ChatAdministratorRights field - and without a live Telegram connection to
// test against, guessing at its exact expected shape a third time isn't a
// responsible use of your time. Dropped entirely in favor of the plain,
// extremely well-established form of this button (no rights payload) that
// works everywhere. Rights are still checked and shown immediately after
// the channel is picked (registerChannelFromChatId, below) - that part
// never depended on this field.
function addChannelReplyKeyboard() {
  return Markup.keyboard([
    [{
      text: '➕ Pick a Channel',
      request_chat: {
        request_id: CHAT_REQUEST_ID,
        chat_is_channel: true,
        bot_is_member: false,
        request_title: true,
        request_username: true,
      },
    }],
    ['⬅️ Back to Home'],
  ]).resize();
}

async function enter(ctx) {
  ctx.session = { scene: 'channels' };
  const channels = await channelsModel.list();
  await ctx.reply(
    `📡 Channels (${channels.length} registered)\n\n` +
      'Registered channels show 🟢 (can post) or 🔴 (an issue), plus 🔕 if alerts are muted for it.\n' +
      'Tap a channel to open its Manage Channel screen.',
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
  const target = chatIdOrUsername;
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
    await channelsModel.setAdminRights(saved.chat_id, snapshotRights(member));
    await ctx.reply(`✅ Registered: ${saved.title || saved.chat_id}\n\nUse Manage Channel any time to check rights, mute alerts, or set a post signature.`, subScreenReplyKeyboard());
    await enter(ctx);
  } catch (err) {
    // v2.2.0 FIX (#1, round 2): "chat not found" is the single most common,
    // fully expected outcome here - it just means the bot hasn't been
    // added to that chat yet, not an actual system error. Give it its own
    // plain-language message instead of the raw diagnostic format, which
    // is meant for genuinely unexpected failures, not routine "not set up
    // yet" states.
    const description = err?.description || err?.message || '';
    if (/chat not found/i.test(description)) {
      await ctx.reply(
        "🔍 I couldn't find that chat — it looks like the bot hasn't been added to it yet.\n\n" +
          'To fix this: open the channel in Telegram, add this bot as an admin (with at least "Post Messages" rights), then try adding it here again.'
      );
      return;
    }
    const msg = await logAction({ scene: 'channels', step: 'register', attempted: `verify admin status for ${target}`, error: err });
    await ctx.reply(`${msg}\n\nMake sure the bot has been added to it first.`);
  }
}

async function handleText(ctx) {
  const text = ctx.message.text?.trim();
  const forwardChat = ctx.message.forward_from_chat;

  // A pending "type your post signature" prompt takes priority over channel
  // registration parsing, so the same text-message pipe can serve both.
  const pending = ctx.session?.pendingAction;
  if (pending?.type === 'set_signature') {
    ctx.session.pendingAction = null;
    await handleSignatureInput(ctx, pending.chatId, text || '');
    return;
  }

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

function stripEmojiAndTrim(raw) {
  // Admin custom titles reject emoji and cap at 16 chars - strip common
  // emoji/symbol ranges rather than let Telegram bounce it with a cryptic
  // BUTTON_USER_PRIVACY_RESTRICTED-style error.
  const noEmoji = raw.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();
  return noEmoji.slice(0, MAX_SIGNATURE_LENGTH);
}

async function handleSignatureInput(ctx, chatId, rawText) {
  const cleaned = stripEmojiAndTrim(rawText);
  if (!cleaned) {
    await ctx.reply('That signature ended up empty after removing emoji (not allowed by Telegram) - try plain text, 16 characters max.');
    return;
  }
  try {
    // v2.2.0 FIX (#2, round 2): setChatAdministratorCustomTitle (the Bot
    // API method previously used here) is confirmed groups/supergroups-only
    // - it does not work for channels at all, which is this bot's entire
    // use case. Routed through the GramJS command queue instead (same
    // mechanism as the Sign Messages toggle), since setting an admin's
    // custom title/signature in a CHANNEL is only reachable via a full
    // MTProto user session, not the Bot API.
    const me = await ctx.telegram.getMe();
    await queueSetChannelSignature(chatId, me.id, cleaned);
    await channelsModel.setPostSignature(chatId, cleaned);
    const truncatedNote = cleaned.length < rawText.trim().length ? '\n(shortened/cleaned to fit Telegram\'s 16-character, no-emoji limit)' : '';
    await ctx.reply(
      `🖋 Requested: setting post signature to "${cleaned}".${truncatedNote}\n\n` +
        'This runs through the GramJS monitor service (needs your MTProto session configured) and can take a few seconds. ' +
        'This only shows on posts if the channel also has "Sign messages" turned on - use 🔔 Enable Sign Messages below if it isn\'t yet.\n\n' +
        'If it doesn\'t seem to take effect, check ⚙️ Settings → 🛡 Watchdog for the GramJS connection status.'
    );
  } catch (err) {
    const msg = await logAction({ scene: 'channels', step: 'set_signature', attempted: `queue channel signature update for ${chatId}`, error: err, chatId });
    await ctx.reply(msg);
  }
  await showChannelView(ctx, chatId);
}

function channelViewText(channel) {
  const status = channel.is_admin ? '🟢 Can post' : `🔴 Issue: ${channel.admin_issue || 'unknown'}`;
  const { granted, missing } = grantedVsMissing(channel.admin_rights);
  const rightsBlock = channel.rights_checked_at
    ? `\n\n✅ Granted: ${granted.length ? granted.join(', ') : 'none'}` +
      `\n⚪️ Missing: ${missing.length ? missing.join(', ') : 'none'}`
    : '\n\n(Rights not checked yet - tap 🔄 Re-check Rights)';

  return (
    `📡 Manage Channel: ${channel.title || channel.chat_id}\n${status}` +
    `${channel.muted ? '\n🔕 Alerts muted' : ''}` +
    `${channel.post_signature ? `\n🖋 Signature: "${channel.post_signature}"` : ''}` +
    `\n${channel.sign_messages ? '🔔' : '🔕'} Sign messages: ${channel.sign_messages ? 'on' : 'off'}` +
    rightsBlock +
    `\n\nLast checked: ${channel.last_checked_at ? new Date(channel.last_checked_at).toLocaleString() : 'never'}`
  );
}

function channelViewKeyboard(channel) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Re-check Rights', `channels:recheck:${channel.chat_id}`)],
    [Markup.button.callback('🖋 Set Post Signature', `channels:setsig:${channel.chat_id}`)],
    [Markup.button.callback(channel.sign_messages ? '🔕 Disable Sign Messages' : '🔔 Enable Sign Messages', `channels:togglesign:${channel.chat_id}`)],
    [Markup.button.callback(channel.muted ? '🔔 Unmute Alerts' : '🔕 Mute Alerts', `channels:mute:${channel.chat_id}`)],
    [Markup.button.callback('🗑 Remove Channel', `channels:remove:${channel.chat_id}`)],
    backHomeRow('channels:list'),
  ]);
}

async function showChannelView(ctx, chatId) {
  const channel = await channelsModel.findByChatId(chatId);
  if (!channel) {
    await ctx.reply('Channel not found - it may have just been removed.');
    return;
  }
  await ctx.reply(channelViewText(channel), channelViewKeyboard(channel));
}

async function registerHandlers(bot) {
  bot.action('channels:list', async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx);
  });

  bot.action('channels:add', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      '➕ Add a channel any of these ways:\n\n' +
        '• Tap "➕ Pick a Channel" below - Telegram will suggest this bot\'s needed admin rights automatically, just confirm\n' +
        '• Forward any message from the channel\n' +
        '• Send its @username, a t.me/ link, or its numeric chat ID\n\n' +
        'Either way, the bot needs to already be an admin there with "Post Messages" rights.',
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
    await showChannelView(ctx, chatId);
  });

  bot.action(/^channels:recheck:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery('Checking...');
    try {
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(chatId, me.id);
      const isAdmin = isEffectivelyAdmin(member);
      await channelsModel.setAdminStatus(chatId, isAdmin, isAdmin ? null : describeIssue(member));
      await channelsModel.setAdminRights(chatId, snapshotRights(member));
      await ctx.reply(formatPermissions(member));
      await showChannelView(ctx, chatId);
    } catch (err) {
      await channelsModel.setAdminStatus(chatId, false, err.message);
      const msg = await logAction({ scene: 'channels', step: 'recheck', attempted: `read admin rights via getChatMember for ${chatId}`, error: err, chatId });
      await ctx.reply(msg);
    }
  });

  bot.action(/^channels:setsig:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session = ctx.session || {};
    ctx.session.pendingAction = { type: 'set_signature', chatId };
    await ctx.reply(
      '🖋 Send the signature text you want to appear on posts in this channel.\n\n' +
        `Telegram limits this to ${MAX_SIGNATURE_LENGTH} characters and no emoji - I'll trim/clean it automatically if needed.`
    );
  });

  bot.action(/^channels:togglesign:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return ctx.reply('Channel not found.');
    const nextState = !channel.sign_messages;
    try {
      await queueToggleSignMessages(chatId, nextState);
      await channelsModel.setSignMessages(chatId, nextState);
      await ctx.reply(
        `${nextState ? '🔔 Requested: turning on' : '🔕 Requested: turning off'} Sign Messages for this channel.\n\n` +
          'This runs through the GramJS monitor service (it needs your MTProto session configured) and can take a few seconds. ' +
          'If it doesn\'t seem to take effect, check ⚙️ Settings → 🛡 Watchdog for the GramJS connection status.'
      );
    } catch (err) {
      const msg = await logAction({ scene: 'channels', step: 'toggle_sign_messages', attempted: `queue toggle_signatures request for ${chatId}`, error: err, chatId });
      await ctx.reply(msg);
    }
    await showChannelView(ctx, chatId);
  });

  bot.action(/^channels:mute:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    const channel = await channelsModel.findByChatId(chatId);
    if (!channel) return ctx.reply('Channel not found.');
    const updated = await channelsModel.setMuted(chatId, !channel.muted);
    try {
      await ctx.editMessageText(channelViewText(updated), channelViewKeyboard(updated));
    } catch (_) {
      await showChannelView(ctx, chatId);
    }
  });

  bot.action(/^channels:remove:(.+)$/, async (ctx) => {
    const chatId = ctx.match[1];
    await ctx.answerCbQuery();
    await ctx.reply(
      'Remove this channel from the bot? Past posts stay in the channel itself - this only stops the bot managing it.',
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
