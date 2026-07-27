import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { verifyStandardProof } from '../server/merkle.js';
import { RewardManager } from '../server/reward-manager.js';
import { RoninRewardChain } from '../server/reward-chain.js';
import {
  REWARD_CHAIN_ID,
  REWARD_CONTRACT_ADDRESS,
  createRewardPlan,
  rewardEpochForWeek
} from '../server/reward-plan.js';
import { MemoryRewardStore } from '../server/reward-store.js';
import { MattMineService } from '../server/service.js';

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);
const WEEK = '2026-07-20';
const PRIMARY_KEY = 'primary-admin-secret';
const APPROVER_KEY = 'independent-approver-secret';
const contractsRequire = createRequire(new URL('../contracts/package.json', import.meta.url));
const { StandardMerkleTree } = contractsRequire('@openzeppelin/merkle-tree');
const accounts = Array.from({ length: 10 }, (_, index) =>
  privateKeyToAccount(`0x${String(index + 1).padStart(64, '0')}`)
);

function finalizedSnapshot(mode = 'free') {
  return {
    mode,
    week: WEEK,
    finalized: true,
    finalizedAt: '2026-07-28T00:00:00.000Z',
    participantCount: 10,
    totalScore: 55_000,
    runCount: 70,
    rows: accounts.map((account, index) => ({
      rank: index + 1,
      address: account.address,
      score: (10 - index) * 1_000
    }))
  };
}

function fakeChain(options = {}) {
  let published = options.published === true;
  let claimed = options.claimed === true;
  return {
    publicConfig() {
      return {
        chainId: REWARD_CHAIN_ID,
        rewardsContract: REWARD_CONTRACT_ADDRESS
      };
    },
    async publicationTransactions(plan) {
      return [{ to: REWARD_CONTRACT_ADDRESS, value: '0x0', data: plan.merkleRoot }];
    },
    async epochStatus() {
      return {
        published,
        claimed,
        paused: false,
        closed: false,
        claimDeadline: Math.floor(NOW / 1000) + 86_400
      };
    },
    async assertClaimable() {
      assert.equal(published, true);
      assert.equal(claimed, false);
      return { published, claimed, paused: false, closed: false };
    },
    claimTransaction(reward) {
      return {
        to: REWARD_CONTRACT_ADDRESS,
        value: '0x0',
        data: `0x${reward.proof.length.toString(16).padStart(8, '0')}`
      };
    },
    publish() {
      published = true;
    },
    markClaimed() {
      claimed = true;
    }
  };
}

test('reward plans allocate the full pool across eligible top-ten players with contract-compatible proofs', () => {
  const plan = createRewardPlan({
    snapshot: finalizedSnapshot(),
    poolMatt: 100_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 100_000
  });

  assert.equal(plan.epoch, String(rewardEpochForWeek(WEEK)));
  assert.equal(plan.entries.length, 10);
  assert.deepEqual(
    plan.entries.map((entry) => entry.amountMatt),
    [30_000, 18_000, 12_000, 8_000, 7_000, 6_000, 5_500, 5_000, 4_500, 4_000]
  );
  assert.equal(plan.allocatedMatt, 100_000);
  assert.equal(plan.allocatedRaw, plan.requestedRaw);
  assert.equal(plan.unallocatedMatt, 0);
  const first = plan.entries[0];
  const values = plan.entries.map((entry) => [
    String(REWARD_CHAIN_ID),
    REWARD_CONTRACT_ADDRESS,
    plan.epoch,
    String(plan.board),
    entry.address,
    entry.amountRaw
  ]);
  const openZeppelinTree = StandardMerkleTree.of(
    values,
    ['uint256', 'address', 'uint256', 'uint8', 'address', 'uint256']
  );
  assert.equal(plan.merkleRoot, openZeppelinTree.root);
  assert.deepEqual(first.proof, openZeppelinTree.getProof(0));
  assert.equal(verifyStandardProof(
    plan.merkleRoot,
    [
      String(REWARD_CHAIN_ID),
      REWARD_CONTRACT_ADDRESS,
      plan.epoch,
      String(plan.board),
      first.address,
      first.amountRaw
    ],
    first.proof
  ), true);
});

test('reward plans normalize the full pool when fewer than ten players qualify', () => {
  const snapshot = finalizedSnapshot();
  snapshot.rows = snapshot.rows.slice(0, 3);
  snapshot.participantCount = 3;
  const plan = createRewardPlan({
    snapshot,
    poolMatt: 10_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 100_000
  });

  assert.deepEqual(
    plan.entries.map((entry) => entry.amountMatt),
    [5_000, 3_000, 2_000]
  );
  assert.equal(plan.allocatedMatt, 10_000);
  assert.equal(plan.allocatedRaw, plan.requestedRaw);
  assert.equal(plan.unallocatedMatt, 0);
});

