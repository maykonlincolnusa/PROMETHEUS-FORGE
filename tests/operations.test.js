const { test } = require('node:test');
const assert = require('node:assert/strict');
const operations = require('../lib/operations');
const { demoTelemetry } = require('../lib/intelligence');
const inventory = require('../data/assets.json');

const asset = (id, overrides = {}) => ({
  id, name: `Ativo ${id}`, type: 'Energia', state: 'TX',
  health: 80, vibration: 40, temperature: 40, hours: 100, criticality: 50, ...overrides,
});

test('risk is reconstructible by hand and bands split at 45 and 70', () => {
  const critical = asset('AR', { health: 44, vibration: 86, temperature: 79, criticality: 96 });
  // 0,50·56 + 0,20·86 + 0,15·79 + 0,15·96 = 28 + 17,2 + 11,85 + 14,4 = 71,45
  assert.equal(operations.riskScore(critical), 71);
  assert.equal(operations.bandOf(operations.riskScore(critical)).id, 'critical');

  const terms = operations.riskContributions(critical);
  assert.equal(terms.length, 4);
  assert.equal(terms.reduce((sum, term) => sum + term.weight, 0), 1);
  assert.ok(Math.abs(terms.reduce((sum, term) => sum + term.points, 0) - 71.45) < 1e-9);

  assert.equal(operations.bandOf(70).id, 'critical');
  assert.equal(operations.bandOf(69.9).id, 'attention');
  assert.equal(operations.bandOf(45).id, 'attention');
  assert.equal(operations.bandOf(44.9).id, 'stable');
  assert.equal(operations.bandOf(0).id, 'stable');

  // A pristine asset scores only its criticality term; a spent one saturates.
  assert.equal(operations.riskScore(asset('ok', { health: 100, vibration: 0, temperature: 0, criticality: 0 })), 0);
  assert.equal(operations.riskScore(asset('bad', { health: 0, vibration: 100, temperature: 100, criticality: 100 })), 100);
});

test('readiness is weighted by criticality and zeroes unavailable assets', () => {
  const fleet = [asset('A', { health: 80, criticality: 50 }), asset('B', { health: 40, criticality: 100 })];
  // (80·50 + 40·100) ÷ 150 = 53,33
  assert.equal(operations.readiness(fleet), 53.3);
  // Both assets deliver 4000 capability-points here, so losing either costs the
  // same: the index measures delivered capability, not headline criticality.
  assert.equal(operations.readiness(fleet, new Set(['A'])), 26.7);
  assert.equal(operations.readiness(fleet, new Set(['B'])), 26.7);
  assert.equal(operations.readiness([]), null);

  const uneven = [asset('A', { health: 80, criticality: 50 }), asset('B', { health: 60, criticality: 100 })];
  const exposure = operations.singlePointsOfFailure(uneven);
  assert.equal(exposure[0].assetId, 'B', 'ranked by the capability actually lost');
  assert.equal(exposure[0].delta, 40);
  assert.equal(exposure[1].delta, 26.7);
  // A (health 80) can stand in for B; B (health 60) is below the threshold.
  assert.equal(exposure[0].hasSubstitute, true);
  assert.equal(exposure[1].hasSubstitute, false);
});

