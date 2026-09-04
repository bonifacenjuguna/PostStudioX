const { Pool, types } = require('pg');
const config = require('../config/env');

// BIGINT (OID 20) comes back as a string by default to avoid precision loss
// on huge numbers. Telegram message/chat IDs are always well within
// Number.MAX_SAFE_INTEGER, so parsing them as real numbers avoids subtle
// string-vs-number bugs (comparisons, arithmetic, GramJS calls) elsewhere.
types.setTypeParser(20, (val) => parseInt(val, 10));

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.databaseUrl(),
      ssl: config.isProduction ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      // Prevents an idle client error from crashing the whole process.
      // The watchdog's DB monitor is responsible for detecting real outages.
      console.error('[db] Unexpected error on idle client', err);
    });
  }
  return pool;
}

async function query(text, params) {
  const start = Date.now();
  const res = await getPool().query(text, params);
  const duration = Date.now() - start;
  if (duration > 500) {
    console.warn(`[db] Slow query (${duration}ms): ${text.slice(0, 100)}`);
  }
  return res;
}

async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function healthCheck() {
  const start = Date.now();
  await getPool().query('SELECT 1');
  return Date.now() - start;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { getPool, query, withClient, healthCheck, closePool };
