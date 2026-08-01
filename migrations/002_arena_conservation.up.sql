CREATE TABLE IF NOT EXISTS matt_mine_normalized.arena_recoveries (
  recovery_id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL UNIQUE,
  original_run_id TEXT NOT NULL UNIQUE,
  recovery_run_id TEXT UNIQUE,
  failure_code TEXT NOT NULL,
  authorized_by TEXT NOT NULL,
  authorized_at_ms BIGINT NOT NULL,
  resolved_at_ms BIGINT,
  resolution TEXT CHECK (resolution IN ('resume_original','recovery_run','cancel_refund'))
);

-- The partial unique index is installed by the Arena store after its schema
-- exists; keeping that ordering explicit makes a fresh database migration safe.
