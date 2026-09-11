/**
 * Shared operational decision model.
 *
 * Every asset number the console shows is produced here, so the browser, the
 * API and the tests agree on a single definition. Weights are explicit and
 * bounded on purpose: a reviewer must be able to reconstruct any score by hand
 * from the asset record alone. Nothing in this module is a calibrated forecast.
 */
const { fit, score } = require('./intelligence');

// Risk weights sum to 1 and each input is on a 0-100 scale, so risk is 0-100.
const riskWeights = Object.freeze({ degradation: 0.5, vibration: 0.2, temperature: 0.15, criticality: 0.15 });
const bands = Object.freeze([
  Object.freeze({ id: 'critical', min: 70, label: 'CRÍTICO', tone: 'high' }),
  Object.freeze({ id: 'attention', min: 45, label: 'ATENÇÃO', tone: 'medium' }),
  Object.freeze({ id: 'stable', min: 0, label: 'ESTÁVEL', tone: 'low' }),
]);
const readinessThreshold = 70; // Health at or above this counts as mission-capable.
const freshnessLimitHours = 3; // Telemetry older than this marks an asset as stale.
const nominalLoad = 50;        // Load percentage the risk baseline already assumes.
const loadSensitivity = 14;    // Risk points added when load doubles the nominal.
const wearCeiling = 4;         // Maximum risk points a fully degraded asset accrues per day.
const changeClasses = Object.freeze({
  component: { weight: 2, label: 'Substituição de componente' },
  configuration: { weight: 1, label: 'Alteração de configuração' },
  load: { weight: 3, label: 'Aumento de carga operacional' },
});

const clamp = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value));
const round = (value, digits = 0) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** The four terms behind a risk score, so the console can show the arithmetic. */
function riskContributions(asset) {
  return [
    { factor: 'degradation', label: 'Degradação (100 − saúde)', input: 100 - asset.health, weight: riskWeights.degradation },
    { factor: 'vibration', label: 'Vibração', input: asset.vibration, weight: riskWeights.vibration },
    { factor: 'temperature', label: 'Temperatura', input: asset.temperature, weight: riskWeights.temperature },
    { factor: 'criticality', label: 'Criticidade operacional', input: asset.criticality, weight: riskWeights.criticality },
  ].map(term => ({ ...term, points: round(term.input * term.weight, 2) }));
}

const riskScore = asset => round(riskContributions(asset).reduce((sum, term) => sum + term.points, 0));
const bandOf = value => bands.find(band => value >= band.min);

/**
 * Fleet readiness weighted by criticality: losing a critical asset must cost
 * more than losing a spare one. Unavailable assets contribute zero health while
 * still counting in the denominator, because the capability is still required.
 */
function readiness(assets, unavailable = new Set()) {
  const required = assets.reduce((sum, asset) => sum + asset.criticality, 0);
  if (!required) return null;
  const available = assets.reduce((sum, asset) => sum + (unavailable.has(asset.id) ? 0 : asset.health * asset.criticality), 0);
  return round(available / required, 1);
}

/** Assets enriched with their derived score, band and telemetry freshness. */
function enrich(assets, telemetry = [], now = Date.now()) {
  const latest = new Map();
  for (const row of telemetry) {
    const at = Date.parse(row.timestamp);
    if (Number.isFinite(at) && at > (latest.get(row.assetId) ?? -Infinity)) latest.set(row.assetId, at);
  }
  return assets.map(asset => {
    const seen = latest.get(asset.id) ?? null;
    const ageHours = seen === null ? null : round((now - seen) / 3600000, 2);
    const value = riskScore(asset);
    const band = bandOf(value);
    return {
      ...asset,
      risk: value,
      band: band.id,
      bandLabel: band.label,
      tone: band.tone,
      contributions: riskContributions(asset),
      capable: asset.health >= readinessThreshold,
      lastSeen: seen === null ? null : new Date(seen).toISOString(),
      ageHours,
      stale: ageHours === null || ageHours > freshnessLimitHours,
    };
  });
}

/**
 * Telemetry completeness over the observed window: one sample per asset per
 * hour is the contract, so coverage is observed hourly buckets over expected.
 */
function coverage(assets, telemetry) {
  const empty = { completeness: null, reporting: 0, total: assets.length, expected: 0, observed: 0, windowHours: 0 };
  if (!telemetry.length || !assets.length) return empty;
  const buckets = new Map();
  let first = Infinity;
  let last = -Infinity;
  for (const row of telemetry) {
    const at = Date.parse(row.timestamp);
    if (!Number.isFinite(at)) continue;
    first = Math.min(first, at);
    last = Math.max(last, at);
    if (!buckets.has(row.assetId)) buckets.set(row.assetId, new Set());
    buckets.get(row.assetId).add(Math.floor(at / 3600000));
  }
  if (!Number.isFinite(first)) return empty;
  const windowHours = Math.floor((last - first) / 3600000) + 1;
  const expected = windowHours * assets.length;
  const observed = assets.reduce((sum, asset) => sum + (buckets.get(asset.id)?.size ?? 0), 0);
  return {
    completeness: expected ? round(Math.min(1, observed / expected) * 100, 1) : null,
    reporting: assets.filter(asset => buckets.has(asset.id)).length,
    total: assets.length,
    expected,
    observed,
    windowHours,
  };
}

