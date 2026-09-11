const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function quantile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function describe(values) {
  if (!values.length) return { count: 0, mean: null, median: null, stddev: null, min: null, max: null, p95: null };
  const average = mean(values);
  return {
    count: values.length, mean: average, median: quantile(values, .5),
    stddev: values.length > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1)) : null,
    min: Math.min(...values), max: Math.max(...values), p95: quantile(values, .95),
  };
}

function correlation(xs, ys) {
  if (xs.length !== ys.length || xs.length < 3) return null;
  const mx = mean(xs), my = mean(ys);
  const covariance = xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0);
  const denominator = Math.sqrt(xs.reduce((sum, x) => sum + (x - mx) ** 2, 0) * ys.reduce((sum, y) => sum + (y - my) ** 2, 0));
  return denominator ? covariance / denominator : null;
}

// An hourly slope, not a calibrated forecast or a confidence interval.
function trend(rows, metric) {
  if (rows.length < 3) return null;
  const start = Date.parse(rows[0].timestamp);
  const xs = rows.map(row => (Date.parse(row.timestamp) - start) / 3600000);
  const ys = rows.map(row => row[metric]);
  const mx = mean(xs), my = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return denominator ? xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / denominator : null;
}

module.exports = { mean, quantile, describe, correlation, trend };
