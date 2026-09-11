const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { demoTelemetry } = require('./lib/intelligence');

const root = __dirname;
// data/ holds seeds that ship with the repository and is only ever read; every
// write lands in the runtime directory, so the image can run on a read-only
// root filesystem and a test run can be pointed at a throwaway directory.
const seedAssets = path.join(root, 'data', 'assets.json');
const seedAudit = path.join(root, 'data', 'audit.json');
const runtimeDir = process.env.FORGE_DATA_DIR || path.join(root, 'data', 'runtime');
const runtimeFile = path.join(runtimeDir, 'intelligence.json');
const auditFile = path.join(runtimeDir, 'audit.json');
let writes = Promise.resolve();
function serializeWrite(work) {
  const operation = writes.then(work);
  writes = operation.catch(() => {});
  return operation;
}
async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(temporary, file);
}
async function runtime() {
  try { return await localRead(runtimeFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { telemetry: [], runs: [] };
  }
}
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined })
  : null;

// Condition is never stored: lib/operations.js derives risk and band from
// these inputs, so both backends hand the console the same raw record.
const toAsset = row => ({
  id: row.id, name: row.name, type: row.asset_type, state: row.state_code,
  health: row.health, vibration: row.vibration, temperature: row.temperature,
  hours: row.operating_hours, criticality: row.criticality,
});
async function localRead(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }

async function assets() {
  if (!pool) return localRead(seedAssets);
  const result = await pool.query('SELECT * FROM assets ORDER BY id');
  return result.rows.map(toAsset);
}
/** Local audit history, seeded from data/ until the first write creates it. */
async function localAudit() {
  try { return await localRead(auditFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return localRead(seedAudit);
  }
}
async function audit() {
  if (!pool) return localAudit();
  const result = await pool.query('SELECT id, action, detail, source, created_at FROM audit_events ORDER BY created_at DESC LIMIT 500');
  // Both backends expose the same record shape, so the console never has to
  // know which one answered.
  return result.rows.map(({ created_at, ...row }) => ({ ...row, at: created_at.toISOString() }));
}
async function appendAudit(entry) {
  if (!pool) {
    return serializeWrite(async () => {
      const entries = await localAudit();
      entries.unshift(entry);
      await atomicWrite(auditFile, entries.slice(0, 500));
      return entry;
    });
  }
  await pool.query('INSERT INTO audit_events(id, action, detail, source) VALUES ($1, $2, $3, $4)', [entry.id, entry.action, entry.detail, entry.source]);
  return entry;
}
async function health() {
  if (!pool) return { persistence: 'local-demo' };
  await pool.query('SELECT 1'); return { persistence: 'postgresql' };
}
async function telemetry(dataset = 'synthetic-v1') {
  // Demo records are generated separately and never mixed into imported telemetry.
  if (dataset === 'synthetic-v1') return demoTelemetry(await assets());
  if (!pool) return (await runtime()).telemetry;
  const result = await pool.query('SELECT asset_id AS "assetId", observed_at, health, vibration, temperature, label, source FROM telemetry ORDER BY observed_at DESC LIMIT 10000');
  return result.rows.map(({ observed_at, ...row }) => ({ ...row, timestamp: observed_at.toISOString() }));
}

async function ingest(records) {
  if (!pool) return serializeWrite(async () => {
    const state = await runtime();
    const keys = new Set(state.telemetry.map(row => `${row.assetId}/${row.timestamp}`));
    const fresh = records.filter(row => !keys.has(`${row.assetId}/${row.timestamp}`));
    const combined = [...state.telemetry, ...fresh].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const evicted = Math.max(0, combined.length - 10000);
    state.telemetry = combined.slice(-10000);
    await atomicWrite(runtimeFile, state);
    return { accepted: fresh.length, duplicates: records.length - fresh.length, evicted, retained: state.telemetry.length };
  });
  const client = await pool.connect();
  let accepted = 0;
  try {
    await client.query('BEGIN');
    for (const row of records) {
      const result = await client.query('INSERT INTO telemetry(asset_id, observed_at, health, vibration, temperature, label, source) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [row.assetId, row.timestamp, row.health, row.vibration, row.temperature, row.label, row.source]);
      accepted += result.rowCount;
    }
    await client.query('COMMIT');
    return { accepted, duplicates: records.length - accepted, evicted: 0 };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function modelRuns() {
  if (!pool) return (await runtime()).runs;
  const result = await pool.query('SELECT result FROM model_runs ORDER BY created_at DESC LIMIT 50');
  return result.rows.map(row => row.result);
}

async function saveRun(run) {
  if (!pool) return serializeWrite(async () => {
    const state = await runtime();
    state.runs = [run, ...state.runs].slice(0, 50);
    await atomicWrite(runtimeFile, state);
    return run;
  });
  await pool.query('INSERT INTO model_runs(id, result) VALUES ($1,$2)', [run.id, run]);
  return run;
}

/**
 * Collected public-context snapshots, one row per source and scope. The
 * collector writes them on a schedule; the console reads the latest without
 * putting a federal API in the path of an operator's click.
 */
async function saveContext(snapshot) {
  const key = `${snapshot.source}:${snapshot.scope}`;
  if (!pool) {
    return serializeWrite(async () => {
      const state = await runtime();
      state.context = { ...(state.context || {}), [key]: snapshot };
      await atomicWrite(runtimeFile, state);
      return snapshot;
    });
  }
  await pool.query(
    `INSERT INTO context_snapshots(source, scope, collected_at, payload) VALUES ($1,$2,$3,$4)
     ON CONFLICT (source, scope) DO UPDATE SET collected_at = EXCLUDED.collected_at, payload = EXCLUDED.payload`,
    [snapshot.source, snapshot.scope, snapshot.fetchedAt, snapshot],
  );
  return snapshot;
}

async function contextCache() {
  if (!pool) return Object.values((await runtime()).context || {});
  const result = await pool.query('SELECT payload FROM context_snapshots ORDER BY collected_at DESC LIMIT 100');
  return result.rows.map(row => row.payload);
}

async function close() { if (pool) await pool.end(); }
module.exports = {
  assets, audit, appendAudit, health, telemetry, ingest, modelRuns, saveRun,
  saveContext, contextCache, close, production: Boolean(pool),
};
