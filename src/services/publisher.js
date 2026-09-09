// Single source of truth for "actually send this post to Telegram."
// Used both by the bot's immediate "Send Now" action and by the BullMQ
// scheduled-post worker, so the two paths can never drift apart.
//
// publishSavedItem is called synchronously and awaited from the webhook
// path itself ("Send Now" in create-post/edit-post), not just from the
// worker. bot.telegram.send* calls are real, unbounded network calls to
// Telegram's API - same shape of risk as the dead-socket problem already
// fixed for Redis and Postgres (see redisClient.js / db/pool.js), just
// against a different endpoint. Bounded here for the same reason: one
// hung outbound call shouldn't be able to sit forever.

const { buildInlineKeyboard } = require('./buttonBuilder');
const savedItems = require('../db/models/savedItems');
const statsModel = require('../db/models/stats');

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

async function publishSavedItem(bot, item) {
  const options = item.options || {};
  const extra = {
    parse_mode: undefined, // we use explicit `entities`, not parse_mode
    entities: item.entities && item.entities.length ? item.entities : undefined,
    disable_notification: !!options.disable_notification,
    protect_content: !!options.protect_content,
    reply_markup: buildInlineKeyboard(item.buttons),
    has_spoiler: !!options.has_spoiler,
  };

  const results = [];

  for (const chatId of item.channel_ids) {
    let sent;
    if (item.media_type === 'media_group' && Array.isArray(item.media_items) && item.media_items.length > 1) {
      sent = await sendMediaGroup(bot, chatId, item, extra);
    } else if (item.media_type === 'photo') {
      sent = [await withApiTimeout(bot.telegram.sendPhoto(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup', 'has_spoiler']),
      }), 'sendPhoto')];
    } else if (item.media_type === 'video') {
      sent = [await withApiTimeout(bot.telegram.sendVideo(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup', 'has_spoiler']),
      }), 'sendVideo')];
    } else if (item.media_type === 'document') {
      sent = [await withApiTimeout(bot.telegram.sendDocument(chatId, item.media_items[0].file_id, {
        caption: item.caption, caption_entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup']),
      }), 'sendDocument')];
    } else if (item.media_type === 'poll') {
      const pollData = item.options.poll || { question: item.caption, answers: ['Yes', 'No'] };
      sent = [await withApiTimeout(bot.telegram.sendPoll(chatId, pollData.question, pollData.answers, pick(extra, ['disable_notification'])), 'sendPoll')];
    } else {
      // text
      sent = [await withApiTimeout(bot.telegram.sendMessage(chatId, item.caption || '', {
        entities: extra.entities, ...pick(extra, ['disable_notification', 'protect_content', 'reply_markup']),
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

  return results;
}

async function sendMediaGroup(bot, chatId, item, extra) {
  const media = item.media_items.map((m, idx) => ({
    type: m.type,
    media: m.file_id,
    caption: idx === 0 ? item.caption : (m.caption || undefined),
    caption_entities: idx === 0 ? extra.entities : undefined,
    has_spoiler: !!m.has_spoiler,
  }));
  const sentGroup = await withApiTimeout(bot.telegram.sendMediaGroup(chatId, media, {
    disable_notification: extra.disable_notification,
    protect_content: extra.protect_content,
  }), 'sendMediaGroup');

  // Telegram doesn't allow reply_markup on sendMediaGroup - per spec, follow
  // up with a separate linked message carrying the buttons if any exist.
  if (item.buttons && item.buttons.length > 0) {
    const buttonMsg = await withApiTimeout(bot.telegram.sendMessage(chatId, '\u200b', { reply_markup: extra.reply_markup }), 'sendMessage(buttons)');
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
