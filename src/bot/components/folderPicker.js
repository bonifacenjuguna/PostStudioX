const { Markup } = require('telegraf');
const folders = require('../../db/models/folders');

// Shown right after a saved_item is created, so filing it into a folder
// happens at save time instead of a separate trip to a folders screen
// later (which is the whole point of merging folders into Templates - see
// templates/index.js for where fld:pick*/fld:new-for-item are handled).
async function promptFolderChoice(ctx, savedItemId, { message = '📂 Save this to a folder?' } = {}) {
  const list = await folders.list();
  const rows = list.map((f) => [Markup.button.callback(`📂 ${f.name}`, `fld:pick:${savedItemId}:${f.id}`)]);
  rows.push([Markup.button.callback('➕ Create New Folder', `fld:picknew:${savedItemId}`)]);
  rows.push([Markup.button.callback('⏭ Skip (no folder)', `fld:pickskip:${savedItemId}`)]);
  await ctx.reply(message, Markup.inlineKeyboard(rows));
}

module.exports = { promptFolderChoice };
