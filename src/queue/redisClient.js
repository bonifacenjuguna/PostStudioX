const IORedis = require('ioredis');
const config = require('../config/env');

// ─────────────────────────────────────────────────────────────────────────
// BUG FIX (see CHANGELOG / commit): the bot going completely unresponsive
// until every redeploy was traced to this file. There used to be a single
// shared ioredis client, configured with `maxRetriesPerRequest: null`,
// that was reused for BOTH BullMQ *and* plain request-path calls (session
// middleware on every update, /status, emergencyStop, etc).
//
// `maxRetriesPerRequest: null` is genuinely required by BullMQ - but it
// also means a command is *never* rejected, it just waits forever for the
// connection to come back. Managed Redis providers (Railway/Upstash/etc.)
// commonly close idle TCP connections silently; without TCP keepalive or a
// command timeout, ioredis has no way to notice the socket is dead, so any
// in-flight command hangs indefinitely instead of erroring.
//
// Every request handler in this codebase already has a try/catch that
// assumes a Redis call can fail fast and degrade gracefully (session.js
// falls back to the Postgres backup, status.js prints 🔴, etc.) - so the
// intended resilience was already designed in. The only problem was that
// the shared connection could never actually *produce* an error - it just
// hung, so `await` never resolved, `next()` was never called, and the
// webhook response to Telegram was never sent. The bot would then sit
// silently unresponsive on that stale connection until a redeploy handed
// it a brand new socket - matching exactly the "works after redeploy,
// dies again after a while" symptom.
//
// Fix: two separate connections.
//   - getRedis()          general-purpose, request-path client. Bounded
//                          retries + keepalive + a command timeout, so a
//                          dead connection surfaces as a rejected promise
//                          within seconds (letting the existing fallback
//                          logic do its job) instead of hanging forever.
//   - getQueueConnection() dedicated connection for BullMQ Queue/Worker
//                          instances only, which is the one place
//                          `maxRetriesPerRequest: null` is actually
//                          required. Kept fully separate so a stalled
//                          queue connection can never block a live
//                          Telegram update from getting a response.
// ─────────────────────────────────────────────────────────────────────────

let client = null;
let queueConnection = null;

function getRedis() {
  if (!client) {
    client = new IORedis(config.redisUrl(), {
      // Fail fast: after 3 retries on a given command, reject instead of
      // queuing forever. Combined with commandTimeout below, this bounds
      // the absolute worst case wait to a few seconds.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      // TCP keepalive (ms) so a silently-dropped idle connection is
      // detected by the OS/ioredis instead of looking "open" forever.
      keepAlive: 10000,
      connectTimeout: 10000,
      // Belt-and-suspenders: even if a command somehow gets stuck on a
      // connection that looks alive, give up and reject after 5s.
      commandTimeout: 5000,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    client.on('error', (err) => {
      console.error('[redis] Connection error:', err.message);
    });
  }
  return client;
}

// BullMQ requires `maxRetriesPerRequest: null` on the connections it's
// given (both Queue and Worker) because of the blocking commands it issues
// internally - it manages its own retry/backoff semantics on top. Do NOT
// use this connection for anything in the request path.
function getQueueConnection() {
  if (!queueConnection) {
    queueConnection = new IORedis(config.redisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      keepAlive: 10000,
      connectTimeout: 10000,
      retryStrategy: (times) => Math.min(times * 200, 3000),
    });
    queueConnection.on('error', (err) => {
      console.error('[redis:queue] Connection error:', err.message);
    });
  }
  return queueConnection;
}

module.exports = { getRedis, getQueueConnection };
