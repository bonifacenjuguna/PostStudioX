const { Markup } = require('telegraf');
const savedItems = require('../../../db/models/savedItems');
const { paginationRow, PAGE_SIZE, offsetFor } = require('../../components/pagination');
const { subScreenReplyKeyboard, homeReplyKeyboard } = require('../../components/navRow');

async function enter(ctx, page = 0) {
  ctx.session = { scene: 'templates', page };
  const templates = await savedItems.listByKind('template', { limit: PAGE_SIZE, offset: offsetFor(page) });
  const total = await savedItems.countByKind('template');

  if (total === 0) {
    await ctx.reply('🗂 No templates saved yet.\n\nSave one from any post\'s preview screen with 💾 Save as Template.', subScreenReplyKeyboard());
    return;
  }

  const rows = templates.map((t) => [Markup.button.callback(`📄 ${t.name || '(unnamed)'}`, `tpl:view:${t.id}`)]);
  rows.push(...paginationRow(page, total, 'tpl'));
  rows.push([Markup.button.callback('🏠 Home', 'nav:home')]);

  await ctx.reply(`🗂 Templates (${total})`, subScreenReplyKeyboard());
  await ctx.reply('Pick a template:', Markup.inlineKeyboard(rows));
}

async function registerHandlers(bot, scenes) {
  bot.action(/^tpl:page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await enter(ctx, parseInt(ctx.match[1], 10));
  });

  bot.action(/^tpl:view:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const t = await savedItems.findById(id);
    if (!t) return ctx.reply('Template not found.');
    await ctx.reply(
      `📄 ${t.name}\n\n${t.caption || '(no caption)'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('▶️ Use', `tpl:use:${id}`)],
        [Markup.button.callback('✏️ Edit', `tpl:edit:${id}`), Markup.button.callback('🗑 Delete', `tpl:delete:${id}`)],
        [Markup.button.callback('🏠 Home', 'nav:home')],
      ])
    );
  });

  bot.action(/^tpl:use:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const t = await savedItems.findById(id);
    ctx.session = {
      scene: 'create-post',
      step: 'select_channels',
      draft: {
        channelIds: [], mediaType: t.media_type, mediaItems: t.media_items || [],
        caption: t.caption || '', entities: t.entities || [], buttons: t.buttons || [], options: t.options || {},
      },
    };
    const channelsModel = require('../../../db/models/channels');
    const channels = await channelsModel.list();
    const { flowReplyKeyboard } = require('../../components/navRow');
    await ctx.reply('Using template — pick target channel(s):', flowReplyKeyboard());
    const rows = channels.map((c) => [Markup.button.callback(`⬜ ${c.title || c.chat_id}`, `cp:chan:${c.chat_id}`)]);
    rows.push([Markup.button.callback('➡️ Next', 'cp:chan:next')]);
    rows.push([Markup.button.callback('❌ Cancel', 'nav:cancel')]);
    await ctx.reply('Select target channel(s):', Markup.inlineKeyboard(rows));
  });

  bot.action(/^tpl:edit:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery();
    const { openEditMenu } = require('../edit-post');
    await openEditMenu(ctx, id);
  });

  bot.action(/^tpl:delete:(\d+)$/, async (ctx) => {
    const id = parseInt(ctx.match[1], 10);
    await ctx.answerCbQuery('Deleted');
    await savedItems.hardDelete(id);
    try { await ctx.editMessageText('🗑 Template deleted.'); } catch (_) {}
  });
}

module.exports = { enter, registerHandlers };