test('draft creation requires a finalized snapshot and enforces the pilot payout cap', async () => {
  const store = new MemoryRewardStore({ snapshots: [finalizedSnapshot()] });
  const manager = await new RewardManager({
    store,
    chain: fakeChain(),
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    approverKey: APPROVER_KEY,
    maxBoardMatt: 100_000
  }).init();

  await assert.rejects(
    () => manager.createDraft('wrong-key', {
      week: WEEK,
      mode: 'free',
      poolMatt: 10_000
    }),
    (error) => error.code === 'admin_key_rejected'
  );
  await assert.rejects(
    () => manager.createDraft(PRIMARY_KEY, {
      week: WEEK,
      mode: 'free',
      poolMatt: 100_001
    }),
    (error) => error.code === 'reward_pool_cap_exceeded'
  );
  await assert.rejects(
    () => manager.createDraft(PRIMARY_KEY, {
      week: '2026-07-13',
      mode: 'free',
      poolMatt: 10_000
    }),
    (error) => error.code === 'leaderboard_not_finalized'
  );
});

test('independent approval produces a dry-run Safe package without publishing or moving MATT', async () => {
  const store = new MemoryRewardStore({ snapshots: [finalizedSnapshot()] });
  const chain = fakeChain();
  const manager = await new RewardManager({
    store,
    chain,
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    approverKey: APPROVER_KEY,
    publicationEnabled: false,
    maxBoardMatt: 100_000
  }).init();

  const draft = await manager.createDraft(PRIMARY_KEY, {
    week: WEEK,
    mode: 'free',
    poolMatt: 10_000,
    claimDays: 30
  });
  assert.equal(draft.status, 'draft');
  await assert.rejects(
    () => manager.approveDraft(PRIMARY_KEY, draft.id),
    (error) => error.code === 'reward_approver_rejected'
  );
  const approved = await manager.approveDraft(APPROVER_KEY, draft.id);
  assert.equal(approved.draft.status, 'approved');
  assert.equal(approved.broadcastReady, false);
  assert.equal(approved.safeTransactions, undefined);
  assert.equal(approved.safeTransactionPreview.length, 1);
  assert.equal(approved.safeTransactionBuilderFile.chainId, '2020');
  assert.equal(
    approved.safeTransactionBuilderFile.meta.createdFromSafeAddress,
    '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc'
  );
  assert.equal(approved.safeTransactionBuilderFile.transactions.length, 1);
  assert.equal(approved.safeFileName, `matt-mine-${draft.id}-safe.json`);
  assert.match(approved.safety, /DRY RUN/);
});

test('the same secret cannot satisfy both reward approval roles', async () => {
  const store = new MemoryRewardStore({ snapshots: [finalizedSnapshot()] });
  const manager = await new RewardManager({
    store,
    chain: fakeChain(),
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    approverKey: PRIMARY_KEY
  }).init();
  const draft = await manager.createDraft(PRIMARY_KEY, {
    week: WEEK,
    mode: 'free',
    poolMatt: 10_000
  });
  await assert.rejects(
    () => manager.approveDraft(PRIMARY_KEY, draft.id),
    (error) => error.code === 'reward_approver_not_independent'
  );
});

test('an exact on-chain epoch unlocks only the included wallet claim transaction', async () => {
  const store = new MemoryRewardStore({ snapshots: [finalizedSnapshot()] });
  const chain = fakeChain();
  const manager = await new RewardManager({
    store,
    chain,
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    approverKey: APPROVER_KEY,
    publicationEnabled: true,
    maxBoardMatt: 100_000
  }).init();

  const draft = await manager.createDraft(PRIMARY_KEY, {
    week: WEEK,
    mode: 'free',
    poolMatt: 10_000
  });
  await manager.approveDraft(APPROVER_KEY, draft.id);
  let rewards = await manager.playerRewards(accounts[0].address);
  assert.equal(rewards[0].chain.published, false);

  chain.publish();
  const synced = await manager.syncDraft(PRIMARY_KEY, draft.id);
  assert.equal(synced.draft.status, 'published');
  rewards = await manager.playerRewards(accounts[0].address);
  assert.equal(rewards[0].chain.published, true);
  assert.equal(rewards[0].amountMatt, 3_000);
  const prepared = await manager.prepareClaim(accounts[0].address, draft.id);
  assert.equal(prepared.transaction.to, REWARD_CONTRACT_ADDRESS);
  assert.equal(prepared.transaction.value, '0x0');

  await assert.rejects(
    () => manager.prepareClaim(
      privateKeyToAccount(`0x${'11'.repeat(32)}`).address,
      draft.id
    ),
    (error) => error.code === 'player_reward_missing'
  );
});

