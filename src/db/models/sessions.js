// Wizard/session state lives primarily in Redis (see src/bot/middleware/session.js)
// for speed. This Postgres mirror is a durability backstop only, in case Redis
// is flushed/restarted — it lets us tell the user plainly that a draft is gone
// rather than silently failing, per the "state survives or tells you" rule.

const db = require('../pool');

async function save(chatId, scene, state) {
  await db.query(
    `INSERT INTO sessions (chat_id, scene, state, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (chat_id) DO UPDATE SET scene = EXCLUDED.scene, state = EXCLUDED.state, updated_at = now()`,
    [String(chatId), scene, JSON.stringify(state)]
  );
}

async function load(chatId) {
  const res = await db.query('SELECT * FROM sessions WHERE chat_id = $1', [String(chatId)]);
  return res.rows[0] || null;
}

async function clear(chatId) {
  await db.query('DELETE FROM sessions WHERE chat_id = $1', [String(chatId)]);
}

module.exports = { save, load, clear };
