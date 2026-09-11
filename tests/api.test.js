const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let server, base, directory;
const token = 'test-only-platform-token-32-characters';
async function request(endpoint, body, authenticated = true) {
  return fetch(base + endpoint, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(authenticated ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-api-test-'));
  process.env.FORGE_DATA_DIR = directory;
  process.env.FORGE_API_TOKEN = token;
  process.env.DATABASE_URL = '';
  process.env.AI_PROVIDER = 'disabled';
  process.env.NODE_ENV = 'test';
  // Public context is switched off so no test reaches a federal API, which
  // also lets the context limiter be exercised without any outbound request.
  process.env.PUBLIC_CONTEXT_ENABLED = 'false';
  process.env.FORGE_WRITE_LIMIT = '500';
  process.env.FORGE_CONTEXT_LIMIT = '3';
  ({ server } = require('../server'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(resolve => server.close(resolve));
  const resolved = await fs.realpath(directory);
  const tempRoot = await fs.realpath(os.tmpdir());
  assert.equal(path.dirname(resolved), tempRoot);
  assert.ok(path.basename(resolved).startsWith('forge-api-test-'));
  await fs.rm(resolved, { recursive: true });
});

test('health is public; platform APIs require the configured token', async () => {
  assert.equal((await request('/api/health', undefined, false)).status, 200);
  assert.equal((await request('/api/models', undefined, false)).status, 401);
  assert.equal((await request('/api/platform')).status, 200);
});

test('static routes cannot expose internal files or encoded traversal', async () => {
  for (const url of ['/server.js', '/database.js', '/.env', '/package-lock.json', '/data/assets.json', '/lib/bedrock.js', '/infra/aws/runtime.json', '/%2e%2e%5c.env']) {
    assert.equal((await request(url, undefined, false)).status, 404, url);
  }
  for (const url of ['/', '/workspaces.js', '/assets/forge-banner.svg']) assert.equal((await request(url, undefined, false)).status, 200, url);
  assert.equal((await request('/api/unknown')).status, 404);
});

test('telemetry ingestion validates atomically and handles concurrent retries', async () => {
  const row = { assetId: 'VX-204', timestamp: '2026-03-01T00:00:00Z', health: 75, vibration: 40, temperature: 60 };
  assert.equal((await request('/api/telemetry', { records: [row, { ...row, assetId: 'unknown' }] })).status, 400);
  assert.equal((await (await request('/api/telemetry?dataset=ingested')).json()).count, 0);
  const responses = await Promise.all(Array.from({ length: 5 }, () => request('/api/telemetry', { records: [row] })));
  const results = await Promise.all(responses.map(response => response.json()));
  assert.equal(results.reduce((sum, item) => sum + item.accepted, 0), 1);
  assert.equal(results.reduce((sum, item) => sum + item.duplicates, 0), 4);
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'intelligence.json'), 'utf8'));
  assert.equal(persisted.telemetry.length, 1);
  const demo = await (await request('/api/telemetry')).json();
  assert.equal(demo.count, 288);
  assert.equal((await request('/api/telemetry', '{invalid')).status, 400);
  assert.equal((await request('/api/telemetry', 'x'.repeat(70000))).status, 413);
});

test('analytics handles invalid queries and empty series', async () => {
  const stats = await (await request('/api/analytics?assetId=VX-204')).json();
  assert.equal(stats.summary.count, 48);
  assert.equal(stats.synthetic, true);
  const empty = await (await request('/api/analytics?assetId=GX-019&dataset=ingested')).json();
  assert.equal(empty.summary.mean, null);
  assert.equal((await request('/api/analytics?metric=unknown')).status, 400);
  assert.equal((await request('/api/analytics?assetId=unknown')).status, 404);
  assert.equal((await request('/api/analytics?dataset=unknown')).status, 400);
});

test('experiment metadata survives reload and Bedrock remains disabled', async () => {
  const response = await request('/api/models/evaluate', { modelId: 'robust-mad-v1' });
  assert.equal(response.status, 201);
  const run = await response.json();
  const models = await (await request('/api/models')).json();
  assert.equal(models.runs[0].id, run.id);
  assert.equal(models.runs[0].datasetHash.length, 64);
  assert.equal(models.bedrock.enabled, false);
  assert.equal((await request('/api/ai/explain', { question: 'Analise o ativo', assetId: 'VX-204' })).status, 503);
  assert.equal((await request('/api/models/evaluate', { modelId: 'zscore-v1', dataset: 'ingested' })).status, 422);
});

