// Redis-backed session state for wizard flows. Telegraf's default session
// middleware is in-memory only, which would lose all state on every Railway
// redeploy — this persists it so drafts survive restarts (see navigation
// rule: "state survives, or tells you plainly when it can't").

const { getRedis } = require('../../queue/redisClient');
const sessionsModel = require('../../db/models/sessions');

const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 3; // 3 days - stale drafts expire, not accumulate forever

function sessionMiddleware() {
  return async (ctx, next) => {
    const chatId = ctx.chat?.id || ctx.from?.id;
    if (!chatId) return next();

    const redis = getRedis();
    const key = SESSION_PREFIX + chatId;

    let raw;
    try {
      raw = await redis.get(key);
    } catch (err) {
      console.error('[session] Redis read failed, falling back to Postgres:', err.message);
    }

    if (raw) {
      ctx.session = JSON.parse(raw);
    } else {
      // Redis miss - check the Postgres backup before assuming there's no draft.
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
      await redis.set(key, JSON.stringify(ctx.session || {}), 'EX', SESSION_TTL_SECONDS);
      // Fire-and-forget the durability mirror; don't block the response on it.
      sessionsModel.save(chatId, ctx.session?.scene || null, ctx.session || {}).catch((err) => {
        console.error('[session] Postgres session backup write failed:', err.message);
      });
    } catch (err) {
      console.error('[session] Redis write failed:', err.message);
    }
  };
}

async function clearSession(ctx) {
  const chatId = ctx.chat?.id || ctx.from?.id;
  if (!chatId) return;
  ctx.session = {};
  try {
    await getRedis().del(SESSION_PREFIX + chatId);
  } catch (err) {
    console.error('[session] Redis clear failed:', err.message);
  }
  sessionsModel.clear(chatId).catch(() => {});
}

module.exports = { sessionMiddleware, clearSession };
