const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const folders = require('../../../db/models/folders');
const { paginationRow, PAGE_SIZE, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard, flowReplyKeyboard, backHomeRow } = require('../../components/navRow');

// Templates absorbs what used to be the separate "📁 My Folders" screen -
// per the redesign, folders are how you browse templates/saved posts, not
// a parallel destination. Folder-first: you see folders (and anything not
// filed into one) before a flat list of everything.
async function enter(ctx, page = 0) {
  ctx.session = { scene: 'templates', page };

  const folderList = await folders.list();
  const unfoldered = await savedItems.listByKind('template', { limit: PAGE_SIZE, offset: offsetFor(page) });
  const total = await savedItems.countByKind('template');

  const rows = folderList.map((f) => [Markup.button.callback(`📂 ${f.name} (${f.item_count})`, `tpl:fld:view:${f.id}`)]);
  rows.push([Markup.button.callback('➕ New Folder', 'tpl:fld:new'), Markup.button.callback('📝 Create Template', 'tpl:create')]);

  const unfolderedInFolders = new Set();
  for (const f of folderList) {
    const items = await folders.itemsIn(f.id);
    for (const i of items) unfolderedInFolders.add(i.id);
  }
  const looseTemplates = unfoldered.filter((t) => !unfolderedInFolders.has(t.id));
  if (looseTemplates.length) {
    rows.push(...looseTemplates.map((t) => [Markup.button.callback(`📄 ${t.name || '(unnamed)'}`, `tpl:view:${t.id}`)]));
  }
  rows.push(...paginationRow(page, total, 'tpl'));
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);

  const header = folderList.length || total
    ? `🗂 Templates (${total}) across ${folderList.length} folder${folderList.length === 1 ? '' : 's'}`
    : '🗂 No templates or folders yet.';
  await ctx.reply(header, subScreenReplyKeyboard());
  await ctx.reply(
    folderList.length || looseTemplates.length
      ? 'Browse a folder, or pick a template below:'
      : 'Create your first template, or start a folder to organize them as you go.',
    Markup.inlineKeyboard(rows)
  );
}

