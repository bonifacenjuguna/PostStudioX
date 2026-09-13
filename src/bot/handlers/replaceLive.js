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
const savedItems = require('../../db/models/savedItems');
const { extractDraftFieldsFromMessage } = require('../../services/messageAdapter');
const { buildInlineKeyboard } = require('../../services/buttonBuilder');
const { publishSavedItem } = require('../../services/publisher');
const { resolveLiveMessageRef } = require('../../services/liveMessageResolver');
const channelsModel = require('../../db/models/channels');
const { isEffectivelyAdmin, describeIssue } = require('../../services/channelPermissions');
const { logAction } = require('../../services/actionErrors');
const { homeReplyKeyboard } = require('../components/navRow');

const GLOBAL_COMMANDS = /^\/(start|help|status|reset)(\s|$)/i;

async function resolveTarget(ctx) {
  const resolved = await resolveLiveMessageRef(ctx, { channelsModel });
  if (!resolved) return null; // not a forward or link - let other handlers try
  if (resolved.error) return { error: resolved.error };
  return resolved;
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
  // can_edit_messages is only required to edit a message some OTHER admin
  // posted - a bot can always edit its own posts without it, and channel
  // posts don't reliably expose authorship info to this API to tell those
  // cases apart up front. So this can't safely gate the flow (that would
  // break it for people whose bot only edits its own posts), but it's
  // worth a heads-up: if this specific post turns out not to be one the
  // bot originally sent, this is the most likely reason an edit attempt
  // would fail.
  const missingEditRight = member.status !== 'creator' && member.can_edit_messages !== true;

  const item = await ensureTrackedItem(target.chatId, target.messageId, target.message);
  ctx.session = { scene: 'replace-live', pendingItemId: item.id, pendingChatId: target.chatId, pendingMessageId: target.messageId };

  await ctx.reply(
    `📍 Found this post in ${target.chatId}.${missingEditRight ? '\n\n⚠️ Heads up: the bot is admin here without "Edit Messages" rights — if this post wasn\'t originally sent by this bot, an edit attempt will fail with a permissions error.' : ''}\n\nWhat do you want to do with it?`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Edit In Place', `rl:edit:${item.id}`)],
      [Markup.button.callback('🔄 Replace Entirely', `rl:replace:${item.id}`)],
      [Markup.button.callback('❌ Cancel', 'nav:cancel')],
    ])
  );
  return true;
}

// Content-type buckets for deciding whether Telegram can edit the existing
// message into the new content, or whether it needs a delete + repost.
// editMessageText only works on a message that has never had media;
// editMessageMedia only works on one that already does - neither API can
// cross that line, so "is this message text-shaped or media-shaped" is the
// only distinction that matters here (photo -> video, photo -> document,
// etc. are all fine in place; text -> photo or photo -> text are not).
function isTextShaped(mediaType) {
  return !mediaType || mediaType === 'text';
}

// BUGFIX (Replace Entirely): this used to unconditionally delete the live
// message and hand off to the full Compose wizard for every replacement,
// even a plain "same kind of content, just different text/media" swap -
// which is why it always looked like a fresh post going out rather than an
// edit. Now it takes whatever's sent next exactly as-is (native Telegram
// formatting entities, not re-parsed through Compose's typed shorthand, so
// nothing about the formatting can be mangled in translation) and edits
// the SAME live message in place whenever Telegram's API allows it -
// same message id, same position, no new post. Delete + repost only
// happens for the one case Telegram genuinely can't edit around: a
// text <-> media type change - and even then, only after asking first.
async function handleReplacementContent(ctx) {
  const itemId = ctx.session.targetItemId;
  const item = await savedItems.findById(itemId);
  if (!item) {
    await ctx.reply('That post is no longer tracked — nothing to replace.', homeReplyKeyboard());
    ctx.session = {};
    return;
  }

  const refs = item.current_message_refs || [];
  if (refs.length === 0) {
    await ctx.reply('Nothing to replace — no live message is tracked for this post.', homeReplyKeyboard());
    ctx.session = {};
    return;
  }

  // A media group (album) is multiple messages, one per item - a single
  // incoming message can't stand in for that 1:1. Not something in-place
  // Replace can handle; Delete (via Edit In Place) + a fresh Compose album
  // still covers this case.
  if (item.media_type === 'media_group' || refs.length > 1) {
    await ctx.reply(
      '🔴 This live post is a media group (album) — a single replacement message can\'t stand in for multiple album items. Use ✏️ Edit In Place → 🗑 (delete each), then 🎨 Compose a fresh album instead.',
      homeReplyKeyboard()
    );
    ctx.session = {};
    return;
  }

  const fields = extractDraftFieldsFromMessage(ctx.message);
  const ref = refs[0];
  const oldIsText = isTextShaped(item.media_type);
  const newIsText = isTextShaped(fields.mediaType);

  if (oldIsText === newIsText) {
    // Editable in place - same message identity throughout.
    try {
      if (newIsText) {
        await ctx.telegram.editMessageText(ref.chat_id, ref.message_id, undefined, fields.caption, {
          entities: fields.entities && fields.entities.length ? fields.entities : undefined,
          reply_markup: buildInlineKeyboard(item.buttons),
        });
      } else {
        await ctx.telegram.editMessageMedia(ref.chat_id, ref.message_id, undefined, {
          type: fields.mediaType,
          media: fields.mediaItems[0].file_id,
          caption: fields.caption,
          caption_entities: fields.entities && fields.entities.length ? fields.entities : undefined,
        });
      }
      await savedItems.updateWithVersion(itemId, {
        media_type: fields.mediaType, media_items: fields.mediaItems,
        caption: fields.caption, entities: fields.entities,
      });
      await ctx.reply('✅ Replaced in place — same message, new content.', homeReplyKeyboard());
    } catch (err) {
      const msg = await logAction({ scene: 'replace-live', step: 'inplace_replace', attempted: `replace live content on ${ref.chat_id}/${ref.message_id}`, error: err, savedItemId: itemId });
      await ctx.reply(msg, homeReplyKeyboard());
    }
    ctx.session = {};
    return;
  }

  // Genuine text <-> media type change - ask before doing anything
  // destructive, rather than assuming it's wanted.
  ctx.session.step = 'awaiting_crosstype_confirm';
  ctx.session.pendingCrossTypeReplacement = { itemId, fields };
  await ctx.reply(
    `This live post is ${oldIsText ? 'text-only' : `a ${item.media_type}`}, and what you just sent is ${newIsText ? 'text-only' : `a ${fields.mediaType}`} — Telegram doesn't allow an in-place edit across that line (text ↔ media).\n\n` +
      'I can delete the old one and post this exact content fresh in its place instead. Want me to do that?',
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete + post this', 'rl:crosstype:confirm')],
      [Markup.button.callback('❌ Cancel', 'nav:cancel')],
    ])
  );
}

