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

module.exports = { PAGE_SIZE, paginationRow, offsetFor };