async function registerHandlers(bot) {
  bot.action('tpl:list', async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, ctx.session.page || 0);
  });

  bot.action(/^tpl:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, parseInt(ctx.match[1], 10));
  });

  // Jumps straight into New Post - the fastest path to a finished template
  // is composing normally and hitting 💾 Save as Template in the preview,
  // rather than a separate template-only wizard duplicating that logic.
  bot.action('tpl:create', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = {};
    const createPost = require('../create-post');
    await ctx.reply('📝 Compose it like any post — you\'ll get the option to save it as a template once it\'s ready.');
    await createPost.enter(ctx);
  });

  bot.action(/^tpl:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const t = await savedItems.findById(id);
    if (!t) return ctx.reply('Template not found.');
    const { sendPreview, draftShapeFromSavedItem } = require('../../components/previewRenderer');
    await sendPreview(ctx, draftShapeFromSavedItem(t)).catch(() => {});
    await ctx.reply(
      `📄 ${t.name}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Use', `tpl:use:${id}`)],
        [Markup.button.callback('✏️ Edit', `tpl:edit:${id}`), Markup.button.callback('🗑 Delete', `tpl:delete:${id}`)],
        [Markup.button.callback('🔀 Move/Add to Folder', `tpl:folderfor:${id}`)],
        backHomeRow('tpl:list'),
      ])
    );
  });

  // v1.1.0 FIX (#9, preserved): loads the draft and jumps straight to the
  // preview/finish screen instead of re-asking media type from scratch.
  bot.action(/^tpl:use:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const t = await savedItems.findById(id);
    if (!t) return ctx.reply('Template not found.');
    ctx.session = {
      scene: 'create-post',
      draft: {
        channelIds: [], mediaType: t.media_type, mediaItems: t.media_items || [],
        caption: t.caption || '', entities: t.entities || [], buttons: t.buttons || [], options: t.options || {},
      },
    };
    await ctx.reply('Using template — here\'s the preview:', flowReplyKeyboard());
    const createPost = require('../create-post');
    await createPost.goToPreview(ctx);
  });

  bot.action(/^tpl:edit:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, id, { returnTo: `tpl:view:${id}` });
  });

  bot.action(/^tpl:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    await savedItems.hardDelete(id);
    try { await ctx.editMessageText('🗑 Template deleted.'); } catch (_) {}
  });

  bot.action(/^tpl:folderfor:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const { promptFolderChoice } = require('../../components/folderPicker');
    await promptFolderChoice(ctx, id, { message: '📂 File this template into which folder?' });
  });

  // ── Folders (absorbed from the old standalone "My Folders" scene) ──────
  bot.action('tpl:fld:new', async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'templates', step: 'awaiting_folder_name' };
    await ctx.reply('Name the new folder:');
  });

  bot.action(/^tpl:fld:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const folder = await folders.findById(id);
    if (!folder) return ctx.reply('That folder no longer exists.');
    const items = await folders.itemsIn(id);
    const rows = items.map((i) => [
      Markup.button.callback(`${i.kind === 'template' ? '🗂' : '📝'} ${i.name || i.caption?.slice(0, 30) || '(untitled)'}`, `tpl:fld:item:${id}:${i.id}`),
    ]);
    rows.push([Markup.button.callback('✏️ Rename', `tpl:fld:rename:${id}`), Markup.button.callback('🗑 Delete Folder', `tpl:fld:delete:${id}`)]);
    rows.push([Markup.button.callback('⬅️ Back to Templates', 'tpl:list')]);
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
    await ctx.reply(`📂 ${folder.name}${items.length ? '' : '\n\n(empty)'}`, Markup.inlineKeyboard(rows));
  });

  bot.action(/^tpl:fld:item:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    await ctx.reply('What do you want to do?', Markup.inlineKeyboard([
      [Markup.button.callback('🎨 Use in Compose', `tpl:use:${itemId}`)],
      [Markup.button.callback('🔀 Move to another folder', `tpl:fld:move:${folderId}:${itemId}`)],
      [Markup.button.callback('➖ Remove from folder', `tpl:fld:removeitem:${folderId}:${itemId}`)],
      // v2.2.0 FIX (#4): this menu had no way to actually delete the item
      // itself - only the folder as a whole. Removing from a folder just
      // un-files it, it doesn't delete it (that's what "Remove from
      // folder" already correctly does), so a real Delete was missing.
      [Markup.button.callback('🗑 Delete This Item', `tpl:fld:deleteitem:${folderId}:${itemId}`)],
      backHomeRow(`tpl:fld:view:${folderId}`),
    ]));
  });

  bot.action(/^tpl:fld:deleteitem:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Permanently delete this item? This removes it entirely, not just from the folder.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete it', `tpl:fld:deleteitemconfirm:${folderId}:${itemId}`)],
      backHomeRow(`tpl:fld:view:${folderId}`),
    ]));
  });

  bot.action(/^tpl:fld:deleteitemconfirm:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Deleted');
    await savedItems.hardDelete(itemId);
    try { await ctx.editMessageText('🗑 Item deleted.'); } catch (_) {}
  });

  bot.action(/^tpl:fld:move:(\d+):(\d+)$/, async (ctx) => {
    const fromFolderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery();
    const list = await folders.list();
    const others = list.filter((f) => f.id !== fromFolderId);
    if (others.length === 0) {
      await ctx.reply('No other folders yet — create one first from 🗂 Templates.');
      return;
    }
    const rows = others.map((f) => [Markup.button.callback(`📂 ${f.name}`, `tpl:fld:moveto:${fromFolderId}:${itemId}:${f.id}`)]);
    rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
    await ctx.reply('Move to which folder?', Markup.inlineKeyboard(rows));
  });

  bot.action(/^tpl:fld:moveto:(\d+):(\d+):(\d+)$/, async (ctx) => {
    const fromFolderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    const toFolderId = parseInt(ctx.match[3], 10);
    await ctx.answerCbQuery('Moved');
    await folders.addItem(toFolderId, itemId);
    await folders.removeItem(fromFolderId, itemId);
    try { await ctx.editMessageText('🔀 Moved to the other folder.'); } catch (_) {}
  });

  bot.action(/^tpl:fld:removeitem:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Removed');
    await folders.removeItem(folderId, itemId);
    try { await ctx.editMessageText('➖ Removed from folder.'); } catch (_) {}
  });

  bot.action(/^tpl:fld:rename:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    ctx.session = { scene: 'templates', step: 'awaiting_rename', renamingFolderId: parseInt(ctx.match[1], 10) };
    await ctx.reply('Send the new folder name:');
  });

  bot.action(/^tpl:fld:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Delete this folder? Items inside stay in Templates/History, just un-foldered.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete', `tpl:fld:deleteconfirm:${id}`)],
      backHomeRow(`tpl:fld:view:${id}`),
    ]));
  });

  bot.action(/^tpl:fld:deleteconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    await folders.remove(id);
    try { await ctx.editMessageText('🗑 Folder deleted.'); } catch (_) {}
  });

  // ── Save-time folder choice (see components/folderPicker.js) ───────────
  // Fired right after a saved_item is created (currently: Save as Template
  // from New Post) - lets the owner file it into a folder, make a new one
  // on the spot, or skip, instead of a separate trip later.
  bot.action(/^fld:pick:(\d+):(\d+)$/, async (ctx) => {
    const itemId = parseInt(ctx.match[1], 10);
    const folderId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Saved to folder');
    await folders.addItem(folderId, itemId);
    try { await ctx.editMessageText('📂 Filed into that folder.'); } catch (_) {}
  });

  bot.action(/^fld:picknew:(\d+)$/, async (ctx) => {
    const itemId = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    ctx.session = { scene: 'templates', step: 'awaiting_new_folder_for_item', pendingItemId: itemId };
    await ctx.reply('Name the new folder — this item will be filed into it once created:');
  });

  bot.action(/^fld:pickskip:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try { await ctx.editMessageText('Okay — not filed into a folder. Find it under 🗂 Templates directly.'); } catch (_) {}
  });
}

async function handleText(ctx) {
  const step = ctx.session?.step;

  if (step === 'awaiting_folder_name') {
    const name = ctx.message.text.trim();
    if (!name) {
      await ctx.reply('Folder name can\'t be empty — send a name:');
      return;
    }
    await folders.create(name);
    ctx.session = { scene: 'templates' };
    await ctx.reply(`📂 Folder "${name}" created.`);
    await enter(ctx);
    return;
  }

  if (step === 'awaiting_new_folder_for_item') {
    const name = ctx.message.text.trim();
    if (!name) {
      await ctx.reply('Folder name can\'t be empty — send a name:');
      return;
    }
    const folder = await folders.create(name);
    await folders.addItem(folder.id, ctx.session.pendingItemId);
    ctx.session = { scene: 'templates' };
    await ctx.reply(`📂 Created "${name}" and filed it in.`);
    await enter(ctx);
    return;
  }

  if (step === 'awaiting_rename') {
    const name = ctx.message.text.trim();
    if (!name) {
      await ctx.reply('Folder name can\'t be empty — send a name:');
      return;
    }
    await folders.rename(ctx.session.renamingFolderId, name);
    ctx.session = { scene: 'templates' };
    await ctx.reply('✏️ Folder renamed.');
    await enter(ctx);
  }
}

module.exports = { enter, handleText, registerHandlers };