function registerHandlers(bot) {
  // Registered AFTER registerSceneRouter in bot/index.js - sceneRouter
  // already calls next() for idle sessions (and for the 'replace-live'
  // scene, which isn't in its scene map), so these only run when nothing
  // else claimed the message.
  bot.on('text', async (ctx, next) => {
    if (ctx.session?.scene === 'replace-live' && ctx.session?.step === 'awaiting_replacement_content') {
      if (GLOBAL_COMMANDS.test(ctx.message.text || '')) return next();
      return handleReplacementContent(ctx);
    }
    if (ctx.session?.scene) return next();
    const handled = await offerActions(ctx);
    if (!handled) return next();
  });

  bot.on(['photo', 'video', 'document'], async (ctx, next) => {
    if (ctx.session?.scene === 'replace-live' && ctx.session?.step === 'awaiting_replacement_content') {
      return handleReplacementContent(ctx);
    }
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
      'Replace this post\u2019s content? Confirm, then send the replacement message (text, photo, video, or document) right after — it\u2019s taken exactly as sent, formatting included, and edited into the SAME live message in place (no new post). Only a text ↔ media type change needs a delete + repost, and I\u2019ll confirm with you first if that\u2019s the case.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ OK, sending it next', `rl:replaceconfirm:${id}`)],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
  });

  bot.action(/^rl:replaceconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('That post is no longer tracked — nothing to replace.');
    ctx.session = { scene: 'replace-live', step: 'awaiting_replacement_content', targetItemId: id };
    await ctx.reply('Send the replacement message now (text, photo, video, or document):');
  });

  bot.action('rl:crosstype:confirm', async (ctx) => {
    await ctx.answerCbQuery();
    const pending = ctx.session?.pendingCrossTypeReplacement;
    if (!pending) {
      await ctx.reply('That replacement expired — forward/link the post again to retry.', homeReplyKeyboard());
      return;
    }
    const { itemId, fields } = pending;
    const item = await savedItems.findById(itemId);
    if (!item) {
      await ctx.reply('That post is no longer tracked.', homeReplyKeyboard());
      ctx.session = {};
      return;
    }
    const refs = item.current_message_refs || [];
    for (const ref of refs) {
      try {
        await ctx.telegram.deleteMessage(ref.chat_id, ref.message_id);
      } catch (err) {
        await logAction({ scene: 'replace-live', step: 'delete_for_crosstype_replace', attempted: `delete ${ref.chat_id}/${ref.message_id} before cross-type replace`, error: err, savedItemId: itemId });
      }
    }
    const updated = await savedItems.updateWithVersion(itemId, {
      status: 'draft', media_type: fields.mediaType, media_items: fields.mediaItems,
      caption: fields.caption, entities: fields.entities, current_message_refs: [],
    });
    try {
      await publishSavedItem(ctx.telegram, updated);
      await ctx.reply('🗑 Old post deleted, new content posted in its place.', homeReplyKeyboard());
    } catch (err) {
      const msg = await logAction({ scene: 'replace-live', step: 'crosstype_publish', attempted: `publish replacement for post ${itemId}`, error: err, savedItemId: itemId });
      await ctx.reply(`${msg}\n\n⚠️ The old post was already deleted and this new content did NOT go out — check the channel and re-send manually if needed.`, homeReplyKeyboard());
    }
    ctx.session = {};
  });
}

module.exports = { registerHandlers };
