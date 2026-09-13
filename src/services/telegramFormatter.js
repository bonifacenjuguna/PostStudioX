// Converts a lightweight custom shorthand into Telegram's native message
// entity format (offset + length + type), rather than raw MarkdownV2/HTML
// strings. This sidesteps MarkdownV2's escaping rules entirely and makes
// later edits (link replacement, link stripping, import-and-edit) a simple
// entity-array operation instead of re-parsing text.
//
// v2.0.1 BUG FIX: the previous version ran each format type as its own
// sequential pass over a progressively-shrinking text (bold pass, then
// italic pass, then...), recording each entity's offset at the moment it
// was found. That's unsound: a LATER pass stripping marker characters
// BEFORE an EARLIER pass's already-recorded entity silently invalidates
// that entity's offset, since the text shifts left underneath it. Any
// message combining more than one format type - unless the first-processed
// style happened to also be first in the text - ended up with corrupted,
// misaligned entities. Rewritten as a single pass: every pattern is matched
// against the ORIGINAL, unmodified text first, all matches are sorted by
// position, overlaps resolved, and the final text + entity offsets are
// built in exactly one left-to-right walk - so no entity's position is ever
// computed against a text state that later changes underneath it.
//
// Shorthand supported:
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

const TG_USER_ID_PATTERN = /^tg:\/\/user\?id=(\d+)$/;

// Registration order doubles as overlap-resolution priority: if two
// matches start at the exact same position (a genuine ambiguity, not the
// sequential-shrinkage bug above), the one registered first wins.
const MATCHERS = [
  {
    regex: /\{emoji:(\d+)\}(.+?)\{\/emoji\}/g,
    build: (m) => ({ type: 'custom_emoji', custom_emoji_id: m[1], replacement: m[2] }),
  },
  {
    regex: /\[(.+?)\]\((tg:\/\/user\?id=\d+|https?:\/\/[^\s)]+)\)/g,
    build: (m) => {
      const userIdMatch = m[2].match(TG_USER_ID_PATTERN);
      if (userIdMatch) return { type: 'text_mention', user: { id: Number(userIdMatch[1]) }, replacement: m[1] };
      return { type: 'text_link', url: m[2], replacement: m[1] };
    },
  },
  {
    regex: /(?<!>)>>>(?!>)([\s\S]+?)(?<!<)<<<(?!<)/g,
    build: (m) => ({ type: 'expandable_blockquote', replacement: m[1] }),
  },
  {
    regex: /(?<!>)>>(?!>)([\s\S]+?)(?<!<)<<(?!<)/g,
    build: (m) => ({ type: 'blockquote', replacement: m[1] }),
  },
  { regex: /\*\*(.+?)\*\*/g, build: (m) => ({ type: 'bold', replacement: m[1] }) },
  { regex: /__(.+?)__/g, build: (m) => ({ type: 'italic', replacement: m[1] }) },
  { regex: /~~(.+?)~~/g, build: (m) => ({ type: 'strikethrough', replacement: m[1] }) },
  { regex: /\+\+(.+?)\+\+/g, build: (m) => ({ type: 'underline', replacement: m[1] }) },
  { regex: /\|\|(.+?)\|\|/g, build: (m) => ({ type: 'spoiler', replacement: m[1] }) },
  { regex: /```([\s\S]+?)```/g, build: (m) => ({ type: 'pre', replacement: m[1] }) },
  { regex: /`(.+?)`/g, build: (m) => ({ type: 'code', replacement: m[1] }) },
];

// Rough URL matcher for raw (non-markdown) links typed directly in text —
// used by stripLinks/replaceAllLinks to catch links that weren't wrapped
// in [text](url) shorthand at all.
const RAW_URL_PATTERN = /(https?:\/\/[^\s]+)/g;

