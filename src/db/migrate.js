// Lightweight migration runner. Reads .sql files from ./migrations in
// filename order, applies any not yet recorded in schema_migrations,
// each inside its own transaction. Safe to run on every deploy/boot.

const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function getAppliedMigrations(client) {
  const res = await client.query('SELECT filename FROM schema_migrations');
  return new Set(res.rows.map((r) => r.filename));
}

async function runMigrations() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let appliedCount = 0;

    for (const file of files) {
      if (applied.has(file)) continue;

      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(fullPath, 'utf8');

      console.log(`[migrate] Applying ${file}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        appliedCount += 1;
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[migrate] Failed applying ${file}:`, err.message);
        throw err;
      }
    }

    if (appliedCount === 0) {
      console.log('[migrate] No new migrations to apply.');
    } else {
      console.log(`[migrate] Applied ${appliedCount} migration(s).`);
    }
  } finally {
    client.release();
  }
}

// Allow running directly via `npm run migrate`, or importing programmatically
// (the bot calls this at boot before accepting webhook traffic).
if (require.main === module) {
  runMigrations()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[migrate] Migration run failed:', err);
      process.exit(1);
    });
}

module.exports = { runMigrations };
