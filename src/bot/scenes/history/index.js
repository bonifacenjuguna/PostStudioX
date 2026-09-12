const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const statsModel = require('../../../db/models/stats');
const db = require('../../../db/pool');
const { paginationRow, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard, backHomeRow } = require('../../components/navRow');
const { logAction } = require('../../../services/actionErrors');

// v2.0.0 (#4): the old list showed up to 8 items with no real per-post
// detail, and there was no way to actually remove anything from History -
// only Trash (a status change) existed. History gets its own smaller page
// size on purpose (easier to scan on a phone than Templates' 8), full
// timestamps per post (laying groundwork for the automation mentioned when
// this was requested), and real clear-one/clear-all actions.
const HISTORY_PAGE_SIZE = 6;

async function enter(ctx, page = 0, statusFilter = null) {
  ctx.session = { scene: 'history', page, statusFilter };
  const filterLabel = statusFilter ? ` (${statusFilter})` : '';
  await ctx.reply(`📜 History${filterLabel}`, subScreenReplyKeyboard());

  const items = statusFilter
    ? await savedItems.listByKind('post', { limit: HISTORY_PAGE_SIZE, offset: offsetFor(page, HISTORY_PAGE_SIZE), statusFilter })
    : await listAllPosts(page);
  const total = statusFilter
    ? await savedItems.countByKind('post', statusFilter)
    : await countAllPosts();

  if (total === 0) {
    await ctx.reply('Nothing here yet.', Markup.inlineKeyboard([backHomeRow('nav:home')]));
    return;
  }

  const rows = items.map((i) => [
    Markup.button.callback(`${statusIcon(i.status)}${i.loop_config?.enabled ? ' 🔁' : ''} ${i.caption?.slice(0, 30) || '(media post)'}`, `hist:view:${i.id}`),
  ]);
  rows.push(...paginationRow(page, total, 'hist', HISTORY_PAGE_SIZE));
  rows.push([
    Markup.button.callback('🟢 Sent', 'hist:filter:sent'),
    Markup.button.callback('🗑 Trashed', 'hist:filter:trashed'),
    Markup.button.callback('🔄 All', 'hist:filter:all'),
  ]);
  rows.push([Markup.button.callback('🧹 Clear All History', 'hist:clearall')]);
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
  await ctx.reply('Posts:', Markup.inlineKeyboard(rows));
}

