-- Published snapshots are immutable historical records. Republishing the same
-- content for a later window creates a new snapshot ID and must remain
-- traceable; content equality is not an idempotency key.
ALTER TABLE matt_mine_normalized.competition_published_snapshots
  DROP CONSTRAINT IF EXISTS competition_published_snapshots_slot_id_content_hash_key;

CREATE INDEX IF NOT EXISTS competition_published_snapshots_slot_content
  ON matt_mine_normalized.competition_published_snapshots(slot_id, content_hash);
