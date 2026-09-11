const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const { cancelScheduledPost, cancelAutoDelete } = require('../../../queue/queues');
const { paginationRow, PAGE_SIZE, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard, backHomeRow } = require('../../components/navRow');
const { logAction } = require('../../../services/actionErrors');

// v2.0.0 (#5 + approved audit items): previously this only showed posts
// about to be SENT, with no visibility into posts about to be auto-deleted -
// two different upcoming fates the owner asked to see side by side. Also
// adds outright Delete (not just Cancel-to-draft) and a Post Now shortcut.

function timeRemaining(targetIso) {
  const ms = new Date(targetIso).getTime() - Date.now();
  if (ms <= 0) return 'any moment now';
  const hrs = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  if (hrs === 0) return `${mins}m`;
  const days = Math.floor(hrs / 24);
  if (days === 0) return `${hrs}h ${mins}m`;
  return `${days}d ${hrs % 24}h`;
}

async function enter(ctx, page = 0) {
  ctx.session = { scene: 'scheduled', page };
  await ctx.reply('⏰ Scheduled', subScreenReplyKeyboard());

  const posting = await savedItems.listScheduled({ limit: PAGE_SIZE, offset: offsetFor(page) });
  const postingTotal = await savedItems.countByKind('post', 'scheduled');
  const deleting = await savedItems.listPendingAutoDelete({ limit: PAGE_SIZE, offset: 0 });
  const deletingTotal = await savedItems.countPendingAutoDelete();

  if (postingTotal === 0 && deletingTotal === 0) {
    await ctx.reply('Nothing pending right now.', Markup.inlineKeyboard([backHomeRow('nav:home')]));
    return;
  }

  if (postingTotal > 0) {
    const rows = posting.map((i) => [
      Markup.button.callback(`🕐 in ${timeRemaining(i.scheduled_for)}${i.loop_config?.enabled ? ' 🔁' : ''} — ${i.caption?.slice(0, 22) || '(media post)'}`, `sch:view:${i.id}`),
    ]);
    rows.push(...paginationRow(page, postingTotal, 'sch'));
    await ctx.reply('📤 POSTING SOON:', Markup.inlineKeyboard(rows));
  }

  if (deletingTotal > 0) {
    const rows = deleting.map((i) => [
      Markup.button.callback(`🗑 in ${timeRemaining(i.auto_delete_at)} — ${i.caption?.slice(0, 22) || '(media post)'}`, `sch:delview:${i.id}`),
    ]);
    await ctx.reply(`🗑 AUTO-DELETING SOON${deletingTotal > PAGE_SIZE ? ` (showing ${PAGE_SIZE} of ${deletingTotal})` : ''}:`, Markup.inlineKeyboard(rows));
  }

  await ctx.reply('—', Markup.inlineKeyboard([backHomeRow('nav:home')]));
}

