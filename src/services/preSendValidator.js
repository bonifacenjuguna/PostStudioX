const { countButtons, MAX_BUTTONS } = require('./buttonBuilder');
const { checkAll, extractUrls } = require('./linkChecker');
const channelsModel = require('../db/models/channels');
const dedupeChecker = require('./dedupeChecker');

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

// v1.1.0 (#4): channel selection now happens at the *end* of New Post (Send
// / Schedule / Save), not the start - so this needs to validate content on
// its own without requiring channels to exist yet. Pass
// { requireChannels: true } only at the point where channels have actually
// been picked (right before Send/Schedule).
async function validateDraft(draft, { requireChannels = true } = {}) {
  const issues = [];
  const warnings = [];

  const limit = draft.mediaType && draft.mediaType !== 'text' ? CAPTION_LIMIT : TEXT_LIMIT;
  if ((draft.caption || '').length > limit) {
    issues.push(`Text is ${draft.caption.length} chars, over the ${limit} limit for this post type.`);
  }

  // v2.2.5 FIX: this validator existed but never checked for genuinely
  // empty content, and was only ever called informationally (to build the
  // Preview screen's warnings) - never as an actual gate before sending.
  // That combination let an empty text-only post reach Telegram's own
  // sendMessage call, which rejects it outright ("message text is empty")
  // - by then it's too late to give the owner a clean chance to fix it.
  if (draft.mediaType === 'text' && (draft.caption || '').trim().length === 0) {
    issues.push('This post has no text — a text-only post needs some content before it can be sent.');
  }
  if (draft.mediaType === 'poll') {
    if (!draft.options?.poll?.question || draft.options.poll.question.trim().length === 0) {
      issues.push('This poll has no question yet.');
    }
    if (!draft.options?.poll?.answers || draft.options.poll.answers.length < 2) {
      issues.push('A poll needs at least 2 answer options.');
    }
  }
  if (['photo', 'video', 'document'].includes(draft.mediaType) && (!draft.mediaItems || draft.mediaItems.length === 0)) {
    issues.push(`This post is set to ${draft.mediaType}, but no file was actually attached.`);
  }
  if (draft.mediaType === 'media_group' && (!draft.mediaItems || draft.mediaItems.length < 2)) {
    issues.push('A media group needs at least 2 photos/videos — use a single Photo/Video post type for just one.');
  }

  if (requireChannels) {
    if (!draft.channelIds || draft.channelIds.length === 0) {
      issues.push('No target channel selected.');
    } else {
      for (const chatId of draft.channelIds) {
        const ch = await channelsModel.findByChatId(chatId);
        if (ch && !ch.is_admin) {
          issues.push(`Bot no longer has admin rights in ${ch.title || chatId}.`);
        }
      }
    }
  }

  const buttonCount = countButtons(draft.buttons);
  if (buttonCount > MAX_BUTTONS) {
    issues.push(`Too many buttons (${buttonCount}), max is ${MAX_BUTTONS}.`);
  }

  const urls = extractUrls(draft.entities, draft.buttons);
  if (urls.length > 0) {
    const results = await checkAll(urls);
    for (const r of results) {
      if (!r.ok) issues.push(`Link may be broken: ${r.url} (${r.reason || r.status})`);
    }
  }

  if (!draft.mediaType) {
    issues.push('No content type selected.');
  }

  // Soft warning only - never blocks sending. A near-duplicate of something
  // posted recently is often intentional (reminders, cross-posts).
  if (draft.caption && draft.caption.trim().length > 0) {
    try {
      const similar = await dedupeChecker.findSimilarRecent(draft.caption);
      if (similar.length > 0) {
        const days = Math.round((Date.now() - new Date(similar[0].createdAt).getTime()) / 86400000);
        warnings.push(`This looks similar to a post you sent ${days === 0 ? 'today' : `${days}d ago`} (${Math.round(similar[0].similarity * 100)}% match).`);
      }
    } catch (_) {
      // best-effort only, never fail validation because of this
    }
  }

  return { ok: issues.length === 0, issues, warnings };
}

module.exports = { validateDraft };
