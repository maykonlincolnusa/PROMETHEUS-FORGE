const fs = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');

const root = __dirname;
const fallbackAssets = path.join(root, 'data', 'assets.json');
const fallbackAudit = path.join(root, 'data', 'audit.json');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined })
  : null;

const toAsset = row => ({ id: row.id, name: row.name, type: row.asset_type, state: row.state_code, health: row.health, vibration: row.vibration, temperature: row.temperature, hours: row.operating_hours, criticality: row.criticality, status: row.status, last: row.updated_at });
async function localRead(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function assets() {
  if (!pool) return localRead(fallbackAssets);
  const result = await pool.query('SELECT * FROM assets ORDER BY id');
  return result.rows.map(toAsset);
}
async function audit() {
  if (!pool) return localRead(fallbackAudit);
  const result = await pool.query('SELECT id, action, detail, source, created_at FROM audit_events ORDER BY created_at DESC LIMIT 500');
  return result.rows;
}
async function appendAudit(entry) {
  if (!pool) {
    const entries = await localRead(fallbackAudit);
    entries.unshift(entry); await fs.writeFile(fallbackAudit, `${JSON.stringify(entries.slice(0, 500), null, 2)}\n`);
    return entry;
  }
  await pool.query('INSERT INTO audit_events(id, action, detail, source) VALUES ($1, $2, $3, $4)', [entry.id, entry.action, entry.detail, entry.source]);
  return entry;
}
async function health() {
  if (!pool) return { persistence: 'local-demo' };
  await pool.query('SELECT 1'); return { persistence: 'postgresql' };
}
module.exports = { assets, audit, appendAudit, health, production: Boolean(pool) };