async function registerHandlers(bot) {
  bot.action('sch:list', async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, ctx.session.page || 0);
  });

  bot.action(/^sch:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^sch:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found — it may have already sent or been removed.');
    await ctx.reply(
      `🕐 Sends in ${timeRemaining(item.scheduled_for)} (${new Date(item.scheduled_for).toLocaleString()})\n` +
        `${item.caption?.slice(0, 200) || '(media post)'}\nChannels: ${item.channel_ids.join(', ')}` +
        (item.loop_config?.enabled ? `\n🔁 Loop cycle ${item.loop_config.cycles_done || 0}${item.loop_config.max_cycles != null ? `/${item.loop_config.max_cycles}` : ' (infinite)'}` : ''),
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Time', `ep:reschedule:${id}`)],
        [Markup.button.callback('✏️ Edit Content', `sch:editcontent:${id}`)],
        [Markup.button.callback('🚀 Post Now', `sch:postnow:${id}`)],
        [Markup.button.callback('↩️ Cancel (→ Draft)', `sch:cancel:${id}`), Markup.button.callback('🗑 Delete Outright', `sch:delete:${id}`)],
        backHomeRow('sch:list'),
      ])
    );
  });

  bot.action(/^sch:editcontent:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = parseInt(ctx.match[1], 10);
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, id, { returnTo: `sch:view:${id}` });
  });

  bot.action(/^sch:postnow:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Post this right now instead of waiting?', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, post now', `sch:postnowconfirm:${id}`)],
      backHomeRow(`sch:view:${id}`),
    ]));
  });

  bot.action(/^sch:postnowconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found.');
    try {
      await cancelScheduledPost(id);
      const { publishSavedItem } = require('../../../services/publisher');
      await publishSavedItem(ctx.telegram, item);
      await savedItems.updateWithVersion(id, { status: 'sent', scheduled_for: null });
      try { await ctx.editMessageText('🚀 Posted now.'); } catch (_) {}
    } catch (err) {
      const msg = await logAction({ scene: 'scheduled', step: 'post_now', attempted: `send saved item ${id} immediately`, error: err, savedItemId: id });
      await ctx.reply(msg);
    }
  });

  bot.action(/^sch:cancel:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Cancel this scheduled post? It moves back to Draft (not deleted).', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, cancel it', `sch:cancelconfirm:${id}`)],
      backHomeRow(`sch:view:${id}`),
    ]));
  });

  bot.action(/^sch:cancelconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Cancelled');
    await cancelScheduledPost(id);
    await savedItems.updateWithVersion(id, { status: 'draft', scheduled_for: null });
    try { await ctx.editMessageText('🕐 Schedule cancelled — moved back to draft.'); } catch (_) {}
  });

  // v2.0.0: outright delete, distinct from Cancel-to-draft - approved
  // audit addition (#6 in the fix list).
  bot.action(/^sch:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Delete this scheduled post outright? It goes to Trash (recoverable for 30 days), not just back to Draft.', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, delete', `sch:deleteconfirm:${id}`)],
      backHomeRow(`sch:view:${id}`),
    ]));
  });

  bot.action(/^sch:deleteconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    await cancelScheduledPost(id);
    await savedItems.trash(id);
    try { await ctx.editMessageText('🗑 Moved to Trash.'); } catch (_) {}
  });

  // ── Auto-delete-pending items ────────────────────────────────────────
  bot.action(/^sch:delview:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found — it may have already been deleted.');
    await ctx.reply(
      `🗑 Auto-deletes in ${timeRemaining(item.auto_delete_at)} (${new Date(item.auto_delete_at).toLocaleString()})\n` +
        `${item.caption?.slice(0, 200) || '(media post)'}\nChannels: ${item.channel_ids.join(', ')}` +
        (item.loop_config?.enabled ? `\n🔁 Will repost after this (loop is active, cycle ${item.loop_config.cycles_done || 0}${item.loop_config.max_cycles != null ? `/${item.loop_config.max_cycles}` : ''})` : ''),
      Markup.inlineKeyboard([
        [Markup.button.callback('🚫 Cancel Auto-Delete (keep it up)', `sch:canceldel:${id}`)],
        ...(item.loop_config?.enabled ? [[Markup.button.callback('🛑 Stop Looping (still deletes this once)', `sch:stoploop:${id}`)]] : []),
        backHomeRow('sch:list'),
      ])
    );
  });

  bot.action(/^sch:canceldel:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    // NOTE: a looping item's active auto-delete job id is cycle-suffixed
    // (autodelete:<id>:c<cycles_done>, see worker.js) - the plain-form
    // cancelAutoDelete only removes the non-loop job id, so for a looping
    // item this call is a best-effort no-op on the queue side and relies on
    // clearing auto_delete_at so the worker treats it as already handled.
    await cancelAutoDelete(id);
    await savedItems.updateWithVersion(id, { auto_delete_at: null });
    try { await ctx.editMessageText('🚫 Auto-delete cancelled — this post stays up.'); } catch (_) {}
  });

  bot.action(/^sch:stoploop:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Loop stopped');
    const item = await savedItems.findById(id);
    if (item?.loop_config) {
      await savedItems.updateWithVersion(id, { loop_config: { ...item.loop_config, active: false } });
    }
    try { await ctx.editMessageText('🛑 Loop stopped — this post will still auto-delete once as scheduled, but won\'t repost after.'); } catch (_) {}
  });
}

module.exports = { enter, registerHandlers };
