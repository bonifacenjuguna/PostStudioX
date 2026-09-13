// The "give me a link or forward the whole message, then edit it" feature.
// Distinct from Compose's Import (which brings content in as a NEW draft) -
// this one targets an ALREADY-LIVE channel post directly, in place.
//
// v2.2.2 REDESIGN: previously offered a choice between "Edit In Place"
// (a separate, limited menu-based flow that turned out to be buggy - see
// CHANGELOG v2.2.1) and "Replace Entirely" (delete + start a fresh Compose
// post) - the two didn't share any actual editing machinery, and Replace
// Entirely wasn't earning its keep as its own choice. Now there's exactly
// one path: straight into the SAME Compose flow used for everything else
// (all its formatting/button/option tools, pre-filled with the existing
// content), ending in a single "🔄 Replace Live Post" action at Finish that
// automatically does the right thing - an in-place edit when Telegram's
// API can express the change, or a delete-and-resend only when the content
// type genuinely changed shape (e.g. text -> photo) and editing in place
// isn't possible. See create-post/index.js's cp:finish:replace handler for
// that logic.
//
// Triggers ambiently: forward a channel post to the bot, or paste a t.me
// link, while not in the middle of any other flow (idle/Home state) - no
// menu navigation needed. Registered to run AFTER sceneRouter (see
// bot/index.js), which already calls next() for idle-session text/media,
// so this only ever fires when nothing else claimed the message first.

const channelsModel = require('../../db/models/channels');
const savedItems = require('../../db/models/savedItems');
const { extractDraftFieldsFromMessage } = require('../../services/messageAdapter');
const { parseTmeLink } = require('../../services/telegramLinks');
const { isEffectivelyAdmin, describeIssue } = require('../../services/channelPermissions');
const { logAction } = require('../../services/actionErrors');
const { flowReplyKeyboard } = require('../components/navRow');

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
    if (!channel) return { error: `"${parsed.username}" isn't one of your registered channels — only channels the bot manages can be edited this way.` };
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
  // the system (Compose's replace, History) can work with it normally.
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

async function startEditFlow(ctx) {
  const target = await resolveTarget(ctx);
  if (!target) return false; // not a forward or link - let other handlers try
  if (target.error) {
    await ctx.reply(`🔴 ${target.error}`);
    return true;
  }

  const me = await ctx.telegram.getMe();
  const member = await ctx.telegram.getChatMember(target.chatId, me.id).catch(() => null);
  if (!isEffectivelyAdmin(member)) {
    await ctx.reply(`🔴 Can't edit that: ${describeIssue(member) || 'the bot isn\'t an admin there'}.`);
    return true;
  }

  const item = await ensureTrackedItem(target.chatId, target.messageId, target.message);

  // Same loading pattern as Templates' "Use in Compose" (tpl:use) - the
  // one difference is draft.replaceTarget, which is what tells Compose's
  // Preview/Finish step to show "🔄 Replace Live Post" instead of the
  // normal Save/Send/Schedule options.
  ctx.session = {
    scene: 'create-post',
    draft: {
      channelIds: [target.chatId], mediaType: item.media_type, mediaItems: item.media_items || [],
      caption: item.caption || '', entities: item.entities || [], buttons: item.buttons || [], options: item.options || {},
      replaceTarget: { itemId: item.id, chatId: target.chatId, messageId: target.messageId, originalMediaType: item.media_type },
    },
  };
  await ctx.reply('📍 Found it — editing this post. Use any of the tools below, then tap 🔄 Replace Live Post when ready.', flowReplyKeyboard());
  const createPost = require('../scenes/create-post');
  await createPost.goToPreview(ctx);
  return true;
}

function registerHandlers(bot) {
  // Registered AFTER registerSceneRouter in bot/index.js - sceneRouter
  // already calls next() for idle sessions, so these only run when nothing
  // else claimed the message (i.e. genuinely idle, matching the "ambient
  // trigger" design).
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.scene) return next();
    const handled = await startEditFlow(ctx);
    if (!handled) return next();
  });

  bot.on(['photo', 'video', 'document'], async (ctx, next) => {
    if (ctx.session?.scene) return next();
    const handled = await startEditFlow(ctx);
    if (!handled) return next();
  });
}

module.exports = { registerHandlers };
