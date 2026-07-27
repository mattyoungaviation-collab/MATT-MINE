import test from 'node:test';
import assert from 'node:assert/strict';

import { RewardManager } from '../server/reward-manager.js';

const ENTRY = Object.freeze({
  address: '0x1111111111111111111111111111111111111111',
  rank: 1,
  score: 42_000,
  amountMatt: 250_000,
  amountRaw: '250000000000000000000000',
  proof: [`0x${'2'.repeat(64)}`]
});

test('admin reward drafts expose canonical totals and entries through the dashboard compatibility fields', async () => {
  const storedDraft = {
    id: 'reward_2026-07-20_free',
    week: '2026-07-20',
    mode: 'free',
    status: 'published',
    allocatedMatt: 250_000,
    allocatedRaw: '250000000000000000000000',
    merkleRoot: `0x${'1'.repeat(64)}`,
    entries: [ENTRY]
  };
  const manager = new RewardManager({
    adminKey: 'admin-secret',
    chain: {},
    store: {
      async listDrafts() {
        return [structuredClone(storedDraft)];
      }
    }
  });

  const result = await manager.listDrafts('admin-secret');
  const draft = result.drafts[0];

  assert.equal(draft.allocatedMatt, 250_000);
  assert.equal(draft.totalMatt, 250_000);
  assert.equal(draft.entries.length, 1);
  assert.equal(draft.allocations.length, 1);
  assert.equal(draft.allocations[0].address, ENTRY.address);
  assert.equal(Number.isFinite(draft.totalMatt), true);
});

test('legacy reward summaries are normalized back to the canonical draft shape', async () => {
  const manager = new RewardManager({
    adminKey: 'admin-secret',
    chain: {},
    store: {
      async listDrafts() {
        return [{
          id: 'reward_2026-07-20_free',
          week: '2026-07-20',
          mode: 'free',
          status: 'published',
          totalMatt: 250_000,
          allocations: [ENTRY]
        }];
      }
    }
  });

  const result = await manager.listDrafts('admin-secret');
  const draft = result.drafts[0];

  assert.equal(draft.allocatedMatt, 250_000);
  assert.equal(draft.totalMatt, 250_000);
  assert.deepEqual(draft.entries, draft.allocations);
  assert.equal(draft.entries.length, 1);
});
