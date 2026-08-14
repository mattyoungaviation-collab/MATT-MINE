import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 7, 11, 20, 0, 0);
const account = privateKeyToAccount(
  `0x${createHash('sha256').update('matt-mine-refresh-recovery-player').digest('hex')}`
);

function minerProfile(runLocked = false, minerId = 1) {
  return {
    minerId,
    owner: account.address,
    progression: { bankedXp: 0, level: 1, evolution: 0, prestigeXp: 0 },
    equipped: { weapon: 0, backpack: 2, helmet: 0, armor: 4, queuedBackpacks: 0 },
    gameplay: {
      maximumHealth: 175,
      crystalCarryMultiplier: 2,
      armorEffective: true,
      runLocked
    },
    render: { layout: 'matt-miner-fixed-v1', layers: [] }
  };
}

function createHarness({ ownsMiner = true } = {}) {
  let randomCounter = 0;
  let locked = false;
  const cancellations = [];
  const finalized = [];
  const database = new MemoryDatabase();
  const nftGameplayService = {
    publicStatus: () => ({ enabled: true, chainId: 202601 }),
    async playerMiner(_address, requestedMinerId = 0) {
      if (!ownsMiner) return null;
      return minerProfile(false, requestedMinerId || 1);
    },
    async beginRun({ serverRunId }) {
      locked = true;
      return {
        minerId: 1,
        profile: minerProfile(true),
        crystalCarryLimit: 20,
        runId: `chain-${serverRunId}`,
        beginTransactionHash: `0x${'12'.repeat(32)}`
      };
    },
    async cancelRun({ minerId }) {
      cancellations.push(minerId);
      const cancelled = locked;
      locked = false;
      return { cancelled, minerId };
    }
  };
  const competitiveReplayValidator = {
    publicStatus: () => ({ modes: [SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.FREE] }),
    async register() {
      return { throughSeq: 0, throughTick: 0, transcriptHash: 'genesis', signature: 'start' };
    },
    async finalize(runId, status) {
      finalized.push([runId, status]);
    }
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => START,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    nftGameplayService,
    competitiveReplayValidator,
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return { database, service, cancellations, finalized };
}

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  return service.verifyChallenge({ address: account.address, nonce: challenge.nonce, signature });
}

test('signed-in Practice remains public and never locks or mutates a Miner NFT', async () => {
  const harness = createHarness();
  const session = await signIn(harness.service);
  const practice = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);

  const afterRefresh = await harness.service.me(session.token);
  assert.equal(afterRefresh.interruptedNftPractice, null);
  assert.equal(practice.mode, SERVER_RUN_MODES.PRACTICE);
  assert.equal(practice.nftRun, undefined);
  assert.deepEqual(practice.practicePolicy, {
    public: true,
    walletRequired: false,
    minerRequired: false,
    xpEnabled: false,
    crystalsEnabled: false,
    label: 'ANYONE CAN PLAY · NO XP · NO CRYSTALS'
  });
  assert.deepEqual(harness.cancellations, []);

  const state = await harness.database.read();
  assert.equal(state.runs[practice.runId].status, 'active');
  assert.equal(state.runs[practice.runId].nftRun, undefined);
  assert.equal(state.wallets[account.address.toLowerCase()].profile.totalRuns, 0);
});

test('refresh recovery is unavailable without an active NFT Practice run', async () => {
  const harness = createHarness();
  const session = await signIn(harness.service);
  await assert.rejects(
    () => harness.service.restartInterruptedNftPractice(session.token),
    (error) => error.code === 'interrupted_nft_practice_missing'
  );
});

test('reward-bearing mines reject a wallet without a selected owned Miner before consuming its run', async () => {
  const harness = createHarness({ ownsMiner: false });
  const session = await signIn(harness.service);
  await harness.service.setPlayerIdentity(session.token, { name: 'GateTester' });

  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE, { minerId: 1 }),
    (error) => error.code === 'miner_nft_required'
  );

  const player = await harness.service.me(session.token);
  assert.equal(player.entitlements.freeRunAvailable, true);
  const state = await harness.database.read();
  assert.equal(Object.keys(state.runs).length, 0);
});
