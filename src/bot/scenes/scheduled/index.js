const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const { cancelScheduledPost } = require('../../../queue/queues');
const { paginationRow, PAGE_SIZE, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard } = require('../../components/navRow');

async function enter(ctx, page = 0) {
  ctx.session = { scene: 'scheduled', page };
  const items = await savedItems.listScheduled({ limit: PAGE_SIZE, offset: offsetFor(page) });
  const total = await savedItems.countByKind('post', 'scheduled');

  await ctx.reply('⏰ Scheduled', subScreenReplyKeyboard());

  if (total === 0) {
    await ctx.reply('Nothing scheduled right now.');
    return;
  }

  const rows = items.map((i) => [
    Markup.button.callback(
      `🕐 ${new Date(i.scheduled_for).toLocaleString()} — ${i.caption?.slice(0, 25) || '(media post)'}`,
      `sch:view:${i.id}`
    ),
  ]);
  rows.push(...paginationRow(page, total, 'sch'));
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);
  await ctx.reply('Pending posts:', Markup.inlineKeyboard(rows));
}

async function registerHandlers(bot) {
  bot.action(/^sch:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^sch:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const item = await savedItems.findById(id);
    if (!item) return ctx.reply('Not found.');
    const when = new Date(item.scheduled_for);
    const remainingMs = when.getTime() - Date.now();
    const hrs = Math.floor(remainingMs / 3600000);
    const mins = Math.floor((remainingMs % 3600000) / 60000);
    await ctx.reply(
      `🕐 Sends in ${hrs}h ${mins}m\n${item.caption?.slice(0, 200) || '(media post)'}\nChannels: ${item.channel_ids.join(', ')}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit', `ep:reschedule:${id}`)],
        [Markup.button.callback('✏️ Edit Content', `sch:editcontent:${id}`)],
        [Markup.button.callback('🕐 Cancel Schedule', `sch:cancel:${id}`)],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action(/^sch:editcontent:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^sch:cancel:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    await ctx.reply('Cancel this scheduled post? It moves back to Draft (not deleted).', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Yes, cancel it', `sch:cancelconfirm:${id}`)],
      [Markup.button.callback('❌ Nevermind', 'nav:cancel')],
    ]));
  });

  bot.action(/^sch:cancelconfirm:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Cancelled');
    await cancelScheduledPost(id);
    await savedItems.updateWithVersion(id, { status: 'draft', scheduled_for: null });
    try { await ctx.editMessageText('🕐 Schedule cancelled — moved back to draft.'); } catch (_) {}
  });
}

module.exports = { enter, registerHandlers };
