-- Lossless rollback: the legacy matt_mine_state row remains authoritative.
-- This deliberately does not drop normalized tables or financial history.
UPDATE matt_mine_normalized.cutover_state
SET read_source = 'legacy', dual_write_enabled = FALSE, updated_at = NOW()
WHERE singleton = TRUE;
