const { buildInlineKeyboard } = require('../../services/buttonBuilder');

// Sends a full-fidelity preview of a draft post to the owner, using the same
// send calls as real publishing (minus channel/protect_content specifics),
// so what you see is what subscribers would see.
async function sendPreview(ctx, draft) {
  const keyboard = buildInlineKeyboard(draft.buttons);
  const opts = {
    entities: draft.entities && draft.entities.length ? draft.entities : undefined,
    reply_markup: keyboard,
    has_spoiler: draft.options?.has_spoiler || undefined,
  };

  if (draft.mediaType === 'photo' && draft.mediaItems?.[0]) {
    return ctx.replyWithPhoto(draft.mediaItems[0].file_id, { caption: draft.caption, caption_entities: opts.entities, reply_markup: keyboard, has_spoiler: opts.has_spoiler });
  }
  if (draft.mediaType === 'video' && draft.mediaItems?.[0]) {
    return ctx.replyWithVideo(draft.mediaItems[0].file_id, { caption: draft.caption, caption_entities: opts.entities, reply_markup: keyboard, has_spoiler: opts.has_spoiler });
  }
  if (draft.mediaType === 'document' && draft.mediaItems?.[0]) {
    return ctx.replyWithDocument(draft.mediaItems[0].file_id, { caption: draft.caption, caption_entities: opts.entities, reply_markup: keyboard });
  }
  if (draft.mediaType === 'media_group' && draft.mediaItems?.length > 1) {
    const media = draft.mediaItems.map((m, idx) => ({
      type: m.type,
      media: m.file_id,
      caption: idx === 0 ? draft.caption : undefined,
      caption_entities: idx === 0 ? opts.entities : undefined,
    }));
    await ctx.replyWithMediaGroup(media);
    if (keyboard) return ctx.reply('👆 Buttons that will accompany this album:', { reply_markup: keyboard });
    return;
  }
  // text
  return ctx.reply(draft.caption || '(empty message)', { entities: opts.entities, reply_markup: keyboard });
}

module.exports = { sendPreview };
