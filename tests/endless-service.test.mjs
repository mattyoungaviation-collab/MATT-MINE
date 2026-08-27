import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { defaultEndlessConfig } from '../src/game/endlessMine.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ORIGIN = 'http://localhost:4173';

function harness({ ownsMiner = true, endlessRewardSettler = null, endlessPaymentVerifier = null } = {}) {
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
    endlessPaymentVerifier,
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
  const state = await active.database.read();
  const bootstrap = state.endlessCompetition.configVersions[state.endlessCompetition.activeConfigVersion].config;
  assert.equal(bootstrap.rewards.economyVersion, 'endless-conservative-v1');
  assert.equal(bootstrap.rewards.crystalConversionNumerator, 1);
  assert.equal(bootstrap.rewards.crystalConversionDenominator, 400);
  assert.equal(bootstrap.rewards.enabled, false);
  assert.equal(run.currentPhase, 1);
  assert.equal(run.manifest.configVersion, run.configVersion);
});

test('paid Endless entry prepares, verifies, stores, and consumes one exact MATT transfer', async () => {
  const paymentHash = `0x${'cd'.repeat(32)}`;
  let verifiedInput;
  const active = harness({
    endlessPaymentVerifier: {
      publicStatus() {
        return {
          configured: true,
          chainId: 2020,
          asset: 'MATT',
          token: '0xa5450417bdca0bdfb058ffe41205400ffda1174d',
          recipient: '0xbace355d23d378a6e1add986e53a18dd12e6eeac',
          decimals: 18,
          confirmations: 3
        };
      },
      transactionForPayment(mattPrice) {
        return { to: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d', value: '0x0', data: `0x${String(mattPrice).padStart(8, '0')}` };
      },
      async verifyPayment(input) {
        verifiedInput = input;
        return {
          key: `${paymentHash}:2`,
          transactionHash: paymentHash,
          logIndex: 2,
          blockNumber: '123',
          transactionBlockAt: Date.UTC(2026, 7, 26, 11, 59),
          chainId: 2020,
          asset: 'MATT',
          token: '0xa5450417bdca0bdfb058ffe41205400ffda1174d',
          payer: ADDRESS,
          recipient: '0xbace355d23d378a6e1add986e53a18dd12e6eeac',
          decimals: 18,
          amountMatt: 2_500_000,
          amountRaw: '2500000000000000000000000',
          confirmations: 3
        };
      }
    }
  });
  const token = await login(active.service);
  const state = await active.database.read();
  const config = structuredClone(state.endlessCompetition.configVersions[1].config);
  config.entry = { paidEnabled: true, mattPrice: 2_500_000 };
  await active.service.publishEndlessConfig('endless-admin-key', {
    config,
    reason: 'Exercise exact paid Endless entry verification.'
  });
  const status = await active.service.endlessStatus();
  assert.equal(status.paidEntryEnabled, true);
  assert.equal(status.entryPriceMatt, 2_500_000);
  assert.equal(status.paymentReady, true);
  assert.equal(status.payment.recipient, '0xbace355d23d378a6e1add986e53a18dd12e6eeac');
  assert.equal(status.entryTransaction.value, '0x0');
  await assert.rejects(
    () => active.service.startRun(token, 'endless', { minerId: 7 }),
    (error) => error.code === 'endless_payment_confirmation_required' || error.code === 'invalid_transaction_hash'
  );
  const run = await active.service.startRun(token, 'endless', {
    minerId: 7,
    entryTransactionHash: paymentHash
  });
  assert.deepEqual(verifiedInput, { transactionHash: paymentHash, address: ADDRESS, mattPrice: 2_500_000 });
  assert.equal(run.payment.status, 'confirmed');
  assert.equal(run.payment.amountMatt, 2_500_000);
  assert.equal(run.payment.transactionHash, paymentHash);
  const stored = await active.database.read();
  assert.equal(stored.endlessCompetition.paymentTransactions[paymentHash].runId, run.runId);
  assert.equal(stored.endlessCompetition.runs[run.runId].payment.amountRaw, '2500000000000000000000000');
  await assert.rejects(
    () => active.service.startRun(token, 'endless', { minerId: 7, entryTransactionHash: paymentHash }),
    (error) => error.code === 'payment_already_consumed'
  );
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
  const chainRun = {
    runId: `0x${'31'.repeat(32)}`,
    versionId: `0x${'41'.repeat(32)}`,
    loadoutHash: `0x${'51'.repeat(32)}`,
    checkpointDigest: `0x${'00'.repeat(32)}`,
    nonce: '0',
    completedPhases: 0,
    minedCrystalUnits: 0
  };
  const active = harness({
    endlessRewardSettler: {
      async beginRun() {
        return { transactionHash: `0x${'61'.repeat(32)}`, chainRun };
      },
      async checkpoint(input) {
        return {
          transactionHash: `0x${'71'.repeat(32)}`,
          chainRun: {
            ...chainRun,
            checkpointDigest: `0x${input.rollingDigest}`,
            completedPhases: input.completedPhases,
            minedCrystalUnits: input.minedCrystalUnits
          }
        };
      },
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
  const run = await active.service.startRun(token, 'endless', {
    minerId: 7,
    authorization: { player: ADDRESS },
    playerSignature: `0x${'11'.repeat(65)}`
  });
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
  assert.equal(settlementPayload.chainRun.completedPhases, 1);
  const state = await active.database.read();
  assert.equal(state.endlessCompetition.runs[run.runId].rewardSettlement.settled, true);
  assert.equal(state.endlessCompetition.leaderboardEntries[0].crystalsBanked, 3);
});
