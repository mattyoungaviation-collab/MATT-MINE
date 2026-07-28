import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta,
  normalizeNuggetLedger
} from '../server/nugget-ledger.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

test('append-only nugget history remains intact beyond the old 5,000-entry ceiling', () => {
  const wallet = {
    address: ADDRESS,
    profile: { bankedNuggets: 0 },
    nuggetLedger: []
  };
  for (let index = 0; index < 5_050; index += 1) {
    applyNuggetLedgerDelta(wallet, 1, {
      type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
      idempotencyKey: `durability-${index}`,
      timestamp: 1_000_000 + index
    });
  }
  assert.equal(wallet.nuggetLedger.length, 5_050);
  assert.equal(wallet.profile.bankedNuggets, 5_050);
  assert.equal(wallet.nuggetLedger[0].idempotencyKey, 'durability-0');
  assert.equal(wallet.nuggetLedger.at(-1).idempotencyKey, 'durability-5049');
  assert.equal(normalizeNuggetLedger(wallet.nuggetLedger, ADDRESS).length, 5_050);
});
