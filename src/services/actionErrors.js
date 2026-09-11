// Complements watchdog_log (system health - memory, redis, queue backlog)
// with per-action errors: something the owner directly triggered (send a
// post, replace a link, set a signature...) that failed. Per the product
// requirement, the owner never wants a bare "❌ An error occurred" - every
// error should say what the bot was doing, in which screen, and why it
// failed, so it's fixable/locatable on sight instead of a guessing game.

// Required lazily (not at module top) so pure functions in this file
// (formatErrorMessage) can be imported/tested without needing a live 'pg'
// module available - useful in the smoke-test's dependency-free pass.
function db() {
  return require('../db/pool');
}

async function logAction({ scene, step, attempted, error, savedItemId = null, chatId = null }) {
  const reason = error?.description || error?.message || String(error || 'unknown error');
  const errorCode = error?.error_code ? String(error.error_code) : error?.code ? String(error.code) : null;

  try {
    await db().query(
      `INSERT INTO action_errors (scene, step, attempted, reason, error_code, saved_item_id, chat_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [scene, step || null, attempted, reason, errorCode, savedItemId, chatId ? String(chatId) : null]
    );
  } catch (dbErr) {
    // Logging the error must never itself crash the flow that triggered it.
    console.error('[actionErrors] Failed to log action error:', dbErr.message);
  }

  return formatErrorMessage({ scene, step, attempted, reason, errorCode });
}

// Builds the specific, locatable error text shown to the owner. Format is
// deliberately consistent everywhere it's used: WHERE, WHAT, WHY.
function formatErrorMessage({ scene, step, attempted, reason, errorCode }) {
  const location = step ? `${scene} → ${step}` : scene;
  const codeSuffix = errorCode ? ` (code: ${errorCode})` : '';
  return (
    `🔴 Error in ${location}\n` +
    `Tried to: ${attempted}\n` +
    `Reason: ${reason}${codeSuffix}`
  );
}

async function recent(limit = 20) {
  const res = await db().query('SELECT * FROM action_errors ORDER BY created_at DESC LIMIT $1', [limit]);
  return res.rows;
}

async function clearAll() {
  await db().query('DELETE FROM action_errors');
}

module.exports = { logAction, formatErrorMessage, recent, clearAll };
