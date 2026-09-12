const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const channelsModel = require('../../../db/models/channels');
const { parseShorthand, stripLinks } = require('../../../services/telegramFormatter');
const { publishSavedItem } = require('../../../services/publisher');
const { schedulePost, cancelScheduledPost } = require('../../../queue/queues');
const { buildInlineKeyboard } = require('../../../services/buttonBuilder');
const { flowReplyKeyboard, homeReplyKeyboard, backHomeRow } = require('../../components/navRow');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');
const { parseNaturalTime, quickPickPresets } = require('../../../services/naturalTime');
const { logAction } = require('../../../services/actionErrors');
const { isEffectivelyAdmin, describeIssue } = require('../../../services/channelPermissions');

function editMenuKeyboard(item, returnTo) {
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
  rows.push(returnTo ? backHomeRow(returnTo) : [Markup.button.callback('🏠 Home', 'nav:home')]);
  return Markup.inlineKeyboard(rows);
}

// v1.2.0: `returnTo` is a callback_data string pointing back to wherever
// this edit menu was opened from (e.g. `hist:view:42`, `tpl:view:7`) so
// the Back button is a real "previous screen," not another Home shortcut.
async function openEditMenu(ctx, itemId, { returnTo } = {}) {
  const item = await savedItems.findById(itemId);
  if (!item) return ctx.reply('That post no longer exists.');
  ctx.session = { scene: 'edit-post', editingId: itemId, editReturnTo: returnTo };
  // v2.0.1 (#preview coverage): previously this only showed a 60-char text
  // summary - now shows the actual rendered post (real formatting/media),
  // the same renderer used by Compose's own Preview step, so editing
  // starts from seeing what's actually there instead of guessing from text.
  const { sendPreview, draftShapeFromSavedItem } = require('../../components/previewRenderer');
  await sendPreview(ctx, draftShapeFromSavedItem(item)).catch(() => {});
  await ctx.reply(
    `Editing: ${item.name || item.caption?.slice(0, 60) || '(untitled)'}\nStatus: ${item.status} · v${item.version}`,
    editMenuKeyboard(item, returnTo)
  );
}

async function handleText(ctx) {
  const step = ctx.session.step;
  const id = ctx.session.editingId;
  if (!id) return;

  if (step === 'awaiting_new_caption') {
    const { text, entities } = parseShorthand(ctx.message.text);
    const item = await savedItems.updateWithVersion(id, { caption: text, entities });
    if (item.status === 'sent') {
      await applyLiveEdit(ctx, item);
    }
    await ctx.reply('✅ Caption updated.', homeReplyKeyboard());
    ctx.session = {};
  }

  if (step === 'awaiting_reschedule_time') {
    const tz = await settingsModel.get('timezone', 'UTC');
    const { dt, error } = parseNaturalTime(ctx.message.text, tz);
    if (error) return ctx.reply(error);
    await finalizeReschedule(ctx, id, dt, tz);
    return;
  }

  if (step === 'awaiting_clone_target') {
    // legacy typed-target fallback - kept only in case a session was
    // mid-flow during the upgrade to the channel picker below; the picker
    // is now the primary path (ep:clonepick).
    const target = ctx.message.text.trim();
    await cloneToChannel(ctx, id, target);
  }
}

async function finalizeReschedule(ctx, id, dtUtc, tz) {
  if (dtUtc.toMillis() <= Date.now()) {
    await ctx.reply('That works out to a time in the past — try again with a future time.');
    return;
  }
  await cancelScheduledPost(id);
  await savedItems.updateWithVersion(id, { scheduled_for: dtUtc.toISO() });
  await schedulePost(id, dtUtc.toISO());
  const local = dtUtc.setZone(tz);
  await ctx.reply(`⏰ Rescheduled to ${local.toFormat('EEE d MMM, HH:mm')} (${tz}).`, homeReplyKeyboard());
  ctx.session = {};
}

