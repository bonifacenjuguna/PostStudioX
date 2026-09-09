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

    // Persist whatever the handler left in ctx.session.
    try {
      await safeRedis.set(key, JSON.stringify(ctx.session || {}), 'EX', SESSION_TTL_SECONDS);
    } catch (err) {
      console.error('[session] Redis write failed:', err.message);
    }
    // Fire-and-forget the durability mirror; don't block the response on it.
    // Outside the try/catch above on purpose - a Redis failure must never
    // stop the Postgres backup from being attempted.
    sessionsModel.save(chatId, ctx.session?.scene || null, ctx.session || {}).catch((err) => {
      console.error('[session] Postgres session backup write failed:', err.message);
    });
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
