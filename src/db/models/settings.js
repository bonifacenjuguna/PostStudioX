const db = require('../pool');

async function get(key, fallback = null) {
  const res = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  if (res.rows.length === 0) return fallback;
  return res.rows[0].value;
}

async function set(key, value) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify(value)]
  );
}

async function getAll() {
  const res = await db.query('SELECT key, value FROM settings');
  const out = {};
  for (const row of res.rows) out[row.key] = row.value;
  return out;
}

module.exports = { get, set, getAll };
