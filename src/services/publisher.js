// Single source of truth for "actually send this post to Telegram."
// Used both by the bot's immediate "Send Now" action and by the BullMQ
// scheduled-post worker, so the two paths can never drift apart.
//
// v1.1.0 FIX (#1): this function takes a Telegram *API client* (the object
// with .sendMessage/.sendPhoto/etc directly on it) - i.e. `ctx.telegram`
// from inside a Telegraf handler, or `bot.telegram` from a standalone
// Telegraf instance (like the queue worker). It is NOT a full Telegraf bot
// instance. The previous version was written as if it received a full bot
// and did `bot.telegram.sendMessage(...)` internally - which is why calls
// from create-post/edit-post (which correctly passed `ctx.telegram`, the
// API client) blew up with "Cannot read properties of undefined (reading
// 'sendMessage')": `ctx.telegram.telegram` doesn't exist. The worker's own
// call happened to pass a full bot, so it silently worked while in-chat
// "Send Now" / "Clone" did not. Standardized on the API client everywhere -
// see worker.js (now passes bot.telegram), create-post/index.js, and
// edit-post/index.js (already passed ctx.telegram, unchanged).

const { buildInlineKeyboard } = require('./buttonBuilder');
const savedItems = require('../db/models/savedItems');
const statsModel = require('../db/models/stats');
const mediaLibrary = require('../db/models/mediaLibrary');

const API_TIMEOUT_MS = 20000;

function withApiTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Telegram API call timed out after ${API_TIMEOUT_MS}ms: ${label}`));
    }, API_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function publishSavedItem(telegram, item) {
  if (!telegram || typeof telegram.sendMessage !== 'function') {
    throw new Error('publishSavedItem: expected a Telegram API client (ctx.telegram / bot.telegram), got something else.');
  }

  const options = item.options || {};
  const extra = {
    entities: item.entities && item.entities.length ? item.entities : undefined,
    disable_notification: !!options.disable_notification,
    protect_content: !!options.protect_content,
    reply_markup: buildInlineKeyboard(item.buttons),
    has_spoiler: !!options.has_spoiler,
    // v2.0.1: exposed as a toggle after testing turned up an unwanted large
    // link-preview card with no way to turn it off - only matters for
    // plain-text posts (sendMessage below); media captions don't generate
    // their own separate preview card.
    link_preview_options: options.disable_link_preview ? { is_disabled: true } : undefined,
  };

  const results = [];

  for (const chatId of item.channel_ids) {
    let sent;
    if (item.media_type === 'media_group' && Array.isArray(item.media_items) && item.media_items.length > 1) {
      sent = await sendMediaGroup(telegram, chatId, item, extra);
    } else if (item.media_type === 'photo') {
      sent = [await withApiTimeout(telegram.sendPhoto(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup', 'has_spoiler']),
      }), 'sendPhoto')];
    } else if (item.media_type === 'video') {
      sent = [await withApiTimeout(telegram.sendVideo(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup', 'has_spoiler']),
      }), 'sendVideo')];
    } else if (item.media_type === 'document') {
      sent = [await withApiTimeout(telegram.sendDocument(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup']),
      }), 'sendDocument')];
    } else if (item.media_type === 'poll') {
      const pollData = item.options.poll || { question: item.caption, answers: ['Yes', 'No'] };
      sent = [await withApiTimeout(telegram.sendPoll(chatId, pollData.question, pollData.answers, {
        is_anonymous: pollData.isAnonymous !== false,
        allows_multiple_answers: !!pollData.allowsMultiple,
        type: pollData.quizMode ? 'quiz' : 'regular',
        correct_option_id: pollData.quizMode ? (pollData.correctOptionId || 0) : undefined,
        ...pick(extra, ['disable_notification']),
      }), 'sendPoll')];
    } else {
      // text
      sent = [await withApiTimeout(telegram.sendMessage(chatId, item.caption || '', {
        entities: extra.entities, link_preview_options: extra.link_preview_options,
        ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup']),
      }), 'sendMessage')];
    }

    for (const msg of sent) {
      await statsModel.upsertMessageRef(item.id, chatId, msg.message_id);
    }
    results.push({ chatId, messages: sent });
  }

  const messageRefs = results.flatMap((r) => r.messages.map((m) => ({ chat_id: r.chatId, message_id: m.message_id })));

  await savedItems.updateWithVersion(item.id, {
    status: 'sent',
    sent_at: new Date().toISOString(),
    current_message_refs: JSON.stringify(messageRefs),
  });

  // Best-effort: remember media used in a real send for the "pick from
  // library" step in New Post. Never let this block the actual publish.
  if (['photo', 'video', 'document'].includes(item.media_type) && item.media_items?.[0]?.file_id) {
    const m = item.media_items[0];
    mediaLibrary
      .add({ fileId: m.file_id, fileUniqueId: m.file_unique_id || null, mediaType: item.media_type, label: (item.caption || '').slice(0, 60) || null })
      .catch(() => {});
  }

  return results;
}

async function sendMediaGroup(telegram, chatId, item, extra) {
  const media = item.media_items.map((m, idx) => ({
    type: m.type,
    media: m.file_id,
    caption: idx === 0 ? item.caption : (m.caption || undefined),
    caption_entities: idx === 0 ? extra.entities : undefined,
    has_spoiler: !!m.has_spoiler,
  }));
  const sentGroup = await withApiTimeout(telegram.sendMediaGroup(chatId, media, {
    disable_notification: extra.disable_notification,
    protect_content: extra.protect_content,
  }), 'sendMediaGroup');

  // Telegram doesn't allow reply_markup on sendMediaGroup - per spec, follow
  // up with a separate linked message carrying the buttons if any exist.
  if (item.buttons && item.buttons.length > 0) {
    const buttonMsg = await withApiTimeout(telegram.sendMessage(chatId, '\u200b', { reply_markup: extra.reply_markup }), 'sendMessage(buttons)');
    return [...sentGroup, buttonMsg];
  }
  return sentGroup;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = { publishSavedItem };
