const db = require('../pool');

const JSONB_COLUMNS = new Set(['media_items', 'entities', 'buttons', 'options']);

async function create(fields) {
  const cols = ['kind', 'name', 'status', 'channel_ids', 'media_type', 'media_items',
    'caption', 'entities', 'buttons', 'options', 'scheduled_for', 'auto_delete_at'];
  const values = cols.map((c) => {
    const camelKey = c.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    const raw = fields[camelKey] !== undefined ? fields[camelKey] : defaultFor(c);
    // node-postgres serializes plain JS arrays as Postgres array literals
    // ({a,b,c}), not JSON - fine for the real text[] channel_ids column, but
    // wrong for JSONB columns, which need an explicit JSON string.
    if (JSONB_COLUMNS.has(c) && raw !== null && typeof raw !== 'string') {
      return JSON.stringify(raw);
    }
    return raw;
  });
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  const res = await db.query(
    `INSERT INTO saved_items (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return res.rows[0];
}

function defaultFor(col) {
  if (col === 'channel_ids') return [];
  if (['media_items', 'entities', 'buttons', 'options'].includes(col)) return JSON.stringify(col === 'options' ? {} : []);
  if (col === 'kind') return 'post';
  if (col === 'status') return 'draft';
  return null;
}

async function findById(id) {
  const res = await db.query('SELECT * FROM saved_items WHERE id = $1', [id]);
  return res.rows[0] || null;
}

async function listByKind(kind, { limit = 8, offset = 0, statusFilter = null } = {}) {
  const params = [kind];
  let where = 'kind = $1';
  if (statusFilter) {
    params.push(statusFilter);
    where += ` AND status = $${params.length}`;
  }
  params.push(limit, offset);
  const res = await db.query(
    `SELECT * FROM saved_items WHERE ${where} ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return res.rows;
}

async function countByKind(kind, statusFilter = null) {
  const params = [kind];
  let where = 'kind = $1';
  if (statusFilter) {
    params.push(statusFilter);
    where += ` AND status = $${params.length}`;
  }
  const res = await db.query(`SELECT COUNT(*)::int AS count FROM saved_items WHERE ${where}`, params);
  return res.rows[0].count;
}

async function listScheduled({ limit = 8, offset = 0 } = {}) {
  const res = await db.query(
    `SELECT * FROM saved_items WHERE status = 'scheduled' ORDER BY scheduled_for ASC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return res.rows;
}

// Every mutation to a saved_item bumps version and snapshots the *previous*
// state into post_versions, so rollback always has something to roll back to.
async function updateWithVersion(id, patch) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const current = await client.query('SELECT * FROM saved_items WHERE id = $1 FOR UPDATE', [id]);
      if (current.rows.length === 0) throw new Error(`saved_items row ${id} not found`);
      const row = current.rows[0];

      await client.query(
        'INSERT INTO post_versions (saved_item_id, version, snapshot) VALUES ($1, $2, $3)',
        [id, row.version, JSON.stringify(row)]
      );

      const setCols = Object.keys(patch);
      const setClauses = setCols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      const values = setCols.map((c) => patch[c]);

      const updated = await client.query(
        `UPDATE saved_items SET ${setClauses}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, ...values]
      );

      await client.query('COMMIT');
      return updated.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function listVersions(id) {
  const res = await db.query(
    'SELECT * FROM post_versions WHERE saved_item_id = $1 ORDER BY version DESC',
    [id]
  );
  return res.rows;
}

async function rollbackToVersion(id, versionId) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const versionRes = await client.query('SELECT * FROM post_versions WHERE id = $1 AND saved_item_id = $2', [versionId, id]);
      if (versionRes.rows.length === 0) throw new Error('Version not found');
      const snapshot = versionRes.rows[0].snapshot;

      const current = await client.query('SELECT * FROM saved_items WHERE id = $1 FOR UPDATE', [id]);
      await client.query(
        'INSERT INTO post_versions (saved_item_id, version, snapshot) VALUES ($1, $2, $3)',
        [id, current.rows[0].version, JSON.stringify(current.rows[0])]
      );

      const updated = await client.query(
        `UPDATE saved_items SET caption = $2, entities = $3, buttons = $4, media_items = $5, options = $6,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [id, snapshot.caption, JSON.stringify(snapshot.entities), JSON.stringify(snapshot.buttons),
          JSON.stringify(snapshot.media_items), JSON.stringify(snapshot.options)]
      );

      await client.query('COMMIT');
      return updated.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function trash(id) {
  await db.query(`UPDATE saved_items SET status = 'trashed', trashed_at = now() WHERE id = $1`, [id]);
}

async function restoreFromTrash(id) {
  await db.query(`UPDATE saved_items SET status = 'draft', trashed_at = NULL WHERE id = $1`, [id]);
}

async function purgeOldTrash(days = 30) {
  const res = await db.query(
    `DELETE FROM saved_items WHERE status = 'trashed' AND trashed_at < now() - ($1 || ' days')::interval RETURNING id`,
    [days]
  );
  return res.rows.length;
}

async function hardDelete(id) {
  await db.query('DELETE FROM saved_items WHERE id = $1', [id]);
}

async function pruneOldVersions(keep = 10) {
  // Keeps the most recent `keep` versions per saved_item, deletes the rest.
  const res = await db.query(`
    DELETE FROM post_versions
    WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY saved_item_id ORDER BY version DESC) AS rn
        FROM post_versions
      ) ranked WHERE rn > $1
    )
    RETURNING id
  `, [keep]);
  return res.rows.length;
}

module.exports = {
  create, findById, listByKind, countByKind, listScheduled,
  updateWithVersion, listVersions, rollbackToVersion,
  trash, restoreFromTrash, purgeOldTrash, hardDelete, pruneOldVersions,
};
