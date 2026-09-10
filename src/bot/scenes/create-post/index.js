const { Markup } = require('telegraf');
const channelsModel = require('../../../db/models/channels');
const savedItems = require('../../../db/models/savedItems');
const { parseShorthand, stripLinks } = require('../../../services/telegramFormatter');
const { buildInlineKeyboard, colorLabel } = require('../../../services/buttonBuilder');
const { validateDraft } = require('../../../services/preSendValidator');
const { sendPreview } = require('../../components/previewRenderer');
const { publishSavedItem } = require('../../../services/publisher');
const { schedulePost, scheduleAutoDelete } = require('../../../queue/queues');
const { flowReplyKeyboard, homeReplyKeyboard, quickNavRow, withEmergencyStop } = require('../../components/navRow');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');

function freshDraft() {
  return { channelIds: [], mediaType: null, mediaItems: [], caption: '', entities: [], buttons: [], options: {}, templateName: null };
}

// Content comes first now - what you're posting, not where. Channel
// selection (and the option to also save a template) moves to the very
// end, in showDestinationScreen(), once there's actually something to
// send. Previously this scene opened by demanding a channel before you'd
// typed a single word, and "Save as Template" vs "Send/Schedule" were
// mutually exclusive outcomes of the same draft - you couldn't do both.
async function enter(ctx) {
  ctx.session = { scene: 'create-post', step: 'media_type', draft: freshDraft() };
  await ctx.reply('Composing a new post.', flowReplyKeyboard());
  await ctx.reply('What kind of post is this?', mediaTypeKeyboard());
}

function mediaTypeKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼 Photo', 'cp:type:photo'), Markup.button.callback('🎥 Video', 'cp:type:video')],
    [Markup.button.callback('📄 Document', 'cp:type:document'), Markup.button.callback('💬 Text only', 'cp:type:text')],
    [Markup.button.callback('📊 Poll', 'cp:type:poll'), Markup.button.callback('🖼🎥 Media Group', 'cp:type:media_group')],
    [Markup.button.callback('❌ Cancel', 'nav:cancel')],
  ]);
}

function formattingKeyboard(draft) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Bold', 'cp:fmt:bold'), Markup.button.callback('Italic', 'cp:fmt:italic'), Markup.button.callback('Underline', 'cp:fmt:underline')],
    [Markup.button.callback('Strike', 'cp:fmt:strike'), Markup.button.callback('Spoiler', 'cp:fmt:spoiler'), Markup.button.callback('Code', 'cp:fmt:code')],
    [Markup.button.callback('🔗 Link', 'cp:fmt:link'), Markup.button.callback('💬 Quote', 'cp:fmt:quote')],
    [Markup.button.callback('🚫 Remove All Links', 'cp:fmt:striplinks')],
    [Markup.button.callback('🔘 Add Buttons', 'cp:buttons:add')],
    [Markup.button.callback('✅ Done, continue', 'cp:fmt:done')],
    [Markup.button.callback('⬅️ Back', 'cp:back:content'), Markup.button.callback('❌ Cancel', 'nav:cancel')],
  ]);
}

async function askForContent(ctx) {
  const { mediaType } = ctx.session.draft;
  ctx.session.step = 'awaiting_content';
  const prompts = {
    photo: 'Send the photo now.',
    video: 'Send the video now.',
    document: 'Send the document now.',
    text: 'Type your message text now. You can use shorthand: **bold** __italic__ ~~strike~~ ++underline++ ||spoiler|| `code` [text](url)',
    poll: 'Send your poll question, then I\'ll ask for answer options.',
    media_group: 'Send up to 10 photos/videos one at a time. Tap "Done adding" when finished.',
  };
  await ctx.reply(prompts[mediaType] || 'Send your content.');
}