function collectShorthandMatches(rawText) {
  const allMatches = [];
  for (const matcher of MATCHERS) {
    const re = new RegExp(matcher.regex.source, matcher.regex.flags.includes('g') ? matcher.regex.flags : matcher.regex.flags + 'g');
    let match;
    while ((match = re.exec(rawText)) !== null) {
      const built = matcher.build(match);
      allMatches.push({ start: match.index, end: match.index + match[0].length, built });
      if (match[0].length === 0) re.lastIndex += 1;
    }
  }
  return allMatches;
}

// Shared by parseShorthand and parseWithNativeEntities: takes a list of
// {start, end, built} matches (positions relative to the ORIGINAL rawText),
// resolves overlaps, and builds the final text + entities in exactly one
// left-to-right pass - the same single-pass guarantee described above, now
// reusable for any source of matches, not just shorthand ones.
function buildFromMatches(rawText, allMatches) {
  // Sort by start position; for a genuine tie, registration/insertion order
  // (already the array's order) decides via a stable sort, which every
  // modern JS engine's Array.prototype.sort is.
  const sorted = allMatches.slice().sort((a, b) => a.start - b.start || a.end - b.end);

  // Resolve overlaps: once a match is accepted, any later (in sort order)
  // match that starts before the accepted match's end is a genuine overlap
  // and is dropped rather than corrupting the single pass below.
  const resolved = [];
  let lastEnd = -1;
  for (const m of sorted) {
    if (m.start < lastEnd) continue;
    resolved.push(m);
    lastEnd = m.end;
  }

  let result = '';
  let cursor = 0;
  const entities = [];
  for (const m of resolved) {
    result += rawText.slice(cursor, m.start);
    const offset = utf16LengthAsCodeUnits(result);
    result += m.built.replacement;
    const length = utf16LengthAsCodeUnits(m.built.replacement);
    const entity = { type: m.built.type, offset, length };
    if (m.built.url) entity.url = m.built.url;
    if (m.built.user) entity.user = m.built.user;
    if (m.built.custom_emoji_id) entity.custom_emoji_id = m.built.custom_emoji_id;
    entities.push(entity);
    cursor = m.end;
  }
  result += rawText.slice(cursor);

  return { text: result, entities };
}

function parseShorthand(rawText) {
  return buildFromMatches(rawText, collectShorthandMatches(rawText));
}

// v2.2.0 FIX (#8): previously, "does this message have native Telegram
// entities" and "parse it for shorthand markers" were treated as mutually
// exclusive - if a message had ANY native entity (e.g. Telegram's own
// client auto-converting **bold** as you type), shorthand parsing was
// skipped ENTIRELY, silently dropping any marker Telegram's client doesn't
// recognize itself (++underline++ and [text](url) are NOT native Telegram
// client shortcuts, only this bot's own shorthand). Native entities are
// kept exactly as-is (their span is protected from re-parsing, since that
// text is already real formatting, not literal marker characters), while
// any shorthand marker found OUTSIDE those spans still gets parsed
// normally - so a message can mix "Telegram auto-formatted this" and
// "the bot's own shorthand caught this" correctly in one pass.
function parseWithNativeEntities(rawText, nativeEntities) {
  const nativeMatches = (nativeEntities || []).map((e) => ({
    start: e.offset,
    end: e.offset + e.length,
    built: {
      type: e.type,
      url: e.url,
      user: e.user,
      custom_emoji_id: e.custom_emoji_id,
      replacement: rawText.slice(e.offset, e.offset + e.length),
    },
  }));

  const shorthandMatches = collectShorthandMatches(rawText).filter(
    (sm) => !nativeMatches.some((nm) => sm.start < nm.end && sm.end > nm.start)
  );

  return buildFromMatches(rawText, [...nativeMatches, ...shorthandMatches]);
}

// Telegram counts entity offsets in UTF-16 code units. JS string .length
// already counts UTF-16 code units (surrogate pairs count as 2), so this is
// a pass-through — kept as a named helper so the assumption stays explicit
// and isn't accidentally "fixed" into codepoint counting later.
function utf16LengthAsCodeUnits(str) {
  return str.length;
}

