import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta,
  normalizeNuggetLedger
} from '../server/nugget-ledger.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

test('append-only nugget history remains intact beyond the old 5,000-entry ceiling', () => {
  const existing = Array.from({ length: 5_050 }, (_, index) => ({
    id: `ledger-ADMIN_ADJUSTMENT-${1_000_000 + index}-${String(index + 1).padStart(6, '0')}`,
    walletAddress: ADDRESS,
    direction: 'credit',
    type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
    amount: 1,
    previousBalance: index,
    newBalance: index + 1,
    runId: '',
    transactionHash: '',
    idempotencyKey: `durability-${index}`,
    adminActor: 'TEST',
    details: 'Durability fixture',
    timestamp: 1_000_000 + index
  }));
  const wallet = {
    address: ADDRESS,
    profile: { bankedNuggets: 5_050 },
    nuggetLedger: existing
  };
  applyNuggetLedgerDelta(wallet, 1, {
    type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
    idempotencyKey: 'durability-5050',
    timestamp: 1_005_050
  });
  assert.equal(wallet.nuggetLedger.length, 5_051);
  assert.equal(wallet.profile.bankedNuggets, 5_051);
  assert.equal(wallet.nuggetLedger[0].idempotencyKey, 'durability-0');
  assert.equal(wallet.nuggetLedger.at(-1).idempotencyKey, 'durability-5050');
  assert.equal(normalizeNuggetLedger(wallet.nuggetLedger, ADDRESS).length, 5_051);
});
