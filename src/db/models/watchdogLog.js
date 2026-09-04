const db = require('../pool');
const config = require('../../config/env');

async function record({ level, category, message, selfHealed = false, resolved = false }) {
  const res = await db.query(
    `INSERT INTO watchdog_log (level, category, message, self_healed, resolved, bot_version)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [level, category, message, selfHealed, resolved, config.botVersion]
  );
  return res.rows[0];
}

async function recentFailures(category, windowMinutes) {
  const res = await db.query(
    `SELECT * FROM watchdog_log
     WHERE category = $1 AND level IN ('warning', 'critical') AND resolved = false
     AND created_at > now() - ($2 || ' minutes')::interval
     ORDER BY created_at DESC`,
    [category, windowMinutes]
  );
  return res.rows;
}

async function listRecent({ limit = 8, offset = 0 } = {}) {
  const res = await db.query(
    'SELECT * FROM watchdog_log ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return res.rows;
}

async function markResolved(id) {
  await db.query('UPDATE watchdog_log SET resolved = true WHERE id = $1', [id]);
}

async function pruneOld(days = 30) {
  const res = await db.query(
    `DELETE FROM watchdog_log WHERE created_at < now() - ($1 || ' days')::interval RETURNING id`,
    [days]
  );
  return res.rows.length;
}

module.exports = { record, recentFailures, listRecent, markResolved, pruneOld };
