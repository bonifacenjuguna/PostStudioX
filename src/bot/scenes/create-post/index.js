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
const { clearSession } = require('../../middleware/session');
const { DateTime } = require('luxon');
const settingsModel = require('../../../db/models/settings');
const { parseNaturalTime, quickPickPresets } = require('../../../services/naturalTime');
const { logAction } = require('../../../services/actionErrors');

// ---------------------------------------------------------------------------
// v2.0.0 REDESIGN — renamed from "New Post" to "Compose" (the old name and
// layout are explicitly what this rebuild moves away from), rebuilt around:
// natural-language scheduling in the owner's own timezone (no more typing
// UTC by hand), a safe fallback when no channel is connected yet (never a
// dead-end message), per-phrase formatting instead of whole-caption-only,
// and every Telegram entity type the formatter now supports.
//
// The single "control panel" message architecture from v1.2.0 (edited in
// place step to step, rather than a new chat message per step) is kept —
// it already achieves the edit-in-place goal the rest of this rebuild is
// applying everywhere else, so redoing it from scratch would be a step
// backward, not forward.
// ---------------------------------------------------------------------------

const TOTAL_STEPS = 5;
const STEP_LABELS = { 1: 'Post Type', 2: 'Content', 3: 'Format & Buttons', 4: 'Preview', 5: 'Finish' };

function header(stepNum) {
  return `🎨 COMPOSE — Step ${stepNum}/${TOTAL_STEPS} — ${STEP_LABELS[stepNum]}`;
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

function ensureLoopDefaults(draft) {
  if (!draft.options.loop) {
    draft.options.loop = { enabled: false, stayMinutes: null, gapMinutes: null, maxCycles: null };
  }
  return draft.options.loop;
}

// Applies the ⚙️ Settings → Defaults "strip links automatically" toggle
// right when a caption is captured, so the preview the owner sees already
// reflects it - rather than a surprise change happening silently at send time.
function applyStripLinksDefault(draft) {
  if (!draft.options.strip_links_default || !draft.caption) return;
  const stripped = stripLinks(draft.caption, draft.entities);
  draft.caption = stripped.text;
  draft.entities = stripped.entities;
}

// Translates the UI-facing draft.options.loop shape into the loop_config
// column's shape (see migration 003_v2_redesign.sql) - only when actually
// enabled and both durations are set, since a half-configured loop
// shouldn't silently start behaving unexpectedly.
function buildLoopConfig(draft) {
  const loop = draft.options.loop;
  if (!loop?.enabled || !loop.stayMinutes || !loop.gapMinutes) return null;
  return {
    enabled: true,
    stay_seconds: loop.stayMinutes * 60,
    gap_seconds: loop.gapMinutes * 60,
    max_cycles: loop.maxCycles ?? null,
    cycles_done: 0,
    active: true,
  };
}

async function enter(ctx) {
  const draft = freshDraft();
  // v2.0.0 FIX: ⚙️ Settings → 🎛 Defaults was previously never actually
  // read anywhere - every toggle in there was cosmetic. Applied here so
  // it's real, still fully overridable per post below.
  const defaults = await settingsModel.get('defaults', {});
  if (defaults.protect_content) draft.options.protect_content = true;
  if (defaults.disable_notification) draft.options.disable_notification = true;
  if (defaults.strip_links) draft.options.strip_links_default = true;
  if (defaults.default_channel_ids?.length) draft.channelIds = [...defaults.default_channel_ids];
  const autoDelete = await settingsModel.get('auto_delete_defaults', {});
  if (autoDelete.enabled && autoDelete.ttl_minutes) draft.options.autoDeleteMinutes = autoDelete.ttl_minutes;

  ctx.session = { scene: 'create-post', step: 'media_type', draft };
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
    [Markup.button.callback('📥 Import Existing Post', 'cp:import')],
    [Markup.button.callback('❌ Cancel', 'nav:cancel')],
  ]);
}

function formattingKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('Bold', 'cp:fmt:bold'), Markup.button.callback('Italic', 'cp:fmt:italic'), Markup.button.callback('Underline', 'cp:fmt:underline')],
    [Markup.button.callback('Strike', 'cp:fmt:strikethrough'), Markup.button.callback('Spoiler', 'cp:fmt:spoiler'), Markup.button.callback('Code', 'cp:fmt:code')],
    [Markup.button.callback('💬 Quote', 'cp:fmt:blockquote'), Markup.button.callback('💬 Expandable Quote', 'cp:fmt:expandable_blockquote')],
    [Markup.button.callback('🔗 Link', 'cp:fmt:link')],
    [Markup.button.callback('🚫 Remove All Links', 'cp:fmt:striplinks'), Markup.button.callback('🔀 Replace All Links', 'cp:fmt:replacelinks')],
    [Markup.button.callback('🔘 Add Buttons', 'cp:buttons:add')],
    [Markup.button.callback('❓ Formatting Help', 'cp:fmt:help')],
    [Markup.button.callback('✅ Done, continue', 'cp:fmt:done')],
    backCancelRow('cp:back:content'),
  ]);
}

const FORMAT_HELP_TEXT =
  '❓ FORMATTING HELP\n\n' +
  'Fastest way: type shorthand directly in your caption — no buttons needed:\n' +
  '**bold**  __italic__  ~~strike~~  ++underline++  ||spoiler||\n' +
  '`code`  ```code block```\n' +
  '>>blockquote<<  >>>expandable blockquote<<<\n' +
  '[link text](https://example.com)\n' +
  '[mention](tg://user?id=123456789) — mentions a user with no @username\n' +
  '{emoji:5368324170671202286}😀{/emoji} — custom emoji (fallback glyph shown to non-Premium viewers)\n\n' +
  'Or use the buttons: tap a style, then send the exact word/phrase from your caption to apply it to just that part (or send ALL to apply to everything).';

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

// Maps a real Telegram Message object (from a forward, or fetched via
// forwardMessage when importing by link) into our draft shape. Used by the
// Import feature - this is the whole reason importing goes through
// forward/link rather than copy-paste: the Message object carries the real
// entities array (hyperlinks, blockquotes, everything), which manual
// copy-paste of visible text cannot reproduce.
const { extractDraftFieldsFromMessage } = require('../../../services/messageAdapter');
const { parseTmeLink } = require('../../../services/telegramLinks');

async function handleImportInput(ctx) {
  const draft = ctx.session.draft;

  // Case 1: forwarded directly into this chat - everything needed is
  // already on ctx.message, no extra API call required.
  if (ctx.message.forward_from_chat || ctx.message.forward_origin?.chat) {
    const fields = extractDraftFieldsFromMessage(ctx.message);
    const sourceChat = ctx.message.forward_from_chat || ctx.message.forward_origin.chat;
    Object.assign(draft, fields);
    draft.importedFrom = { chat_id: String(sourceChat.id), message_id: ctx.message.forward_from_message_id || ctx.message.message_id, via: 'forward' };
    ctx.session.step = 'formatting';
    await showStep(
      ctx,
      `${header(3)}\n\n📥 Imported. Formatting, media, and links carried over as-is — use 🔀 Replace All Links below if you want to swap the links, or edit anything else.`,
      formattingKeyboard()
    );
    return true;
  }

  // Case 2: a t.me link to a post in one of our own registered channels.
  const text = ctx.message.text?.trim();
  if (!text) return false;
  const parsed = parseTmeLink(text);
  if (!parsed) return false;

  const messageId = parsed.messageId;
  let sourceChatId;
  if (parsed.chatId) {
    sourceChatId = parsed.chatId; // t.me/c/<internal_id>/<msg_id> form
  } else {
    const channel = await channelsModel.list().then((list) => list.find((c) => c.username?.toLowerCase() === parsed.username.toLowerCase()));
    if (!channel) {
      await ctx.reply(`🔴 "${parsed.username}" isn't one of your registered channels, so I can't read that post — only channels the bot manages can be imported from.`);
      return true;
    }
    sourceChatId = channel.chat_id;
  }

  try {
    // forwardMessage (not copyMessage) is used deliberately here: it's the
    // only Bot API call that returns the FULL Message object, entities
    // included - copyMessage only returns a bare message_id. The forwarded
    // copy lands in this owner<->bot chat as a staging step, then gets
    // deleted once its content is captured, so no forward-tagged clutter
    // is left behind for the owner to see.
    const fetched = await ctx.telegram.forwardMessage(ctx.chat.id, sourceChatId, messageId);
    const fields = extractDraftFieldsFromMessage(fetched);
    Object.assign(draft, fields);
    draft.importedFrom = { chat_id: String(sourceChatId), message_id: messageId, via: 'link' };
    await ctx.telegram.deleteMessage(ctx.chat.id, fetched.message_id).catch(() => {});
    ctx.session.step = 'formatting';
    await showStep(
      ctx,
      `${header(3)}\n\n📥 Imported. Formatting, media, and links carried over as-is — use 🔀 Replace All Links below if you want to swap the links, or edit anything else.`,
      formattingKeyboard()
    );
  } catch (err) {
    const msg = await logAction({ scene: 'create-post', step: 'import', attempted: `read post ${messageId} from ${sourceChatId} via link`, error: err });
    await ctx.reply(msg);
  }
  return true;
}

