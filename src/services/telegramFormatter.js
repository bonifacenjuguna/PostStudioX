// Converts a lightweight custom shorthand into Telegram's native message
// entity format (offset + length + type), rather than raw MarkdownV2 strings.
// This sidesteps MarkdownV2's escaping rules entirely and makes later edits
// (link replacement, link stripping) a simple entity-array operation instead
// of re-parsing text.
//
// Shorthand supported:
//   **bold**            -> bold
//   __italic__          -> italic
//   ~~strike~~          -> strikethrough
//   ++underline++       -> underline
//   ||spoiler||         -> spoiler
//   `code`              -> code
//   ```block```         -> pre
//   [text](url)         -> text_link
//   >> quote text <<    -> blockquote (whole line, see parseBlockquotes)

const PATTERNS = [
  { regex: /\*\*(.+?)\*\*/g, type: 'bold' },
  { regex: /__(.+?)__/g, type: 'italic' },
  { regex: /~~(.+?)~~/g, type: 'strikethrough' },
  { regex: /\+\+(.+?)\+\+/g, type: 'underline' },
  { regex: /\|\|(.+?)\|\|/g, type: 'spoiler' },
  { regex: /```([\s\S]+?)```/g, type: 'pre' },
  { regex: /`(.+?)`/g, type: 'code' },
];

const LINK_PATTERN = /\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;

// Rough URL matcher for raw (non-markdown) links typed directly in text.
const RAW_URL_PATTERN = /(https?:\/\/[^\s]+)/g;

function parseShorthand(rawText) {
  let text = rawText;
  const entities = [];

  // Links first, since their replacement text length differs from the source.
  text = replaceAndTrack(text, LINK_PATTERN, entities, (match) => ({
    type: 'text_link',
    url: match[2],
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
    const { type, url, replacement } = buildEntity(match);
    result += text.slice(lastIndex, match.index);
    const offset = utf16LengthAsCodeUnits(result);
    result += replacement;
    const length = utf16LengthAsCodeUnits(replacement);

    const entity = { type, offset, length };
    if (url) entity.url = url;
    entities.push(entity);

    lastIndex = match.index + match[0].length;
  }
  result += text.slice(lastIndex);
  return result;
}

// Telegram counts entity offsets in UTF-16 code units, not JS string .length
// naively for most text this is the same, but this helper makes the
// assumption explicit rather than accidental.
function utf16LengthAsCodeUnits(str) {
  return str.length;
}

function sortEntities(entities) {
  return entities.slice().sort((a, b) => a.offset - b.offset);
}

// Removes all text_link entities and any raw http(s) URLs sitting as plain
// text in the caption. Two different operations because they're two
// different representations, per the product decision to support both.
function stripLinks(text, entities) {
  const keptEntities = (entities || []).filter((e) => e.type !== 'text_link' && e.type !== 'url');
  const strippedText = text.replace(RAW_URL_PATTERN, '').replace(/\s{2,}/g, ' ').trim();
  return { text: strippedText, entities: keptEntities };
}

// Replaces the URL of an existing text_link entity that wraps the given
// visible text, without touching anything else in the caption.
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

module.exports = { parseShorthand, stripLinks, replaceLinkUrl };
