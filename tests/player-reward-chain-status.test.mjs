import test from 'node:test';
import assert from 'node:assert/strict';

import { RewardManager } from '../server/reward-manager.js';

const PLAYER = '0x1dab596d0121c250a24b00137e84170fa6874be6';
const REWARD_ID = 'reward_2026-07-20_free';
const ALLOCATED_RAW = '2890173410404624277456647';
const PLAYER_AMOUNT_RAW = '346820809248554913294797';
const ROOT = '0x2bdaacc66bea0b481492c780143de103c6a1dbaf1ee95b1ca6c8b16e9147168a';

function harness(overrides = {}) {
  const playerReward = {
    id: REWARD_ID,
    week: '2026-07-20',
    mode: 'free',
    epoch: '2950',
    board: 0,
    status: 'published',
    merkleRoot: ROOT,
    claimDeadline: 1787702861,
    publishedAt: 1785114593261,
    address: PLAYER,
    rank: 3,
    score: 1144,
    amountMatt: 346820,
    amountRaw: PLAYER_AMOUNT_RAW,
    proof: [`0x${'11'.repeat(32)}`]
  };
  const draft = {
    id: REWARD_ID,
    week: '2026-07-20',
    mode: 'free',
    epoch: '2950',
    board: 0,
    status: 'published',
    merkleRoot: ROOT,
    allocatedRaw: ALLOCATED_RAW,
    claimDeadline: 1787702861
  };
  const observed = [];
  const store = {
    async init() {},
    async playerRewards() {
      return [structuredClone(playerReward)];
    },
    async getDraft() {
      return structuredClone(overrides.draft || draft);
    },
    async markPublished() {}
  };
  const chain = {
    async epochStatus(reward, player) {
      observed.push({ operation: 'status', reward: structuredClone(reward), player });
      assert.equal(reward.allocatedRaw, ALLOCATED_RAW);
      assert.equal(reward.merkleRoot, ROOT);
      return {
        published: true,
        claimed: false,
        paused: false,
        closed: false,
        claimDeadline: reward.claimDeadline
      };
    },
    async assertClaimable(reward, player) {
      observed.push({ operation: 'prepare', reward: structuredClone(reward), player });
      assert.equal(reward.allocatedRaw, ALLOCATED_RAW);
      assert.equal(reward.amountRaw, PLAYER_AMOUNT_RAW);
      assert.deepEqual(reward.proof, playerReward.proof);
      return {
        published: true,
        claimed: false,
        paused: false,
        closed: false,
        claimDeadline: reward.claimDeadline
      };
    },
    claimTransaction(reward) {
      observed.push({ operation: 'transaction', reward: structuredClone(reward) });
      return {
        to: '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619',
        value: '0x0',
        data: '0x8a23213f'
      };
    }
  };
  return {
    manager: new RewardManager({ store, chain }),
    observed
  };
}

test('published player rewards are rebound to the immutable draft before Ronin status checks', async () => {
  const { manager, observed } = harness();
  const claims = await manager.playerRewards(PLAYER);

  assert.equal(claims.length, 1);
  assert.equal(claims[0].id, REWARD_ID);
  assert.equal(claims[0].rank, 3);
  assert.equal(claims[0].amountRaw, PLAYER_AMOUNT_RAW);
  assert.equal(claims[0].chain.published, true);
  assert.equal(claims[0].chain.claimed, false);
  assert.equal(claims[0].chain.unavailable, undefined);
  assert.equal(claims[0].allocatedRaw, undefined);
  assert.equal(claims[0].merkleRoot, undefined);
  assert.equal(observed[0].reward.allocatedRaw, ALLOCATED_RAW);
});

test('claim preparation uses the player proof plus the epoch total stored on the draft', async () => {
  const { manager, observed } = harness();
  const prepared = await manager.prepareClaim(PLAYER, REWARD_ID);

  assert.equal(prepared.reward.amountRaw, PLAYER_AMOUNT_RAW);
  assert.equal(prepared.reward.allocatedRaw, undefined);
  assert.equal(prepared.transaction.to.toLowerCase(), '0x6ba468ee15cb3634f4ea340407e9fd7a75267619');
  assert.equal(prepared.transaction.data, '0x8a23213f');
  assert.deepEqual(observed.map((entry) => entry.operation), ['prepare', 'transaction']);
});

test('mismatched player and draft epoch metadata is rejected before chain access', async () => {
  const { manager, observed } = harness({
    draft: {
      id: REWARD_ID,
      epoch: '2951',
      board: 0,
      merkleRoot: ROOT,
      allocatedRaw: ALLOCATED_RAW,
      claimDeadline: 1787702861
    }
  });

  await assert.rejects(
    () => manager.prepareClaim(PLAYER, REWARD_ID),
    (error) => error.code === 'reward_epoch_metadata_mismatch'
  );
  assert.equal(observed.length, 0);
});
