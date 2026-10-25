-- Opt-in cloud API for health data (worker/health.ts, docs/health-data.md).
-- No Xiaomi token, band serial, name, e-mail or IP address is stored: an account is a random id
-- that only its API keys (stored as SHA-256 hashes) can reach.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  retention_days INTEGER NOT NULL DEFAULT 90
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'read')),
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_keys_account ON api_keys (account_id);

-- One row per account, record kind and UTC day: a JSON array of miband-health/1 records.
CREATE TABLE chunks (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, kind, day)
) WITHOUT ROWID;
