const { Markup } = require('telegraf');
const folders = require('../../../db/models/folders');
const savedItems = require('../../../db/models/savedItems');
const { subScreenReplyKeyboard, quickNavRow, withEmergencyStop } = require('../../components/navRow');

async function enter(ctx) {
  ctx.session = { scene: 'folders' };
  const list = await folders.list();
  const rows = list.map((f) => [Markup.button.callback(`📂 ${f.name} (${f.item_count})`, `fld:view:${f.id}`)]);
  rows.push([Markup.button.callback('➕ New Folder', 'fld:new')]);
  rows.push(...quickNavRow('folders'));
  await ctx.reply('📁 My Folders', subScreenReplyKeyboard());
  await ctx.reply(list.length ? 'Pick a folder:' : 'No folders yet.', Markup.inlineKeyboard(withEmergencyStop(rows)));
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
    if (!folder) return ctx.reply('Folder not found.');
    const items = await folders.itemsIn(id);
    const rows = items.map((i) => [
      Markup.button.callback(`${i.kind === 'template' ? '🗂' : '📝'} ${i.name || i.caption?.slice(0, 30) || '(untitled)'}`, `fld:item:${id}:${i.id}`),
    ]);
    rows.push([Markup.button.callback('✏️ Rename', `fld:rename:${id}`), Markup.button.callback('🗑 Delete Folder', `fld:delete:${id}`)]);
    rows.push([Markup.button.callback('⬅️ Back to Folders', 'fld:list')]);
    await ctx.reply(`📂 ${folder.name}`, Markup.inlineKeyboard(withEmergencyStop(rows)));
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
      [Markup.button.callback('🔀 Move to another folder', `fld:move:${folderId}:${itemId}`)],
      [Markup.button.callback('➖ Remove from folder', `fld:removeitem:${folderId}:${itemId}`)],
      [Markup.button.callback('🏠 Home', 'nav:home')],
    ]));
  });

  // Previously "🔀 Move to another folder" had no handler registered
  // anywhere - a dead tap. This also fixes a second problem the old button
  // had even in principle: it only carried the itemId, with no source
  // folder to remove the item FROM, so a correct move wasn't even possible
  // without this extra hop.
  bot.action(/^fld:move:(\d+):(\d+)$/, async (ctx) => {
    const sourceFolderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    const list = await folders.list();
    const options = list.filter((f) => f.id !== sourceFolderId);
    if (options.length === 0) {
      await ctx.reply('No other folders to move it to — create one first from 📁 My Folders.');
      return;
    }
    const rows = options.map((f) => [Markup.button.callback(`📂 ${f.name}`, `fld:moveto:${sourceFolderId}:${f.id}:${itemId}`)]);
    rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
    await ctx.reply('Move to which folder?', Markup.inlineKeyboard(rows));
  });

  bot.action(/^fld:moveto:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const sourceFolderId = parseInt(ctx.match[1], 10);
    const targetFolderId = parseInt(ctx.match[2], 10);
    const itemId = parseInt(ctx.match[3], 10);
    await ctx.answerCbQuery('Moved');
    await folders.addItem(targetFolderId, itemId);
    await folders.removeItem(sourceFolderId, itemId);
    try { await ctx.editMessageText('🔀 Moved to the new folder.'); } catch (_) {}
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