// Removes all text_link/text_mention entities and any raw http(s) URLs
// sitting as plain text in the caption. Two different operations because
// they're two different representations, per the product decision to
// support both.
//
// v2.2.0 BUG FIX: this used to build the stripped text with a blind
// text.replace(RAW_URL_PATTERN, '') call, then separately collapse
// whitespace - both operations shift every character position after the
// removed text, but nothing recalculated the offsets of entities that were
// KEPT (bold, italic, blockquote, etc.), so any such entity sitting after a
// removed URL ended up pointing at the wrong span - exactly the "entity
// begins in a middle of a UTF-16 symbol" error reported. Rewritten with the
// same delta-tracking approach as replaceAllLinks below: every kept
// entity's offset is explicitly adjusted by exactly how much text was
// removed before it, in one pass, instead of trusting a lucky coincidence.
function stripLinks(text, entities) {
  const workingEntities = (entities || [])
    .filter((e) => e.type !== 'text_link' && e.type !== 'url' && e.type !== 'text_mention')
    .map((e) => ({ ...e }));

  const rawMatches = [];
  let m;
  const re = new RegExp(RAW_URL_PATTERN.source, 'g');
  while ((m = re.exec(text)) !== null) {
    rawMatches.push({ index: m.index, length: m[0].length });
  }

  let resultText = text;
  let delta = 0;
  for (const match of rawMatches) {
    const start = match.index + delta;
    const end = start + match.length;
    resultText = resultText.slice(0, start) + resultText.slice(end);
    for (const e of workingEntities) {
      if (e.offset >= end) {
        e.offset -= match.length;
      } else if (e.offset + e.length > start) {
        // A kept entity somehow overlapped a stripped URL span - shrink it
        // rather than leave a now-invalid length. Shouldn't normally happen
        // (link/mention entities are already filtered out above), but a
        // safe fallback beats a corrupted offset reaching Telegram.
        e.length = Math.max(0, e.length - match.length);
      }
    }
    delta -= match.length;
  }

  // Only trimming leading/trailing whitespace (not collapsing internal
  // double-spaces, which the previous version did but which isn't safe to
  // do without re-checking every entity again) - shift every entity left by
  // exactly how much leading whitespace was removed, so this stays exact.
  const leadingWhitespaceLength = resultText.length - resultText.replace(/^\s+/, '').length;
  const trimmedText = resultText.trim();
  const finalEntities = workingEntities
    .map((e) => ({ ...e, offset: e.offset - leadingWhitespaceLength }))
    .filter((e) => e.offset >= 0 && e.offset + e.length <= trimmedText.length);

  return { text: trimmedText, entities: finalEntities };
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
  let resultText = text;
  let linksFound = false;

  const rawMatches = [];
  let m;
  const re = new RegExp(RAW_URL_PATTERN.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const alreadyEntityUrl = workingEntities.some(
      (e) => (e.type === 'text_link') && text.slice(e.offset, e.offset + e.length) === m[0]
    );
    if (!alreadyEntityUrl) rawMatches.push({ index: m.index, length: m[0].length });
  }

  let delta = 0;
  for (const match of rawMatches) {
    const start = match.index + delta;
    const end = start + match.length;
    resultText = resultText.slice(0, start) + newUrl + resultText.slice(end);
    const lengthDiff = newUrl.length - match.length;
    for (const e of workingEntities) {
      if (e.offset >= end) e.offset += lengthDiff;
    }
    delta += lengthDiff;
    linksFound = true;
  }

  const finalEntities = workingEntities.map((e) => {
    if (e.type === 'text_link') {
      linksFound = true;
      return { ...e, url: newUrl };
    }
    return e;
  });

  return { text: resultText, entities: finalEntities, linksFound };
}

module.exports = { parseShorthand, parseWithNativeEntities, stripLinks, replaceLinkUrl, replaceAllLinks };
