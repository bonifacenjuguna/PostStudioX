// Parses a t.me link into either a username-based reference or a private
// (c/<internal_id>) reference. Shared by Compose's Import feature and the
// Replace-Live feature (edit/replace an already-sent post via link) - both
// need to turn "a link someone pasted" into "which chat, which message" the
// same way, so this lives in one place rather than two.

const TME_LINK_PATTERN = /^(?:https?:\/\/)?t\.me\/(c\/(\d+)|([A-Za-z0-9_]+))\/(\d+)/i;

// Returns { username, messageId } or { chatId, messageId } depending on the
// link form, or null if it doesn't look like a t.me post link at all.
function parseTmeLink(text) {
  const match = (text || '').trim().match(TME_LINK_PATTERN);
  if (!match) return null;
  const messageId = parseInt(match[4], 10);
  if (match[2]) return { chatId: `-100${match[2]}`, messageId };
  return { username: match[3], messageId };
}

module.exports = { TME_LINK_PATTERN, parseTmeLink };
