const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describe, quantile, correlation, trend } = require('../lib/statistics');
const { demoTelemetry, validateBatch, evaluate } = require('../lib/intelligence');
const assets = require('../data/assets.json');

test('statistics handles empty, singleton, constant and known distributions', () => {
  assert.equal(describe([]).mean, null);
  assert.equal(describe([5]).stddev, null);
  assert.equal(describe([5, 5, 5]).stddev, 0);
  assert.deepEqual(describe([1, 2, 3, 4, 5]), { count: 5, mean: 3, median: 3, stddev: Math.sqrt(2.5), min: 1, max: 5, p95: 4.8 });
  assert.equal(quantile([5, 1, 3, 2], .5), 2.5);
  assert.equal(correlation([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(correlation([1, 1, 1], [2, 3, 4]), null);
});

test('trend accounts for irregular time intervals', () => {
  const rows = [0, 2, 5].map(hour => ({ timestamp: new Date(Date.UTC(2026, 0, 1, hour)).toISOString(), health: 10 + hour * 3 }));
  assert.ok(Math.abs(trend(rows, 'health') - 3) < 1e-12);
});

test('ingestion rejects invalid values, unknown assets, impossible dates and duplicates', () => {
  const row = { assetId: assets[0].id, timestamp: '2026-01-01T00:00:00Z', health: 70, temperature: 45, vibration: 20 };
  assert.equal(validateBatch({ records: [row] }, assets)[0].label, null);
  for (const changes of [{ health: '70' }, { temperature: 101 }, { vibration: NaN }, { assetId: 'unknown' }, { timestamp: '2026-02-30T00:00:00Z' }, { label: 'false' }]) {
    assert.throws(() => validateBatch({ records: [{ ...row, ...changes }] }, assets), { status: 400 });
  }
  assert.throws(() => validateBatch({ records: [row, row] }, assets), /duplicata/);
  assert.throws(() => validateBatch({ records: Array(101).fill(row) }, assets), /100/);
  assert.throws(() => validateBatch(null, assets), /records/);
});

test('evaluation is reproducible and test data cannot change training baselines', () => {
  const rows = demoTelemetry(assets);
  const first = evaluate(rows, 'robust-mad-v1');
  const reordered = evaluate([...rows].reverse(), 'robust-mad-v1');
  assert.deepEqual(first, reordered);
  assert.equal(first.trainCount, 192);
  assert.equal(first.testCount, 96);
  // Corrupting every sample from the split onwards must leave the fitted
  // baselines untouched: only the training window may inform them.
  const testStart = first.baselines[0].testStart;
  const changed = rows.map(row => row.timestamp >= testStart ? { ...row, health: 0, label: !row.label } : row);
  const second = evaluate(changed, 'robust-mad-v1');
  assert.deepEqual(first.baselines, second.baselines);
  assert.notEqual(first.datasetHash, second.datasetHash);
  assert.ok(first.baselines.every(baseline => baseline.trainEnd < baseline.testStart));
});

test('evaluation confusion matrix and undefined denominators are explicit', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ assetId: 'unit', timestamp: new Date(Date.UTC(2026, 0, 1, i)).toISOString(), health: 50, temperature: 50, vibration: i >= 10 ? 80 : 50, label: i % 2 === 0, source: 'ingested' }));
  for (const model of ['robust-mad-v1', 'zscore-v1']) {
    const run = evaluate(rows, model);
    assert.deepEqual(run.matrix, { tp: 1, fp: 1, tn: 1, fn: 1 });
    assert.equal(run.f1, .5);
    const constant = evaluate(rows.map(row => ({ ...row, vibration: 50, label: false })), model);
    assert.equal(constant.precision, null);
    assert.equal(constant.recall, null);
  }
  assert.throws(() => evaluate(rows.map(row => ({ ...row, label: null })), 'zscore-v1'), { status: 422 });
  assert.throws(() => evaluate(rows, 'unknown'), { status: 400 });
});
