// Export/import for portable configuration - deliberately excludes secrets
// (bot token, DB creds, GramJS session string) even under "Everything" scope.

const db = require('../db/pool');
const settingsModel = require('../db/models/settings');
const folders = require('../db/models/folders');

const SCHEMA_VERSION = 1;

async function exportData(scope = 'everything') {
  const payload = { schema_version: SCHEMA_VERSION, exported_at: new Date().toISOString(), scope };

  if (scope === 'templates' || scope === 'everything') {
    const res = await db.query(`SELECT * FROM saved_items WHERE kind = 'template'`);
    payload.templates = res.rows;
  }
  if (scope === 'settings' || scope === 'everything') {
    payload.settings = await settingsModel.getAll();
  }
  if (scope === 'recipes' || scope === 'everything') {
    const res = await db.query(`SELECT * FROM saved_items WHERE kind = 'recipe'`);
    payload.recipes = res.rows;
  }
  if (scope === 'folders' || scope === 'everything') {
    payload.folders = await folders.list();
  }

  return payload;
}

function validateImportShape(payload) {
  const errors = [];
  if (typeof payload !== 'object' || payload === null) {
    errors.push('File is not a valid JSON object.');
    return { valid: false, errors };
  }
  if (payload.schema_version === undefined) {
    errors.push('Missing schema_version - this may not be an export from this bot.');
  } else if (payload.schema_version > SCHEMA_VERSION) {
    errors.push(`File was exported from a newer bot version (schema v${payload.schema_version}); this bot supports up to v${SCHEMA_VERSION}.`);
  }
  return { valid: errors.length === 0, errors };
}

function summarize(payload) {
  return {
    templates: (payload.templates || []).length,
    settings: payload.settings ? Object.keys(payload.settings).length : 0,
    recipes: (payload.recipes || []).length,
    folders: (payload.folders || []).length,
  };
}

async function importData(payload, { mode = 'merge' } = {}) {
  let imported = { templates: 0, settings: 0, recipes: 0, folders: 0 };

  if (payload.settings) {
    for (const [key, value] of Object.entries(payload.settings)) {
      await settingsModel.set(key, value);
      imported.settings += 1;
    }
  }

  for (const t of payload.templates || []) {
    if (mode === 'merge') {
      const existing = await db.query(`SELECT id FROM saved_items WHERE kind = 'template' AND name = $1`, [t.name]);
      if (existing.rows.length > 0) continue; // skip conflicts in merge mode
    }
    await db.query(
      `INSERT INTO saved_items (kind, name, status, caption, entities, buttons, options, media_type, media_items)
       VALUES ('template', $1, 'draft', $2, $3, $4, $5, $6, $7)`,
      [t.name, t.caption, JSON.stringify(t.entities || []), JSON.stringify(t.buttons || []),
        JSON.stringify(t.options || {}), t.media_type, JSON.stringify(t.media_items || [])]
    );
    imported.templates += 1;
  }

  for (const r of payload.recipes || []) {
    await db.query(
      `INSERT INTO saved_items (kind, name, status, options) VALUES ('recipe', $1, 'draft', $2)`,
      [r.name, JSON.stringify(r.options || {})]
    );
    imported.recipes += 1;
  }

  for (const f of payload.folders || []) {
    if (mode === 'merge') {
      const existing = await db.query('SELECT id FROM folders WHERE name = $1', [f.name]);
      if (existing.rows.length > 0) continue;
    }
    await db.query('INSERT INTO folders (name) VALUES ($1)', [f.name]);
    imported.folders += 1;
  }

  return imported;
}

module.exports = { exportData, validateImportShape, summarize, importData, SCHEMA_VERSION };