async function listAllPosts(page) {
  const res = await db.query(
    `SELECT * FROM saved_items WHERE kind = 'post' ORDER BY updated_at DESC LIMIT $1 OFFSET $2`,
    [HISTORY_PAGE_SIZE, offsetFor(page, HISTORY_PAGE_SIZE)]
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

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function detailText(item) {
  const loop = item.loop_config;
  const loopLine = loop?.enabled
    ? `\n🔁 Loop: cycle ${loop.cycles_done || 0}${loop.max_cycles != null ? `/${loop.max_cycles}` : ' (infinite)'}, ${loop.active ? 'active' : 'stopped'}`
    : '';
  const importLine = item.imported_from ? `\n📥 Imported via ${item.imported_from.via} from ${item.imported_from.chat_id}` : '';

  return (
    `${statusIcon(item.status)} ${item.caption?.slice(0, 200) || '(media post)'}\n\n` +
    `Status: ${item.status} · v${item.version}\n` +
    `Channels: ${item.channel_ids?.join(', ') || 'none'}\n` +
    `Created: ${fmt(item.created_at)}\n` +
    `Last updated: ${fmt(item.updated_at)}\n` +
    (item.scheduled_for ? `Scheduled for: ${fmt(item.scheduled_for)}\n` : '') +
    (item.auto_delete_at ? `Auto-deletes: ${fmt(item.auto_delete_at)}\n` : '') +
    loopLine + importLine
  );
}

function detailKeyboard(item) {
  const rows = [];
  if (item.status === 'trashed') {
    rows.push([Markup.button.callback('♻️ Restore', `hist:restore:${item.id}`)]);
  } else {
    rows.push([Markup.button.callback('✏️ Edit', `ep:open:${item.id}`), Markup.button.callback('📊 Stats', `hist:stats:${item.id}`)]);
    rows.push([Markup.button.callback('🔁 Repost Now', `hist:repost:${item.id}`), Markup.button.callback('💾 Save as Template', `hist:savetemplate:${item.id}`)]);
    rows.push([Markup.button.callback('💾 Save to Folder', `hist:savefolder:${item.id}`)]);
  }
  rows.push([Markup.button.callback('🗑 Clear from History', `hist:clear:${item.id}`)]);
  rows.push(backHomeRow('hist:list'));
  return Markup.inlineKeyboard(rows);
}

async function showDetail(ctx, id) {
  const item = await savedItems.findById(id);
  if (!item) return ctx.reply('Not found — it may have already been cleared.');
  const { sendPreview, draftShapeFromSavedItem } = require('../../components/previewRenderer');
  await sendPreview(ctx, draftShapeFromSavedItem(item)).catch(() => {});
  await ctx.reply(detailText(item), detailKeyboard(item));
}

async function registerHandlers(bot) {
  bot.action('hist:list', async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, ctx.session.page || 0, ctx.session.statusFilter || null);
  });

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
    await ctx.answerCbQuery();
    await showDetail(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^ep:open:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, id, { returnTo: `hist:view:${id}` });
  });

  bot.action(/^hist:stats:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const rows = await statsModel.forSavedItem(id);
    if (rows.length === 0) return ctx.reply('No stats tracked for this post yet.', Markup.inlineKeyboard([backHomeRow(`hist:view:${id}`)]));
    const lines = rows.map((r) => {
      const reactions = Object.entries(r.reactions || {}).map(([emoji, count]) => `${emoji} ${count}`).join(' ');
      return `${r.chat_id}: 👁 ${r.views} views ${reactions ? '· ' + reactions : ''}`;
    });
    await ctx.reply(`📊 Stats\n\n${lines.join('\n')}`, Markup.inlineKeyboard([backHomeRow(`hist:view:${id}`)]));
  });

  bot.action(/^hist:savefolder:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const { promptFolderChoice } = require('../../components/folderPicker');
    await promptFolderChoice(ctx, id, { message: '📂 Save this to which folder?' });
  });

  bot.action(/^hist:savetemplate:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found.');
    const created = await savedItems.create({
      kind: 'template', name: item.caption?.slice(0, 40) || `Template from post #${item.id}`, status: 'draft',
      mediaType: item.media_type, mediaItems: item.media_items, caption: item.caption, entities: item.entities,
      buttons: item.buttons, options: item.options, channelIds: [],
    });
    await ctx.reply(`💾 Saved as a new template: "${created.name}"`);
    const { promptFolderChoice } = require('../../components/folderPicker');
    await promptFolderChoice(ctx, created.id);
  });

  bot.action(/^hist:repost:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found.');
    if (!item.channel_ids?.length) {
      await ctx.reply('This post has no channels attached to repost to — use Edit to add one first.', Markup.inlineKeyboard([backHomeRow(`hist:view:${id}`)]));
      return;
    }
    try {
      const { publishSavedItem } = require('../../../services/publisher');
      await publishSavedItem(ctx.telegram, item);
      await ctx.reply(`🔁 Reposted to: ${item.channel_ids.join(', ')}`, Markup.inlineKeyboard([backHomeRow(`hist:view:${id}`)]));
    } catch (err) {
      const msg = await logAction({ scene: 'history', step: 'repost', attempted: `repost saved item ${id}`, error: err, savedItemId: id });
      await ctx.reply(msg);
    }
  });

  bot.action(/^hist:restore:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Restored');
    await savedItems.restoreFromTrash(id);
    try { await ctx.editMessageText('♻️ Restored from Trash.'); } catch (_) {}
  });

  // "Clear" is a real hard delete of the history record itself, distinct
  // from Trash (a status - the item still shows up under 🗑 Trashed until
  // cleared). This is what the redesign asked for: a way to actually make
  // an entry go away, not just relabel it.
  bot.action(/^hist:clear:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Permanently clear this from History? This cannot be undone.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, clear it', `hist:clearconfirm:${id}`)],
      backHomeRow(`hist:view:${id}`),
    ]));
  });

  bot.action(/^hist:clearconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Cleared');
    await savedItems.hardDelete(id);
    try { await ctx.editMessageText('🗑 Cleared from History.'); } catch (_) {}
  });

  bot.action('hist:clearall', async (ctx) => {
    await ctx.answerCbQuery();
    const filter = ctx.session?.statusFilter;
    await ctx.reply(
      `Permanently clear ${filter ? `all "${filter}"` : 'ALL'} history? This cannot be undone.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, clear everything shown', 'hist:clearallconfirm')],
        [Markup.button.callback('❌ Cancel', 'nav:cancel')],
      ])
    );
  });

  bot.action('hist:clearallconfirm', async (ctx) => {
    await ctx.answerCbQuery('Cleared');
    const filter = ctx.session?.statusFilter;
    await savedItems.hardDeleteAllPosts(filter || null);
    try { await ctx.editMessageText('🧹 History cleared.'); } catch (_) {}
    await enter(ctx, 0, null);
  });
}

module.exports = { enter, registerHandlers };
