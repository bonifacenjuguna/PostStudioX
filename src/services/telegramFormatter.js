// Converts a lightweight custom shorthand into Telegram's native message
// entity format (offset + length + type), rather than raw MarkdownV2/HTML
// strings. This sidesteps MarkdownV2's escaping rules entirely and makes
// later edits (link replacement, link stripping, import-and-edit) a simple
// entity-array operation instead of re-parsing text.
//
// Shorthand supported (v2 — full Telegram entity coverage):
//   **bold**                       -> bold
//   __italic__                     -> italic
//   ~~strike~~                     -> strikethrough
//   ++underline++                  -> underline
//   ||spoiler||                    -> spoiler
//   `code`                         -> code
//   ```block```                    -> pre
//   [text](url)                    -> text_link
//   [text](tg://user?id=123)       -> text_mention (mention a user with no @username)
//   >>>text<<<                    -> expandable_blockquote (collapsible)
//   >>text<<                       -> blockquote
//   {emoji:CUSTOM_EMOJI_ID}😀{/emoji} -> custom_emoji (fallback glyph kept as visible text)
//
// Auto-detected by Telegram itself and NOT parsed here (left as plain text
// on purpose — Telegram recognizes them client-side): @mentions, #hashtags,
// $cashtags, /bot_commands, raw http(s) URLs, emails, phone numbers.

const EXPANDABLE_BLOCKQUOTE_PATTERN = /(?<!>)>>>(?!>)([\s\S]+?)(?<!<)<<<(?!<)/g;
const BLOCKQUOTE_PATTERN = /(?<!>)>>(?!>)([\s\S]+?)(?<!<)<<(?!<)/g;
const CUSTOM_EMOJI_PATTERN = /\{emoji:(\d+)\}(.+?)\{\/emoji\}/g;

// Order matters: expandable_blockquote and custom_emoji must run before the
// generic PATTERNS loop so their markers don't get mistaken for anything
// else, and blockquote must run after expandable_blockquote so `>>>...<<<`
// isn't half-consumed by the shorter `>>...<<` regex first.
const PATTERNS = [
  { regex: /\*\*(.+?)\*\*/g, type: 'bold' },
  { regex: /__(.+?)__/g, type: 'italic' },
  { regex: /~~(.+?)~~/g, type: 'strikethrough' },
  { regex: /\+\+(.+?)\+\+/g, type: 'underline' },
  { regex: /\|\|(.+?)\|\|/g, type: 'spoiler' },
  { regex: /```([\s\S]+?)```/g, type: 'pre' },
  { regex: /`(.+?)`/g, type: 'code' },
];

const LINK_PATTERN = /\[(.+?)\]\((tg:\/\/user\?id=\d+|https?:\/\/[^\s)]+)\)/g;
const TG_USER_ID_PATTERN = /^tg:\/\/user\?id=(\d+)$/;

// Rough URL matcher for raw (non-markdown) links typed directly in text —
// used by stripLinks/replaceAllLinks to catch links that weren't wrapped
// in [text](url) shorthand at all.
const RAW_URL_PATTERN = /(https?:\/\/[^\s]+)/g;

function parseShorthand(rawText) {
  let text = rawText;
  const entities = [];

  // Custom emoji first: its braces don't collide with anything else, but
  // running it early keeps the fallback glyph's offset stable before any
  // other replacement shifts things around.
  text = replaceAndTrack(text, CUSTOM_EMOJI_PATTERN, entities, (match) => ({
    type: 'custom_emoji',
    custom_emoji_id: match[1],
    replacement: match[2],
  }));

  // Links (and text-mentions, a link whose "url" is a tg://user?id=... deep
  // link) next, since their replacement text length differs from the source.
  text = replaceAndTrack(text, LINK_PATTERN, entities, (match) => {
    const userIdMatch = match[2].match(TG_USER_ID_PATTERN);
    if (userIdMatch) {
      return {
        type: 'text_mention',
        user: { id: Number(userIdMatch[1]) },
        replacement: match[1],
      };
    }
    return { type: 'text_link', url: match[2], replacement: match[1] };
  });

  // Expandable blockquote before plain blockquote (see ordering note above).
  text = replaceAndTrack(text, EXPANDABLE_BLOCKQUOTE_PATTERN, entities, (match) => ({
    type: 'expandable_blockquote',
    replacement: match[1],
  }));
  text = replaceAndTrack(text, BLOCKQUOTE_PATTERN, entities, (match) => ({
    type: 'blockquote',
    replacement: match[1],
  }));

  for (const { regex, type } of PATTERNS) {
    text = replaceAndTrack(text, regex, entities, (match) => ({
      type,
      replacement: match[1],
    }));
  }

  return { text, entities: sortEntities(entities) };
}