// v2.0.0 BUG FIX: if the owner applies formatting using Telegram's own
// native toolbar (bold/italic/blockquote buttons in the app) instead of
// typing this bot's **shorthand** markers, the message arrives with REAL
// entities already attached (ctx.message.entities/caption_entities) - the
// plain .text field never contains the formatting, only the visible
// characters. Previously this was never checked, so native formatting was
// silently discarded and only literally-typed shorthand markers worked.
// Native entities (when present) are trusted as-is instead of re-parsing
// plain text for shorthand, since they're already the exact real thing.
function extractFormattedContent(message) {
  const nativeEntities = message.entities || message.caption_entities;
  const rawText = message.text ?? message.caption ?? '';
  if (nativeEntities && nativeEntities.length > 0) {
    return { text: rawText, entities: nativeEntities };
  }
  return parseShorthand(rawText);
}

async function handleText(ctx) {
  const step = ctx.session.step;
  const draft = ctx.session.draft;
  const text = ctx.message.text;
  if (!draft) {
    await ctx.reply('⏱ This Compose session has expired or already finished. Start a new one with 🎨 Compose.', homeReplyKeyboard());
    ctx.session = {};
    return;
  }

  if (step === 'awaiting_import') {
    const handled = await handleImportInput(ctx);
    if (handled) return;
    await ctx.reply('That didn\'t look like a forward or a t.me link — try again, or tap Back to pick a post type instead.');
    return;
  }

  if (step === 'awaiting_content' && (draft.mediaType === 'text' || draft.mediaType === 'poll')) {
    if (draft.mediaType === 'poll' && !draft.options.pollQuestion) {
      draft.options.pollQuestion = text;
      ctx.session.step = 'awaiting_poll_answers';
      await showStep(ctx, `${header(2)}\n\nNow send answer options separated by commas, e.g.:\nYes, No, Maybe`, Markup.inlineKeyboard([backCancelRow('cp:back:mediatype')]));
      return;
    }
    if (draft.mediaType === 'text') {
      const { text: parsedText, entities } = extractFormattedContent(ctx.message);
      draft.caption = parsedText;
      draft.entities = entities;
      applyStripLinksDefault(draft);
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
    const { text: parsedText, entities } = text === '/skip' ? { text: '', entities: [] } : extractFormattedContent(ctx.message);
    draft.caption = parsedText;
    draft.entities = entities;
    applyStripLinksDefault(draft);
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
    const defaultStyle = (await settingsModel.get('defaults', {})).button_style || 'default';
    const mark = (s) => (s === defaultStyle ? '⭐ ' : '');
    await showStep(ctx, `${header(3)}\n\nPick a color style for this button (⭐ = your Settings default):`, Markup.inlineKeyboard([
      [Markup.button.callback(`${mark('primary')}🔵 Primary`, 'cp:btnstyle:primary'), Markup.button.callback(`${mark('danger')}🔴 Danger`, 'cp:btnstyle:danger')],
      [Markup.button.callback(`${mark('success')}🟢 Success`, 'cp:btnstyle:success'), Markup.button.callback(`${mark('default')}⚪ Default`, 'cp:btnstyle:default')],
      backCancelRow('cp:back:formatting'),
    ]));
    return;
  }

  if (step === 'awaiting_loop_stay_custom' || step === 'awaiting_loop_gap_custom') {
    const { parseDurationMinutes } = require('../../../services/naturalTime');
    const { minutes, error } = parseDurationMinutes(text);
    if (error) {
      await ctx.reply(error);
      return;
    }
    const loop = ensureLoopDefaults(draft);
    loop[step === 'awaiting_loop_stay_custom' ? 'stayMinutes' : 'gapMinutes'] = minutes;
    ctx.session.step = 'formatting'; // harmless placeholder, immediately overwritten by showStep below
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
    return;
  }

  if (step === 'awaiting_loop_cycles') {
    const n = parseInt(text.trim(), 10);
    if (!Number.isInteger(n) || n < 1) {
      await ctx.reply('Send a whole number of 1 or more, e.g. 5.');
      return;
    }
    const loop = ensureLoopDefaults(draft);
    loop.maxCycles = n;
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
    return;
  }

  if (step === 'awaiting_format_target') {
    const target = text.trim();
    const applyWhole = target.toUpperCase() === 'ALL';
    const idx = applyWhole ? 0 : draft.caption.indexOf(target);
    if (!applyWhole && idx === -1) {
      await ctx.reply(`Couldn't find "${target}" in your caption exactly as typed — try again, or send ALL for the whole text.`);
      return;
    }
    const length = applyWhole ? draft.caption.length : target.length;
    draft.entities.push({ type: ctx.session.formatAction, offset: idx, length });
    delete ctx.session.formatAction;
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\n✅ Applied. Add more, or tap Done.`, formattingKeyboard());
    return;
  }

  if (step === 'awaiting_replace_links_url') {
    const { replaceAllLinks } = require('../../../services/telegramFormatter');
    const newUrl = text.trim();
    const result = replaceAllLinks(draft.caption, draft.entities, newUrl);
    draft.caption = result.text;
    draft.entities = result.entities;
    ctx.session.step = 'formatting';
    await showStep(
      ctx,
      `${header(3)}\n\n${result.linksFound ? `🔀 All links replaced with ${newUrl}.` : 'No links were found to replace — nothing changed.'}`,
      formattingKeyboard()
    );
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

// v2.0.0 BUG FIX: photo/video/document previously always asked for a
// caption as a SEPARATE follow-up message, even when the owner had already
// attached one to the same message they sent (the normal way most people
// post - attach media, type caption, hit send once). That attached caption
// was silently discarded and the bot asked for it again. Now it's read
// straight off the incoming message when present, entities included.
async function captureAttachedCaptionOrPrompt(ctx) {
  const draft = ctx.session.draft;
  if (ctx.message.caption) {
    const { text: parsedText, entities } = extractFormattedContent(ctx.message);
    draft.caption = parsedText;
    draft.entities = entities;
    applyStripLinksDefault(draft);
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\nCaption carried over. Add more formatting, links, or buttons — or tap Done.`, formattingKeyboard());
    return;
  }
  ctx.session.step = 'caption_for_media';
  await showStep(ctx, `${header(3)}\n\nAdd a caption (or send /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
}

async function handleMedia(ctx) {
  const step = ctx.session.step;
  const draft = ctx.session.draft;
  if (!draft) return;

  if (step === 'awaiting_import') {
    await handleImportInput(ctx);
    return;
  }

  if (step !== 'awaiting_content') return;

  if (draft.mediaType === 'photo' && ctx.message.photo) {
    const largest = ctx.message.photo[ctx.message.photo.length - 1];
    draft.mediaItems = [{ file_id: largest.file_id, type: 'photo' }];
    await captureAttachedCaptionOrPrompt(ctx);
  } else if (draft.mediaType === 'video' && ctx.message.video) {
    draft.mediaItems = [{ file_id: ctx.message.video.file_id, type: 'video' }];
    await captureAttachedCaptionOrPrompt(ctx);
  } else if (draft.mediaType === 'document' && ctx.message.document) {
    draft.mediaItems = [{ file_id: ctx.message.document.file_id, type: 'document' }];
    await captureAttachedCaptionOrPrompt(ctx);
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

function formatMinutes(minutes) {
  if (!minutes) return 'not set';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(minutes % 60 ? 1 : 0)} hr`;
  if (minutes < 10080) return `${(minutes / 1440).toFixed(minutes % 1440 ? 1 : 0)} day(s)`;
  return `${(minutes / 10080).toFixed(1)} week(s)`;
}

const LOOP_DURATION_PRESETS = [10, 30, 60, 180, 1440, 10080]; // minutes: 10m,30m,1h,3h,1d,1w

function loopMenuKeyboard(loop) {
  const rows = [];
  const durationRow = (prefix) => {
    const r = [];
    for (let i = 0; i < LOOP_DURATION_PRESETS.length; i += 3) {
      rows.push(
        LOOP_DURATION_PRESETS.slice(i, i + 3).map((m) => Markup.button.callback(formatMinutes(m), `cp:loop:${prefix}:${m}`))
      );
    }
    rows.push([Markup.button.callback('⌨️ Type a custom duration', `cp:loop:${prefix}custom`)]);
  };
  rows.push([Markup.button.callback('— Set "stay up" duration —', 'nav:noop')]);
  durationRow('stay');
  rows.push([Markup.button.callback('— Set "repost gap" duration —', 'nav:noop')]);
  durationRow('gap');
  rows.push([
    Markup.button.callback(`${loop.maxCycles == null ? '✅' : '⬜'} Infinite`, 'cp:loop:cycles:infinite'),
    Markup.button.callback(`${loop.maxCycles != null ? '✅' : '⬜'} Set a number`, 'cp:loop:cycles:set'),
  ]);
  rows.push([Markup.button.callback(loop.enabled ? '🛑 Disable Loop' : '✅ Enable Loop', 'cp:loop:toggle')]);
  rows.push(backCancelRow('cp:finish:backpreview'));
  return Markup.inlineKeyboard(rows);
}

function loopMenuText(loop) {
  return (
    `${header(4)}\n\n🔁 LOOP MODE\n\n` +
    `Stay up: ${formatMinutes(loop.stayMinutes)}\n` +
    `Repost gap: ${formatMinutes(loop.gapMinutes)}\n` +
    `Cycles: ${loop.maxCycles == null ? 'Infinite (until you stop it)' : loop.maxCycles}\n` +
    `Status: ${loop.enabled ? '✅ Enabled' : '⬜ Disabled'}\n\n` +
    (loop.enabled && (!loop.stayMinutes || !loop.gapMinutes)
      ? '⚠️ Set both durations before this can actually run.\n\n'
      : '') +
    'Post goes live → stays up → deletes → waits the gap → reposts. Repeats per your cycle setting.'
  );
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
    rows.push([Markup.button.callback('▫️▫️ OPTIONS ▫️▫️', 'nav:noop')]);
    rows.push([
      Markup.button.callback(`${draft.options.protect_content ? '🔒' : '🔓'} Protect Content: ${draft.options.protect_content ? 'On' : 'Off'}`, 'cp:opt:toggle:protect_content'),
    ]);
    rows.push([
      Markup.button.callback(`${draft.options.disable_link_preview ? '🚫🔗' : '🔗'} Link Preview: ${draft.options.disable_link_preview ? 'Off' : 'On'}`, 'cp:opt:toggle:disable_link_preview'),
    ]);
    rows.push([
      Markup.button.callback(`🔁 Loop Mode: ${draft.options.loop?.enabled ? 'On' : 'Off'}`, 'cp:loop:menu'),
    ]);
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
    buttons: draft.buttons, options: draft.options, loopConfig: buildLoopConfig(draft), importedFrom: draft.importedFrom || null,
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
        await clearSession(ctx);
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

async function scheduleTimeKeyboard() {
  const presets = quickPickPresets();
  const rows = [];
  for (let i = 0; i < presets.length; i += 2) {
    rows.push(
      presets.slice(i, i + 2).map((p, j) => Markup.button.callback(p.label, `cp:schedpick:${i + j}`))
    );
  }
  rows.push(backCancelRow('cp:finish:backpreview'));
  return Markup.inlineKeyboard(rows);
}

async function showScheduleStep(ctx) {
  ctx.session.step = 'awaiting_schedule_time';
  const tz = await settingsModel.get('timezone', 'UTC');
  const now = DateTime.now().setZone(tz);
  await showStep(
    ctx,
    `${header(5)}\n\nRight now it's ${now.toFormat('EEE d MMM, HH:mm')} in your timezone (${tz}).\n\n` +
      'Pick a quick option, or just type when — e.g. "tomorrow 9am", "friday 6pm", "in 2 hours".',
    await scheduleTimeKeyboard()
  );
}

async function handleScheduleInput(ctx, text) {
  const tz = await settingsModel.get('timezone', 'UTC');
  const { dt, error } = parseNaturalTime(text, tz);
  if (error) {
    await ctx.reply(`${error}`);
    return;
  }
  await finalizeSchedule(ctx, dt, tz);
}

async function finalizeSchedule(ctx, dtUtc, tz) {
  if (dtUtc.toMillis() <= Date.now()) {
    await ctx.reply('That works out to a time in the past — try again with a future time.');
    return;
  }
  const draft = ctx.session.draft;
  const item = await savedItems.create({
    kind: 'post', status: 'scheduled', channelIds: draft.channelIds, mediaType: draft.mediaType,
    mediaItems: draft.mediaItems, caption: draft.caption, entities: draft.entities,
    buttons: draft.buttons, options: draft.options, scheduledFor: dtUtc.toISO(),
    autoDeleteAt: draft.options.autoDeleteMinutes ? dtUtc.plus({ minutes: draft.options.autoDeleteMinutes }).toISO() : null,
    loopConfig: buildLoopConfig(draft), importedFrom: draft.importedFrom || null,
  });
  await schedulePost(item.id, dtUtc.toISO());
  const names = await channelNames(draft.channelIds);
  const local = dtUtc.setZone(tz);
  await ctx.reply(`⏰ Scheduled for ${local.toFormat('EEE d MMM, HH:mm')} (${tz}) to ${names}.`, homeReplyKeyboard());
  ctx.session = {};
}

async function saveAsTemplate(ctx, name, { silent = false } = {}) {
  const draft = ctx.session.draft;
  const saved = await savedItems.create({
    kind: 'template', name, status: 'draft', mediaType: draft.mediaType, mediaItems: draft.mediaItems,
    caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options, channelIds: [],
  });
  if (silent) {
    await ctx.reply(`💾 Saved as template: "${name}" — now sending...`);
  } else {
    await ctx.reply(`💾 Saved as template: "${name}"`);
    ctx.session = { scene: 'templates' };
    const { promptFolderChoice } = require('../../components/folderPicker');
    await promptFolderChoice(ctx, saved.id);
  }
}

async function registerHandlers(bot) {
  // v1.2.0 FIX: every cp:* handler below reads ctx.session.draft. If the
  // session had already moved on (post already sent, flow abandoned and
  // reset by starting a new one, 3-day session TTL expired) and the person
  // taps a button from an old, still-visible message, draft is gone and
  // the handler would throw a raw TypeError trying to read a property off
  // undefined - which is exactly what produced the generic "Something
  // went wrong" error. Every cp:* action now checks first and fails with
  // an actual explanation instead.
  const requireDraft = async (ctx, next) => {
    if (!ctx.session?.draft) {
      await ctx.answerCbQuery('This step has expired', { show_alert: true });
      try { await ctx.editMessageText('⏱ This Compose session has expired or already finished. Start a new one with 🎨 Compose.'); } catch (_) {}
      return;
    }
    return next();
  };

  bot.action(/^cp:chan:(.+)$/, requireDraft, async (ctx) => {
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
        await showScheduleStep(ctx);
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

  bot.action(/^cp:type:(.+)$/, requireDraft, async (ctx) => {
    const type = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.draft.mediaType = type;
    if (type === 'media_group') ctx.session.draft.mediaItems = [];
    await askForContent(ctx);
  });

  bot.action('cp:library', requireDraft, async (ctx) => {
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

  bot.action('cp:import', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_import';
    await showStep(
      ctx,
      `${header(1)}\n\n📥 IMPORT EXISTING POST\n\n` +
        'Forward the post here, or send a t.me link to a post in one of YOUR registered channels ' +
        '(the bot can only read posts from channels it actually manages — not arbitrary outside channels).\n\n' +
        'Formatting, media, and hyperlinks come across exactly as they are — this is why forwarding/linking is used ' +
        'instead of copy-paste, which silently drops hyperlink formatting.',
      Markup.inlineKeyboard([backCancelRow('cp:back:mediatype')])
    );
  });

  bot.action(/^cp:libpick:(\d+)$/, requireDraft, async (ctx) => {
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

  bot.action('cp:media:done', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nAdd a caption for the album (or /skip):`, Markup.inlineKeyboard([backCancelRow('cp:back:content')]));
  });

  bot.action(/^cp:fmt:(.+)$/, requireDraft, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    if (action === 'done') {
      await goToPreview(ctx);
      return;
    }
    if (action === 'help') {
      await showStep(ctx, `${header(3)}\n\n${FORMAT_HELP_TEXT}`, formattingKeyboard());
      return;
    }
    if (action === 'striplinks') {
      const stripped = stripLinks(draft.caption, draft.entities);
      draft.caption = stripped.text;
      draft.entities = stripped.entities;
      await showStep(ctx, `${header(3)}\n\n🚫 All links removed from the text.`, formattingKeyboard());
      return;
    }
    if (action === 'replacelinks') {
      ctx.session.step = 'awaiting_replace_links_url';
      await showStep(ctx, `${header(3)}\n\n🔀 Send the one new link — every existing link in this post will be replaced with it (labels stay the same).`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
      return;
    }
    if (action === 'link') {
      ctx.session.step = 'awaiting_link_text';
      await showStep(ctx, `${header(3)}\n\nSend the visible text for the link.`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
      return;
    }
    // v2.0.0 FIX: every style used to apply to the ENTIRE caption, no matter
    // how long, with no way to format just a phrase - now prompts for which
    // exact word/phrase to wrap (or ALL for the whole thing), and applies
    // the entity to just that span.
    const ENTITY_TYPES = ['bold', 'italic', 'underline', 'strikethrough', 'spoiler', 'code', 'blockquote', 'expandable_blockquote'];
    if (ENTITY_TYPES.includes(action)) {
      if (!draft.caption) {
        await showStep(ctx, `${header(3)}\n\nType your text first, then apply formatting.`, formattingKeyboard());
        return;
      }
      ctx.session.step = 'awaiting_format_target';
      ctx.session.formatAction = action;
      await showStep(
        ctx,
        `${header(3)}\n\nSend the exact word/phrase from your caption to make ${action.replace('_', ' ')} — or send ALL for the whole text.`,
        Markup.inlineKeyboard([backCancelRow('cp:back:formatting')])
      );
    }
  });

  bot.action('cp:buttons:add', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_button_text';
    await showStep(ctx, `${header(3)}\n\nSend the button label text.`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
  });

  bot.action(/^cp:btnstyle:(.+)$/, requireDraft, async (ctx) => {
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

  bot.action(/^cp:opt:toggle:(.+)$/, requireDraft, async (ctx) => {
    const key = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    draft.options[key] = !draft.options[key];
    await backToPreviewPanel(ctx);
  });

  bot.action('cp:loop:menu', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    const loop = ensureLoopDefaults(ctx.session.draft);
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
  });

  bot.action(/^cp:loop:(stay|gap):(\d+)$/, requireDraft, async (ctx) => {
    const [, field, minutesStr] = ctx.match;
    await ctx.answerCbQuery();
    const loop = ensureLoopDefaults(ctx.session.draft);
    loop[field === 'stay' ? 'stayMinutes' : 'gapMinutes'] = parseInt(minutesStr, 10);
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
  });

  bot.action(/^cp:loop:(stay|gap)custom$/, requireDraft, async (ctx) => {
    const field = ctx.match[1];
    await ctx.answerCbQuery();
    ctx.session.step = `awaiting_loop_${field}_custom`;
    await showStep(ctx, `${header(4)}\n\nType a duration, e.g. "45m", "2h", "1 day":`, Markup.inlineKeyboard([backCancelRow('cp:loop:menu')]));
  });

  bot.action('cp:loop:cycles:infinite', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    const loop = ensureLoopDefaults(ctx.session.draft);
    loop.maxCycles = null;
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
  });

  bot.action('cp:loop:cycles:set', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_loop_cycles';
    await showStep(ctx, `${header(4)}\n\nHow many cycles? (a whole number, e.g. 5)`, Markup.inlineKeyboard([backCancelRow('cp:loop:menu')]));
  });

  bot.action('cp:loop:toggle', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    const loop = ensureLoopDefaults(ctx.session.draft);
    loop.enabled = !loop.enabled;
    await showStep(ctx, loopMenuText(loop), loopMenuKeyboard(loop));
  });

  bot.action('cp:edit:caption', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'caption_for_media';
    await showStep(ctx, `${header(3)}\n\nSend the new caption text (shorthand formatting supported):`, Markup.inlineKeyboard([backCancelRow('cp:back:formatting')]));
  });

  bot.action('cp:save:template', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_template_name';
    await showStep(ctx, `${header(5)}\n\nName this template:`, Markup.inlineKeyboard([backCancelRow('cp:finish:backpreview')]));
  });

  bot.action('cp:save:draft', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    await savedItems.create({
      kind: 'post', status: 'draft', channelIds: [], mediaType: draft.mediaType, mediaItems: draft.mediaItems,
      caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options,
      loopConfig: buildLoopConfig(draft), importedFrom: draft.importedFrom || null,
    });
    await ctx.reply('📝 Saved as a draft (no channel, not sent) — find it later in 📜 History.', homeReplyKeyboard());
    ctx.session = {};
  });

  // v2.0.0: "no channel connected" recovery path - the draft is saved for
  // real first (so it genuinely can never just disappear), THEN we hand off
  // to Channels. True in-place resumption isn't safe to fake without a
  // larger session-stack redesign, so this is the honest version: nothing
  // lost, findable in History once the channel's added.
  bot.action('cp:save:draft:then_channels', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    await savedItems.create({
      kind: 'post', status: 'draft', channelIds: [], mediaType: draft.mediaType, mediaItems: draft.mediaItems,
      caption: draft.caption, entities: draft.entities, buttons: draft.buttons, options: draft.options,
      loopConfig: buildLoopConfig(draft), importedFrom: draft.importedFrom || null,
    });
    await ctx.reply('📝 Saved as a draft so nothing\'s lost — find it in 📜 History once your channel is added.\n\nNow let\'s add that channel:');
    const channels = require('../channels');
    await channels.enter(ctx);
  });

  bot.action(/^cp:schedpick:(\d+)$/, requireDraft, async (ctx) => {
    const idx = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const preset = quickPickPresets()[idx];
    if (!preset) return;
    const tz = await settingsModel.get('timezone', 'UTC');
    const dt = DateTime.now().setZone(tz).plus({ minutes: preset.minutes }).toUTC();
    await finalizeSchedule(ctx, dt, tz);
  });

  bot.action(/^cp:finish:(send|schedule|send_template)$/, requireDraft, async (ctx) => {
    const action = ctx.match[1];
    await ctx.answerCbQuery();
    const channels = await channelsModel.list();
    if (channels.length === 0) {
      // v2.0.0 FIX: this used to be a plain text dead end ("go add a
      // channel, then come back") with no way to recover the post in
      // progress from right here. The draft is still sitting in the
      // session untouched, so offer the two things that actually help.
      await ctx.reply(
        'No channels registered yet, so there\'s nowhere to send this to.',
        Markup.inlineKeyboard([
          [Markup.button.callback('📝 Save as Draft instead', 'cp:save:draft')],
          [Markup.button.callback('➕ Add a Channel Now (auto-saves as draft first)', 'cp:save:draft:then_channels')],
          backCancelRow('cp:finish:backpreview'),
        ])
      );
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
  bot.action('cp:finish:backpreview', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    delete ctx.session.finishAction;
    await backToPreviewPanel(ctx);
  });

  bot.action(/^cp:poll:toggle:(.+)$/, requireDraft, async (ctx) => {
    const field = ctx.match[1];
    await ctx.answerCbQuery();
    const draft = ctx.session.draft;
    draft.options.poll[field] = !draft.options.poll[field];
    try {
      await ctx.editMessageReplyMarkup(pollOptionsKeyboard(draft).reply_markup);
    } catch (_) {}
  });

  bot.action('cp:poll:continue', requireDraft, async (ctx) => {
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

  bot.action('cp:back:mediatype', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    await showMediaTypeStep(ctx);
  });

  bot.action('cp:back:content', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    await askForContent(ctx);
  });

  bot.action('cp:back:formatting', requireDraft, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'formatting';
    await showStep(ctx, `${header(3)}\n\nAdd formatting, links, or buttons — or tap Done.`, formattingKeyboard());
  });
}

module.exports = { enter, handleText, handleMedia, registerHandlers, goToPreview };
