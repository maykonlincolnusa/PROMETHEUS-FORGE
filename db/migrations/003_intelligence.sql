CREATE TABLE IF NOT EXISTS telemetry (
  asset_id TEXT NOT NULL REFERENCES assets(id),
  observed_at TIMESTAMPTZ NOT NULL,
  health DOUBLE PRECISION NOT NULL CHECK (health BETWEEN 0 AND 100),
  vibration DOUBLE PRECISION NOT NULL CHECK (vibration BETWEEN 0 AND 100),
  temperature DOUBLE PRECISION NOT NULL CHECK (temperature BETWEEN 0 AND 100),
  label BOOLEAN,
  source TEXT NOT NULL CHECK (source IN ('ingested', 'synthetic-v1')),
  PRIMARY KEY (asset_id, observed_at)
);
CREATE INDEX IF NOT EXISTS telemetry_observed_at_idx ON telemetry (observed_at DESC);

CREATE TABLE IF NOT EXISTS model_runs (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result JSONB NOT NULL
);
