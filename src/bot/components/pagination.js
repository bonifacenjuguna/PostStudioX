const { Markup } = require('telegraf');

const PAGE_SIZE = 8;
const JUMP_THRESHOLD_PAGES = 4;

function paginationRow(currentPage, totalItems, callbackPrefix) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const row = [];

  if (currentPage > 0) {
    row.push(Markup.button.callback('⬅️ Prev', `${callbackPrefix}:page:${currentPage - 1}`));
  }
  row.push(Markup.button.callback(`${currentPage + 1}/${totalPages}`, 'nav:noop'));
  if (currentPage < totalPages - 1) {
    row.push(Markup.button.callback('Next ➡️', `${callbackPrefix}:page:${currentPage + 1}`));
  }

  const rows = [row];
  if (totalPages > JUMP_THRESHOLD_PAGES) {
    rows.push([Markup.button.callback('🔢 Jump to page', `${callbackPrefix}:jump`)]);
  }
  return rows;
}

function offsetFor(page) {
  return page * PAGE_SIZE;
}

// Turns typed input into a validated 0-indexed page number, or a rejection
// with the valid range so the caller can prompt again.
function parseJumpTarget(text, totalItems) {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const n = parseInt(String(text).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > totalPages) {
    return { ok: false, totalPages };
  }
  return { ok: true, page: n - 1, totalPages };
}

// Single shared handler for the "🔢 Jump to page" button across every list
// screen that uses paginationRow (templates/scheduled/history). Previously
// this button had no handler registered anywhere at all - a pure dead tap.
// Each scene still needs a tiny handleText that checks for
// ctx.session.step === 'awaiting_page_jump' and calls parseJumpTarget with
// its own total count - this just standardizes the prompt/step so it can't
// drift between scenes.
function registerJumpHandler(bot) {
  bot.action(/^(\w+):jump$/, async (ctx) => {
    const prefix = ctx.match[1];
    if (!ctx.session?.scene) return; // stray tap from a stale keyboard, no scene to jump within
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_page_jump';
    ctx.session.jumpPrefix = prefix;
    await ctx.reply('Which page number? (see the current "x / y" indicator for the total)');
  });
}

module.exports = { PAGE_SIZE, paginationRow, offsetFor, parseJumpTarget, registerJumpHandler };
