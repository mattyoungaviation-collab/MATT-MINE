CREATE SCHEMA IF NOT EXISTS matt_mine_normalized;

CREATE TABLE IF NOT EXISTS matt_mine_normalized.schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matt_mine_normalized.wallets (
  address TEXT PRIMARY KEY CHECK (address ~ '^0x[0-9a-f]{40}$'),
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  created_at_ms BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  legacy_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.player_identities (
  address TEXT PRIMARY KEY REFERENCES matt_mine_normalized.wallets(address),
  username TEXT NOT NULL,
  username_key TEXT GENERATED ALWAYS AS (LOWER(username)) STORED,
  updated_at_ms BIGINT NOT NULL DEFAULT 0,
  UNIQUE(username_key)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.avatars (
  address TEXT PRIMARY KEY REFERENCES matt_mine_normalized.wallets(address),
  mime_type TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.wallet_sessions (
  token_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  session_type TEXT NOT NULL DEFAULT 'player',
  csrf_hash TEXT,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  revoked_at_ms BIGINT,
  last_seen_at_ms BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.authentication_challenges (
  nonce TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  origin TEXT NOT NULL,
  message TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'player_login',
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  consumed_at_ms BIGINT
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.runs (
  run_id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  token_hash TEXT,
  seed TEXT,
  started_at_ms BIGINT NOT NULL DEFAULT 0,
  expires_at_ms BIGINT NOT NULL DEFAULT 0,
  finished_at_ms BIGINT,
  build_commit TEXT NOT NULL DEFAULT 'unknown',
  engine_version TEXT NOT NULL DEFAULT 'unknown',
  replay_schema_version TEXT NOT NULL DEFAULT 'unknown',
  map_snapshot_id TEXT,
  map_hash TEXT,
  tuning_version TEXT,
  tuning_hash TEXT,
  player_profile_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  pass_multipliers JSONB NOT NULL DEFAULT '{"xp":1,"nuggets":1}'::jsonb,
  authoritative_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  legacy_payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS normalized_runs_wallet_status ON matt_mine_normalized.runs(address,status);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.run_checkpoints (
  run_id TEXT NOT NULL REFERENCES matt_mine_normalized.runs(run_id),
  sequence INTEGER NOT NULL,
  tick INTEGER NOT NULL,
  transcript_hash TEXT NOT NULL,
  engine_state JSONB NOT NULL,
  signature TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  PRIMARY KEY(run_id,sequence)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.entitlements (
  entitlement_key TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  kind TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  consumed_run_id TEXT,
  payload JSONB NOT NULL,
  UNIQUE(transaction_hash,log_index),
  UNIQUE(kind,transaction_hash,log_index)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.pass_purchases (
  payment_key TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  confirmed_at_ms BIGINT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(transaction_hash,log_index)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.paid_run_purchases (
  payment_key TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL DEFAULT 0,
  entitlement_id TEXT NOT NULL,
  confirmed_at_ms BIGINT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(transaction_hash,log_index),
  UNIQUE(address,entitlement_id)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.paid_revives (
  transaction_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  run_id TEXT NOT NULL UNIQUE,
  quote_id TEXT NOT NULL UNIQUE,
  amount_wei NUMERIC(78,0) NOT NULL CHECK (amount_wei > 0),
  transaction_block_at_ms BIGINT NOT NULL,
  authoritative_checkpoint JSONB NOT NULL,
  completed_response JSONB NOT NULL,
  confirmed_at_ms BIGINT NOT NULL,
  resumed_at_ms BIGINT
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.nugget_balances (
  address TEXT PRIMARY KEY REFERENCES matt_mine_normalized.wallets(address),
  balance BIGINT NOT NULL CHECK (balance >= 0),
  ledger_sequence BIGINT NOT NULL DEFAULT 0,
  updated_at_ms BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.nugget_ledger (
  entry_id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  sequence BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  transaction_hash TEXT,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
  entry_type TEXT NOT NULL,
  run_id TEXT,
  created_at_ms BIGINT NOT NULL,
  payload JSONB NOT NULL,
  UNIQUE(address,sequence),
  UNIQUE(address,idempotency_key),
  UNIQUE(transaction_hash)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.practice_claims (
  run_id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  status TEXT NOT NULL,
  transaction_hash TEXT UNIQUE,
  quote_id TEXT UNIQUE,
  projected_nuggets BIGINT NOT NULL,
  created_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  settled_at_ms BIGINT,
  payload JSONB NOT NULL
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.used_transaction_hashes (
  transaction_hash TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  purpose TEXT NOT NULL,
  payment_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  block_number NUMERIC(78,0),
  reserved_at_ms BIGINT NOT NULL,
  chain_verified_at_ms BIGINT,
  ledger_credited_at_ms BIGINT,
  completed_at_ms BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.payment_operations (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  address TEXT NOT NULL,
  purpose TEXT NOT NULL,
  quote_id TEXT,
  transaction_hash TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved','chain_verified','ledger_credited','completed','invalid','needs_reconciliation')),
  completed_response JSONB,
  error_code TEXT,
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  chain_verified_at_ms BIGINT,
  ledger_credited_at_ms BIGINT,
  completed_at_ms BIGINT,
  UNIQUE(transaction_hash),
  UNIQUE(purpose,quote_id)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.admin_operations (
  idempotency_key TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  actor_address TEXT NOT NULL,
  action TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_response JSONB,
  created_at_ms BIGINT NOT NULL,
  completed_at_ms BIGINT
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.mine_operations (
  mine TEXT PRIMARY KEY,
  controls JSONB NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.tuning_versions (
  version_id TEXT PRIMARY KEY,
  lobby TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tuning JSONB NOT NULL,
  created_at_ms BIGINT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(lobby,content_hash)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.competition_studio_drafts (
  slot_id TEXT PRIMARY KEY,
  draft JSONB NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.competition_published_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  effective_at_ms BIGINT NOT NULL,
  expires_at_ms BIGINT,
  snapshot JSONB NOT NULL,
  published_at_ms BIGINT NOT NULL,
  published_by TEXT NOT NULL,
  UNIQUE(slot_id,content_hash)
);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.activity_entries (
  activity_id TEXT PRIMARY KEY,
  address TEXT NOT NULL REFERENCES matt_mine_normalized.wallets(address),
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at_ms BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_wallet_created ON matt_mine_normalized.activity_entries(address,created_at_ms DESC);
CREATE TABLE IF NOT EXISTS matt_mine_normalized.audit_entries (
  audit_id TEXT PRIMARY KEY,
  actor_address TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT NOT NULL,
  request_id TEXT,
  created_at_ms BIGINT NOT NULL,
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS audit_created ON matt_mine_normalized.audit_entries(created_at_ms DESC);
CREATE INDEX IF NOT EXISTS audit_actor_created ON matt_mine_normalized.audit_entries(actor_address,created_at_ms DESC);
