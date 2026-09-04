const { Markup } = require('telegraf');
const folders = require('../../../db/models/folders');
const savedItems = require('../../../db/models/savedItems');
const { subScreenReplyKeyboard } = require('../../components/navRow');

async function enter(ctx) {
  ctx.session = { scene: 'folders' };
  const list = await folders.list();
  const rows = list.map((f) => [Markup.button.callback(`📂 ${f.name} (${f.item_count})`, `fld:view:${f.id}`)]);
  rows.push([Markup.button.callback('➕ New Folder', 'fld:new')]);
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
  await ctx.reply('📁 My Folders', subScreenReplyKeyboard());
  await ctx.reply(list.length ? 'Pick a folder:' : 'No folders yet.', Markup.inlineKeyboard(rows));
}

async function handleText(ctx) {
  if (ctx.session.step === 'awaiting_folder_name') {
    await folders.create(ctx.message.text.trim());
    ctx.session.step = null;
    await ctx.reply('📂 Folder created.');
    await enter(ctx);
    return;
  }
  if (ctx.session.step === 'awaiting_rename') {
    await folders.rename(ctx.session.renamingFolderId, ctx.message.text.trim());
    ctx.session.step = null;
    await ctx.reply('✏️ Folder renamed.');
    await enter(ctx);
  }
}

async function registerHandlers(bot) {
  bot.action('fld:new', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session.step = 'awaiting_folder_name';
    await ctx.reply('Name the new folder:');
  });

  bot.action(/^fld:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const folder = await folders.findById(id);
    const items = await folders.itemsIn(id);
    const rows = items.map((i) => [
      Markup.button.callback(`${i.kind === 'template' ? '🗂' : '📝'} ${i.name || i.caption?.slice(0, 30) || '(untitled)'}`, `fld:item:${id}:${i.id}`),
    ]);
    rows.push([Markup.button.callback('✏️ Rename', `fld:rename:${id}`), Markup.button.callback('🗑 Delete Folder', `fld:delete:${id}`)]);
    rows.push([Markup.button.callback('⬅️ Back to Folders', 'fld:list')]);
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
    await ctx.reply(`📂 ${folder.name}`, Markup.inlineKeyboard(rows));
  });

  bot.action('fld:list', async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx);
  });

  bot.action(/^fld:item:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    await ctx.reply('What do you want to do?', Markup.inlineKeyboard([
      [Markup.button.callback('📝 Use as New Post', `tpl:use:${itemId}`)],
      [Markup.button.callback('🔀 Move to another folder', `fld:move:${itemId}`)],
      [Markup.button.callback('➖ Remove from folder', `fld:removeitem:${folderId}:${itemId}`)],
      [Markup.button.callback('🏠 Home', 'nav:home')],
    ]));
  });

  bot.action(/^fld:removeitem:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Removed');
    await folders.removeItem(folderId, itemId);
    try { await ctx.editMessageText('➖ Removed from folder.'); } catch (_) {}
  });

  bot.action(/^fld:rename:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'folders', step: 'awaiting_rename', renamingFolderId: parseInt(ctx.match[1], 10) };
    await ctx.reply('Send the new folder name:');
  });

  bot.action(/^fld:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Delete this folder? Items inside stay in History, just un-foldered.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete', `fld:deleteconfirm:${id}`)],
      [Markup.button.callback('❌ Cancel', 'nav:cancel')],
    ]));
  });

  bot.action(/^fld:deleteconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    await folders.remove(id);
    try { await ctx.editMessageText('🗑 Folder deleted.'); } catch (_) {}
  });
}

module.exports = { enter, handleText, registerHandlers };
