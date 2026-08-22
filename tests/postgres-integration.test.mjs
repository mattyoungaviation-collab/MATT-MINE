import assert from 'node:assert/strict';
import test from 'node:test';
import { PostgresDatabase } from '../server/database.js';

const url = process.env.TEST_DATABASE_URL;

test('normalized migrations, dual-write backfill, validation, and lossless rollback', { skip: !url }, async () => {
  const database = await new PostgresDatabase(url, { maxConnections: 3, startupRetryAttempts: 3 }).init();
  try {
    const backfill = await database.backfillNormalized();
    assert.equal(backfill.ok, true);
    const migrations = await database.query('SELECT version FROM matt_mine_normalized.schema_migrations ORDER BY version');
    assert.deepEqual(migrations.rows.map((row) => row.version), ['001', '002', '003', '004', '005', '006']);
    const initialCutover = await database.query(`SELECT read_source,dual_write_enabled
      FROM matt_mine_normalized.cutover_state WHERE singleton=TRUE`);
    assert.equal(initialCutover.rows[0].read_source, 'legacy');
    assert.equal(initialCutover.rows[0].dual_write_enabled, false);
    const snapshotConstraint = await database.query(`SELECT COUNT(*)::integer AS count
      FROM pg_constraint
      WHERE connamespace='matt_mine_normalized'::regnamespace
        AND conname='competition_published_snapshots_slot_id_content_hash_key'`);
    assert.equal(snapshotConstraint.rows[0].count, 0);

    const beforeDuplicate = await database.read();
    const originalSnapshot = Object.values(beforeDuplicate.competitionStudio.snapshots)
      .find((snapshot) => snapshot.slotId === 'practice');
    assert.ok(originalSnapshot);
    await database.transact((state) => {
      const duplicateId = 'integration-practice-republish';
      state.competitionStudio.snapshots[duplicateId] = {
        ...structuredClone(originalSnapshot),
        id: duplicateId,
        effectiveAt: originalSnapshot.effectiveAt + 86_400_000,
        publishedAt: originalSnapshot.publishedAt + 86_400_000
      };
      state.competitionStudio.slots.practice.scheduledSnapshotIds.push(duplicateId);
    });
    await database.backfillNormalized();
    const duplicateSnapshots = await database.query(`SELECT content_hash,COUNT(*)::integer AS count
      FROM matt_mine_normalized.competition_published_snapshots
      WHERE slot_id='practice'
      GROUP BY content_hash HAVING COUNT(*) > 1`);
    assert.equal(duplicateSnapshots.rows.length, 1);
    assert.equal(duplicateSnapshots.rows[0].count, 2);
    await database.query(`UPDATE matt_mine_normalized.cutover_state SET read_source='legacy',dual_write_enabled=FALSE WHERE singleton=TRUE`);
    const disabledNonce = 'integration-dual-write-disabled';
    await database.transact((state) => {
      state.challenges[disabledNonce] = {
        nonce: disabledNonce,
        address: '0x0000000000000000000000000000000000000001',
        chainId: 2020,
        origin: 'https://example.test',
        message: 'Disabled dual-write regression challenge',
        purpose: 'player_login',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000
      };
    });
    const disabledChallenge = await database.query(
      'SELECT COUNT(*)::integer AS count FROM matt_mine_normalized.authentication_challenges WHERE nonce=$1',
      [disabledNonce]
    );
    assert.equal(disabledChallenge.rows[0].count, 0);
    const legacy = await database.query('SELECT data FROM matt_mine_state WHERE id=1');
    assert.equal(legacy.rowCount, 1);
    const retiredCurrencyTable = await database.query("SELECT to_regclass('matt_mine_normalized.nugget_ledger') AS table_name");
    assert.equal(retiredCurrencyTable.rows[0].table_name, null);
    const payment = {
      idempotencyKey: 'integration:payment:1',
      requestHash: 'request-hash-1',
      address: '0x0000000000000000000000000000000000000001',
      purpose: 'purchase',
      quoteId: 'integration-quote-1',
      transactionHash: `0x${'12'.repeat(32)}`,
      timestamp: Date.now()
    };
    const reserved = await database.beginPaymentOperation(payment);
    assert.equal(reserved.state, 'reserved');
    const repeated = await database.beginPaymentOperation(payment);
    assert.equal(repeated.idempotency_key, reserved.idempotency_key);
    await database.advancePaymentOperation(payment.idempotencyKey, 'chain_verified');
    await database.advancePaymentOperation(payment.idempotencyKey, 'ledger_credited');
    const completed = await database.advancePaymentOperation(payment.idempotencyKey, 'completed', {
      response: { ok: true, receipt: 'original' }
    });
    assert.deepEqual(completed.completed_response, { ok: true, receipt: 'original' });
    const completedRetry = await database.beginPaymentOperation(payment);
    assert.deepEqual(completedRetry.completed_response, { ok: true, receipt: 'original' });
    await database.query(`UPDATE matt_mine_normalized.cutover_state SET dual_write_enabled=TRUE WHERE singleton=TRUE`);
    const enabledNonce = 'integration-dual-write-enabled';
    await database.transact((state) => {
      state.challenges[enabledNonce] = {
        nonce: enabledNonce,
        address: '0x0000000000000000000000000000000000000001',
        chainId: 2020,
        origin: 'https://example.test',
        message: 'Enabled dual-write regression challenge',
        purpose: 'player_login',
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000
      };
    });
    const enabledChallenge = await database.query(
      'SELECT COUNT(*)::integer AS count FROM matt_mine_normalized.authentication_challenges WHERE nonce=$1',
      [enabledNonce]
    );
    assert.equal(enabledChallenge.rows[0].count, 1);
  } finally {
    await database.close();
  }
});