test('the hard code cap cannot be bypassed by a larger environment setting', () => {
  const manager = new RewardManager({
    store: new MemoryRewardStore(),
    chain: fakeChain(),
    maxBoardMatt: 9_999_999_999
  });
  assert.equal(manager.publicConfig().maxBoardMatt, 5_000_000);

  const maximumPlan = createRewardPlan({
    snapshot: finalizedSnapshot(),
    poolMatt: 5_000_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 9_999_999_999
  });
  assert.equal(maximumPlan.entries[0].amountMatt, 1_500_000);
  assert.equal(maximumPlan.allocatedMatt, 5_000_000);
  assert.throws(
    () => createRewardPlan({
      snapshot: finalizedSnapshot(),
      poolMatt: 5_000_001,
      claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
      maxBoardMatt: 9_999_999_999
    }),
    (error) => error.code === 'reward_pool_cap_exceeded'
  );
});

test('Safe publication funds only the vault shortfall and never double-funds available MATT', async () => {
  const plan = createRewardPlan({
    snapshot: finalizedSnapshot(),
    poolMatt: 10_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 100_000
  });
  const enoughFunding = new RoninRewardChain({
    client: {
      async readContract(request) {
        if (request.functionName === 'balanceOf') return 11_000n * 10n ** 18n;
        if (request.functionName === 'totalReservedMatt') return 1_000n * 10n ** 18n;
        if (request.functionName === 'allowance') return 0n;
        if (request.functionName === 'paused') return false;
        if (request.functionName === 'getEpoch') return { published: false };
        throw new Error(`Unexpected ${request.functionName}`);
      }
    }
  });
  const fundedPackage = await enoughFunding.publicationTransactions(plan);
  assert.equal(fundedPackage.vault.fundingShortfallRaw, '0');
  assert.equal(fundedPackage.transactions.length, 1);
  assert.match(fundedPackage.transactions[0].purpose, /Publish/);

  const shortFunding = new RoninRewardChain({
    client: {
      async readContract(request) {
        if (request.functionName === 'balanceOf') {
          return request.args[0].toLowerCase() === REWARD_CONTRACT_ADDRESS.toLowerCase()
            ? 2_000n * 10n ** 18n
            : 20_000n * 10n ** 18n;
        }
        if (request.functionName === 'totalReservedMatt') return 1_000n * 10n ** 18n;
        if (request.functionName === 'allowance') return 0n;
        if (request.functionName === 'paused') return false;
        if (request.functionName === 'getEpoch') return { published: false };
        throw new Error(`Unexpected ${request.functionName}`);
      }
    }
  });
  const shortPackage = await shortFunding.publicationTransactions(plan);
  assert.equal(shortPackage.vault.fundingShortfallRaw, String(9_000n * 10n ** 18n));
  assert.equal(shortPackage.transactions.length, 3);
  assert.match(shortPackage.transactions[0].purpose, /Approve/);
  assert.match(shortPackage.transactions[1].purpose, /Fund/);
  assert.match(shortPackage.transactions[2].purpose, /Publish/);
});

test('reward publication preflight blocks paused, duplicate, and underfunded Safe packages', async () => {
  const plan = createRewardPlan({
    snapshot: finalizedSnapshot(),
    poolMatt: 10_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 100_000
  });
  const chain = (overrides = {}) => new RoninRewardChain({
    client: {
      async readContract(request) {
        if (request.functionName === 'balanceOf') {
          const isVault = request.args[0].toLowerCase() === REWARD_CONTRACT_ADDRESS.toLowerCase();
          return isVault ? 1_000n * 10n ** 18n : (overrides.treasuryBalance ?? 20_000n * 10n ** 18n);
        }
        if (request.functionName === 'totalReservedMatt') return 1_000n * 10n ** 18n;
        if (request.functionName === 'allowance') return 0n;
        if (request.functionName === 'paused') return overrides.paused === true;
        if (request.functionName === 'getEpoch') return { published: overrides.published === true };
        throw new Error(`Unexpected ${request.functionName}`);
      }
    }
  });

  await assert.rejects(
    () => chain({ paused: true }).publicationTransactions(plan),
    (error) => error.code === 'reward_vault_paused'
  );
  await assert.rejects(
    () => chain({ published: true }).publicationTransactions(plan),
    (error) => error.code === 'reward_epoch_exists'
  );
  await assert.rejects(
    () => chain({ treasuryBalance: 1n }).publicationTransactions(plan),
    (error) => error.code === 'reward_treasury_insufficient'
  );
});

