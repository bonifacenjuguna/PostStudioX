// Builds Telegram inline_keyboard markup from our stored button JSON shape:
//   [[{text, url, style, callback_data}]]
// `style` maps to Bot API 9.4's button background colors (bg_primary /
// bg_danger / bg_success). Telegraf's typed Markup.button helpers may not
// yet pass through `style`, so we build the raw reply_markup object
// directly to guarantee it reaches the API regardless of library version.

const VALID_STYLES = ['bg_primary', 'bg_danger', 'bg_success'];

function buildInlineKeyboard(buttonRows) {
  if (!buttonRows || buttonRows.length === 0) return undefined;

  const inline_keyboard = buttonRows.map((row) =>
    row.map((btn) => {
      const rendered = { text: btn.text };
      if (btn.url) rendered.url = btn.url;
      if (btn.callback_data) rendered.callback_data = btn.callback_data;
      if (btn.style && VALID_STYLES.includes(btn.style)) rendered.style = btn.style;
      return rendered;
    })
  );

  return { inline_keyboard };
}

function colorLabel(style) {
  switch (style) {
    case 'bg_primary': return '🔵 Primary';
    case 'bg_danger': return '🔴 Danger';
    case 'bg_success': return '🟢 Success';
    default: return '⚪ Default';
  }
}

function countButtons(buttonRows) {
  return (buttonRows || []).reduce((sum, row) => sum + row.length, 0);
}

const MAX_BUTTONS = 100;
const MAX_PER_ROW = 8; // practical, not a hard Telegram limit, but keeps rows readable on mobile

module.exports = { buildInlineKeyboard, colorLabel, countButtons, MAX_BUTTONS, MAX_PER_ROW, VALID_STYLES };
