const { createHash } = require('node:crypto');
const { mean, quantile, describe, correlation, trend } = require('./statistics');

const metrics = ['health', 'vibration', 'temperature'];
const modelDefinitions = [
  { id: 'robust-mad-v1', name: 'Robust MAD', version: '1.0.0', threshold: 3.5, kind: 'Desvio absoluto mediano', description: 'Baseline por ativo, ajustado apenas na janela de treino. Sinaliza desvios em qualquer uma das três métricas.' },
  { id: 'zscore-v1', name: 'Z-score', version: '1.0.0', threshold: 3, kind: 'Média e desvio padrão', description: 'Baseline estatístico por ativo para comparar sensibilidade a extremos.' },
];

const demoWindowHours = 48;

/**
 * A rolling 48-hour window ending at the most recent whole hour, so telemetry
 * freshness and coverage on the console are real rather than decorative. The
 * window snaps to the hour, which keeps a dataset hash stable within that hour.
 */
function demoTelemetry(assets, now = Date.now()) {
  const start = Math.floor(now / 3600000) * 3600000 - (demoWindowHours - 1) * 3600000;
  return assets.flatMap((asset, index) => Array.from({ length: demoWindowHours }, (_, hour) => {
    const anomaly = hour >= 32 && (hour + index * 3) % 11 === 0;
    const wave = Math.sin(hour * 1.7 + index) * 2 + Math.cos(hour * .8) * 1.3;
    const clamp = value => Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
    return {
      assetId: asset.id, timestamp: new Date(start + hour * 3600000).toISOString(),
      health: clamp(asset.health + wave - (anomaly ? 16 : 0)),
      vibration: clamp(asset.vibration + wave * 1.4 + (anomaly ? 15 : 0)),
      temperature: clamp(asset.temperature + Math.cos(hour + index) * 2 + (anomaly ? 14 : 0)),
      label: anomaly, source: 'synthetic-v1',
    };
  }));
}

function validateBatch(input, assets) {
  if (!input || !Array.isArray(input.records) || input.records.length < 1 || input.records.length > 100) {
    throw Object.assign(new Error('Envie entre 1 e 100 registros em records.'), { status: 400 });
  }
  const known = new Set(assets.map(asset => asset.id));
  const keys = new Set();
  return input.records.map((row, index) => {
    const fail = message => { throw Object.assign(new Error(`Registro ${index + 1}: ${message}`), { status: 400 }); };
    if (!row || !known.has(row.assetId)) fail('ativo desconhecido.');
    if (typeof row.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(row.timestamp) || !Number.isFinite(Date.parse(row.timestamp))) fail('timestamp UTC inválido.');
    const timestamp = new Date(row.timestamp).toISOString();
    if (timestamp.slice(0, 19) !== row.timestamp.slice(0, 19)) fail('data de calendário inválida.');
    if (Date.parse(timestamp) > Date.now() + 300000) fail('timestamp mais de cinco minutos no futuro.');
    for (const metric of metrics) if (typeof row[metric] !== 'number' || !Number.isFinite(row[metric]) || row[metric] < 0 || row[metric] > 100) fail(`${metric} deve estar entre 0 e 100.`);
    if (row.label !== undefined && row.label !== null && typeof row.label !== 'boolean') fail('label deve ser booleano ou null.');
    const key = `${row.assetId}/${timestamp}`;
    if (keys.has(key)) fail('duplicata dentro do lote.');
    keys.add(key);
    return { assetId: row.assetId, timestamp, ...Object.fromEntries(metrics.map(metric => [metric, row[metric]])), label: row.label ?? null, source: 'ingested' };
  });
}

function fit(rows, definition) {
  return Object.fromEntries(metrics.map(metric => {
    const values = rows.map(row => row[metric]);
    const center = definition.id === 'robust-mad-v1' ? quantile(values, .5) : mean(values);
    const scale = definition.id === 'robust-mad-v1'
      ? quantile(values.map(value => Math.abs(value - center)), .5) * 1.4826
      : describe(values).stddev;
    // One percentage point is the documented minimum noise floor.
    return [metric, { center, scale: Math.max(1, scale || 0) }];
  }));
}

function score(row, baseline) {
  return Math.max(...metrics.map(metric => Math.abs(row[metric] - baseline[metric].center) / baseline[metric].scale));
}

function evaluate(rows, modelId) {
  const definition = modelDefinitions.find(model => model.id === modelId);
  if (!definition) throw Object.assign(new Error('Modelo inválido.'), { status: 400 });
  const matrix = { tp: 0, fp: 0, tn: 0, fn: 0 };
  let trainCount = 0, testCount = 0, skippedLabels = 0;
  const baselines = [];
  for (const assetId of [...new Set(rows.map(row => row.assetId))].sort()) {
    const series = rows.filter(row => row.assetId === assetId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (series.length < 10) continue;
    const split = Math.floor(series.length * 2 / 3);
    const train = series.slice(0, split), test = series.slice(split);
    const baseline = fit(train, definition);
    baselines.push({ assetId, trainEnd: train.at(-1).timestamp, testStart: test[0].timestamp, baseline });
    trainCount += train.length;
    for (const row of test) {
      if (typeof row.label !== 'boolean') { skippedLabels++; continue; }
      const predicted = score(row, baseline) >= definition.threshold;
      matrix[predicted ? (row.label ? 'tp' : 'fp') : (row.label ? 'fn' : 'tn')]++;
      testCount++;
    }
  }
  if (!testCount) throw Object.assign(new Error('Avaliação exige pelo menos 10 amostras por ativo e rótulos na janela de teste.'), { status: 422 });
  const { tp, fp, tn, fn } = matrix;
  const sorted = [...rows].sort((a, b) => a.assetId.localeCompare(b.assetId) || a.timestamp.localeCompare(b.timestamp));
  return {
    modelId, modelVersion: definition.version, threshold: definition.threshold,
    datasetHash: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
    split: 'chronological-2/3-per-asset', trainCount, testCount, skippedLabels, matrix,
    precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null,
    f1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : null,
    accuracy: (tp + tn) / testCount, baselines,
    synthetic: rows.some(row => row.source === 'synthetic-v1'),
    limitation: 'Benchmark exploratório. Rótulos sintéticos não demonstram desempenho em produção. Não há promoção automática de modelos.',
  };
}

function analytics(rows, assetId, metric) {
  if (!metrics.includes(metric)) throw Object.assign(new Error('Métrica inválida.'), { status: 400 });
  const series = rows.filter(row => row.assetId === assetId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const baseline = series.length >= 10 ? fit(series.slice(0, Math.floor(series.length * 2 / 3)), modelDefinitions[0]) : null;
  return {
    assetId, metric, summary: describe(series.map(row => row[metric])), slopePerHour: trend(series, metric),
    correlation: correlation(series.map(row => row.vibration), series.map(row => row.temperature)),
    series: series.map(row => ({ ...row, anomaly: baseline ? score(row, baseline) >= 3.5 : null })),
    synthetic: series.some(row => row.source === 'synthetic-v1'),
  };
}

module.exports = { metrics, modelDefinitions, demoWindowHours, demoTelemetry, validateBatch, fit, score, evaluate, analytics };
