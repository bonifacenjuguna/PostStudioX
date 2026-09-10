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
