const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const savedItems = require('../../../db/models/savedItems');
const mediaLibrary = require('../../../db/models/mediaLibrary');
const { parseShorthand, stripLinks } = require('../../../services/telegramFormatter');
const { buildInlineKeyboard, colorLabel } = require('../../../services/buttonBuilder');
const { validateDraft } = require('../../../services/preSendValidator');
const { sendPreview } = require('../../components/previewRenderer');
const { publishSavedItem } = require('../../../services/publisher');
const { schedulePost, scheduleAutoDelete } = require('../../../queue/queues');
const { flowReplyKeyboard, homeReplyKeyboard, backCancelRow } = require('../../components/navRow');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');

// ---------------------------------------------------------------------------
// v1.2.0 REDESIGN
//
// Previously every step of New Post sent a brand new chat message, so a
// single post could leave 10-15 messages scattered through the chat by the
// time you finished - hard to scan back through, not something you'd want
// to hand a client using this as a commercial tool.
//
// Now the whole wizard lives in ONE "control panel" message that gets
// *edited in place* step to step (showStep, below) - it feels like a
// single app screen advancing, not a chat log. The only messages that
// can't be folded into that panel are the ones Telegram itself requires to
// be their own message (an actual photo/video/poll you send, and the real
// preview of your post) - those appear inline as themselves, with the
// control panel picking back up right after.
//
// Every step also shows a "Step X/5 — Name" header so you always know
// where you are and how much is left, and has a real "⬅️ Back" that
// returns to the *previous* step specifically - not a blanket trip Home.
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 5;
const STEP_LABELS = { 1: 'Post Type', 2: 'Content', 3: 'Format & Buttons', 4: 'Preview', 5: 'Finish' };

function header(stepNum) {
  return `🆕 NEW POST — Step ${stepNum}/${TOTAL_STEPS} — ${STEP_LABELS[stepNum]}`;
}

// Edits the single ongoing "control panel" message in place when possible;
// falls back to sending a fresh message the first time, if the old message
// is gone, or if forceNew is requested (used right after Telegram content
// that had to be its own message, e.g. the real post preview).
async function showStep(ctx, text, keyboard, { forceNew = false } = {}) {
  const chatId = ctx.chat?.id || ctx.from.id;
  const msgId = ctx.session.wizardMsgId;
  const extra = { reply_markup: keyboard?.reply_markup };

  if (!forceNew && msgId) {
    try {
      await ctx.telegram.editMessageText(chatId, msgId, undefined, text, extra);
      return;
    } catch (err) {
      if (/message is not modified/i.test(err.message)) return; // already showing this - no-op
      // message too old / deleted / not editable - fall through to a fresh one
    }
  }
  const sent = await ctx.reply(text, extra);
  ctx.session.wizardMsgId = sent.message_id;
}

function freshDraft() {
  return { channelIds: [], mediaType: null, mediaItems: [], caption: '', entities: [], buttons: [], options: {} };
}

async function enter(ctx) {
  ctx.session = { scene: 'create-post', step: 'media_type', draft: freshDraft() };
  await ctx.reply('📝 Starting a new post.', flowReplyKeyboard());
  await showMediaTypeStep(ctx);
}

async function showMediaTypeStep(ctx) {
  ctx.session.step = 'media_type';
  await showStep(ctx, `${header(1)}\n\nWhat kind of post is this?`, mediaTypeKeyboard());
}

function channelPickerKeyboard(channels, selected) {
  const rows = channels.map((c) => [
    Markup.button.callback(`${selected.includes(c.chat_id) ? '✅' : '⬜'} ${c.title || c.chat_id}`, `cp:chan:${c.chat_id}`),
  ]);
  rows.push([Markup.button.callback('➡️ Continue', 'cp:chan:next')]);
  rows.push(backCancelRow('cp:finish:backpreview'));
  return Markup.inlineKeyboard(rows);
}

function mediaTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼 Photo', 'cp:type:photo'), Markup.button.callback('🎥 Video', 'cp:type:video')],
    [Markup.button.callback('📄 Document', 'cp:type:document'), Markup.button.callback('💬 Text only', 'cp:type:text')],
    [Markup.button.callback('📊 Poll', 'cp:type:poll'), Markup.button.callback('🖼🎥 Media Group', 'cp:type:media_group')],
    [Markup.button.callback('📚 From Library', 'cp:library')],
    [Markup.button.callback('❌ Cancel', 'nav:cancel')],
  ]);
}

function formattingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Bold', 'cp:fmt:bold'), Markup.button.callback('Italic', 'cp:fmt:italic'), Markup.button.callback('Underline', 'cp:fmt:underline')],
    [Markup.button.callback('Strike', 'cp:fmt:strike'), Markup.button.callback('Spoiler', 'cp:fmt:spoiler'), Markup.button.callback('Code', 'cp:fmt:code')],
    [Markup.button.callback('🔗 Link', 'cp:fmt:link'), Markup.button.callback('💬 Quote', 'cp:fmt:quote')],
    [Markup.button.callback('🚫 Remove All Links', 'cp:fmt:striplinks')],
    [Markup.button.callback('🔘 Add Buttons', 'cp:buttons:add')],
    [Markup.button.callback('✅ Done, continue', 'cp:fmt:done')],
    backCancelRow('cp:back:content'),
  ]);
}

function pollOptionsKeyboard(draft) {
  const p = draft.options.poll;
  return Markup.inlineKeyboard([
    [Markup.button.callback(`${p.isAnonymous !== false ? '✅' : '⬜'} Anonymous`, 'cp:poll:toggle:isAnonymous')],
    [Markup.button.callback(`${p.allowsMultiple ? '✅' : '⬜'} Allow multiple answers`, 'cp:poll:toggle:allowsMultiple')],
    [Markup.button.callback(`${p.quizMode ? '✅' : '⬜'} Quiz mode (one correct answer)`, 'cp:poll:toggle:quizMode')],
    [Markup.button.callback('➡️ Continue', 'cp:poll:continue')],
    backCancelRow('cp:back:mediatype'),
  ]);
}

async function askForContent(ctx) {
  const { mediaType } = ctx.session.draft;
  ctx.session.step = 'awaiting_content';
  const prompts = {
    photo: 'Send the photo now.',
    video: 'Send the video now.',
    document: 'Send the document now.',
    text: 'Type your message text now.\n\nShorthand: **bold** __italic__ ~~strike~~ ++underline++ ||spoiler|| [text](url)',
    poll: 'Send your poll question — I\'ll ask for answer options next.',
    media_group: 'Send up to 10 photos/videos, one at a time. Tap "Done adding" when finished.',
  };
  await showStep(ctx, `${header(2)}\n\n${prompts[mediaType] || 'Send your content.'}`, Markup.inlineKeyboard([backCancelRow('cp:back:mediatype')]));
}

