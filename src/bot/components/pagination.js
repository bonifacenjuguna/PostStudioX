const { Markup } = require('telegraf');

const PAGE_SIZE = 8; // default, used where a screen doesn't need a different size
const JUMP_THRESHOLD_PAGES = 4;

function paginationRow(currentPage, totalItems, callbackPrefix, pageSize = PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
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

function offsetFor(page, pageSize = PAGE_SIZE) {
  return page * pageSize;
}

// v1.1.0 FIX (#6): "🔢 Jump to page" rendered by paginationRow() above had
// no handler anywhere - tapping it did nothing. `handlers` maps a
// callback-prefix ('tpl', 'hist', 'sch', ...) to an async (ctx, zeroBasedPage)
// function that re-renders that scene's list at the requested page.
function registerPaginationJump(bot, handlers) {
  bot.action(/^([a-zA-Z]+):jump$/, async (ctx) => {
    const prefix = ctx.match[1];
    if (!handlers[prefix]) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    ctx.session = { ...(ctx.session || {}), awaitingPageJumpFor: prefix };
    await ctx.reply('Send the page number to jump to (e.g. 3):');
  });

  bot.on('text', async (ctx, next) => {
    const prefix = ctx.session?.awaitingPageJumpFor;
    if (!prefix || !handlers[prefix] || ctx.message.text?.startsWith('/')) return next();

    const n = parseInt(ctx.message.text.trim(), 10);
    delete ctx.session.awaitingPageJumpFor;
    if (!Number.isInteger(n) || n < 1) {
      await ctx.reply('That\'s not a valid page number. Try again with just a number, e.g. 3.');
      return;
    }
    await handlers[prefix](ctx, n - 1);
  });
}

module.exports = { PAGE_SIZE, paginationRow, offsetFor, registerPaginationJump };
