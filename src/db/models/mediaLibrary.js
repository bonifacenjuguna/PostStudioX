const db = require('../pool');

async function add({ fileId, fileUniqueId, mediaType, label }) {
  const res = await db.query(
    'INSERT INTO media_library (file_id, file_unique_id, media_type, label) VALUES ($1, $2, $3, $4) RETURNING *',
    [fileId, fileUniqueId || null, mediaType, label || null]
  );
  return res.rows[0];
}

async function list({ limit = 8, offset = 0 } = {}) {
  const res = await db.query(
    'SELECT * FROM media_library ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit, offset]
  );
  return res.rows;
}

async function remove(id) {
  await db.query('DELETE FROM media_library WHERE id = $1', [id]);
}

module.exports = { add, list, remove };
