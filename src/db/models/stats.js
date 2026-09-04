const db = require('../pool');

async function upsertMessageRef(savedItemId, chatId, messageId) {
  await db.query(
    `INSERT INTO stats (saved_item_id, chat_id, message_id) VALUES ($1, $2, $3)
     ON CONFLICT (chat_id, message_id) DO NOTHING`,
    [savedItemId, String(chatId), messageId]
  );
}

async function updateViews(chatId, messageId, views) {
  await db.query(
    `UPDATE stats SET views = $3, last_polled_at = now(), updated_at = now()
     WHERE chat_id = $1 AND message_id = $2`,
    [String(chatId), messageId, views]
  );
}

async function updateReactions(chatId, messageId, reactions) {
  await db.query(
    `UPDATE stats SET reactions = $3, updated_at = now()
     WHERE chat_id = $1 AND message_id = $2`,
    [String(chatId), messageId, JSON.stringify(reactions)]
  );
}

async function forSavedItem(savedItemId) {
  const res = await db.query('SELECT * FROM stats WHERE saved_item_id = $1', [savedItemId]);
  return res.rows;
}

async function allTrackedRefs() {
  const res = await db.query('SELECT * FROM stats');
  return res.rows;
}

module.exports = { upsertMessageRef, updateViews, updateReactions, forSavedItem, allTrackedRefs };