test('coverage and freshness come from the observed telemetry window', () => {
  const fleet = [asset('A'), asset('B')];
  const at = hour => new Date(Date.UTC(2026, 0, 1, hour)).toISOString();
  const rows = [
    { assetId: 'A', timestamp: at(0), health: 80, vibration: 40, temperature: 40 },
    { assetId: 'A', timestamp: at(1), health: 80, vibration: 40, temperature: 40 },
    { assetId: 'A', timestamp: at(2), health: 80, vibration: 40, temperature: 40 },
    { assetId: 'B', timestamp: at(2), health: 40, vibration: 40, temperature: 40 },
  ];
  const coverage = operations.coverage(fleet, rows);
  assert.deepEqual(
    { completeness: coverage.completeness, expected: coverage.expected, observed: coverage.observed, windowHours: coverage.windowHours },
    { completeness: 66.7, expected: 6, observed: 4, windowHours: 3 },
  );
  assert.equal(operations.coverage(fleet, []).completeness, null);
  assert.equal(operations.coverage([], rows).completeness, null);

  // Repeated samples in one hour do not inflate coverage beyond 100%.
  const duplicated = [...rows, { assetId: 'B', timestamp: at(2), health: 41, vibration: 40, temperature: 40 }];
  assert.ok(operations.coverage(fleet, duplicated).completeness <= 100);

  const now = Date.parse(at(2));
  const enriched = operations.enrich(fleet, rows, now + 6 * 3600000);
  assert.equal(enriched[0].lastSeen, at(2));
  assert.equal(enriched[0].ageHours, 6);
  assert.equal(enriched[0].stale, true, 'six hours exceeds the three-hour freshness limit');
  assert.equal(operations.enrich(fleet, [], now)[0].stale, true, 'no telemetry at all is stale');

  const trend = operations.readinessTrend(fleet, rows);
  assert.equal(trend.length, 3);
  assert.deepEqual(trend.map(point => point.timestamp), [at(0), at(1), at(2)]);
  // Only assets present in a bucket count, in numerator and denominator alike.
  assert.equal(trend[0].readiness, 80);
  assert.equal(trend.at(-1).readiness, 60);
});

test('load projection sums its published terms and rejects impossible inputs', () => {
  const subject = asset('VX', { health: 50, vibration: 60, temperature: 60, criticality: 80 });
  const result = operations.projectLoad(subject, { load: 90, horizonHours: 72 });
  const total = result.terms.reduce((sum, term) => sum + term.points, 0);
  assert.equal(result.projectedRisk, Math.round(total), 'the displayed terms must add up to the headline');
  assert.ok(result.projectedRisk > result.baseRisk, 'load above nominal must raise risk');

  // Below the nominal load the projection can fall back towards the baseline.
  assert.ok(operations.projectLoad(subject, { load: 20, horizonHours: 24 }).terms[1].points < 0);
  assert.equal(operations.projectLoad(subject, { load: 50, horizonHours: 24 }).terms[1].points, 0);

  for (const input of [{ load: -1, horizonHours: 24 }, { load: 101, horizonHours: 24 }, { load: NaN, horizonHours: 24 },
    { load: 50, horizonHours: 0 }, { load: 50, horizonHours: 721 }, { load: 50, horizonHours: 'x' }]) {
    assert.throws(() => operations.projectLoad(subject, input), { status: 400 });
  }
  assert.ok(operations.projectLoad(asset('X', { health: 0, criticality: 100, vibration: 100, temperature: 100 }),
    { load: 100, horizonHours: 720 }).projectedRisk <= 100, 'risk stays bounded at 100');
});

test('outage impact reports the readiness cost and any like-for-like reserve', () => {
  const fleet = [
    asset('A', { type: 'Energia', health: 90, criticality: 60 }),
    asset('B', { type: 'Energia', health: 95, criticality: 40 }),
    asset('C', { type: 'Plataforma aérea', health: 50, criticality: 100 }),
  ];
  const power = operations.outageImpact(fleet, 'A', 12);
  // The cost of an outage is exactly the capability the asset was delivering:
  // (90 · 60) ÷ 200 = 27 points of the fleet readiness index.
  assert.equal(power.delta, 27);
  assert.deepEqual(power.substitutes.map(item => item.id), ['B'], 'same type and above the readiness threshold');

  const aerial = operations.outageImpact(fleet, 'C', 24);
  assert.deepEqual(aerial.substitutes, []);
  assert.match(aerial.mitigation, /ponto único de falha/);
  // A degraded asset costs less to lose than a healthy one, even at higher
  // criticality, because half a capability was only ever delivering half.
  assert.equal(aerial.delta, 25);
  assert.ok(aerial.share > power.share, 'while still holding the larger share of required capability');

  assert.throws(() => operations.outageImpact(fleet, 'unknown', 12), { status: 404 });
  assert.throws(() => operations.outageImpact(fleet, 'A', 0), { status: 400 });
  assert.throws(() => operations.outageImpact(fleet, 'A', 721), { status: 400 });
});

