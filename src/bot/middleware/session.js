// Redis-backed session state for wizard flows. Telegraf's default session
// middleware is in-memory only, which would lose all state on every Railway
// redeploy — this persists it so drafts survive restarts (see navigation
// rule: "state survives, or tells you plainly when it can't").
//
// Every Redis call here goes through safeRedis (see queue/redisClient.js),
// not getRedis() directly - this middleware runs on literally every update,
// so it's the one place a wedged Redis connection would take the whole bot
// down with it. safeRedis bounds each call to a few seconds and resets the
// connection on timeout, so a stuck call fails fast into the existing
// Postgres fallback below instead of hanging forever.

const { safeRedis } = require('../../queue/redisClient');
const sessionsModel = require('../../db/models/sessions');

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days - stale drafts expire, not accumulate forever

function sessionMiddleware() {
  return async (ctx, next) => {
    // channel_post / edited_channel_post / message_reaction_count updates
    // (see ownerOnly.js - these now reach this middleware instead of being
    // dropped) describe channel activity, not a wizard flow the owner is
    // driving. ctx.chat for these is the CHANNEL, not the owner's private
    // chat, so giving them a session would create junk rows in the sessions
    // table keyed on channel chat IDs and could stomp on nothing useful.
    // Only the owner's private chat with the bot carries real scene state.
    if (ctx.chat && ctx.chat.type !== 'private') {
      return next();
    }

    const chatId = ctx.chat?.id || ctx.from?.id;
    if (!chatId) return next();

    const key = SESSION_PREFIX + chatId;

    let raw;
    try {
      raw = await safeRedis.get(key);
    } catch (err) {
      console.error('[session] Redis read failed, falling back to Postgres:', err.message);
    }

    if (raw) {
      ctx.session = JSON.parse(raw);
    } else {
      // Redis miss (or Redis failed above) - check the Postgres backup
      // before assuming there's no draft.
      try {
        const backup = await sessionsModel.load(chatId);
        ctx.session = backup ? backup.state : {};
        if (backup) {
          ctx.session.__recoveredFromBackup = true;
        }
      } catch (err) {
        console.error('[session] Postgres session backup read failed:', err.message);
        ctx.session = {};
      }
    }

    await next();

    // Persist whatever the handler left in ctx.session. Both stores are
    // AWAITED (not fire-and-forget) before the webhook response completes.
    // Previously the Postgres backup was fire-and-forget: if the Redis
    // write above also failed (or the process restarted a beat later), a
    // step transition set by a handler - e.g. "awaiting_folder_name" right
    // after tapping "+ New Folder" - could vanish without landing in either
    // store. The next message then reads back a session with no step, the
    // scene's handleText matches nothing, and the owner sees total silence
    // with no idea why. One retry on Redis + always awaiting Postgres closes
    // that gap; if BOTH still fail, we say so instead of pretending it worked.
    let redisOk = false;
    for (let attempt = 0; attempt < 2 && !redisOk; attempt += 1) {
      try {
        await safeRedis.set(key, JSON.stringify(ctx.session || {}), 'EX', SESSION_TTL_SECONDS);
        redisOk = true;
      } catch (err) {
        console.error(`[session] Redis write failed (attempt ${attempt + 1}):`, err.message);
      }
    }

    let pgOk = false;
    try {
      await sessionsModel.save(chatId, ctx.session?.scene || null, ctx.session || {});
      pgOk = true;
    } catch (err) {
      console.error('[session] Postgres session backup write failed:', err.message);
    }

    if (!redisOk && !pgOk) {
      // Neither store took the write. Whatever step/flag the handler just
      // set is about to be lost. Tell the owner now, while there's still a
      // message to attach it to, rather than leaving a silent dead end.
      try {
        await ctx.reply("⚠️ Couldn't save state just now (storage hiccup) - if your next message seems ignored, that's why. Please try again.");
      } catch (_) { /* best effort */ }
    }
  };
}

async function clearSession(ctx) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  if (!chatId) return;
  ctx.session = {};
  try {
    await safeRedis.del(SESSION_PREFIX + chatId);
  } catch (err) {
    console.error('[session] Redis clear failed:', err.message);
  }
  sessionsModel.clear(chatId).catch(() => {});
}

module.exports = { sessionMiddleware, clearSession };
