const db = require('../pool');

async function list() {
  const res = await db.query(`
    SELECT f.*, COUNT(fi.saved_item_id)::int AS item_count
    FROM folders f
    LEFT JOIN folder_items fi ON fi.folder_id = f.id
    GROUP BY f.id
    ORDER BY f.created_at ASC
  `);
  return res.rows;
}

async function create(name) {
  const res = await db.query('INSERT INTO folders (name) VALUES ($1) RETURNING *', [name]);
  return res.rows[0];
}

async function rename(id, name) {
  await db.query('UPDATE folders SET name = $2 WHERE id = $1', [id, name]);
}

async function remove(id) {
  await db.query('DELETE FROM folders WHERE id = $1', [id]);
}

async function addItem(folderId, savedItemId) {
  await db.query(
    'INSERT INTO folder_items (folder_id, saved_item_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [folderId, savedItemId]
  );
}

async function removeItem(folderId, savedItemId) {
  await db.query('DELETE FROM folder_items WHERE folder_id = $1 AND saved_item_id = $2', [folderId, savedItemId]);
}

async function itemsIn(folderId) {
  const res = await db.query(
    `SELECT si.* FROM saved_items si
     JOIN folder_items fi ON fi.saved_item_id = si.id
     WHERE fi.folder_id = $1 ORDER BY si.updated_at DESC`,
    [folderId]
  );
  return res.rows;
}

async function findById(id) {
  const res = await db.query('SELECT * FROM folders WHERE id = $1', [id]);
  return res.rows[0] || null;
}

module.exports = { list, create, rename, remove, addItem, removeItem, itemsIn, findById };
