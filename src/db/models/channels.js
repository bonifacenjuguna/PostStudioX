const db = require('../pool');

async function list() {
  const res = await db.query('SELECT * FROM channels ORDER BY created_at ASC');
  return res.rows;
}

async function findByChatId(chatId) {
  const res = await db.query('SELECT * FROM channels WHERE chat_id = $1', [String(chatId)]);
  return res.rows[0] || null;
}

async function add({ chatId, title, username }) {
  const res = await db.query(
    `INSERT INTO channels (chat_id, title, username, is_admin, last_checked_at)
     VALUES ($1, $2, $3, true, now())
     ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, username = EXCLUDED.username
     RETURNING *`,
    [String(chatId), title || null, username || null]
  );
  return res.rows[0];
}

async function remove(chatId) {
  await db.query('DELETE FROM channels WHERE chat_id = $1', [String(chatId)]);
}

async function setAdminStatus(chatId, isAdmin, issue = null) {
  await db.query(
    'UPDATE channels SET is_admin = $2, admin_issue = $3, last_checked_at = now() WHERE chat_id = $1',
    [String(chatId), isAdmin, issue]
  );
}

async function setMuted(chatId, muted) {
  const res = await db.query(
    'UPDATE channels SET muted = $2 WHERE chat_id = $1 RETURNING *',
    [String(chatId), muted]
  );
  return res.rows[0];
}

// Persists a permission snapshot (see channelPermissions.snapshotRights) so
// Manage Channels can show granted-vs-missing without a live API call.
async function setAdminRights(chatId, rightsSnapshot) {
  const res = await db.query(
    'UPDATE channels SET admin_rights = $2, rights_checked_at = now() WHERE chat_id = $1 RETURNING *',
    [String(chatId), JSON.stringify(rightsSnapshot)]
  );
  return res.rows[0];
}

async function setPostSignature(chatId, signature) {
  const res = await db.query(
    'UPDATE channels SET post_signature = $2 WHERE chat_id = $1 RETURNING *',
    [String(chatId), signature]
  );
  return res.rows[0];
}

async function setSignMessages(chatId, enabled) {
  const res = await db.query(
    'UPDATE channels SET sign_messages = $2 WHERE chat_id = $1 RETURNING *',
    [String(chatId), enabled]
  );
  return res.rows[0];
}

module.exports = {
  list,
  findByChatId,
  add,
  remove,
  setAdminStatus,
  setMuted,
  setAdminRights,
  setPostSignature,
  setSignMessages,
};