async function handleText(ctx) {
  const step = ctx.session.step;
  const draft = ctx.session.draft;
  const text = ctx.message.text;

  if (step === 'awaiting_content' && (draft.mediaType === 'text' || draft.mediaType === 'poll')) {
    if (draft.mediaType === 'poll' && !draft.options.pollQuestion) {
      draft.options.pollQuestion = text;
      ctx.session.step = 'awaiting_poll_answers';
      await ctx.reply('Now send answer options separated by commas, e.g.: Yes, No, Maybe');
      return;
    }
    if (draft.mediaType === 'text') {
      const { text: parsedText, entities } = parseShorthand(text);
      draft.caption = parsedText;
      draft.entities = entities;
      ctx.session.step = 'formatting';
      await ctx.reply('Add more formatting or links? (optional)', formattingKeyboard(draft));
      return;
    }
  }

  if (ctx.session.step === 'awaiting_poll_answers') {
    draft.options.poll = { question: draft.options.pollQuestion, answers: text.split(',').map((s) => s.trim()).filter(Boolean) };
    delete draft.options.pollQuestion;
    await goToPreview(ctx);
    return;
  }

  if (step === 'awaiting_content' && ['photo', 'video', 'document'].includes(draft.mediaType)) {
    await ctx.reply('Please send the actual media file, or use the caption step after sending it.');
    return;
  }

  if (step === 'caption_for_media') {
    const { text: parsedText, entities } = parseShorthand(text === '/skip' ? '' : text);
    draft.caption = parsedText;
    draft.entities = entities;
    ctx.session.step = 'formatting';
    await ctx.reply('Add formatting or links? (optional)', formattingKeyboard(draft));
    return;
  }

  if (step === 'awaiting_link_text') {
    ctx.session.linkDraft = { text };
    ctx.session.step = 'awaiting_link_url';
    await ctx.reply('Now send the URL for that link.');
    return;
  }

  if (step === 'awaiting_link_url') {
    const linkText = ctx.session.linkDraft.text;
    draft.caption += (draft.caption ? ' ' : '') + linkText;
    const offset = draft.caption.length - linkText.length;
    draft.entities.push({ type: 'text_link', url: text.trim(), offset, length: linkText.length });
    ctx.session.step = 'formatting';
    await ctx.reply('Link added.', formattingKeyboard(draft));
    return;
  }

  if (step === 'awaiting_button_text') {
    ctx.session.buttonDraft = { text };
    ctx.session.step = 'awaiting_button_url';
    await ctx.reply('Now send the URL this button should open.');
    return;
  }

  if (step === 'awaiting_button_url') {
    ctx.session.buttonDraft.url = text.trim();
    ctx.session.step = 'awaiting_button_style';
    await ctx.reply('Pick a color style for this button:', Markup.inlineKeyboard([
      [Markup.button.callback('🔵 Primary', 'cp:btnstyle:bg_primary'), Markup.button.callback('🔴 Danger', 'cp:btnstyle:bg_danger')],
      [Markup.button.callback('🟢 Success', 'cp:btnstyle:bg_success'), Markup.button.callback('⚪ Default', 'cp:btnstyle:default')],
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

  if (step === 'awaiting_template_name_combo') {
    draft.templateName = text.trim();
    await showDestinationScreen(ctx);
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
    await ctx.reply('Add a caption (or send /skip):');
  } else if (draft.mediaType === 'video' && ctx.message.video) {
    draft.mediaItems = [{ file_id: ctx.message.video.file_id, type: 'video' }];
    ctx.session.step = 'caption_for_media';
    await ctx.reply('Add a caption (or send /skip):');
  } else if (draft.mediaType === 'document' && ctx.message.document) {
    draft.mediaItems = [{ file_id: ctx.message.document.file_id, type: 'document' }];
    ctx.session.step = 'caption_for_media';
    await ctx.reply('Add a caption (or send /skip):');
  } else if (draft.mediaType === 'media_group' && (ctx.message.photo || ctx.message.video)) {
    const item = ctx.message.photo
      ? { file_id: ctx.message.photo[ctx.message.photo.length - 1].file_id, type: 'photo' }
      : { file_id: ctx.message.video.file_id, type: 'video' };
    draft.mediaItems.push(item);
    if (draft.mediaItems.length >= 10) {
      ctx.session.step = 'caption_for_media';
      await ctx.reply('Reached 10 items (max for an album). Add a caption for the first item (or /skip):');
    } else {
      await ctx.reply(`Added (${draft.mediaItems.length}/10). Send another, or tap Done.`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Done adding media', 'cp:media:done')],
      ]));
    }
  }
}

// Shows the content preview and, once it's valid on its own merits (channel
// selection is deliberately NOT checked here - that's a destination
// concern, not a content concern), moves straight to showDestinationScreen.
// Exported so templates.js's "Use Template" can jump straight here with a
// pre-filled draft, instead of dead-ending back through mediaTypeKeyboard.
async function goToPreview(ctx) {
  ctx.session.step = 'preview';
  const draft = ctx.session.draft;
  await sendPreview(ctx, draft);

  const validation = await validateDraft(draft, { requireChannels: false });
  if (!validation.ok) {
    await ctx.reply(
      '⚠️ Issues found before you can continue:\n' + validation.issues.map((i) => `• ${i}`).join('\n'),
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Caption', 'cp:edit:caption')],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
    return;
  }
  await showDestinationScreen(ctx);
}

// The "finishing up" screen: pick channel(s) if you want to Send/Schedule,
// independently toggle "also save as template" (works with zero channels
// picked too), or just save a template outright. This is what replaces the
// old up-front, mutually-exclusive channel-then-send-OR-template flow.
async function showDestinationScreen(ctx, { edit = false } = {}) {
  ctx.session.step = 'destination';
  const draft = ctx.session.draft;
  const channels = await channelsModel.list();

  const text =
    "Here's your preview above 👆 — now decide where this goes.\n\n" +
    'Pick channel(s) if you want to Send or Schedule. "Also save as template" works independently, with or without channels picked.';

  const rows = channels.map((c) => [
    Markup.button.callback(`${draft.channelIds.includes(c.chat_id) ? '✅' : '⬜'} ${c.label || c.title || c.chat_id}`, `cp:destchan:${c.chat_id}`),
  ]);
  if (channels.length === 0) {
    rows.push([Markup.button.callback('📡 No channels yet - tap to add one', 'nav:goto:channels')]);
  }
  rows.push([Markup.button.callback(
    draft.templateName ? `✅ Also save as template ("${draft.templateName}")` : '⬜ Also save as template',
    'cp:dest:tmpltoggle'
  )]);
  rows.push([Markup.button.callback('⏰ Schedule', 'cp:dest:schedule'), Markup.button.callback('🚀 Send Now', 'cp:dest:send')]);
  rows.push([Markup.button.callback('💾 Save as Template Only', 'cp:dest:templateonly')]);
  rows.push(...quickNavRow());
  rows.push([Markup.button.callback('⬅️ Back', 'cp:back:content'), Markup.button.callback('❌ Cancel', 'nav:cancel')]);

  const keyboard = Markup.inlineKeyboard(withEmergencyStop(rows));
  if (edit) {
    try {
      await ctx.editMessageText(text, keyboard);
      return;
    } catch (_) { /* fall through to a fresh message */ }
  }
  await ctx.reply(text, keyboard);
}

// If the destination screen's template toggle was used, spawns the
// template record and returns its id so the post being sent/scheduled can
// be linked to it (spawned_template_id) - purely informational.
async function maybeSpawnTemplate(draft) {
  if (!draft.templateName) return null;
  const tmpl = await savedItems.create({
    kind: 'template', name: draft.templateName, status: 'draft', mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options, channelIds: [],
  });
  return tmpl.id;
}

async function doSend(ctx, { undoWindow = true } = {}) {
  const draft = ctx.session.draft;
  const templateId = await maybeSpawnTemplate(draft);
  const item = await savedItems.create({
    kind: 'post', status: 'draft', channelIds: draft.channelIds, mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options,
  });
  if (templateId) await savedItems.updateWithVersion(item.id, { spawned_template_id: templateId });

  const templateNote = templateId ? ` (also saved as template "${draft.templateName}")` : '';

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
        await ctx.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, `✅ Posted to ${draft.channelIds.join(', ')}${templateNote}`);
        ctx.session = {};
      } catch (err) {
        await ctx.telegram.sendMessage(msg.chat.id, `🔴 Send failed: ${err.message}`);
      }
    }, 5000);
  } else {
    await publishSavedItem(ctx.telegram, item);
    await ctx.reply(`✅ Posted to ${draft.channelIds.join(', ')}${templateNote}`, homeReplyKeyboard());
    ctx.session = {};
  }
}

