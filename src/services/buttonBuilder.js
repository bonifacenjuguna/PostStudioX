// Builds Telegram inline_keyboard markup from our stored button JSON shape:
//   [[{text, url, style}]]                 - link button
//   [[{text, note, style}]]                - "note" button, no URL - tapping
//                                             it shows `note` as a popup
//                                             instead of opening a link
//
// `style` maps to Bot API 9.4's button color field. The actual accepted
// values are 'primary' (blue), 'success' (green), 'danger' (red) - no
// prefix. (Earlier version of this file used bg_primary/bg_danger/
// bg_success, which don't match the real API and would have been silently
// dropped/rejected by Telegram - fixed here.) Telegraf's typed
// Markup.button helpers may not yet pass through `style` since it's a very
// recent addition, so the raw reply_markup object is built directly to
// guarantee it reaches the API regardless of library version.

const VALID_STYLES = ['primary', 'success', 'danger'];
const NOTE_PREFIX = 'note:';
const MAX_CALLBACK_DATA_BYTES = 64;

function buildInlineKeyboard(buttonRows) {
  if (!buttonRows || buttonRows.length === 0) return undefined;

  const inline_keyboard = buttonRows.map((row) =>
    row.map((btn) => {
      const rendered = { text: btn.text };
      if (btn.note) {
        // Telegram caps callback_data at 64 bytes total, so the note is
        // truncated to fit alongside the "note:" prefix. Long notes still
        // work fine as buttons - answerCbQuery's alert popup just shows the
        // truncated version. (This is a hard Bot API limit, not a design
        // choice - there's no way to fit an unbounded string here without a
        // DB round trip, which would add real latency to every tap.)
        const budget = MAX_CALLBACK_DATA_BYTES - Buffer.byteLength(NOTE_PREFIX, 'utf8');
        rendered.callback_data = NOTE_PREFIX + truncateToBytes(btn.note, budget);
      } else if (btn.url) {
        rendered.url = btn.url;
      } else if (btn.callback_data) {
        rendered.callback_data = btn.callback_data;
      }
      if (btn.style && VALID_STYLES.includes(btn.style)) rendered.style = btn.style;
      return rendered;
    })
  );

  return { inline_keyboard };
}

function truncateToBytes(str, maxBytes) {
  let bytes = 0;
  let out = '';
  for (const ch of str) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    out += ch;
    bytes += chBytes;
  }
  return out;
}

function colorLabel(style) {
  switch (style) {
    case 'primary': return '🔵 Primary';
    case 'danger': return '🔴 Danger';
    case 'success': return '🟢 Success';
    default: return '⚪ Default';
  }
}

function countButtons(buttonRows) {
  return (buttonRows || []).reduce((sum, row) => sum + row.length, 0);
}

const MAX_BUTTONS = 100;
const MAX_PER_ROW = 8; // practical, not a hard Telegram limit, but keeps rows readable on mobile

module.exports = { buildInlineKeyboard, colorLabel, countButtons, MAX_BUTTONS, MAX_PER_ROW, VALID_STYLES, NOTE_PREFIX };