test('change screening routes by class weight and current risk band', () => {
  const stable = asset('S', { health: 95, vibration: 10, temperature: 10, criticality: 20 });
  const attention = asset('M', { health: 70, vibration: 60, temperature: 55, criticality: 70 });
  const critical = asset('C', { health: 20, vibration: 95, temperature: 90, criticality: 95 });
  assert.equal(operations.bandOf(operations.riskScore(stable)).id, 'stable');
  assert.equal(operations.bandOf(operations.riskScore(attention)).id, 'attention');
  assert.equal(operations.bandOf(operations.riskScore(critical)).id, 'critical');

  const verdict = (subject, changeType) => operations.screenChange(subject, { changeType, description: 'teste' }).verdict;
  assert.equal(verdict(stable, 'configuration'), 'acceptable');
  assert.equal(verdict(stable, 'load'), 'controlled');
  assert.equal(verdict(attention, 'component'), 'controlled');
  assert.equal(verdict(attention, 'load'), 'blocked');
  assert.equal(verdict(critical, 'configuration'), 'controlled');
  assert.equal(verdict(critical, 'load'), 'blocked');

  const screened = operations.screenChange(critical, { changeType: 'load', description: '  aumento de teto  ' });
  assert.equal(screened.description, 'aumento de teto');
  assert.equal(screened.checks.filter(check => check.status === 'fail').length, 1);
  assert.match(screened.limitation, /nem constitui autorização/);

  assert.throws(() => operations.screenChange(stable, { changeType: 'unknown', description: '' }), { status: 400 });
  assert.throws(() => operations.screenChange(stable, { changeType: 'load', description: 'x'.repeat(281) }), { status: 400 });
  assert.throws(() => operations.screenChange(stable, { changeType: 'load', description: 42 }), { status: 400 });
});

test('overview derives every command-centre figure from the demo inventory', () => {
  const telemetry = demoTelemetry(inventory);
  const data = operations.overview(inventory, telemetry);

  assert.equal(data.total, inventory.length);
  assert.equal(data.bands.critical + data.bands.attention + data.bands.stable, inventory.length);
  assert.ok(data.bands.critical >= 1 && data.bands.stable >= 1, 'the demo fleet exercises more than one band');
  assert.equal(data.backlog.total, data.bands.critical + data.bands.attention);
  assert.equal(data.backlog.urgent, data.bands.critical);
  assert.equal(data.capable, inventory.filter(item => item.health >= operations.readinessThreshold).length);
  assert.equal(data.coverage.completeness, 100);
  assert.equal(data.coverage.reporting, inventory.length);
  assert.deepEqual(data.stale, [], 'the rolling demo window is always fresh');
  assert.equal(data.trend.length, 24);
  assert.ok(data.signals.length > 0, 'the synthetic anomalies are detectable');
  assert.ok(data.signals.every(signal => signal.deviations >= 3.5));
  assert.equal(data.worstCaseDrop, data.exposure[0].delta);
  assert.ok(data.assets.every(item => item.risk === operations.riskScore(item)));
});

test('the demo telemetry window rolls with the clock and snaps to the hour', () => {
  const now = Date.UTC(2026, 5, 1, 12, 34, 56);
  const rows = demoTelemetry(inventory, now);
  const last = rows.map(row => row.timestamp).sort().at(-1);
  assert.equal(last, new Date(Date.UTC(2026, 5, 1, 12)).toISOString());
  assert.deepEqual(demoTelemetry(inventory, now + 60000), rows, 'stable within the same hour');
  assert.notDeepEqual(demoTelemetry(inventory, now + 3600000), rows, 'advances with the next hour');
});