async function handleScheduleInput(ctx, text) {
  const tz = await settingsModel.get('timezone', 'UTC');
  const dt = DateTime.fromFormat(text.trim(), 'yyyy-MM-dd HH:mm', { zone: tz });
  if (!dt.isValid) {
    await ctx.reply('Could not parse that. Use format: 2026-09-05 18:30');
    return;
  }
  const draft = ctx.session.draft;
  const templateId = await maybeSpawnTemplate(draft);
  const item = await savedItems.create({
    kind: 'post', status: 'scheduled', channelIds: draft.channelIds, mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options, scheduledFor: dt.toUTC().toISO(),
    autoDeleteAt: draft.options.autoDeleteMinutes ? dt.plus({ minutes: draft.options.autoDeleteMinutes }).toUTC().toISO() : null,
  });
  if (templateId) await savedItems.updateWithVersion(item.id, { spawned_template_id: templateId });
  const templateNote = templateId ? ` (also saved as template "${draft.templateName}")` : '';
  await schedulePost(item.id, dt.toUTC().toISO());
  await ctx.reply(`⏰ Scheduled for ${dt.toFormat('yyyy-MM-dd HH:mm')} (${tz})${templateNote}.`, homeReplyKeyboard());
  ctx.session = {};
}

async function saveAsTemplate(ctx, name) {
  const draft = ctx.session.draft;
  await savedItems.create({
    kind: 'template', name, status: 'draft', mediaType: draft.mediaType, mediaItems: draft.mediaItems,
    caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options, channelIds: [],
  });
  await ctx.reply(`💾 Saved as template: "${name}"`, homeReplyKeyboard());
  ctx.session = {};
}

