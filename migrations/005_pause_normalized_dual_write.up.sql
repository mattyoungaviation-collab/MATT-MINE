-- The compatibility projection rewrites the entire normalized state inside
-- every legacy transaction. Keep the legacy row authoritative and pause that
-- projection until row-scoped normalized command handlers replace it.
-- This is lossless: normalized and financial tables remain intact, and the
-- explicit operator backfill command remains available.
UPDATE matt_mine_normalized.cutover_state
SET read_source = 'legacy',
    dual_write_enabled = FALSE,
    updated_at = NOW()
WHERE singleton = TRUE;
