const { countButtons, MAX_BUTTONS } = require('./buttonBuilder');
const { checkAll, extractUrls } = require('./linkChecker');
const channelsModel = require('../db/models/channels');

const CAPTION_LIMIT = 1024;
const TEXT_LIMIT = 4096;

async function validateDraft(draft) {
  const issues = [];

  const limit = draft.mediaType && draft.mediaType !== 'text' ? CAPTION_LIMIT : TEXT_LIMIT;
  if ((draft.caption || '').length > limit) {
    issues.push(`Text is ${draft.caption.length} chars, over the ${limit} limit for this post type.`);
  }

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

  return { ok: issues.length === 0, issues };
}

module.exports = { validateDraft };
