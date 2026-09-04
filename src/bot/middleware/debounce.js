// Prevents double-post/double-delete from rapid double-taps or Telegram
// occasionally re-delivering an update on a slow connection. Keyed on
// callback_data + message_id, short in-memory window is enough since this
// is a single-owner bot (no cross-instance concern at this scale).

const recentTaps = new Map();
const DEBOUNCE_MS = 1200;

function debounce() {
  return async (ctx, next) => {
    if (!ctx.callbackQuery) return next();

    const key = `${ctx.callbackQuery.message?.message_id}:${ctx.callbackQuery.data}`;
    const now = Date.now();
    const last = recentTaps.get(key);

    if (last && now - last < DEBOUNCE_MS) {
      // Acknowledge silently so Telegram stops showing the loading spinner,
      // but don't run the handler again.
      try {
        await ctx.answerCbQuery();
      } catch (_) { /* ignore */ }
      return;
    }

    recentTaps.set(key, now);
    // Cheap cleanup so the map doesn't grow unbounded over a long uptime.
    if (recentTaps.size > 500) {
      const cutoff = now - DEBOUNCE_MS * 10;
      for (const [k, t] of recentTaps) {
        if (t < cutoff) recentTaps.delete(k);
      }
    }

    return next();
  };
}

module.exports = { debounce };
