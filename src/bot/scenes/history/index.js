const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const statsModel = require('../../../db/models/stats');
const db = require('../../../db/pool');
const { paginationRow, PAGE_SIZE, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard } = require('../../components/navRow');

async function enter(ctx, page = 0, statusFilter = null) {
  ctx.session = { scene: 'history', page, statusFilter };
  const filterLabel = statusFilter ? ` (${statusFilter})` : '';
  await ctx.reply(`📜 History${filterLabel}`, subScreenReplyKeyboard());

  const items = statusFilter
    ? await savedItems.listByKind('post', { limit: PAGE_SIZE, offset: offsetFor(page), statusFilter })
    : await listAllPosts(page);
  const total = statusFilter
    ? await savedItems.countByKind('post', statusFilter)
    : await countAllPosts();

  if (total === 0) {
    await ctx.reply('Nothing here yet.');
    return;
  }

  const rows = items.map((i) => [
    Markup.button.callback(`${statusIcon(i.status)} ${i.caption?.slice(0, 30) || '(media post)'}`, `hist:view:${i.id}`),
  ]);
  rows.push(...paginationRow(page, total, 'hist'));
  rows.push([
    Markup.button.callback('🟢 Sent', 'hist:filter:sent'),
    Markup.button.callback('🗑 Trashed', 'hist:filter:trashed'),
    Markup.button.callback('🔄 All', 'hist:filter:all'),
  ]);
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
  await ctx.reply('Posts:', Markup.inlineKeyboard(rows));
}

async function listAllPosts(page) {
  const res = await db.query(
    `SELECT * FROM saved_items WHERE kind = 'post' ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, offsetFor(page)]
  );
  return res.rows;
}

async function countAllPosts() {
  const res = await db.query(`SELECT COUNT(*)::int AS count FROM saved_items WHERE kind = 'post'`);
  return res.rows[0].count;
}

function statusIcon(status) {
  return { sent: '🟢', scheduled: '🕐', draft: '⚪', trashed: '🗑', deleted: '⚫', failed: '🔴' }[status] || '⚪';
}

async function registerHandlers(bot) {
  bot.action(/^hist:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, parseInt(ctx.match[1], 10), ctx.session.statusFilter);
  });

  bot.action(/^hist:filter:(.+)$/, async (ctx) => {
    const filter = ctx.match[1];
    await ctx.answerCbQuery();
    await enter(ctx, 0, filter === 'all' ? null : filter);
  });

  bot.action(/^hist:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found.');

    const rows = [];
    if (item.status === 'trashed') {
      rows.push([Markup.button.callback('♻️ Restore', `hist:restore:${id}`)]);
    } else {
      rows.push([Markup.button.callback('✏️ Edit', `ep:open:${id}`)]);
      rows.push([Markup.button.callback('📊 Stats', `hist:stats:${id}`)]);
      rows.push([Markup.button.callback('💾 Save to Folder', `hist:savefolder:${id}`)]);
    }
    rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);

    await ctx.reply(
      `${statusIcon(item.status)} ${item.caption || '(media post)'}\n\nStatus: ${item.status} · v${item.version}\nChannels: ${item.channel_ids.join(', ')}`,
      Markup.inlineKeyboard(rows)
    );
  });

  bot.action(/^ep:open:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^hist:stats:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const rows = await statsModel.forSavedItem(id);
    if (rows.length === 0) return ctx.reply('No stats tracked for this post yet.');
    const lines = rows.map((r) => {
      const reactions = Object.entries(r.reactions || {}).map(([emoji, count]) => `${emoji} ${count}`).join(' ');
      return `${r.chat_id}: 👁 ${r.views} views ${reactions ? '· ' + reactions : ''}`;
    });
    await ctx.reply(`📊 Stats\n\n${lines.join('\n')}`);
  });

  bot.action(/^hist:savefolder:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const folders = require('../../../db/models/folders');
    const list = await folders.list();
    if (list.length === 0) return ctx.reply('No folders yet — create one from 📁 My Folders first.');
    const rows = list.map((f) => [Markup.button.callback(`📂 ${f.name}`, `hist:addtofolder:${f.id}:${id}`)]);
    await ctx.reply('Save to which folder?', Markup.inlineKeyboard(rows));
  });

  bot.action(/^hist:addtofolder:(\d+):(\d+)$/, async (ctx) => {
    const folderId = parseInt(ctx.match[1], 10);
    const itemId = parseInt(ctx.match[2], 10);
    await ctx.answerCbQuery('Saved');
    const folders = require('../../../db/models/folders');
    await folders.addItem(folderId, itemId);
    try { await ctx.editMessageText('💾 Saved to folder.'); } catch (_) {}
  });

  bot.action(/^hist:restore:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Restored');
    await savedItems.restoreFromTrash(id);
    try { await ctx.editMessageText('♻️ Restored from Trash.'); } catch (_) {}
  });
}

module.exports = { enter, registerHandlers };