function replaceAndTrack(text, regex, entities, buildEntity) {
  let result = '';
  let lastIndex = 0;
  let match;
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');

  while ((match = re.exec(text)) !== null) {
    const built = buildEntity(match);
    const { type, url, user, custom_emoji_id: customEmojiId, replacement } = built;
    result += text.slice(lastIndex, match.index);
    const offset = utf16LengthAsCodeUnits(result);
    result += replacement;
    const length = utf16LengthAsCodeUnits(replacement);

    const entity = { type, offset, length };
    if (url) entity.url = url;
    if (user) entity.user = user;
    if (customEmojiId) entity.custom_emoji_id = customEmojiId;
    entities.push(entity);

    lastIndex = match.index + match[0].length;
    // Guard against a zero-length match looping forever.
    if (match[0].length === 0) re.lastIndex += 1;
  }
  result += text.slice(lastIndex);
  return result;
}

// Telegram counts entity offsets in UTF-16 code units. JS string .length
// already counts UTF-16 code units (surrogate pairs count as 2), so this is
// a pass-through — kept as a named helper so the assumption stays explicit
// and isn't accidentally "fixed" into codepoint counting later.
function utf16LengthAsCodeUnits(str) {
  return str.length;
}

function sortEntities(entities) {
  return entities.slice().sort((a, b) => a.offset - b.offset);
}

// Removes all text_link/text_mention entities and any raw http(s) URLs
// sitting as plain text in the caption. Two different operations because
// they're two different representations, per the product decision to
// support both.
function stripLinks(text, entities) {
  const keptEntities = (entities || []).filter(
    (e) => e.type !== 'text_link' && e.type !== 'url' && e.type !== 'text_mention'
  );
  const strippedText = text.replace(RAW_URL_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
  return { text: strippedText, entities: keptEntities };
}

// Replaces the URL of an existing text_link entity that wraps the given
// visible text, without touching anything else in the caption. Used when
// the user wants to swap one specific link's destination.
function replaceLinkUrl(entities, targetText, fullText, newUrl) {
  return (entities || []).map((e) => {
    if (e.type !== 'text_link') return e;
    const visible = fullText.slice(e.offset, e.offset + e.length);
    if (visible === targetText) {
      return { ...e, url: newUrl };
    }
    return e;
  });
}

// "Replace Links" feature: every existing link in the post — whether it's a
// text_link entity (label + hidden url) or a bare http(s) URL sitting in
// the visible text — gets swapped for the SAME single new url. Visible
// labels on text_link entities are left alone (only the destination
// changes); bare URLs are replaced in-place as text, and since the
// replacement text length can differ from the original, every entity that
// comes after a rewritten bare URL has its offset shifted to match.
function replaceAllLinks(text, entities, newUrl) {
  const workingEntities = (entities || []).map((e) => ({ ...e }));
  let resultText = '';
  let cursor = 0;
  let linksFound = false;

  // Sort raw-URL matches by position so we process left to right and can
  // shift later entity offsets by a running delta.
  const rawMatches = [];
  let m;
  const re = new RegExp(RAW_URL_PATTERN.source, 'g');
  while ((m = re.exec(text)) !== null) {
    // Skip a raw URL that's actually the hidden target of a text_link
    // entity's visible text (rare, but avoids double-touching it).
    const alreadyEntityUrl = workingEntities.some(
      (e) => (e.type === 'text_link') && text.slice(e.offset, e.offset + e.length) === m[0]
    );
    if (!alreadyEntityUrl) rawMatches.push({ index: m.index, length: m[0].length });
  }

  let delta = 0;
  for (const match of rawMatches) {
    const start = match.index + delta;
    const end = start + match.length;
    resultText = resultText || text;
    resultText = resultText.slice(0, start) + newUrl + resultText.slice(end);
    const lengthDiff = newUrl.length - match.length;
    for (const e of workingEntities) {
      if (e.offset >= end) e.offset += lengthDiff;
    }
    delta += lengthDiff;
    linksFound = true;
  }
  resultText = resultText || text;

  const finalEntities = workingEntities.map((e) => {
    if (e.type === 'text_link') {
      linksFound = true;
      return { ...e, url: newUrl };
    }
    return e;
  });

  return { text: resultText, entities: finalEntities, linksFound };
}

module.exports = { parseShorthand, stripLinks, replaceLinkUrl, replaceAllLinks };
