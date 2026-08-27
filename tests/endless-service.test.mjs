import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { defaultEndlessConfig } from '../src/game/endlessMine.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ORIGIN = 'http://localhost:4173';

function harness({ ownsMiner = true, endlessRewardSettler = null } = {}) {
  let timestamp = Date.UTC(2026, 7, 26, 12);
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const nftGameplayService = {
    publicStatus: () => ({ enabled: true, chainId: 2020 }),
    async playerMiner(address, minerId) {
      if (!ownsMiner || address !== ADDRESS || minerId !== 7) return null;
      return {
        minerId,
        owner: address,
        progression: { bankedXp: 1_250, level: 6 },
        gameplay: { crystalCarryCapacity: 12, runLocked: false },
        traits: { level: 6, health: 150, damage: 20, armor: 4, speed: 1, luck: 1, crystalCarryCapacity: 12 },
        equipped: {}
      };
    }
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => timestamp,
    publicOrigin: ORIGIN,
    adminKey: 'endless-admin-key',
    verifySignature: async () => true,
    nftGameplayService,
    endlessRewardSettler,
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    service,
    advance(milliseconds) { timestamp += milliseconds; }
  };
}

async function login(service) {
  const challenge = await service.createChallenge({ address: ADDRESS, chainId: 2020, origin: ORIGIN });
  const session = await service.verifyChallenge({
    address: ADDRESS,
    nonce: challenge.nonce,
    signature: `0x${'11'.repeat(65)}`
  });
  await service.setPlayerIdentity(session.token, { name: 'EndlessMiner' });
  return session.token;
}

function completeEvents(manifest) {
  let tick = 1_000;
  const events = [];
  for (const enemy of manifest.map.objects.filter((object) => object.classification === 'natural')) {
    events.push({ type: 'enemy_killed', targetId: enemy.id, tick: tick += 100 });
  }
  for (const ore of manifest.map.objects.filter((object) => object.classification === 'ore')) {
    events.push({ type: 'ore_broken', targetId: ore.id, tick: tick += 100 });
    if (ore.mattCrystal) events.push({ type: 'crystal_collected', targetId: ore.id, tick: tick += 1 });
  }
  const guardian = manifest.map.objects.find((object) => object.classification === 'boss');
  events.push({ type: 'guardian_defeated', targetId: guardian.id, tick: tick += 100 });
  events.push({ type: 'phase_completed', tick: tick += 100 });
  return events;
}

test('Endless service enforces NFT ownership and starts with free fail-closed rewards', async () => {
  const missing = harness({ ownsMiner: false });
  const missingToken = await login(missing.service);
  await assert.rejects(
    () => missing.service.startRun(missingToken, 'endless', { minerId: 7 }),
    (error) => error.code === 'miner_nft_required'
  );

  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  const status = await active.service.endlessStatus();
  assert.equal(status.paidEntryEnabled, false);
  assert.equal(status.entryPriceMatt, 0);
  assert.equal(status.rewardsEnabled, false);
  assert.equal(run.currentPhase, 1);
  assert.equal(run.manifest.configVersion, run.configVersion);
});

test('heartbeats and bounded reconnects preserve a deep run checkpoint chain', async () => {
  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  const originalExpiry = run.expiresAt;

  active.advance(40_000);
  const heartbeat = await active.service.heartbeatEndlessRun(token, {
    runId: run.runId,
    runToken: run.runToken,
    checkpoint: run.checkpoint
  });
  assert.ok(heartbeat.expiresAt > originalExpiry);

  const reconnected = await active.service.reconnectEndlessRun(token, {
    runId: run.runId,
    runToken: run.runToken
  });
  active.advance(20_000);
  const accepted = await active.service.checkpointEndlessPhase(token, {
    runId: run.runId,
    runToken: run.runToken,
    previousCheckpoint: reconnected.checkpoint,
    events: completeEvents(run.manifest),
    action: 'descend'
  });
  assert.equal(accepted.run.currentPhase, 2);
  assert.equal(accepted.run.completedPhases, 1);
  assert.notEqual(accepted.nextManifest.fingerprint, run.manifest.fingerprint);
  assert.equal(accepted.phase.score, run.manifest.pointBudget);
});

test('Endless cannot reuse a Miner or wallet already active in another ranked run', async () => {
  const active = harness();
  const token = await login(active.service);
  await active.database.transact((state) => {
    state.runs.run_aaaaaaaaaaaaaaaaaaaaaaaa = {
      id: 'run_aaaaaaaaaaaaaaaaaaaaaaaa',
      address: ADDRESS,
      mode: 'paid',
      status: 'active',
      nftRun: { minerId: 7 }
    };
  });
  await assert.rejects(
    () => active.service.startRun(token, 'endless', { minerId: 7 }),
    (error) => error.code === 'ranked_run_active'
  );
});

test('a temporary reward failure keeps the banked run idempotently retryable', async () => {
  let attempts = 0;
  let settlementPayload;
  const active = harness({
    endlessRewardSettler: {
      async settle(input) {
        attempts += 1;
        settlementPayload = input;
        if (attempts === 1) throw new Error('temporary chain outage');
        return { transactionHash: `0x${'ab'.repeat(32)}`, crystalsBanked: 3, minerXpBanked: 10 };
      }
    }
  });
  const token = await login(active.service);
  const config = defaultEndlessConfig();
  config.rewards = {
    ...config.rewards,
    economyVersion: 'endless-test-v1',
    crystalConversionNumerator: 1,
    crystalConversionDenominator: 1,
    mineableCrystalUnits: 3_750,
    maximumPayoutNumerator: 10,
    maximumPayoutDenominator: 1,
    maximumDailyPayoutNumerator: 500,
    maximumDailyPayoutDenominator: 1,
    maximumPhases: 1_000_000,
    phaseXp: 10,
    maximumRunXp: 500,
    maximumWalletXpPerDay: 2_500,
    maximumMinerXpPerDay: 2_500,
    checkpointTimeoutSeconds: 86_400,
    failedRunsRetainXp: false
  };
  await active.service.publishEndlessConfig('endless-admin-key', {
    config,
    reason: 'Enable tested settlement retry values.'
  });
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  active.advance(20_000);
  const banked = await active.service.checkpointEndlessPhase(token, {
    runId: run.runId,
    runToken: run.runToken,
    previousCheckpoint: run.checkpoint,
    events: completeEvents(run.manifest),
    action: 'bank'
  });
  assert.equal(banked.rewardSettlement.pending, true);
  const retried = await active.service.retryEndlessSettlement(token, {
    runId: run.runId,
    runToken: run.runToken
  });
  assert.equal(retried.settled, true);
  assert.equal(attempts, 2);
  assert.equal(settlementPayload.maximumPayoutNumerator, 10);
  assert.equal(settlementPayload.maximumDailyPayoutNumerator, 500);
  assert.equal(settlementPayload.maximumRunXp, 500);
  assert.equal(settlementPayload.failedRunsRetainXp, false);
  const state = await active.database.read();
  assert.equal(state.endlessCompetition.runs[run.runId].rewardSettlement.settled, true);
  assert.equal(state.endlessCompetition.leaderboardEntries[0].crystalsBanked, 3);
});
