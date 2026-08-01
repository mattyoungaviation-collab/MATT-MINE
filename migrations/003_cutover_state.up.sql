CREATE TABLE IF NOT EXISTS matt_mine_normalized.cutover_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  read_source TEXT NOT NULL DEFAULT 'legacy' CHECK (read_source IN ('legacy','normalized')),
  dual_write_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_backfill_at TIMESTAMPTZ,
  last_validation_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO matt_mine_normalized.cutover_state(singleton)
VALUES (TRUE)
ON CONFLICT(singleton) DO NOTHING;
