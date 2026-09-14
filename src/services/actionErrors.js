// Complements watchdog_log (system health - memory, redis, queue backlog)
// with per-action errors: something the owner directly triggered (send a
// post, replace a link, set a signature...) that failed. Per the product
// requirement, the owner never wants a bare "❌ An error occurred" - every
// error should say what the bot was doing, in which screen, and why it
// failed, so it's fixable/locatable on sight instead of a guessing game.
//
// v2.2.4: adds KNOWN_PATTERNS - a single, centralized table of Telegram
// error strings that represent EXPECTED, routine conditions (the bot isn't
// added to a chat yet, a linked post no longer exists, an edit changed
// nothing) rather than genuine system failures. Those get a specific,
// friendly, actionable message instead of the raw scene/step/reason
// format, which is reserved for actually-unexpected errors. This used to
// be hand-rolled per call site (Channels' "chat not found" check was
// written inline, one-off) - centralized here so every call site benefits
// automatically and new known-error cases only need to be added once.

// Required lazily (not at module top) so pure functions in this file
// (formatErrorMessage, matchKnownPattern) can be imported/tested without
// needing a live 'pg' module available - useful in the smoke-test's
// dependency-free pass.
function db() {
  return require('../db/pool');
}

// Each entry: `test` matches against the raw Telegram error text, `message`
// is a function of the log context (scene/step/attempted/etc.) so the
// friendly text can still reference what was being attempted when useful.
const KNOWN_PATTERNS = [
  {
    test: /chat not found/i,
    message: () =>
      "🔍 I couldn't find that chat — it looks like the bot hasn't been added to it yet.\n\n" +
      'To fix this: open the channel in Telegram, add this bot as an admin (with at least "Post Messages" rights), then try again.',
  },
  {
    test: /message to forward not found/i,
    message: () =>
      "📭 That post doesn't exist anymore, or the bot can't reach it — it may have been deleted, or it's in a channel the bot isn't a member of.",
  },
  {
    test: /message can'?t be deleted/i,
    message: () =>
      "🗑 That message can no longer be deleted — Telegram only allows deleting a channel post within 48 hours, and it may already be past that, or already gone.",
  },
  {
    test: /message identifier is not specified|message.*not found/i,
    message: () =>
      '📭 That message no longer exists on Telegram\'s side — it may have already been deleted directly in the channel.',
  },
  {
    test: /not enough rights|user_not_participant|CHAT_ADMIN_REQUIRED/i,
    message: () =>
      "🔒 The bot doesn't currently have the rights needed for that action in this chat — check ⚙️ Settings → 📡 Channels → 🔄 Re-check Rights.",
  },
  {
    // Defense-in-depth: validateDraft (preSendValidator.js) should catch
    // this before it ever reaches Telegram, but if it somehow doesn't
    // (an edge case the validator missed), this is the backstop - still a
    // plain, actionable message instead of a raw code.
    test: /message text is empty|caption is too long|message is too long/i,
    message: () =>
      "📝 That post has no usable content to send — check that it has text (for a text post) or hasn't gone over Telegram's length limit.",
  },
];

function matchKnownPattern(reason) {
  return KNOWN_PATTERNS.find((p) => p.test.test(reason || ''));
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

  // Known, expected conditions get a friendly message instead of the raw
  // diagnostic format - still logged above either way, for the audit
  // trail and Recent Events, just phrased differently to the owner.
  const known = matchKnownPattern(reason);
  if (known) return known.message({ scene, step, attempted, reason, errorCode });

  return formatErrorMessage({ scene, step, attempted, reason, errorCode });
}

// Builds the specific, locatable error text shown to the owner for
// genuinely unexpected errors. Format is deliberately consistent
// everywhere it's used: WHERE, WHAT, WHY.
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

// Telegram rejects an edit outright if the new content is byte-identical to
// what's already live ("message is not modified") - a harmless no-op, not
// a real failure. Kept separate from KNOWN_PATTERNS above (which are for
// genuine errors that just deserve friendlier phrasing) since this one
// isn't an error at all - callers check it BEFORE calling logAction, so it
// never even gets logged as a failure.
function isNotModifiedError(err) {
  const description = err?.description || err?.message || '';
  return /message is not modified/i.test(description);
}

module.exports = { logAction, formatErrorMessage, recent, clearAll, isNotModifiedError, matchKnownPattern };