async function registerHandlers(bot) {
  bot.action(/^cp:type:(.+)$/, async (ctx) => {
    const type = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.draft.mediaType = type;
    if (type === 'media_group') ctx.session.draft.mediaItems = [];
    await askForContent(ctx);
  });

  bot.action('cp:media:done', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await ctx.reply('Add a caption for the album (or /skip):');
  });

  bot.action(/^cp:fmt:(.+)$/, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (!draft) return;
    if (action === 'done') {
      await goToPreview(ctx);
      return;
    }
    if (action === 'striplinks') {
      const stripped = stripLinks(draft.caption, draft.entities);
      draft.caption = stripped.text;
      draft.entities = stripped.entities;
      await renderFormattingState(ctx, '🚫 All links removed from the text.');
      return;
    }
    if (action === 'link') {
      ctx.session.step = 'awaiting_link_text';
      await ctx.reply('Send the visible text for the link.');
      return;
    }
    if (action === 'quote') {
      draft.entities.push({ type: 'blockquote', offset: 0, length: draft.caption.length });
      await renderFormattingState(ctx, '💬 Whole caption marked as a blockquote.');
      return;
    }
    // bold/italic/underline/strike/code apply to the whole current caption for simplicity
    const typeMap = { bold: 'bold', italic: 'italic', underline: 'underline', strike: 'strikethrough', spoiler: 'spoiler', code: 'code' };
    if (typeMap[action] && draft.caption) {
      const already = draft.entities.some((e) => e.type === typeMap[action] && e.offset === 0 && e.length === draft.caption.length);
      if (already) {
        await renderFormattingState(ctx, `${action} is already applied.`);
        return;
      }
      draft.entities.push({ type: typeMap[action], offset: 0, length: draft.caption.length });
      await renderFormattingState(ctx, `Applied ${action}.`);
    } else {
      await ctx.reply('Type your text first, then apply formatting.', formattingKeyboard(draft));
    }
  });

  bot.action('cp:buttons:add', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_button_text';
    await ctx.reply('Send the button label text.');
  });

  bot.action(/^cp:btnstyle:(.+)$/, async (ctx) => {
    const style = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    const btn = { text: ctx.session.buttonDraft.text, url: ctx.session.buttonDraft.url };
    if (style !== 'default') btn.style = style;
    if (draft.buttons.length === 0) draft.buttons.push([]);
    draft.buttons[draft.buttons.length - 1].push(btn);
    delete ctx.session.buttonDraft;
    ctx.session.step = 'formatting';
    await ctx.reply(`🔘 Button added (${colorLabel(style)}).`, formattingKeyboard(draft));
  });

  bot.action('cp:edit:caption', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await ctx.reply('Send the new caption text (shorthand formatting supported):');
  });

  bot.action(/^cp:destchan:(.+)$/, async (ctx) => {
    const val = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (!draft || ctx.session.step !== 'destination') return;
    const idx = draft.channelIds.indexOf(val);
    if (idx >= 0) draft.channelIds.splice(idx, 1);
    else draft.channelIds.push(val);
    await showDestinationScreen(ctx, { edit: true });
  });

  bot.action('cp:dest:tmpltoggle', async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (!draft) return;
    if (draft.templateName) {
      draft.templateName = null;
      await showDestinationScreen(ctx, { edit: true });
    } else {
      ctx.session.step = 'awaiting_template_name_combo';
      await ctx.reply('Name this template (saved alongside whatever you choose next):');
    }
  });

  bot.action('cp:dest:templateonly', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_template_name';
    await ctx.reply('Name this template:');
  });

  bot.action('cp:dest:schedule', async (ctx) => {
    const draft = ctx.session.draft;
    if (!draft) return;
    if (draft.channelIds.length === 0) return ctx.answerCbQuery('Pick at least one channel first.');
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_schedule_time';
    const tz = await settingsModel.get('timezone', 'UTC');
    await ctx.reply(`Send the date/time to send this (format: yyyy-MM-dd HH:mm), in ${tz}.`);
  });

  bot.action('cp:dest:send', async (ctx) => {
    const draft = ctx.session.draft;
    if (!draft) return;
    if (draft.channelIds.length === 0) return ctx.answerCbQuery('Pick at least one channel first.');
    await ctx.answerCbQuery();
    await doSend(ctx, { undoWindow: true });
  });

  bot.action(/^cp:undo:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Undone');
    await savedItems.trash(id);
    try { await ctx.editMessageText('↩️ Send cancelled.'); } catch (_) {}
    ctx.session = {};
  });

  bot.action('cp:back:content', async (ctx) => {
    await ctx.answerCbQuery();
    await askForContent(ctx);
  });
}

async function renderFormattingState(ctx, note) {
  // Edits the SAME message instead of appending a fresh "Applied X" message
  // every tap - previously each format button spammed a new, near-identical
  // confirmation line, which read as "every button gives me the same
  // message back." Editing in place makes the actual change visible.
  const draft = ctx.session.draft;
  const text = `${note}\n\nCurrent text preview:\n${draft.caption || '(empty)'}`;
  try {
    await ctx.editMessageText(text, formattingKeyboard(draft));
  } catch (_) {
    await ctx.reply(text, formattingKeyboard(draft));
  }
}

module.exports = { enter, handleText, handleMedia, registerHandlers, goToPreview, showDestinationScreen };
