const IORedis = require('ioredis');
const config = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────
// BUG HISTORY (read this before touching this file again):
//
// v1: one shared client with `maxRetriesPerRequest: null` (needed by
// BullMQ) was reused for request-path calls too. A silently-dropped idle
// connection meant those calls hung forever -> whole bot went unresponsive
// until redeploy. Fixed by splitting BullMQ onto its own connection
// (getQueueConnection) and giving the general client bounded retries +
// commandTimeout.
//
// v2 (this version): splitting the connection wasn't the whole story.
// ioredis multiplexes every command over ONE TCP connection, in order. If
// a single command gets stuck on a socket that looks "open" but is
// actually dead (common on managed Redis behind a NAT/proxy - the far end
// drops the connection without ever sending a FIN/RST), every command
// queued behind it on that same connection is stuck too - including
// ioredis's own internal retry/timeout bookkeeping, which lives on the
// same connection. In practice a single bad socket could still take the
// whole request path down with it, not just one call: exactly the
// "answered /start once, then completely silent forever" report - the
// very first command after boot got a fresh honest socket; some idle gap
// afterwards let the provider drop it; the next command wedged the
// connection for good.
//
// The fix here doesn't lean on ioredis to notice the problem - it can't,
// reliably, on a socket that never errors. Instead every request-path
// call goes through withTimeout(), which races the Redis call against our
// own clock. If we don't hear back in time we (a) reject right away so
// the caller's existing fallback/error-handling runs, and (b) tear the
// client down so the *next* call gets a brand new socket instead of
// queuing behind the same wedged one. This is a self-healing mechanism
// that doesn't depend on the provider ever telling us the connection died.
// ─────────────────────────────────────────────────────────────────────────

const GENERAL_TIMEOUT_MS = 3000;

let client = null;
let queueConnection = null;

function createGeneralClient() {
  const c = new IORedis(config.redisUrl(), {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    keepAlive: 5000,      // OS-level TCP keepalive, ms
    connectTimeout: 5000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  c.on('error', (err) => {
    console.error('[redis] Connection error:', err.message);
  });
  return c;
}

function getRedis() {
  if (!client) client = createGeneralClient();
  return client;
}

// Tear down and drop the current general client. The next getRedis() call
// builds a fresh one. Used when a call times out under withTimeout(), so a
// single stuck socket can't wedge every call after it.
function resetGeneralClient() {
  if (client) {
    try {
      client.disconnect();
    } catch (_) { /* already dead, that's fine */ }
  }
  client = null;
}

// Races any general-purpose Redis call against our own timeout instead of
// trusting the connection to fail on its own. On timeout: reject (so the
// caller's existing try/catch / fallback logic runs, same as any other
// Redis error) and reset the client (so the connection can't stay wedged).
function withTimeout(promise, ms = GENERAL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      resetGeneralClient();
      reject(new Error(`Redis call timed out after ${ms}ms - connection reset`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Preferred API for the request path (session middleware, /status,
// emergencyStop, watchdog, etc.) - every call is bounded and self-heals a
// wedged connection. Prefer these over calling getRedis().<cmd>(...)
// directly anywhere that's on the hot path of answering a Telegram update.
const safeRedis = {
  get: (key) => withTimeout(getRedis().get(key)),
  set: (key, value, ...args) => withTimeout(getRedis().set(key, value, ...args)),
  del: (key) => withTimeout(getRedis().del(key)),
  ping: () => withTimeout(getRedis().ping()),
  info: (section) => withTimeout(getRedis().info(section)),
  lpush: (key, value) => withTimeout(getRedis().lpush(key, value)),
  rpop: (key) => withTimeout(getRedis().rpop(key)),
  lrange: (key, start, stop) => withTimeout(getRedis().lrange(key, start, stop)),
};

// BullMQ requires `maxRetriesPerRequest: null` on the connections it's
// given (both Queue and Worker) because of the blocking commands it issues
// internally - it manages its own retry/backoff semantics on top. This
// connection is intentionally NOT timeout-wrapped and NOT shared with
// anything in the request path.
function getQueueConnection() {
  if (!queueConnection) {
    queueConnection = new IORedis(config.redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      keepAlive: 5000,
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    queueConnection.on('error', (err) => {
      console.error('[redis:queue] Connection error:', err.message);
    });
  }
  return queueConnection;
}

module.exports = { getRedis, getQueueConnection, safeRedis, resetGeneralClient };
