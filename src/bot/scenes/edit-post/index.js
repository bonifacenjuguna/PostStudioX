const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const { parseShorthand, replaceLinkUrl, stripLinks } = require('../../../services/telegramFormatter');
const { publishSavedItem } = require('../../../services/publisher');
const { schedulePost, cancelScheduledPost } = require('../../../queue/queues');
const { buildInlineKeyboard } = require('../../../services/buttonBuilder');
const { flowReplyKeyboard, homeReplyKeyboard } = require('../../components/navRow');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');

function editMenuKeyboard(item) {
  const rows = [
    [Markup.button.callback('✏️ Edit Caption', `ep:caption:${item.id}`)],
    [Markup.button.callback('🔘 Edit Buttons', `ep:buttons:${item.id}`)],
    [Markup.button.callback('🚫 Strip Links', `ep:striplinks:${item.id}`)],
  ];
  if (item.status === 'sent') {
    rows.push([Markup.button.callback('🖼 Swap Media', `ep:media:${item.id}`)]);
    rows.push([Markup.button.callback('📌 Pin', `ep:pin:${item.id}`)]);
  }
  if (item.status === 'scheduled') {
    rows.push([Markup.button.callback('🕐 Reschedule', `ep:reschedule:${item.id}`)]);
  }
  rows.push([Markup.button.callback('🕓 Version History', `ep:versions:${item.id}`)]);
  rows.push([Markup.button.callback('📋 Clone to...', `ep:clone:${item.id}`)]);
  rows.push([Markup.button.callback('🗑 Delete', `ep:delete:${item.id}`)]);
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
  return Markup.inlineKeyboard(rows);
}

async function openEditMenu(ctx, itemId) {
  const item = await savedItems.findById(itemId);
  if (!item) return ctx.reply('That post no longer exists.');
  ctx.session = { scene: 'edit-post', editingId: itemId };
  await ctx.reply(
    `Editing: ${item.name || item.caption?.slice(0, 60) || '(untitled)'}\nStatus: ${item.status} · v${item.version}`,
    editMenuKeyboard(item)
  );
}

async function handleText(ctx) {
  const step = ctx.session.step;
  const id = ctx.session.editingId;
  if (!id) return;

  if (step === 'awaiting_new_caption') {
    const { text, entities } = parseShorthand(ctx.message.text);
    const item = await savedItems.updateWithVersion(id, { caption: text, entities: JSON.stringify(entities) });
    if (item.status === 'sent') {
      await applyLiveEdit(ctx, item);
    }
    await ctx.reply('✅ Caption updated.', homeReplyKeyboard());
    ctx.session = {};
  }

  if (step === 'awaiting_reschedule_time') {
    const tz = await settingsModel.get('timezone', 'UTC');
    const dt = DateTime.fromFormat(ctx.message.text.trim(), 'yyyy-MM-dd HH:mm', { zone: tz });
    if (!dt.isValid) return ctx.reply('Could not parse that. Use format: 2026-09-05 18:30');
    await cancelScheduledPost(id);
    await savedItems.updateWithVersion(id, { scheduled_for: dt.toUTC().toISO() });
    await schedulePost(id, dt.toUTC().toISO());
    await ctx.reply(`⏰ Rescheduled to ${dt.toFormat('yyyy-MM-dd HH:mm')} (${tz}).`, homeReplyKeyboard());
    ctx.session = {};
  }

  if (step === 'awaiting_clone_target') {
    const item = await savedItems.findById(id);
    const clone = await savedItems.create({
      kind: 'post', status: 'draft', channelIds: [ctx.message.text.trim()], mediaType: item.media_type,
      mediaItems: item.media_items, caption: item.caption, entities: item.entities, buttons: item.buttons, options: item.options,
    });
    await publishSavedItem(ctx.telegram, { ...clone, channel_ids: [ctx.message.text.trim()] });
    await ctx.reply('📋 Cloned and posted.', homeReplyKeyboard());
    ctx.session = {};
  }
}

async function applyLiveEdit(ctx, item) {
  const refs = (item.current_message_refs || []);
  for (const ref of refs) {
    try {
      await ctx.telegram.editMessageCaption(ref.chat_id, ref.message_id, undefined, item.caption, {
        caption_entities: item.entities,
      });
    } catch (err) {
      console.warn(`[edit-post] Live caption edit failed for ${ref.chat_id}/${ref.message_id}: ${err.message}`);
    }
  }
}