async function handleText(ctx) {
  const step = ctx.session.step;
  const draft = ctx.session.draft;
  const text = ctx.message.text;

  if (step === 'awaiting_content' && (draft.mediaType === 'text' || draft.mediaType === 'poll')) {
    if (draft.mediaType === 'poll' && !draft.options.pollQuestion) {
      draft.options.pollQuestion = text;
      ctx.session.step = 'awaiting_poll_answers';
      await showStep(ctx, `${header(2)}\n\nNow send answer options separated by commas, e.g.:\nYes, No, Maybe`, Markup.inlineKeyboard([backCancelRow('cp:back:mediatype')]));
      return;
    }
    if (draft.mediaType === 'text') {
      const { text: parsedText, entities } = parseShorthand(text);
      draft.caption = parsedText;
      draft.entities = entities;
      ctx.session.step = 'formatting';
      await showStep(ctx, `${header(3)}\n\nAdd formatting, links, or buttons — or tap Done.`, formattingKeyboard());
      return;
    }
  }

  if (ctx.session.step === 'awaiting_poll_answers') {
    const answers = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (answers.length < 2) {
      await ctx.reply('A poll needs at least 2 answer options. Send them again, comma-separated.');
      return;
    }
    draft.options.poll = { question: draft.options.pollQuestion, answers, isAnonymous: true, allowsMultiple: false, quizMode: false };
    delete draft.options.pollQuestion;
    ctx.session.step = 'poll_options';
    await showStep(ctx, `${header(2)}\n\nPoll settings:`, pollOptionsKeyboard(draft));
    return;
  }

  if (step === 'awaiting_content' && ['photo', 'video', 'document'].includes(draft.mediaType)) {
    await ctx.reply('Please send the actual media file — I\'ll ask for a caption right after.');
    return;
  }

  if (step === 'caption_for_media') {
    const { text: parsedText, entities } = parseShorthand(text === '/skip' ? '' : text);
    draft.caption = parsedText;
    draft.entities = entities;
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\nAdd formatting, links, or buttons — or tap Done.`, formattingKeyboard());
    return;
  }

  if (step === 'awaiting_link_text') {
    ctx.session.linkDraft = { text };
    ctx.session.step = 'awaiting_link_url';
    await showStep(ctx, `${header(3)}\n\nNow send the URL for that link.`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
    return;
  }

  if (step === 'awaiting_link_url') {
    const linkText = ctx.session.linkDraft.text;
    draft.caption += (draft.caption ? ' ' : '') + linkText;
    const offset = draft.caption.length - linkText.length;
    draft.entities.push({ type: 'text_link', url: text.trim(), offset, length: linkText.length });
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\n🔗 Link added. Add more, or tap Done.`, formattingKeyboard());
    return;
  }

  if (step === 'awaiting_button_text') {
    ctx.session.buttonDraft = { text };
    ctx.session.step = 'awaiting_button_url';
    await showStep(
      ctx,
      `${header(3)}\n\nNow send the URL this button should open — or type NOTE: followed by a short message to make a "tap to reveal" note button instead of a link.`,
      Markup.inlineKeyboard([backCancelRow('cp:back:formatting')])
    );
    return;
  }

  if (step === 'awaiting_button_url') {
    if (/^note:/i.test(text.trim())) {
      ctx.session.buttonDraft.note = text.trim().replace(/^note:/i, '').trim().slice(0, 180);
    } else {
      ctx.session.buttonDraft.url = text.trim();
    }
    ctx.session.step = 'awaiting_button_style';
    await showStep(ctx, `${header(3)}\n\nPick a color style for this button:`, Markup.inlineKeyboard([
      [Markup.button.callback('🔵 Primary', 'cp:btnstyle:bg_primary'), Markup.button.callback('🔴 Danger', 'cp:btnstyle:bg_danger')],
      [Markup.button.callback('🟢 Success', 'cp:btnstyle:bg_success'), Markup.button.callback('⚪ Default', 'cp:btnstyle:default')],
      backCancelRow('cp:back:formatting'),
    ]));
    return;
  }

  if (step === 'awaiting_schedule_time') {
    await handleScheduleInput(ctx, text);
    return;
  }

  if (step === 'awaiting_template_name') {
    await saveAsTemplate(ctx, text);
    return;
  }

  if (step === 'awaiting_template_name_then_send') {
    await saveAsTemplate(ctx, text, { silent: true });
    await doSend(ctx, { undoWindow: true });
    return;
  }
}