test('the command centre is derived from stored data, never from literals', async () => {
  const response = await request('/api/overview');
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.dataset, 'synthetic-v1');
  assert.equal(data.total, 6);
  assert.equal(data.coverage.completeness, 100);
  assert.equal(data.trend.length, 24);
  assert.equal(data.assets.length, 6);
  assert.ok(data.signals.length > 0);
  assert.equal(data.bands.critical + data.bands.attention + data.bands.stable, data.total);
  assert.ok(data.method.risk.includes('0,50'), 'the method travels with the numbers');

  // Every asset carries the arithmetic that produced its score.
  for (const asset of data.assets) {
    const sum = asset.contributions.reduce((total, term) => total + term.points, 0);
    assert.equal(asset.risk, Math.round(sum), asset.id);
    assert.equal(asset.stale, false);
  }

  // The ingested dataset holds the single row the ingestion test accepted, so
  // coverage reports genuine sparsity instead of rounding up to a full window.
  const ingested = await (await request('/api/overview?dataset=ingested')).json();
  assert.equal(ingested.coverage.reporting, 1);
  assert.equal(ingested.coverage.completeness, 16.7);
  assert.equal(ingested.trend.length, 1);
  assert.deepEqual(ingested.stale, data.assets.map(asset => asset.id), 'a months-old sample is stale for every asset');
  assert.equal((await request('/api/overview?dataset=unknown')).status, 400);
});

test('decisions are validated, explained and recorded before they are returned', async () => {
  const before = (await (await request('/api/audit')).json()).length;

  const scenario = await request('/api/decisions/scenario', { assetId: 'AR-081', load: 90, horizonHours: 72 });
  assert.equal(scenario.status, 201);
  const projection = await scenario.json();
  assert.equal(projection.projectedRisk, Math.round(projection.terms.reduce((sum, term) => sum + term.points, 0)));

  const outage = await request('/api/decisions/outage', { assetId: 'AR-081', hours: 24 });
  assert.equal(outage.status, 201);
  const impact = await outage.json();
  assert.equal(impact.delta, Math.round((impact.baselineReadiness - impact.projectedReadiness) * 10) / 10);

  const review = await request('/api/decisions/review', { assetId: 'AR-081', changeType: 'load', description: 'Elevar teto' });
  assert.equal(review.status, 201);
  assert.equal((await review.json()).verdict, 'blocked');

  const entries = await (await request('/api/audit')).json();
  assert.equal(entries.length, before + 3, 'each decision leaves exactly one record');
  assert.ok(entries.slice(0, 3).every(entry => entry.detail.includes('AR-081') && entry.source === 'console'));
  assert.ok(entries.every(entry => entry.id && entry.action && Date.parse(entry.at)));

  // Unknown assets, unknown change classes and out-of-range inputs are refused.
  assert.equal((await request('/api/decisions/scenario', { assetId: 'nope', load: 50, horizonHours: 24 })).status, 404);
  assert.equal((await request('/api/decisions/outage', { assetId: 'nope', hours: 24 })).status, 404);
  assert.equal((await request('/api/decisions/scenario', { assetId: 'AR-081', load: 900, horizonHours: 24 })).status, 400);
  assert.equal((await request('/api/decisions/outage', { assetId: 'AR-081', hours: 0 })).status, 400);
  assert.equal((await request('/api/decisions/review', { assetId: 'AR-081', changeType: 'sabotage', description: '' })).status, 400);
  assert.equal((await request('/api/decisions/review', { assetId: 'AR-081', changeType: 'load', description: 'x'.repeat(300) })).status, 400);
  assert.equal((await (await request('/api/audit')).json()).length, before + 3, 'a refused decision records nothing');
});

test('the audit trail is written to the runtime directory, never to the repository seed', async () => {
  const persisted = JSON.parse(await fs.readFile(path.join(directory, 'audit.json'), 'utf8'));
  assert.ok(persisted.length >= 3);
  const seed = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'data', 'audit.json'), 'utf8'));
  assert.deepEqual(seed, [], 'the shipped seed stays untouched by a test run');

  assert.equal((await request('/api/audit', { action: 'Nota', detail: 'registro manual' })).status, 201);
  assert.equal((await request('/api/audit', { action: '', detail: 'sem ação' })).status, 400);
  assert.equal((await request('/api/audit', { action: 'x'.repeat(81), detail: '' })).status, 400);
  assert.equal((await request('/api/audit', { action: 'Nota', detail: 'x'.repeat(501) })).status, 400);
});

test('public context is allow-listed, switchable and rate limited', async () => {
  const catalogue = await (await request('/api/context')).json();
  assert.equal(catalogue.enabled, false);
  assert.deepEqual(catalogue.providers.map(provider => provider.id).sort(), ['airfield', 'disasters', 'earthquakes', 'weather']);

  // PUBLIC_CONTEXT_ENABLED=false short-circuits before any outbound request,
  // so these calls exercise the limiter without touching a federal API.
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await request('/api/context/weather?area=CA')).status, 503, `attempt ${attempt}`);
  }
  const throttled = await request('/api/context/weather?area=CA');
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get('retry-after')) > 0);
});

test('every response carries the same security headers', async () => {
  for (const url of ['/', '/api/health', '/api/overview', '/api/unknown']) {
    const response = await request(url);
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/, url);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, url);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', url);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', url);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', url);
  }
  // The console loads only its own scripts; styles allow the sizing attributes.
  const policy = (await request('/')).headers.get('content-security-policy');
  assert.match(policy, /script-src 'self'/);
  assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"), 'inline scripts stay forbidden');
});