/** Criticality-weighted readiness per hourly bucket, oldest first. */
function readinessTrend(assets, telemetry, points = 24) {
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const buckets = new Map();
  for (const row of telemetry) {
    const asset = byId.get(row.assetId);
    const at = Date.parse(row.timestamp);
    if (!asset || !Number.isFinite(at)) continue;
    const hour = Math.floor(at / 3600000);
    if (!buckets.has(hour)) buckets.set(hour, { weighted: 0, required: 0 });
    const bucket = buckets.get(hour);
    bucket.weighted += row.health * asset.criticality;
    bucket.required += asset.criticality;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-points)
    .map(([hour, bucket]) => ({
      timestamp: new Date(hour * 3600000).toISOString(),
      readiness: round(bucket.weighted / bucket.required, 1),
    }));
}

/**
 * Recent multivariate deviations, found with the same robust baseline the
 * anomaly model uses. These are signals for a human to look at, not verdicts.
 */
function signals(assets, telemetry, limit = 6) {
  const found = [];
  for (const asset of assets) {
    const series = telemetry.filter(row => row.assetId === asset.id).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (series.length < 10) continue;
    const baseline = fit(series.slice(0, Math.floor(series.length * 2 / 3)), { id: 'robust-mad-v1' });
    for (const row of series) {
      const deviation = score(row, baseline);
      if (deviation < 3.5) continue;
      const metric = ['health', 'vibration', 'temperature']
        .map(name => ({ name, distance: Math.abs(row[name] - baseline[name].center) / baseline[name].scale }))
        .sort((a, b) => b.distance - a.distance)[0];
      found.push({
        assetId: asset.id,
        assetName: asset.name,
        timestamp: row.timestamp,
        metric: metric.name,
        value: round(row[metric.name], 2),
        baseline: round(baseline[metric.name].center, 2),
        deviations: round(deviation, 2),
      });
    }
  }
  return found.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}

/** Assets ranked by how much readiness the fleet loses without each of them. */
function singlePointsOfFailure(assets) {
  const baseline = readiness(assets);
  if (baseline === null) return [];
  return assets
    .map(asset => ({
      assetId: asset.id,
      assetName: asset.name,
      delta: round(baseline - readiness(assets, new Set([asset.id])), 1),
      hasSubstitute: assets.some(item => item.id !== asset.id && item.type === asset.type && item.health >= readinessThreshold),
    }))
    .sort((a, b) => b.delta - a.delta);
}

/** Everything the command centre reports, all of it derived from the inputs. */
function overview(assets, telemetry, now = Date.now()) {
  const enriched = enrich(assets, telemetry, now);
  const counts = { critical: 0, attention: 0, stable: 0 };
  for (const asset of enriched) counts[asset.band]++;
  const exposure = singlePointsOfFailure(assets);
  return {
    generatedAt: new Date(now).toISOString(),
    readiness: readiness(assets),
    meanHealth: assets.length ? round(assets.reduce((sum, asset) => sum + asset.health, 0) / assets.length, 1) : null,
    capable: enriched.filter(asset => asset.capable).length,
    total: assets.length,
    bands: counts,
    backlog: { total: counts.critical + counts.attention, urgent: counts.critical },
    coverage: coverage(assets, telemetry),
    stale: enriched.filter(asset => asset.stale).map(asset => asset.id),
    trend: readinessTrend(assets, telemetry),
    signals: signals(assets, telemetry),
    exposure: exposure.slice(0, 3),
    worstCaseDrop: exposure[0]?.delta ?? null,
    assets: enriched,
    method: {
      risk: 'risco = 0,50·(100 − saúde) + 0,20·vibração + 0,15·temperatura + 0,15·criticidade',
      readiness: 'prontidão = Σ(saúde × criticidade) ÷ Σ(criticidade)',
      coverage: 'cobertura = janelas horárias observadas ÷ janelas horárias esperadas no dataset',
    },
  };
}

/**
 * Risk projection under a sustained load. The load term reflects a level, the
 * wear term accrues with time; both are heuristics, not a failure probability.
 */
