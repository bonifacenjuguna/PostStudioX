const { Markup } = require('telegraf');
const folders = require('../../../db/models/folders');
const { subScreenReplyKeyboard, backHomeRow } = require('../../components/navRow');

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
    const name = ctx.message.text.trim();
    if (!name) {
      await ctx.reply('Folder name can\'t be empty — send a name:');
      return;
    }
    await folders.create(name);
    ctx.session = { scene: 'folders' };
    await ctx.reply(`📂 Folder "${name}" created.`);
    await enter(ctx);
    return;
  }
  if (ctx.session.step === 'awaiting_rename') {
    const name = ctx.message.text.trim();
    if (!name) {
      await ctx.reply('Folder name can\'t be empty — send a name:');
      return;
    }
    await folders.rename(ctx.session.renamingFolderId, name);
    ctx.session = { scene: 'folders' };
    await ctx.reply('✏️ Folder renamed.');
    await enter(ctx);
  }
}

async function registerHandlers(bot) {
  bot.action('fld:new', async (ctx) => {
    await ctx.answerCbQuery();
    // v1.1.0 FIX (#10): a full reset (rather than mutating ctx.session.step
    // in place) guarantees `scene` is definitely 'folders' when the text
    // handler in sceneRouter looks it up next, no matter what state the
    // session happened to be in beforehand.
    ctx.session = { scene: 'folders', step: 'awaiting_folder_name' };
    await ctx.reply('Name the new folder:');
  });

  bot.action(/^fld:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const folder = await folders.findById(id);
    if (!folder) return ctx.reply('That folder no longer exists.');
    const items = await folders.itemsIn(id);
    const rows = items.map((i) => [
      Markup.button.callback(`${i.kind === 'template' ? '🗂' : '📝'} ${i.name || i.caption?.slice(0, 30) || '(untitled)'}`, `fld:item:${id}:${i.id}`),
    ]);
    rows.push([Markup.button.callback('✏️ Rename', `fld:rename:${id}`), Markup.button.callback('🗑 Delete Folder', `fld:delete:${id}`)]);
    rows.push([Markup.button.callback('⬅️ Back to Folders', 'fld:list')]);
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
    await ctx.reply(`📂 ${folder.name}${items.length ? '' : '\n\n(empty)'}`, Markup.inlineKeyboard(rows));
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
      backHomeRow(`fld:view:${folderId}`),
    ]));
  });

  // v1.1.0 FIX: "🔀 Move to another folder" above had no handler at all in
  // the original code - tapping it did nothing. Implemented for real here.
  bot.action(/^fld:move:(\d+):(\d+)$/, async (ctx) => {
    const fromFolderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    const list = await folders.list();
    const others = list.filter((f) => f.id !== fromFolderId);
    if (others.length === 0) {
      await ctx.reply('No other folders to move this to yet — create one first from 📁 My Folders.');
      return;
    }
    const rows = others.map((f) => [Markup.button.callback(`📂 ${f.name}`, `fld:moveto:${fromFolderId}:${itemId}:${f.id}`)]);
    rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
    await ctx.reply('Move to which folder?', Markup.inlineKeyboard(rows));
  });

  bot.action(/^fld:moveto:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const fromFolderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    const toFolderId = parseInt(ctx.match[3], 10);
    await ctx.answerCbQuery('Moved');
    await folders.addItem(toFolderId, itemId);
    await folders.removeItem(fromFolderId, itemId);
    try { await ctx.editMessageText('🔀 Moved to the other folder.'); } catch (_) {}
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
      backHomeRow(`fld:view:${id}`),
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
