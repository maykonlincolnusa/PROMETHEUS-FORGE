-- Collected public-context snapshots.
--
-- One row per source and scope, overwritten on each collection run. The
-- collector (scripts/collect-context.js) is the only writer; the console only
-- reads, so a slow or unavailable federal API can never block an operator.
-- Normalised payloads are stored whole: the shape is owned by lib/context.js
-- and versioning it here would duplicate that contract in two places.

CREATE TABLE IF NOT EXISTS context_snapshots (
  source TEXT NOT NULL,
  scope TEXT NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (source, scope)
);

CREATE INDEX IF NOT EXISTS context_snapshots_collected_at_idx ON context_snapshots (collected_at DESC);
