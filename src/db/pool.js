const { Pool, types } = require('pg');
const config = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────
// ROOT CAUSE (v4 - the one the redis fix didn't cover): this file had the
// exact same "silently dead socket" hole that redisClient.js documents and
// fixes for ioredis - just never patched here.
//
// `connectionTimeoutMillis` only bounds *acquiring* a client from the pool.
// It does nothing once a query is actually running. If a query gets stuck
// on a connection that looks open but is dead (a managed-Postgres network
// blip, a lock wait that never clears, anything that never sends a FIN/RST
// back), `await db.query(...)` hung forever - and since db.query() and
// withClient() are called directly in the webhook request path (session
// backup, preSendValidator, dedupeChecker, publishSavedItem from "Send
// Now", etc.), that hang meant the checked-out client was never released
// (the `finally { client.release() }` in withClient() never runs if the
// query promise never settles).
//
// Telegraf's own handleUpdate has a 90s internal timeout that ends the
// webhook response no matter what, so no single update hung forever - but
// each stuck query permanently ate one of the 10 pool slots and never gave
// it back. A handful of these across different updates and the pool was
// fully exhausted, so every subsequent DB-touching update queued for a
// connection until IT also got stuck the same way. That's "answers /start
// once, then total silence until redeploy" - a redeploy is the only thing
// that kills the pool and frees the wedged connections.
//
// Fixed the same way as Redis: bound query execution, both server-side
// (statement_timeout - Postgres itself kills the query) and client-side
// (query_timeout - node-postgres stops waiting even if Postgres never
// answers at all, e.g. dead socket). idle_in_transaction_session_timeout
// guards the same failure mode for any code that opens a transaction and
// stalls before committing.
// ─────────────────────────────────────────────────────────────────────────

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
      // Server-side: Postgres aborts the query itself after this long.
      statement_timeout: 8000,
      // Client-side: node-postgres stops waiting after this long even if
      // Postgres never responds at all (the dead-socket case). This is the
      // one that actually closes the hole - statement_timeout can't help
      // if the response announcing the timeout never makes it back either.
      query_timeout: 10000,
      // Belt-and-suspenders: don't let a stalled transaction hold a
      // connection open indefinitely either.
      idle_in_transaction_session_timeout: 10000,
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