async function cloneToChannel(ctx, id, target) {
  const item = await savedItems.findById(id);
  try {
    const me = await ctx.telegram.getMe();
    const member = await ctx.telegram.getChatMember(target, me.id);
    if (!isEffectivelyAdmin(member)) {
      await ctx.reply(`🔴 Can't clone there: ${describeIssue(member)}. Promote the bot to admin with Post Messages rights first.`);
      return;
    }
    const clone = await savedItems.create({
      kind: 'post', status: 'draft', channelIds: [target], mediaType: item.media_type,
      mediaItems: item.media_items, caption: item.caption, entities: item.entities, buttons: item.buttons, options: item.options,
    });
    await publishSavedItem(ctx.telegram, { ...clone, channel_ids: [target] });
    await ctx.reply('📋 Cloned and posted.', homeReplyKeyboard());
  } catch (err) {
    const msg = await logAction({ scene: 'edit-post', step: 'clone', attempted: `clone post ${id} to ${target}`, error: err, savedItemId: id });
    await ctx.reply(msg, homeReplyKeyboard());
  }
  ctx.session = {};
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

function rescheduleKeyboard(id) {
  const presets = quickPickPresets();
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(presets.slice(i, i + 2).map((p, j) => Markup.button.callback(p.label, `ep:schedpick:${id}:${i + j}`)));
  }
  rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
  return Markup.inlineKeyboard(rows);
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
    const updated = await savedItems.updateWithVersion(id, { caption: stripped.text, entities: stripped.entities });
    if (updated.status === 'sent') await applyLiveEdit(ctx, updated);
    await ctx.reply('🧹 Links stripped from this post.', homeReplyKeyboard());
  });

  bot.action(/^ep:buttons:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const item = await savedItems.findById(id);
    const buttons = item.buttons || [];
    if (buttons.length === 0) {
      await ctx.reply('No buttons on this post yet. Use 🎨 Compose to add buttons, then save changes here.');
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
    const updated = await savedItems.updateWithVersion(id, { buttons: newButtons });
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
    const id = parseInt(ctx.match[1], 10);
    ctx.session = { scene: 'edit-post', editingId: id, step: 'awaiting_reschedule_time' };
    const tz = await settingsModel.get('timezone', 'UTC');
    const now = DateTime.now().setZone(tz);
    await ctx.reply(
      `Right now it's ${now.toFormat('EEE d MMM, HH:mm')} in your timezone (${tz}).\n\nPick a quick option, or type when — e.g. "tomorrow 9am", "friday 6pm".`,
      rescheduleKeyboard(id)
    );
  });

  bot.action(/^ep:schedpick:(\d+):(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const idx = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    const preset = quickPickPresets()[idx];
    if (!preset) return;
    const tz = await settingsModel.get('timezone', 'UTC');
    const dt = DateTime.now().setZone(tz).plus({ minutes: preset.minutes }).toUTC();
    await finalizeReschedule(ctx, id, dt, tz);
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
    const id = parseInt(ctx.match[1], 10);
    const channels = await channelsModel.list();
    if (channels.length === 0) {
      await ctx.reply('No registered channels to clone to yet — add one from 📡 Channels first.');
      return;
    }
    const rows = channels.map((c) => [Markup.button.callback(`${c.is_admin ? '🟢' : '🔴'} ${c.title || c.chat_id}`, `ep:clonepick:${id}:${c.chat_id}`)]);
    rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
    await ctx.reply('Clone this post to which channel?', Markup.inlineKeyboard(rows));
  });

  bot.action(/^ep:clonepick:(\d+):(.+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    const target = ctx.match[2];
    await ctx.answerCbQuery();
    await cloneToChannel(ctx, id, target);
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
    const id = parseInt(ctx.match[1], 10);
    const item = await savedItems.findById(id);
    ctx.session = { scene: 'edit-post', editingId: id, step: 'awaiting_new_media' };
    await ctx.reply(`Send the replacement ${item.media_type} — it needs to be the same type (${item.media_type}) as the original, Telegram can't swap between types on a live post.`);
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

  const item = await savedItems.findById(id);
  let fileId, type;
  if (ctx.message.photo) { fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id; type = 'photo'; }
  else if (ctx.message.video) { fileId = ctx.message.video.file_id; type = 'video'; }
  else if (ctx.message.document) { fileId = ctx.message.document.file_id; type = 'document'; }
  else return;

  // v2.0.0 FIX: previously this attempted the swap regardless of type,
  // which Telegram's editMessageMedia rejects (or behaves oddly on) for a
  // live post - now checked up front with a message that actually explains
  // why, instead of a raw API error.
  if (type !== item.media_type) {
    await ctx.reply(
      `🔴 That's a ${type}, but this post's original media is a ${item.media_type} — Telegram won't let a live post switch types.\n\n` +
        `Send a ${item.media_type} instead, or use 🗑 Delete + 🎨 Compose to start a fresh post of a different type.`
    );
    return;
  }

  const updated = await savedItems.updateWithVersion(id, { media_items: [{ file_id: fileId, type }] });
  const refs = (updated.current_message_refs || []);
  for (const ref of refs) {
    try {
      const mediaPayload = { type, media: fileId, caption: updated.caption, caption_entities: updated.entities };
      await ctx.telegram.editMessageMedia(ref.chat_id, ref.message_id, undefined, mediaPayload);
    } catch (err) {
      const msg = await logAction({ scene: 'edit-post', step: 'media_swap', attempted: `swap media on ${ref.chat_id}/${ref.message_id}`, error: err, savedItemId: id });
      await ctx.reply(msg);
    }
  }
  await ctx.reply('🖼 Media replaced.', homeReplyKeyboard());
  ctx.session = {};
}

module.exports = { openEditMenu, handleText, handleMedia, registerHandlers };