function projectLoad(asset, { load, horizonHours }) {
  if (!Number.isFinite(load) || load < 0 || load > 100) {
    throw Object.assign(new Error('Carga deve estar entre 0 e 100.'), { status: 400 });
  }
  if (!Number.isFinite(horizonHours) || horizonHours <= 0 || horizonHours > 720) {
    throw Object.assign(new Error('Horizonte deve estar entre 1 e 720 horas.'), { status: 400 });
  }
  const base = riskScore(asset);
  const days = horizonHours / 24;
  const loadTerm = round(((load - nominalLoad) / nominalLoad) * loadSensitivity, 2);
  const wearRate = round(((100 - asset.health) / 100) * wearCeiling, 2);
  const wearTerm = round(wearRate * days, 2);
  const projected = round(clamp(base + loadTerm + wearTerm));
  const band = bandOf(projected);
  return {
    assetId: asset.id,
    assetName: asset.name,
    baseRisk: base,
    load,
    horizonHours,
    terms: [
      { label: 'Risco atual do ativo', points: base },
      { label: `Carga sustentada de ${load}% sobre a nominal de ${nominalLoad}%`, points: loadTerm },
      { label: `Desgaste acumulado · ${wearRate} pts/dia × ${round(days, 2)} dia(s)`, points: wearTerm },
    ],
    projectedRisk: projected,
    band: band.id,
    bandLabel: band.label,
    limitation: 'Projeção heurística sobre o estado atual. Não é probabilidade de falha nem autorização de operação.',
  };
}

/** Readiness cost of taking one asset out of service. */
function outageImpact(assets, assetId, hours) {
  const asset = assets.find(item => item.id === assetId);
  if (!asset) throw Object.assign(new Error('Ativo não encontrado.'), { status: 404 });
  if (!Number.isFinite(hours) || hours <= 0 || hours > 720) {
    throw Object.assign(new Error('Duração deve estar entre 1 e 720 horas.'), { status: 400 });
  }
  const baseline = readiness(assets);
  const projected = readiness(assets, new Set([assetId]));
  const substitutes = assets
    .filter(item => item.id !== assetId && item.type === asset.type && item.health >= readinessThreshold)
    .sort((a, b) => b.health - a.health)
    .map(item => ({ id: item.id, name: item.name, health: item.health, risk: riskScore(item) }));
  const required = assets.reduce((sum, item) => sum + item.criticality, 0);
  return {
    assetId,
    assetName: asset.name,
    hours,
    baselineReadiness: baseline,
    projectedReadiness: projected,
    delta: round(baseline - projected, 1),
    share: required ? round((asset.criticality / required) * 100, 1) : null,
    substitutes,
    mitigation: substitutes.length
      ? `Remanejamento possível: ${substitutes.length} ativo(s) do mesmo tipo acima de ${readinessThreshold}% de saúde.`
      : 'Sem reserva equivalente no inventário; a indisponibilidade é um ponto único de falha.',
    limitation: 'Modelo de capacidade agregada. Não considera logística, pessoal, peças de reposição nem janelas contratuais.',
  };
}

/**
 * Engineering-change screening. The verdict routes a change to the right level
 * of human review; it never approves anything on its own.
 */
function screenChange(asset, { changeType, description }) {
  const change = changeClasses[changeType];
  if (!change) throw Object.assign(new Error('Tipo de alteração inválido.'), { status: 400 });
  if (typeof description !== 'string' || description.length > 280) {
    throw Object.assign(new Error('Descrição deve ter até 280 caracteres.'), { status: 400 });
  }
  const value = riskScore(asset);
  const band = bandOf(value);
  const bandWeight = { critical: 3, attention: 2, stable: 1 }[band.id];
  const exposure = change.weight + bandWeight;
  const verdict = exposure >= 5 ? 'blocked' : exposure >= 3 ? 'controlled' : 'acceptable';
  const checks = [
    { status: 'pass', text: `Alteração classificada como ${change.label.toLowerCase()} · peso ${change.weight} de 3.` },
    {
      status: band.id === 'stable' ? 'pass' : 'warn',
      text: `Ativo em faixa ${band.label} com risco ${value}: vibração ${asset.vibration}% e temperatura ${asset.temperature}%.`,
    },
    {
      status: changeType === 'load' ? 'warn' : 'pass',
      text: changeType === 'load'
        ? `A 90% de carga por 24h, a projeção de risco chega a ${projectLoad(asset, { load: 90, horizonHours: 24 }).projectedRisk}.`
        : 'Sem alteração declarada no envelope de carga operacional.',
    },
    {
      status: verdict === 'blocked' ? 'fail' : 'pass',
      text: verdict === 'blocked'
        ? 'Exposição combinada exige janela controlada e aprovação de responsável técnico antes da execução.'
        : 'Exposição combinada compatível com o fluxo padrão de revisão técnica.',
    },
  ];
  return {
    assetId: asset.id,
    assetName: asset.name,
    changeType,
    changeLabel: change.label,
    description: description.trim(),
    assetRisk: value,
    band: band.id,
    exposure,
    verdict,
    verdictLabel: { blocked: 'REQUER APROVAÇÃO FORMAL', controlled: 'JANELA CONTROLADA', acceptable: 'ACEITÁVEL' }[verdict],
    checks,
    limitation: 'Triagem de impacto. A recomendação não substitui análise de engenharia nem constitui autorização.',
  };
}

module.exports = {
  riskWeights, bands, readinessThreshold, freshnessLimitHours, changeClasses,
  riskContributions, riskScore, bandOf, readiness, enrich, coverage, readinessTrend,
  signals, singlePointsOfFailure, overview, projectLoad, outageImpact, screenChange,
};
