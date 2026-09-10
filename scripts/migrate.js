const fs = require('node:fs/promises');
const path = require('node:path');
const { Client } = require('pg');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const directory = path.join(__dirname, '..', 'db', 'migrations');
    const migrations = (await fs.readdir(directory)).filter(f => f.endsWith('.sql')).sort();
    for (const version of migrations) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
      if (applied.rowCount) continue;
      const sql = await fs.readFile(path.join(directory, version), 'utf8');
      await client.query('BEGIN');
      try { await client.query(sql); await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [version]); await client.query('COMMIT'); console.log(`Applied ${version}`); }
      catch (error) { await client.query('ROLLBACK'); throw error; }
    }
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
