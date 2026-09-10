CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE user_role AS ENUM ('operator', 'engineer', 'approver', 'auditor', 'admin');
CREATE TYPE asset_status AS ENUM ('normal', 'attention', 'critical', 'offline');

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'operator',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  state_code CHAR(2),
  health SMALLINT NOT NULL CHECK (health BETWEEN 0 AND 100),
  vibration SMALLINT NOT NULL CHECK (vibration BETWEEN 0 AND 100),
  temperature SMALLINT NOT NULL CHECK (temperature BETWEEN 0 AND 100),
  operating_hours INTEGER NOT NULL CHECK (operating_hours >= 0),
  criticality SMALLINT NOT NULL CHECK (criticality BETWEEN 0 AND 100),
  status asset_status NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY,
  actor_id UUID REFERENCES users(id),
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 80),
  detail TEXT NOT NULL CHECK (char_length(detail) <= 500),
  source TEXT NOT NULL DEFAULT 'api',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS assets_status_idx ON assets (status);
