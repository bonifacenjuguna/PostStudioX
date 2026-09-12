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
  // v1.1.0 FIX (#8): polls previously had no branch here at all and fell
  // through to the plain-text case below, which just echoed the poll
  // question as a normal message - not a real preview of what a poll post
  // actually looks like (answers, anonymous/multi/quiz settings).
  if (draft.mediaType === 'poll' && draft.options?.poll) {
    const p = draft.options.poll;
    return ctx.replyWithPoll(p.question, p.answers, {
      is_anonymous: p.isAnonymous !== false,
      allows_multiple_answers: !!p.allowsMultiple,
      type: p.quizMode ? 'quiz' : 'regular',
      correct_option_id: p.quizMode ? (p.correctOptionId || 0) : undefined,
    });
  }
  // text
  return ctx.reply(draft.caption || '(empty message)', {
    entities: opts.entities,
    reply_markup: keyboard,
    link_preview_options: draft.options?.disable_link_preview ? { is_disabled: true } : undefined,
  });
}

// Adapts a saved_items DB row (snake_case columns) into the shape
// sendPreview expects (camelCase, draft-like) - shared so every screen that
// wants to show a live preview of an existing item (Edit Post, History,
// Templates) does it the same way instead of each rolling its own mapping.
function draftShapeFromSavedItem(item) {
  return {
    mediaType: item.media_type,
    mediaItems: item.media_items || [],
    caption: item.caption || '',
    entities: item.entities || [],
    buttons: item.buttons || [],
    options: item.options || {},
  };
}

module.exports = { sendPreview, draftShapeFromSavedItem };