async function handleMedia(ctx) {
  const step = ctx.session.step;
  const draft = ctx.session.draft;
  if (step !== 'awaiting_content') return;

  if (draft.mediaType === 'photo' && ctx.message.photo) {
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    draft.mediaItems = [{ file_id: largest.file_id, type: 'photo' }];
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption (or send /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
  } else if (draft.mediaType === 'video' && ctx.message.video) {
    draft.mediaItems = [{ file_id: ctx.message.video.file_id, type: 'video' }];
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption (or send /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
  } else if (draft.mediaType === 'document' && ctx.message.document) {
    draft.mediaItems = [{ file_id: ctx.message.document.file_id, type: 'document' }];
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption (or send /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
  } else if (draft.mediaType === 'media_group' && (ctx.message.photo || ctx.message.video)) {
    const item = ctx.message.photo
      ? { file_id: ctx.message.photo[ctx.message.photo.length - 1].file_id, type: 'photo' }
      : { file_id: ctx.message.video.file_id, type: 'video' };
    draft.mediaItems.push(item);
    if (draft.mediaItems.length >= 10) {
      ctx.session.step = 'caption_for_media';
      await showStep(ctx, `${header(3)}\n\nReached 10 items (max for an album). Add a caption for the first item (or /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
    } else {
      await showStep(
        ctx,
        `${header(2)}\n\nAdded (${draft.mediaItems.length}/10). Send another, or tap Done.`,
        Markup.inlineKeyboard([[Markup.button.callback('✅ Done adding media', 'cp:media:done')], backCancelRow('cp:back:mediatype')])
      );
    }
  }
}

async function buildPreviewPanel(draft) {
  const validation = await validateDraft(draft, { requireChannels: false });
  const rows = [];
  let text = `${header(4)}\n\n`;
  if (!validation.ok) {
    text += '⚠️ ISSUES FOUND BEFORE YOU CAN SEND:\n' + validation.issues.map((i) => `• ${i}`).join('\n');
    rows.push([Markup.button.callback('✏️ Edit Caption', 'cp:edit:caption')]);
    rows.push(backCancelRow('cp:back:formatting'));
  } else {
    text += "Here's your preview above 👆 — how do you want to finish?";
    if (validation.warnings.length) {
      text += '\n\n💡 HEADS UP:\n' + validation.warnings.map((w) => `• ${w}`).join('\n');
    }
    rows.push([Markup.button.callback('✏️ Edit Caption', 'cp:edit:caption'), Markup.button.callback('🔘 Edit Buttons', 'cp:buttons:add')]);
    rows.push([Markup.button.callback('▫️▫️ SAVE ▫️▫️', 'nav:noop')]);
    rows.push([Markup.button.callback('💾 Save as Template', 'cp:save:template'), Markup.button.callback('📝 Save as Draft', 'cp:save:draft')]);
    rows.push([Markup.button.callback('▫️▫️ SEND ▫️▫️', 'nav:noop')]);
    rows.push([Markup.button.callback('⏰ Schedule', 'cp:finish:schedule'), Markup.button.callback('🚀 Send Now', 'cp:finish:send')]);
    rows.push([Markup.button.callback('🚀 Send & 💾 Save as Template', 'cp:finish:send_template')]);
    rows.push(backCancelRow('cp:back:formatting'));
  }
  return { text, rows };
}

// First time reaching Preview: the actual post preview (photo/video/poll/
// text) has to be sent as its own real Telegram message - unavoidable,
// Telegram doesn't let a message become a photo after the fact. The
// control panel restarts fresh right below it.
async function goToPreview(ctx) {
  ctx.session.step = 'preview';
  const draft = ctx.session.draft;
  await sendPreview(ctx, draft);
  const { text, rows } = await buildPreviewPanel(draft);
  await showStep(ctx, text, Markup.inlineKeyboard(rows), { forceNew: true });
}

// v1.2.0 FIX: returning to Preview via "⬅️ Back" from channel-picking /
// schedule-time / template-naming used to call goToPreview() again, which
// re-sent the actual preview media every time - repeated Back taps would
// spam duplicate photos/polls into the chat, the exact clutter this
// redesign exists to prevent. Redraws the control panel in place instead,
// without touching the preview media that's already sitting there.
async function backToPreviewPanel(ctx) {
  ctx.session.step = 'preview';
  const draft = ctx.session.draft;
  const { text, rows } = await buildPreviewPanel(draft);
  await showStep(ctx, text, Markup.inlineKeyboard(rows));
}

async function channelNames(chatIds) {
  const names = await Promise.all(chatIds.map(async (id) => {
    const ch = await channelsModel.findByChatId(id);
    return ch?.title || id;
  }));
  return names.join(', ');
}

async function doSend(ctx, { undoWindow = true } = {}) {
  const draft = ctx.session.draft;
  const item = await savedItems.create({
    kind: 'post', status: 'draft', channelIds: draft.channelIds, mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options,
  });
  const names = await channelNames(draft.channelIds);

  if (undoWindow) {
    const msg = await ctx.reply('Sending in 5s... ', Markup.inlineKeyboard([[Markup.button.callback('↩️ Undo', `cp:undo:${item.id}`)]]));
    ctx.session.pendingSend = { itemId: item.id, msgId: msg.message_id, chatId: msg.chat.id };
    ctx.session.step = 'send_grace_period';
    setTimeout(async () => {
      try {
        // Re-check the session hasn't been undone before firing.
        const fresh = await savedItems.findById(item.id);
        if (!fresh || fresh.status !== 'draft') return; // undone or already handled
        await publishSavedItem(ctx.telegram, fresh);
        if (draft.options.autoDeleteMinutes) {
          const at = new Date(Date.now() + draft.options.autoDeleteMinutes * 60000).toISOString();
          const refreshed = await savedItems.findById(item.id);
          await scheduleAutoDelete(item.id, at, (refreshed.current_message_refs || []));
        }
        await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `✅ Posted to ${names}`);
        ctx.session = {};
      } catch (err) {
        await ctx.telegram.sendMessage(msg.chat.id, `🔴 Send failed: ${err.message}`);
      }
    }, 5000);
  } else {
    await publishSavedItem(ctx.telegram, item);
    await ctx.reply(`✅ Posted to ${names}`, homeReplyKeyboard());
    ctx.session = {};
  }
}

async function handleScheduleInput(ctx, text) {
  const tz = await settingsModel.get('timezone', 'UTC');
  const dt = DateTime.fromFormat(text.trim(), 'yyyy-MM-dd HH:mm', { zone: tz });
  if (!dt.isValid) {
    await ctx.reply(`Could not parse that. Use format: 2026-09-05 18:30 (in ${tz})`);
    return;
  }
  if (dt.toUTC().toMillis() <= Date.now()) {
    await ctx.reply('That time is in the past — send a future date/time.');
    return;
  }
  const draft = ctx.session.draft;
  const item = await savedItems.create({
    kind: 'post', status: 'scheduled', channelIds: draft.channelIds, mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options, scheduledFor: dt.toUTC().toISO(),
    autoDeleteAt: draft.options.autoDeleteMinutes ? dt.plus({ minutes: draft.options.autoDeleteMinutes }).toUTC().toISO() : null,
  });
  await schedulePost(item.id, dt.toUTC().toISO());
  const names = await channelNames(draft.channelIds);
  await ctx.reply(`⏰ Scheduled for ${dt.toFormat('yyyy-MM-dd HH:mm')} (${tz}) to ${names}.`, homeReplyKeyboard());
  ctx.session = {};
}

async function saveAsTemplate(ctx, name, { silent = false } = {}) {
  const draft = ctx.session.draft;
  await savedItems.create({
    kind: 'template', name, status: 'draft', mediaType: draft.mediaType, mediaItems: draft.mediaItems,
    caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options, channelIds: [],
  });
  if (silent) {
    await ctx.reply(`💾 Saved as template: "${name}" — now sending...`);
  } else {
    await ctx.reply(`💾 Saved as template: "${name}"`, homeReplyKeyboard());
    ctx.session = {};
  }
}

async function registerHandlers(bot) {
  bot.action(/^cp:chan:(.+)$/, async (ctx) => {
    const val = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (!draft) return;
    if (val === 'next') {
      if (draft.channelIds.length === 0) {
        await ctx.reply('⚠️ Pick at least one channel first (tap a channel name to check it), then Continue.');
        return;
      }
      const action = ctx.session.finishAction;
      if (action === 'send_template') {
        ctx.session.step = 'awaiting_template_name_then_send';
        await showStep(ctx, `${header(5)}\n\nName this template (it'll be saved, then the post sends):`, Markup.inlineKeyboard([backCancelRow('cp:finish:backpreview')]));
      } else if (action === 'schedule') {
        ctx.session.step = 'awaiting_schedule_time';
        const tz = await settingsModel.get('timezone', 'UTC');
        await showStep(ctx, `${header(5)}\n\nSend the date/time to send this (format: yyyy-MM-dd HH:mm), in ${tz}.`, Markup.inlineKeyboard([backCancelRow('cp:finish:backpreview')]));
      } else {
        await doSend(ctx, { undoWindow: true });
      }
      return;
    }
    const idx = draft.channelIds.indexOf(val);
    if (idx >= 0) draft.channelIds.splice(idx, 1);
    else draft.channelIds.push(val);
    const channels = await channelsModel.list();
    try {
      await ctx.editMessageReplyMarkup(channelPickerKeyboard(channels, draft.channelIds).reply_markup);
    } catch (_) {}
  });

  bot.action(/^cp:type:(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.draft.mediaType = type;
    if (type === 'media_group') ctx.session.draft.mediaItems = [];
    await askForContent(ctx);
  });

  bot.action('cp:library', async (ctx) => {
    await ctx.answerCbQuery();
    const items = await mediaLibrary.list({ limit: 8 });
    if (items.length === 0) {
      await showStep(ctx, `${header(1)}\n\n📚 Your library is empty — media gets remembered here automatically the first time you actually send it.\n\nWhat kind of post is this?`, mediaTypeKeyboard());
      return;
    }
    const icon = { photo: '🖼', video: '🎥', document: '📄' };
    const rows = items.map((i) => [Markup.button.callback(`${icon[i.media_type] || '📎'} ${i.label || i.media_type}`, `cp:libpick:${i.id}`)]);
    rows.push(backCancelRow('cp:back:mediatype'));
    await showStep(ctx, `${header(1)}\n\nPick media from your library:`, Markup.inlineKeyboard(rows));
  });

  bot.action(/^cp:libpick:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await mediaLibrary.findById(id);
    if (!item) {
      await ctx.reply('That item is no longer available.');
      return;
    }
    const draft = ctx.session.draft;
    draft.mediaType = item.media_type;
    draft.mediaItems = [{ file_id: item.file_id, type: item.media_type }];
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption (or send /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:mediatype')]));
  });

  bot.action('cp:media:done', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption for the album (or /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
  });

  bot.action(/^cp:fmt:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (action === 'done') {
      await goToPreview(ctx);
      return;
    }
    if (action === 'striplinks') {
      const stripped = stripLinks(draft.caption, draft.entities);
      draft.caption = stripped.text;
      draft.entities = stripped.entities;
      await showStep(ctx, `${header(3)}\n\n🚫 All links removed from the text.`, formattingKeyboard());
      return;
    }
    if (action === 'link') {
      ctx.session.step = 'awaiting_link_text';
      await showStep(ctx, `${header(3)}\n\nSend the visible text for the link.`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
      return;
    }
    if (action === 'quote') {
      draft.entities.push({ type: 'blockquote', offset: 0, length: draft.caption.length });
      await showStep(ctx, `${header(3)}\n\n💬 Whole caption marked as a blockquote.`, formattingKeyboard());
      return;
    }
    const typeMap = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikethrough', spoiler: 'spoiler', code: 'code' };
    if (typeMap[action] && draft.caption) {
      draft.entities.push({ type: typeMap[action], offset: 0, length: draft.caption.length });
      await showStep(ctx, `${header(3)}\n\n✅ Applied ${action} to the full text.`, formattingKeyboard());
    } else {
      await showStep(ctx, `${header(3)}\n\nType your text first, then apply formatting.`, formattingKeyboard());
    }
  });

  bot.action('cp:buttons:add', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_button_text';
    await showStep(ctx, `${header(3)}\n\nSend the button label text.`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
  });

  bot.action(/^cp:btnstyle:(.+)$/, async (ctx) => {
    const style = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    const btn = { text: ctx.session.buttonDraft.text };
    if (ctx.session.buttonDraft.note) btn.note = ctx.session.buttonDraft.note;
    else btn.url = ctx.session.buttonDraft.url;
    if (style !== 'default') btn.style = style;
    if (draft.buttons.length === 0) draft.buttons.push([]);
    draft.buttons[draft.buttons.length - 1].push(btn);
    delete ctx.session.buttonDraft;
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\n🔘 Button added (${colorLabel(style)}).`, formattingKeyboard());
  });

  bot.action('cp:edit:caption', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nSend the new caption text (shorthand formatting supported):`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
  });

  bot.action('cp:save:template', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_template_name';
    await showStep(ctx, `${header(5)}\n\nName this template:`, Markup.inlineKeyboard([backCancelRow('cp:finish:backpreview')]));
  });

  bot.action('cp:save:draft', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    await savedItems.create({
      kind: 'post', status: 'draft', channelIds: [], mediaType: draft.mediaType, mediaItems: draft.mediaItems,
      caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options,
    });
    await ctx.reply('📝 Saved as a draft (no channel, not sent) — find it later in 📜 History.', homeReplyKeyboard());
    ctx.session = {};
  });

  bot.action(/^cp:finish:(send|schedule|send_template)$/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
    const channels = await channelsModel.list();
    if (channels.length === 0) {
      await ctx.reply('No channels registered yet. Go to 📡 Channels first to add one, then come back and finish this post.');
      return;
    }
    ctx.session.finishAction = action;
    ctx.session.step = 'select_channels_finish';
    await showStep(ctx, `${header(5)}\n\nSelect target channel(s):`, channelPickerKeyboard(channels, ctx.session.draft.channelIds));
  });

  // v1.2.0: Back from channel picking / schedule-time / template-naming
  // returns to the Preview screen with the draft fully intact, instead of
  // the old behavior where the only way out was "❌ Cancel" (which nuked
  // the whole post).
  bot.action('cp:finish:backpreview', async (ctx) => {
    await ctx.answerCbQuery();
    delete ctx.session.finishAction;
    await backToPreviewPanel(ctx);
  });

  bot.action(/^cp:poll:toggle:(.+)$/, async (ctx) => {
    const field = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    draft.options.poll[field] = !draft.options.poll[field];
    try {
      await ctx.editMessageReplyMarkup(pollOptionsKeyboard(draft).reply_markup);
    } catch (_) {}
  });

  bot.action('cp:poll:continue', async (ctx) => {
    await ctx.answerCbQuery();
    await goToPreview(ctx);
  });

  bot.action(/^cp:undo:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Undone');
    await savedItems.trash(id);
    try { await ctx.editMessageText('↩️ Send cancelled.'); } catch (_) {}
    ctx.session = {};
  });

  bot.action('cp:back:mediatype', async (ctx) => {
    await ctx.answerCbQuery();
    await showMediaTypeStep(ctx);
  });

  bot.action('cp:back:content', async (ctx) => {
    await ctx.answerCbQuery();
    await askForContent(ctx);
  });

  bot.action('cp:back:formatting', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\nAdd formatting, links, or buttons — or tap Done.`, formattingKeyboard());
  });
}

module.exports = { enter, handleText, handleMedia, registerHandlers, goToPreview };