test('claim preparation simulates the exact proof on Ronin before opening the wallet', async () => {
  const plan = createRewardPlan({
    snapshot: finalizedSnapshot(),
    poolMatt: 10_000,
    claimDeadline: Math.floor(NOW / 1000) + 30 * 86_400,
    maxBoardMatt: 100_000
  });
  const player = plan.entries[0];
  let simulation = null;
  const chain = new RoninRewardChain({
    client: {
      async readContract(request) {
        if (request.functionName === 'getEpoch') {
          return {
            merkleRoot: plan.merkleRoot,
            totalMatt: BigInt(plan.allocatedRaw),
            claimedMatt: 0n,
            claimDeadline: BigInt(plan.claimDeadline),
            published: true,
            closed: false
          };
        }
        if (request.functionName === 'paused') return false;
        if (request.functionName === 'isClaimed') return false;
        throw new Error(`Unexpected ${request.functionName}`);
      },
      async simulateContract(request) {
        simulation = request;
        return { request };
      }
    }
  });

  await chain.assertClaimable({
    ...plan,
    amountRaw: player.amountRaw,
    proof: player.proof
  }, player.address);

  assert.equal(simulation.functionName, 'claim');
  assert.equal(simulation.account.toLowerCase(), player.address.toLowerCase());
  assert.equal(simulation.args[0], BigInt(plan.epoch));
  assert.equal(simulation.args[2], BigInt(player.amountRaw));
  assert.deepEqual(simulation.args[3], player.proof);
});

test('authenticated HTTP routes carry a capped draft through approval, sync, and claim preparation', async () => {
  const store = new MemoryRewardStore({ snapshots: [finalizedSnapshot()] });
  const chain = fakeChain();
  const manager = await new RewardManager({
    store,
    chain,
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    approverKey: APPROVER_KEY,
    publicationEnabled: false,
    maxBoardMatt: 100_000
  }).init();
  const service = new MattMineService(new MemoryDatabase(), {
    now: () => NOW,
    adminKey: PRIMARY_KEY,
    rewardManager: manager,
    randomHex(bytes) {
      return 'ab'.repeat(bytes);
    }
  });
  const server = createMattMineHttpServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    service
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, {
    method: options.method || 'GET',
    headers: {
      origin,
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.adminKey ? { 'x-matt-admin-key': options.adminKey } : {}),
      ...(options.approverKey ? { 'x-matt-reward-approver-key': options.approverKey } : {}),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  try {
    const challenge = await request('/api/auth/challenge', {
      method: 'POST',
      body: {
        address: accounts[0].address,
        chainId: 2020,
        origin
      }
    });
    const signature = await accounts[0].signMessage({
      message: challenge.body.challenge.message
    });
    const verified = await request('/api/auth/verify', {
      method: 'POST',
      body: {
        address: accounts[0].address,
        nonce: challenge.body.challenge.nonce,
        signature
      }
    });
    const token = verified.body.session.token;
    const created = await request('/api/admin/rewards/drafts', {
      method: 'POST',
      adminKey: PRIMARY_KEY,
      body: { week: WEEK, mode: 'free', poolMatt: 10_000, claimDays: 30 }
    });
    assert.equal(created.status, 201);
    const approved = await request(`/api/admin/rewards/drafts/${created.body.draft.id}/approve`, {
      method: 'POST',
      approverKey: APPROVER_KEY,
      body: {}
    });
    assert.equal(approved.body.broadcastReady, false);
    let claims = await request('/api/rewards/claims', { token });
    assert.equal(claims.body.claims[0].chain.published, false);

    chain.publish();
    const synced = await request(`/api/admin/rewards/drafts/${created.body.draft.id}/sync`, {
      method: 'POST',
      adminKey: PRIMARY_KEY,
      body: {}
    });
    assert.equal(synced.body.draft.status, 'published');
    claims = await request('/api/rewards/claims', { token });
    assert.equal(claims.body.claims[0].chain.published, true);
    const prepared = await request(`/api/rewards/claims/${created.body.draft.id}/prepare`, {
      method: 'POST',
      token,
      body: {}
    });
    assert.equal(prepared.body.transaction.to, REWARD_CONTRACT_ADDRESS);
    assert.equal(prepared.body.transaction.value, '0x0');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
