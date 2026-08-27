CREATE SCHEMA IF NOT EXISTS matt_mine_endless;

CREATE TABLE IF NOT EXISTS matt_mine_endless.projection_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  legacy_backfill_complete BOOLEAN NOT NULL DEFAULT FALSE,
  last_backfill_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO matt_mine_endless.projection_state(singleton)
VALUES(TRUE) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS matt_mine_endless.config_versions (
  config_version INTEGER PRIMARY KEY CHECK (config_version > 0),
  active BOOLEAN NOT NULL DEFAULT FALSE,
  content_hash TEXT NOT NULL,
  config JSONB NOT NULL,
  published_at_ms BIGINT NOT NULL,
  published_by TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS endless_one_active_config
  ON matt_mine_endless.config_versions(active) WHERE active;
CREATE INDEX IF NOT EXISTS endless_config_published
  ON matt_mine_endless.config_versions(published_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_config_content
  ON matt_mine_endless.config_versions(content_hash);

CREATE TABLE IF NOT EXISTS matt_mine_endless.runs (
  run_id TEXT PRIMARY KEY CHECK (run_id ~ '^run_[0-9a-f]{24}$'),
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  miner_id INTEGER NOT NULL CHECK (miner_id > 0),
  status TEXT NOT NULL CHECK (status IN (
    'active','banked','knocked_out','abandoned','rejected','pending_review','expired'
  )),
  verification_status TEXT NOT NULL CHECK (verification_status IN (
    'active','verified','completed','banked','abandoned','disconnected','pending_review','rejected'
  )),
  config_version INTEGER NOT NULL REFERENCES matt_mine_endless.config_versions(config_version),
  token_hash TEXT NOT NULL,
  run_seed TEXT NOT NULL,
  current_phase INTEGER NOT NULL CHECK (current_phase > 0),
  completed_phases INTEGER NOT NULL CHECK (completed_phases >= 0),
  score BIGINT NOT NULL CHECK (score >= 0),
  crystals_carried BIGINT NOT NULL CHECK (crystals_carried >= 0),
  crystals_banked NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (crystals_banked >= 0),
  miner_xp_banked BIGINT NOT NULL DEFAULT 0 CHECK (miner_xp_banked >= 0),
  integrity_score INTEGER NOT NULL CHECK (integrity_score BETWEEN 0 AND 100),
  rolling_digest TEXT NOT NULL,
  payment_transaction_hash TEXT UNIQUE,
  started_at_ms BIGINT NOT NULL,
  phase_started_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  finished_at_ms BIGINT,
  run_payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_runs_wallet_status
  ON matt_mine_endless.runs(address,status,started_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_runs_miner_status
  ON matt_mine_endless.runs(miner_id,status,started_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_runs_status_updated
  ON matt_mine_endless.runs(status,updated_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_runs_verification_started
  ON matt_mine_endless.runs(verification_status,started_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_runs_config
  ON matt_mine_endless.runs(config_version,started_at_ms DESC);

CREATE TABLE IF NOT EXISTS matt_mine_endless.phase_checkpoints (
  run_id TEXT NOT NULL REFERENCES matt_mine_endless.runs(run_id) ON DELETE RESTRICT,
  phase INTEGER NOT NULL CHECK (phase > 0),
  phase_attempt INTEGER NOT NULL CHECK (phase_attempt > 0),
  checkpoint_sequence INTEGER NOT NULL CHECK (checkpoint_sequence > 0),
  manifest_fingerprint TEXT NOT NULL,
  phase_seed TEXT NOT NULL,
  previous_digest TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','pending_review','rejected')),
  score BIGINT NOT NULL CHECK (score >= 0),
  crystals_earned NUMERIC(78,0) NOT NULL CHECK (crystals_earned >= 0),
  crystals_carried BIGINT NOT NULL CHECK (crystals_carried >= 0),
  miner_xp BIGINT NOT NULL CHECK (miner_xp >= 0),
  phase_started_at_ms BIGINT NOT NULL,
  phase_completed_at_ms BIGINT NOT NULL,
  checkpoint_payload JSONB NOT NULL,
  PRIMARY KEY(run_id,phase),
  UNIQUE(run_id,checkpoint_sequence)
);
CREATE INDEX IF NOT EXISTS endless_phases_run_phase
  ON matt_mine_endless.phase_checkpoints(run_id,phase DESC);
CREATE INDEX IF NOT EXISTS endless_phases_verification_time
  ON matt_mine_endless.phase_checkpoints(verification_status,phase_completed_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_phases_manifest
  ON matt_mine_endless.phase_checkpoints(manifest_fingerprint);

CREATE TABLE IF NOT EXISTS matt_mine_endless.entry_payments (
  transaction_hash TEXT PRIMARY KEY CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  run_id TEXT NOT NULL UNIQUE REFERENCES matt_mine_endless.runs(run_id) ON DELETE RESTRICT,
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  recipient TEXT NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{40}$'),
  config_version INTEGER NOT NULL REFERENCES matt_mine_endless.config_versions(config_version),
  amount_raw NUMERIC(78,0) NOT NULL CHECK (amount_raw > 0),
  block_number NUMERIC(78,0) NOT NULL CHECK (block_number >= 0),
  confirmations INTEGER NOT NULL CHECK (confirmations >= 0),
  confirmed_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT NOT NULL,
  payment_payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_payments_wallet_time
  ON matt_mine_endless.entry_payments(address,consumed_at_ms DESC);

CREATE TABLE IF NOT EXISTS matt_mine_endless.leaderboard_entries (
  run_id TEXT PRIMARY KEY REFERENCES matt_mine_endless.runs(run_id) ON DELETE RESTRICT,
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  miner_id INTEGER NOT NULL CHECK (miner_id > 0),
  config_version INTEGER NOT NULL REFERENCES matt_mine_endless.config_versions(config_version),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('verified','pending_review','rejected')),
  deepest_phase INTEGER NOT NULL CHECK (deepest_phase >= 0),
  score BIGINT NOT NULL CHECK (score >= 0),
  crystals_banked NUMERIC(78,0) NOT NULL CHECK (crystals_banked >= 0),
  survival_ms BIGINT NOT NULL CHECK (survival_ms >= 0),
  finished_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_leaderboard_period_rank
  ON matt_mine_endless.leaderboard_entries(
    verification_status,finished_at_ms DESC,deepest_phase DESC,score DESC,crystals_banked DESC
  );
CREATE INDEX IF NOT EXISTS endless_leaderboard_wallet_time
  ON matt_mine_endless.leaderboard_entries(address,finished_at_ms DESC);

CREATE TABLE IF NOT EXISTS matt_mine_endless.integrity_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES matt_mine_endless.runs(run_id) ON DELETE RESTRICT,
  phase INTEGER NOT NULL CHECK (phase >= 0),
  code TEXT NOT NULL,
  integrity_score INTEGER NOT NULL CHECK (integrity_score BETWEEN 0 AND 100),
  created_at_ms BIGINT NOT NULL,
  event_payload JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_integrity_run_time
  ON matt_mine_endless.integrity_events(run_id,created_at_ms DESC);
CREATE INDEX IF NOT EXISTS endless_integrity_code_time
  ON matt_mine_endless.integrity_events(code,created_at_ms DESC);

CREATE TABLE IF NOT EXISTS matt_mine_endless.settlement_transactions (
  transaction_hash TEXT PRIMARY KEY CHECK (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  run_id TEXT NOT NULL REFERENCES matt_mine_endless.runs(run_id) ON DELETE RESTRICT,
  phase INTEGER NOT NULL CHECK (phase >= 0),
  transaction_type TEXT NOT NULL,
  recorded_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS endless_settlement_run_phase
  ON matt_mine_endless.settlement_transactions(run_id,phase,recorded_at_ms);
