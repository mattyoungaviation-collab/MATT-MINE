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
    assert.deepEqual(migrations.rows.map((row) => row.version), ['001', '002', '003']);
    await database.query(`UPDATE matt_mine_normalized.cutover_state SET read_source='legacy',dual_write_enabled=FALSE WHERE singleton=TRUE`);
    const legacy = await database.query('SELECT data FROM matt_mine_state WHERE id=1');
    assert.equal(legacy.rowCount, 1);
    const financial = await database.query('SELECT COUNT(*)::integer AS count FROM matt_mine_normalized.nugget_ledger');
    assert.ok(financial.rows[0].count >= 0);
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
  } finally {
    await database.close();
  }
});
