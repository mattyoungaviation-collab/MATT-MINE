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

test('operations overview reconciles paid and unpaid obligations from Ronin', async () => {
  const second = {
    ...ENTRY,
    address: '0x2222222222222222222222222222222222222222',
    rank: 2,
    score: 21_000,
    amountMatt: 100_000,
    amountRaw: '100000000000000000000000'
  };
  const storedDraft = {
    id: 'reward_2026-07-20_free',
    week: '2026-07-20',
    mode: 'free',
    status: 'published',
    epoch: '20260720',
    board: 0,
    participantCount: 2,
    allocatedMatt: 350_000,
    allocatedRaw: '350000000000000000000000',
    claimDeadline: 1_800_000_000,
    merkleRoot: `0x${'1'.repeat(64)}`,
    entries: [ENTRY, second]
  };
  const manager = new RewardManager({
    adminKey: 'admin-secret',
    publicationEnabled: true,
    maxBoardMatt: 5_000_000,
    chain: {
      async claimStatuses(_draft, entries) {
        return {
          published: true,
          paused: false,
          closed: false,
          claimedRaw: ENTRY.amountRaw,
          entries: entries.map((entry, index) => ({
            address: entry.address,
            claimed: index === 0,
            status: index === 0 ? 'paid' : 'unpaid'
          }))
        };
      }
    },
    store: {
      async listDrafts() {
        return [structuredClone(storedDraft)];
      },
      async finalizedSnapshot(mode) {
        if (mode === 'free') {
          return { finalized: true, participantCount: 2, runCount: 9 };
        }
        return null;
      }
    }
  });

  const overview = await manager.operationsOverview('admin-secret', '2026-07-20');
  const free = overview.boards.find((board) => board.mode === 'free');
  const paid = overview.boards.find((board) => board.mode === 'paid');

  assert.equal(overview.maxBoardMatt, 5_000_000);
  assert.equal(free.status, 'claims_open');
  assert.equal(free.paidCount, 1);
  assert.equal(free.unpaidCount, 1);
  assert.equal(free.paidMatt, 250_000);
  assert.equal(free.unpaidMatt, 100_000);
  assert.equal(free.obligations[0].status, 'paid');
  assert.equal(free.obligations[1].status, 'unpaid');
  assert.equal(paid.status, 'waiting_for_finalization');
});

test('operations overview tells the operator to synchronize a Safe epoch already on Ronin', async () => {
  const storedDraft = {
    id: 'reward_2026-07-20_paid',
    week: '2026-07-20',
    mode: 'paid',
    status: 'approved',
    epoch: '20260720',
    board: 1,
    participantCount: 1,
    allocatedMatt: 250_000,
    allocatedRaw: '250000000000000000000000',
    claimDeadline: 1_800_000_000,
    merkleRoot: `0x${'1'.repeat(64)}`,
    entries: [ENTRY]
  };
  const manager = new RewardManager({
    adminKey: 'admin-secret',
    chain: {
      async claimStatuses() {
        return {
          published: true,
          paused: false,
          closed: false,
          claimedRaw: '0',
          entries: [{ address: ENTRY.address, claimed: false, status: 'unpaid' }]
        };
      }
    },
    store: {
      async listDrafts() {
        return [structuredClone(storedDraft)];
      },
      async finalizedSnapshot(mode) {
        return mode === 'paid' ? { finalized: true, participantCount: 1, runCount: 1 } : null;
      }
    }
  });

  const overview = await manager.operationsOverview('admin-secret', '2026-07-20');
  const paid = overview.boards.find((board) => board.mode === 'paid');
  assert.equal(paid.status, 'server_sync_required');
  assert.match(paid.nextAction, /synchronize/i);
});
