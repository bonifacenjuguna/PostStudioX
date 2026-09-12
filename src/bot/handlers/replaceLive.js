// The "give me a link or forward the whole message, then let me edit or
// completely replace it" feature. Distinct from Compose's Import (which
// brings content in as a NEW draft) - this one targets an ALREADY-LIVE
// channel post directly, in place.
//
// Triggers ambiently: forward a channel post to the bot, or paste a t.me
// link, while not in the middle of any other flow (idle/Home state) - no
// menu navigation needed, matching exactly how this was described when
// requested. Registered to run AFTER sceneRouter (see bot/index.js), which
// already calls next() for idle-session text/media, so this only ever
// fires when nothing else claimed the message first.

const { Markup } = require('telegraf');
const channelsModel = require('../../db/models/channels');
const savedItems = require('../../db/models/savedItems');
const { extractDraftFieldsFromMessage } = require('../../services/messageAdapter');
const { parseTmeLink } = require('../../services/telegramLinks');
const { isEffectivelyAdmin, describeIssue } = require('../../services/channelPermissions');
const { logAction } = require('../../services/actionErrors');

async function resolveTarget(ctx) {
  // Case 1: forwarded straight into this chat.
  const sourceChat = ctx.message?.forward_from_chat || ctx.message?.forward_origin?.chat;
  if (sourceChat) {
    return {
      chatId: String(sourceChat.id),
      messageId: ctx.message.forward_from_message_id || ctx.message.message_id,
      message: ctx.message,
    };
  }

  // Case 2: a t.me link - only resolvable for channels this bot manages
  // (see Compose's Import feature for the same constraint and why).
  const text = ctx.message?.text?.trim();
  const parsed = text ? parseTmeLink(text) : null;
  if (!parsed) return null;

  let chatId = parsed.chatId;
  if (!chatId) {
    const channel = await channelsModel.list().then((list) => list.find((c) => c.username?.toLowerCase() === parsed.username.toLowerCase()));
    if (!channel) return { error: `"${parsed.username}" isn't one of your registered channels — only channels the bot manages can be edited/replaced this way.` };
    chatId = channel.chat_id;
  }

  try {
    const fetched = await ctx.telegram.forwardMessage(ctx.chat.id, chatId, parsed.messageId);
    await ctx.telegram.deleteMessage(ctx.chat.id, fetched.message_id).catch(() => {});
    return { chatId: String(chatId), messageId: parsed.messageId, message: fetched };
  } catch (err) {
    return { error: (await logAction({ scene: 'replace-live', step: 'resolve', attempted: `read post ${parsed.messageId} from ${chatId} via link`, error: err })) };
  }
}

async function ensureTrackedItem(chatId, messageId, message) {
  const existing = await savedItems.findByMessageRef(chatId, messageId);
  if (existing) return existing;

  // Not something we already track (e.g. an old post from before this
  // feature existed, or one sent outside this bot entirely) - adopt it by
  // creating a saved_item that points at the live message so the rest of
  // the system (Edit Post, History) can work with it normally from here on.
  const fields = extractDraftFieldsFromMessage(message);
  return savedItems.create({
    kind: 'post', status: 'sent', channelIds: [chatId], mediaType: fields.mediaType,
    mediaItems: fields.mediaItems, caption: fields.caption, entities: fields.entities,
    buttons: [], options: {}, importedFrom: { chat_id: chatId, message_id: messageId, via: 'replace-live-adopt' },
  }).then(async (item) => {
    await savedItems.updateWithVersion(item.id, { current_message_refs: [{ chat_id: chatId, message_id: messageId }] });
    return savedItems.findById(item.id);
  });
}

async function offerActions(ctx) {
  const target = await resolveTarget(ctx);
  if (!target) return false; // not a forward or link - let other handlers try
  if (target.error) {
    await ctx.reply(`🔴 ${target.error}`);
    return true;
  }

  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(target.chatId, me.id).catch(() => null);
  if (!isEffectivelyAdmin(member)) {
    await ctx.reply(`🔴 Can't edit or replace that: ${describeIssue(member) || 'the bot isn\'t an admin there'}.`);
    return true;
  }

  const item = await ensureTrackedItem(target.chatId, target.messageId, target.message);
  ctx.session = { scene: 'replace-live', pendingItemId: item.id, pendingChatId: target.chatId, pendingMessageId: target.messageId };

  await ctx.reply(
    `📍 Found this post in ${target.chatId}.\n\nWhat do you want to do with it?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit In Place', `rl:edit:${item.id}`)],
      [Markup.button.callback('🔄 Replace Entirely', `rl:replace:${item.id}`)],
      [Markup.button.callback('❌ Cancel', 'nav:cancel')],
    ])
  );
  return true;
}

function registerHandlers(bot) {
  // Registered AFTER registerSceneRouter in bot/index.js - sceneRouter
  // already calls next() for idle sessions, so these only run when nothing
  // else claimed the message (i.e. genuinely idle, matching the "ambient
  // trigger" design).
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.scene) return next();
    const handled = await offerActions(ctx);
    if (!handled) return next();
  });

  bot.on(['photo', 'video', 'document'], async (ctx, next) => {
    if (ctx.session?.scene) return next();
    const handled = await offerActions(ctx);
    if (!handled) return next();
  });

  bot.action(/^rl:edit:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const { openEditMenu } = require('../scenes/edit-post');
    await openEditMenu(ctx, id, { returnTo: 'nav:home' });
  });

  bot.action(/^rl:replace:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply(
      'Replace this post entirely? The live message gets deleted, then you compose a brand-new one to take its place in the same channel — useful if the new content is a different type (e.g. text → video).',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, delete + compose new', `rl:replaceconfirm:${id}`)],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
  });

  bot.action(/^rl:replaceconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('That post is no longer tracked — nothing to replace.');
    const refs = item.current_message_refs || [];
    for (const ref of refs) {
      try {
        await ctx.telegram.deleteMessage(ref.chat_id, ref.message_id);
      } catch (err) {
        await logAction({ scene: 'replace-live', step: 'delete_for_replace', attempted: `delete ${ref.chat_id}/${ref.message_id} before replacing`, error: err, savedItemId: id });
      }
    }
    await savedItems.updateWithVersion(id, { status: 'deleted' });
    await ctx.reply('🗑 Old post deleted. Compose its replacement:');
    const createPost = require('../scenes/create-post');
    ctx.session = {};
    await createPost.enter(ctx);
    // Pre-select the same channel so the replacement lands in the same place.
    if (ctx.session.draft) ctx.session.draft.channelIds = [String(item.channel_ids?.[0] || refs[0]?.chat_id)].filter(Boolean);
  });
}

module.exports = { registerHandlers };