async function registerHandlers(bot) {
  bot.action(/^ep:caption:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'edit-post', editingId: parseInt(ctx.match[1], 10), step: 'awaiting_new_caption' };
    await ctx.reply('Send the new caption (shorthand formatting supported):', flowReplyKeyboard());
  });

  bot.action(/^ep:striplinks:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    const stripped = stripLinks(item.caption, item.entities);
    const updated = await savedItems.updateWithVersion(id, { caption: stripped.text, entities: JSON.stringify(stripped.entities) });
    if (updated.status === 'sent') await applyLiveEdit(ctx, updated);
    await ctx.reply('🧹 Links stripped from this post.', homeReplyKeyboard());
  });

  bot.action(/^ep:buttons:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const item = await savedItems.findById(id);
    const buttons = item.buttons || [];
    if (buttons.length === 0) {
      await ctx.reply('No buttons on this post yet. Use New Post to compose with buttons, then save changes here.');
      return;
    }
    const rows = buttons.flat().map((b, i) => [Markup.button.callback(`🗑 ${b.text}`, `ep:btndelete:${id}:${i}`)]);
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
    await ctx.reply('Tap a button to delete it:', Markup.inlineKeyboard(rows));
  });

  bot.action(/^ep:btndelete:(\d+):(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const idx = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Deleted');
    const item = await savedItems.findById(id);
    const flat = (item.buttons || []).flat();
    flat.splice(idx, 1);
    const newButtons = flat.length ? [flat] : [];
    const updated = await savedItems.updateWithVersion(id, { buttons: JSON.stringify(newButtons) });
    if (updated.status === 'sent') {
      const refs = (updated.current_message_refs || []);
      for (const ref of refs) {
        try {
          await ctx.telegram.editMessageReplyMarkup(ref.chat_id, ref.message_id, undefined, buildInlineKeyboard(newButtons));
        } catch (err) {
          console.warn(`[edit-post] Live button edit failed: ${err.message}`);
        }
      }
    }
    try { await ctx.editMessageText('✅ Button removed.'); } catch (_) {}
  });

  bot.action(/^ep:reschedule:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'edit-post', editingId: parseInt(ctx.match[1], 10), step: 'awaiting_reschedule_time' };
    const tz = await settingsModel.get('timezone', 'UTC');
    await ctx.reply(`Send the new date/time (format: yyyy-MM-dd HH:mm), in ${tz}.`);
  });

  bot.action(/^ep:versions:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const versions = await savedItems.listVersions(id);
    if (versions.length === 0) return ctx.reply('No previous versions yet.');
    const rows = versions.slice(0, 8).map((v) => [
      Markup.button.callback(`v${v.version} · ${new Date(v.created_at).toLocaleString()}`, `ep:rollback:${id}:${v.id}`),
    ]);
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
    await ctx.reply('🕓 Version History (tap to rollback):', Markup.inlineKeyboard(rows));
  });

  bot.action(/^ep:rollback:(\d+):(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const versionId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Rolled back');
    const updated = await savedItems.rollbackToVersion(id, versionId);
    if (updated.status === 'sent') await applyLiveEdit(ctx, updated);
    try { await ctx.editMessageText('↩️ Rolled back to that version.'); } catch (_) {}
  });

  bot.action(/^ep:clone:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'edit-post', editingId: parseInt(ctx.match[1], 10), step: 'awaiting_clone_target' };
    await ctx.reply('Send the @username or chat ID of the channel to clone this post to.');
  });

  bot.action(/^ep:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Delete this post? It will go to Trash (recoverable for 30 days).', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete', `ep:deleteconfirm:${id}`)],
      [Markup.button.callback('❌ Cancel', 'nav:cancel')],
    ]));
  });

  bot.action(/^ep:deleteconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    const item = await savedItems.findById(id);
    if (item.status === 'sent') {
      const refs = (item.current_message_refs || []);
      for (const ref of refs) {
        try { await ctx.telegram.deleteMessage(ref.chat_id, ref.message_id); } catch (_) {}
      }
    }
    await savedItems.trash(id);
    try { await ctx.editMessageText('🗑 Moved to Trash.'); } catch (_) {}
  });

  bot.action(/^ep:media:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'edit-post', editingId: parseInt(ctx.match[1], 10), step: 'awaiting_new_media' };
    await ctx.reply('Send the replacement photo/video/document.');
  });

  bot.action(/^ep:pin:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    const refs = (item.current_message_refs || []);
    for (const ref of refs) {
      try { await ctx.telegram.pinChatMessage(ref.chat_id, ref.message_id); } catch (err) {
        await ctx.reply(`🔴 Pin failed: ${err.message}`);
      }
    }
    await ctx.reply('📌 Pinned.', homeReplyKeyboard());
  });
}

async function handleMedia(ctx) {
  const step = ctx.session.step;
  const id = ctx.session.editingId;
  if (step !== 'awaiting_new_media' || !id) return;

  let fileId, type;
  if (ctx.message.photo) { fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id; type = 'photo'; }
  else if (ctx.message.video) { fileId = ctx.message.video.file_id; type = 'video'; }
  else if (ctx.message.document) { fileId = ctx.message.document.file_id; type = 'document'; }
  else return;

  const item = await savedItems.updateWithVersion(id, { media_items: JSON.stringify([{ file_id: fileId, type }]) });
  const refs = (item.current_message_refs || []);
  for (const ref of refs) {
    try {
      const mediaPayload = { type, media: fileId, caption: item.caption, caption_entities: item.entities };
      await ctx.telegram.editMessageMedia(ref.chat_id, ref.message_id, undefined, mediaPayload);
    } catch (err) {
      console.warn(`[edit-post] Live media swap failed: ${err.message}`);
    }
  }
  await ctx.reply('🖼 Media replaced.', homeReplyKeyboard());
  ctx.session = {};
}

module.exports = { openEditMenu, handleText, handleMedia, registerHandlers };
