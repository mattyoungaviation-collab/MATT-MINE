import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { defaultEndlessConfig } from '../src/game/endlessMine.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ORIGIN = 'http://localhost:4173';

function harness({ ownsMiner = true, endlessRewardSettler = null, endlessPaymentVerifier = null, competitiveReplayValidator = null } = {}) {
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
        gameplay: { carryCapacity: 12, runLocked: false },
        traits: { level: 6, health: 150, damage: 20, armor: 4, speed: 1, luck: 1, baseCarryCapacity: 12 },
        effectiveTraits: { carryCapacity: 12 },
        equipped: {}
      };
    }
  };
  const replayValidator = competitiveReplayValidator || {
    async registerEndlessPhase(run) {
      return { throughSeq: 0, throughTick: 0, transcriptHash: `phase-${run.currentPhase}-${run.phaseAttempt}`, signature: 'test-input-signature' };
    },
    async appendEndlessPhase() {
      return { throughSeq: 1, throughTick: 1_000, transcriptHash: 'test-inputs', signature: 'test-input-signature' };
    },
    async verifyEndlessPhase({ run }) {
      return {
        outcomeEvents: completeEvents(run.manifest),
        evidence: { schemaVersion: 'test-replay-v1', eventCount: 1, transcriptHash: 'test-inputs', runtime: {}, rawScore: 0, state: 'verified' }
      };
    },
    async finalizeEndlessPhase() {}
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => timestamp,
    publicOrigin: ORIGIN,
    adminKey: 'endless-admin-key',
    verifySignature: async () => true,
    nftGameplayService,
    endlessPaymentVerifier,
    endlessRewardSettler,
    competitiveReplayValidator: replayValidator,
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

test('starting Endless automatically clears a wallet ghost row when Ronin has no active run', async () => {
  const active = harness({
    endlessRewardSettler: {
      async activeRun() { return null; }
    }
  });
  const token = await login(active.service);
  const ghost = await active.service.startRun(token, 'endless', { minerId: 7 });
  await active.database.transact((state) => {
    const run = state.endlessCompetition.runs[ghost.runId];
    run.chainRun = { runId: `0x${'ab'.repeat(32)}` };
    run.config.rewards.enabled = true;
    state.runs[ghost.runId] = run;
  });

  const prepared = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(prepared.eligible, true);
  let state = await active.database.read();
  assert.equal(state.endlessCompetition.runs[ghost.runId].status, 'expired');
  assert.equal(state.endlessCompetition.runs[ghost.runId].finishReason, 'chain_unlocked');

  const replacement = await active.service.startRun(token, 'endless', { minerId: 7 });
  state = await active.database.read();
  assert.notEqual(replacement.runId, ghost.runId);
  assert.equal(state.endlessCompetition.runs[replacement.runId].status, 'active');
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
  const publicOverview = await active.service.publicMineSlots();
  const publicSlot = publicOverview.slots.find((slot) => slot.id === 'endless');
  assert.equal(publicSlot.freeEntry, false);
  assert.equal(publicSlot.entryPriceMatt, 2_500_000);
  assert.match(publicSlot.subtitle, /Exact 2,500,000 MATT entry/);
  assert.deepEqual(publicSlot.entryRules, {
    entriesPerWallet: 0,
    entriesPerMiner: 0,
    resetPeriodHours: 24,
    resetUtcHour: 0,
    cooldownSeconds: 0,
    minimumMinerLevel: 1
  });
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

test('entry preflight enforces adjustable wallet, Miner, reset, cooldown, active-run, level, and abandon rules before payment', async () => {
  const active = harness();
  const token = await login(active.service);
  const state = await active.database.read();
  const config = structuredClone(state.endlessCompetition.configVersions[1].config);
  config.entry = {
    ...config.entry,
    entriesPerWallet: 1,
    entriesPerMiner: 1,
    resetPeriodHours: 24,
    resetUtcHour: 0,
    cooldownSeconds: 3_600,
    maximumActiveRunsPerWallet: 1,
    minimumMinerLevel: 6,
    abandonedRunsConsumeEntry: false
  };
  await active.service.publishEndlessConfig('endless-admin-key', {
    config,
    reason: 'Exercise adjustable Endless entry participation controls.'
  });
  const prepared = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(prepared.eligible, true);
  assert.equal(prepared.entryRules.entriesPerWallet, 1);
  assert.equal(prepared.entryRules.entriesPerMiner, 1);
  assert.equal(prepared.entryRules.maximumActiveRunsPerMiner, 1);
  assert.equal(prepared.usage.walletEntriesUsed, 0);
  assert.equal(prepared.usage.walletEntriesRemaining, 1);
  assert.equal(prepared.entryTransaction, null);

  const first = await active.service.startRun(token, 'endless', { minerId: 7 });
  await assert.rejects(
    () => active.service.prepareEndlessEntry(token, { minerId: 7 }),
    (error) => error.code === 'endless_wallet_active_limit'
  );
  await active.service.abandonEndlessRun(token, {
    runId: first.runId,
    runToken: first.runToken,
    reason: 'abandoned'
  });
  const afterAbandon = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(afterAbandon.usage.walletEntriesUsed, 0);
  assert.equal(afterAbandon.usage.cooldownEndsAt, 0);

  const second = await active.service.startRun(token, 'endless', { minerId: 7 });
  await active.database.transact((current) => {
    current.endlessCompetition.runs[second.runId].status = 'banked';
    current.runs[second.runId].status = 'banked';
  });
  await assert.rejects(
    () => active.service.prepareEndlessEntry(token, { minerId: 7 }),
    (error) => error.code === 'endless_wallet_entry_limit'
  );
  const cooldownOnly = structuredClone(config);
  cooldownOnly.entry.entriesPerWallet = 0;
  cooldownOnly.entry.entriesPerMiner = 0;
  await active.service.publishEndlessConfig('endless-admin-key', {
    config: cooldownOnly,
    reason: 'Exercise the independent Endless entry cooldown control.'
  });
  await assert.rejects(
    () => active.service.prepareEndlessEntry(token, { minerId: 7 }),
    (error) => error.code === 'endless_entry_cooldown'
  );
  active.advance(60 * 60 * 1_000);
  const cooledDown = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(cooledDown.usage.cooldownEndsAt, second.startedAt + 3_600_000);
  active.advance(11 * 60 * 60 * 1_000);
  const reset = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(reset.usage.walletEntriesUsed, 0);
  assert.equal(reset.usage.walletEntriesRemaining, null);

  const stricter = structuredClone(config);
  stricter.entry.minimumMinerLevel = 7;
  await active.service.publishEndlessConfig('endless-admin-key', {
    config: stricter,
    reason: 'Raise the tested minimum Miner level requirement.'
  });
  await assert.rejects(
    () => active.service.prepareEndlessEntry(token, { minerId: 7 }),
    (error) => error.code === 'endless_miner_level_required'
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

test('the signed-in wallet can rotate a lost token and resume its active Endless run', async () => {
  const active = harness();
  const token = await login(active.service);
  const started = await active.service.startRun(token, 'endless', { minerId: 7 });

  const resumed = await active.service.resumeEndlessRun(token, { minerId: 7 });

  assert.equal(resumed.runId, started.runId);
  assert.equal(resumed.currentPhase, 1);
  assert.notEqual(resumed.runToken, started.runToken);
  await assert.rejects(
    () => active.service.reconnectEndlessRun(token, {
      runId: started.runId,
      runToken: started.runToken
    }),
    (error) => error.code === 'run_token_rejected'
  );
  const heartbeat = await active.service.heartbeatEndlessRun(token, {
    runId: resumed.runId,
    runToken: resumed.runToken,
    checkpoint: resumed.checkpoint
  });
  assert.ok(heartbeat.expiresAt >= resumed.expiresAt);
});

test('a lost bank response can retry the same signed checkpoint and recover the saved result', async () => {
  const active = harness();
  const token = await login(active.service);
  const started = await active.service.startRun(token, 'endless', { minerId: 7 });
  const inputCheckpoint = await active.service.appendEndlessInputs(token, {
    runId: started.runId,
    runToken: started.runToken,
    previousCheckpoint: started.inputCheckpoint,
    events: [{ seq: 1, type: 'command', tick: 1_000, command: 'extract' }]
  });
  const request = {
    runId: started.runId,
    runToken: started.runToken,
    previousCheckpoint: started.checkpoint,
    inputCheckpoint: inputCheckpoint.inputCheckpoint,
    action: 'bank'
  };

  const first = await active.service.checkpointEndlessPhase(token, request);
  const recovered = await active.service.checkpointEndlessPhase(token, request);

  assert.equal(first.summary.status, 'banked');
  assert.equal(recovered.summary.status, 'banked');
  assert.equal(recovered.summary.totalScore, first.summary.totalScore);
  assert.equal(recovered.checkpoint.signature, first.checkpoint.signature);
  assert.equal(recovered.alreadyAccepted, true);
});

test('a confirmed Ronin checkpoint resyncs the bank before reward settlement', async () => {
  const authoritativeDigest = 'ef'.repeat(32);
  let settlementPayload = null;
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
      async assertEconomyConfig() {
        return { economyVersion: 'endless-test-v1', versionId: `0x${'41'.repeat(32)}` };
      },
      async beginRun() {
        return { transactionHash: `0x${'61'.repeat(32)}`, chainRun };
      },
      async checkpoint() {
        return {
          recovered: true,
          resynced: true,
          transactionHash: '',
          chainRun: {
            ...chainRun,
            checkpointDigest: `0x${authoritativeDigest}`,
            completedPhases: 1,
            minedCrystalUnits: 3
          }
        };
      },
      async settle(input) {
        settlementPayload = structuredClone(input);
        return { transactionHash: `0x${'ab'.repeat(32)}`, crystalsBanked: 3, minerXpBanked: 10 };
      }
    }
  });
  const token = await login(active.service);
  const config = defaultEndlessConfig();
  config.rewards = {
    ...config.rewards,
    enabled: true,
    crystalsEnabled: true,
    minerXpEnabled: true,
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
    reason: 'Exercise authoritative Ronin checkpoint recovery.'
  });
  const started = await active.service.startRun(token, 'endless', {
    minerId: 7,
    authorization: { player: ADDRESS },
    playerSignature: `0x${'11'.repeat(65)}`
  });
  active.advance(20_000);

  const banked = await active.service.checkpointEndlessPhase(token, {
    runId: started.runId,
    runToken: started.runToken,
    previousCheckpoint: started.checkpoint,
    action: 'bank'
  });

  assert.equal(banked.summary.status, 'banked');
  assert.equal(banked.summary.crystalsCarried, 3);
  assert.equal(banked.checkpoint.digest, authoritativeDigest);
  assert.equal(settlementPayload.completedPhases, 1);
  assert.equal(settlementPayload.minedCrystalUnits, 3);
  assert.equal(settlementPayload.rollingDigest, authoritativeDigest);
  assert.equal(settlementPayload.chainRun.checkpointDigest, `0x${authoritativeDigest}`);
  const state = await active.database.read();
  const stored = state.endlessCompetition.runs[started.runId];
  assert.equal(stored.rollingDigest, authoritativeDigest);
  assert.equal(stored.phaseHistory.at(-1).digest, authoritativeDigest);
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
      async assertEconomyConfig() {
        return { economyVersion: 'endless-test-v1', versionId: `0x${'41'.repeat(32)}` };
      },
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
  const pendingPlayer = await active.service.endlessPlayer(token);
  assert.equal(pendingPlayer.history[0].rewardPending, true);
  assert.equal(pendingPlayer.history[0].rewardSettled, false);
  await active.service.updateEndlessOperations('endless-admin-key', {
    patch: { rewardsEnabled: false },
    reason: 'Pause settlement while preserving the verified reward queue.'
  });
  await assert.rejects(
    () => active.service.retryEndlessSettlement(token, {
      runId: run.runId
    }),
    (error) => error.code === 'endless_rewards_paused'
  );
  await active.service.updateEndlessOperations('endless-admin-key', {
    patch: { rewardsEnabled: true },
    reason: 'Restore settlement after verifying the reward queue pause.'
  });
  const retried = await active.service.retryEndlessSettlement(token, {
    runId: run.runId
  });
  assert.equal(retried.settled, true);
  assert.equal(attempts, 2);
  assert.equal(settlementPayload.maximumPayoutNumerator, 10);
  assert.equal(settlementPayload.maximumDailyPayoutNumerator, 500);
  assert.equal(settlementPayload.maximumRunXp, 500);
  assert.equal(settlementPayload.failedRunsRetainXp, false);
  assert.equal(settlementPayload.chainRun.completedPhases, 1);
  assert.equal(settlementPayload.fromTransactionHash, `0x${'71'.repeat(32)}`);
  const state = await active.database.read();
  assert.equal(state.endlessCompetition.runs[run.runId].rewardSettlement.settled, true);
  assert.equal(state.endlessCompetition.leaderboardEntries[0].crystalsBanked, 3);
  const settledPlayer = await active.service.endlessPlayer(token);
  assert.equal(settledPlayer.history[0].rewardPending, false);
  assert.equal(settledPlayer.history[0].rewardSettled, true);
  assert.equal(settledPlayer.history[0].minerXpBanked, 10);
});

test('audited Endless operations immediately gate entries, banking, phase depth, and leaderboards', async () => {
  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  const paused = await active.service.updateEndlessOperations('endless-admin-key', {
    patch: {
      newEntriesEnabled: false,
      bankingEnabled: false,
      leaderboardSubmissionsEnabled: false,
      temporaryMaximumPhase: 1,
      monitoringWindowHours: 48,
      alertThresholds: { unexpectedlyDeepPhase: 2, maximumFlaggedRuns: 0 }
    },
    reason: 'Exercise immediate audited operations controls.'
  });
  assert.equal(paused.newEntriesEnabled, false);
  assert.equal(paused.monitoringWindowHours, 48);
  assert.equal(paused.alertThresholds.unexpectedlyDeepPhase, 2);
  const publicDetail = await active.service.publicMineSlot('endless');
  assert.equal(publicDetail.slot.state, 'paused');
  assert.equal(publicDetail.slot.entriesPaused, true);
  assert.equal(publicDetail.leaderboard.paused, true);
  assert.deepEqual(publicDetail.leaderboard.rows, []);
  await assert.rejects(
    () => active.service.prepareEndlessEntry(token, { minerId: 7 }),
    (error) => error.code === 'endless_entries_paused'
  );
  active.advance(20_000);
  await assert.rejects(
    () => active.service.checkpointEndlessPhase(token, {
      runId: run.runId,
      runToken: run.runToken,
      previousCheckpoint: run.checkpoint,
      action: 'bank'
    }),
    (error) => error.code === 'endless_banking_paused'
  );
  await assert.rejects(
    () => active.service.checkpointEndlessPhase(token, {
      runId: run.runId,
      runToken: run.runToken,
      previousCheckpoint: run.checkpoint,
      action: 'descend'
    }),
    (error) => error.code === 'endless_temporary_phase_limit'
  );
  await active.service.updateEndlessOperations('endless-admin-key', {
    patch: { bankingEnabled: true, temporaryMaximumPhase: 0 },
    reason: 'Restore banking after the operations control test.'
  });
  const banked = await active.service.checkpointEndlessPhase(token, {
    runId: run.runId,
    runToken: run.runToken,
    previousCheckpoint: run.checkpoint,
    action: 'bank'
  });
  assert.equal(banked.summary.status, 'banked');
  const state = await active.database.read();
  assert.equal(state.endlessCompetition.leaderboardEntries.length, 0);
  assert.equal(state.audit.at(-1).action, 'ENDLESS_OPERATIONS_UPDATED');
});

test('Endless Admin monitoring and run review expose adjustable alerts and authoritative detail', async () => {
  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  active.advance(20_000);
  await active.service.checkpointEndlessPhase(token, {
    runId: run.runId,
    runToken: run.runToken,
    previousCheckpoint: run.checkpoint,
    action: 'bank'
  });
  await active.service.updateEndlessOperations('endless-admin-key', {
    patch: { alertThresholds: { unexpectedlyDeepPhase: 1 } },
    reason: 'Lower the depth alert for monitoring verification.'
  });
  const overview = await active.service.adminEndless('endless-admin-key');
  assert.equal(overview.monitoring.counts.completedRuns, 1);
  assert.equal(overview.monitoring.performance.deepestPhase, 1);
  assert.ok(overview.monitoring.alerts.some((alert) => alert.code === 'unexpected_depth'));
  assert.equal(overview.operations.alertThresholds.unexpectedlyDeepPhase, 1);
  const review = await active.service.adminEndlessRun('endless-admin-key', run.runId);
  assert.equal(review.wallet, ADDRESS);
  assert.equal(review.minerId, 7);
  assert.equal(review.highestPhase, 1);
  assert.equal(review.phaseHistory.length, 1);
  assert.equal(review.verification.status, 'verified');
  assert.equal(review.configVersion, 1);
});

test('Endless player history and both boards expose exact verified run totals', async () => {
  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  active.advance(20_000);
  await active.service.checkpointEndlessPhase(token, {
    runId: run.runId,
    runToken: run.runToken,
    previousCheckpoint: run.checkpoint,
    action: 'bank'
  });

  const player = await active.service.endlessPlayer(token);
  assert.equal(player.lifetime.totalRuns, 1);
  assert.equal(player.lifetime.verifiedRuns, 1);
  assert.equal(player.lifetime.deepestPhase, 1);
  assert.equal(player.lifetime.highestScore, player.history[0].score);
  assert.equal(player.history[0].minerId, 7);
  assert.equal(player.history[0].minerLevel, 6);
  assert.equal(player.history[0].verificationStatus, 'verified');
  assert.equal(player.history[0].scoreRank, 1);
  assert.equal(player.history[0].depthRank, 1);
  assert.ok(Object.keys(player.history[0].scoreBreakdown).length > 0);
  assert.ok(Object.keys(player.history[0].enemyBreakdown).length > 0);
  assert.ok(Object.keys(player.history[0].oreBreakdown).length > 0);

  const score = await active.service.endlessLeaderboard(token, 'all-time', 'score');
  const deepest = await active.service.endlessLeaderboard(token, 'all-time', 'deepest');
  assert.equal(score.player.rank, 1);
  assert.equal(score.rows[0].minerLevel, 6);
  assert.equal(score.rows[0].verificationStatus, 'verified');
  assert.equal(deepest.player.runId, run.runId);
  await assert.rejects(
    () => active.service.endlessLeaderboard(token, 'weekly', 'deepest'),
    (error) => error.code === 'endless_deepest_scope'
  );
  await assert.rejects(
    () => active.service.endlessLeaderboard(token, 'unknown', 'score'),
    (error) => error.code === 'endless_leaderboard_scope'
  );
});

test('Admin termination preserves a suspicious Endless run as rejected and releases its active slot', async () => {
  const active = harness();
  const token = await login(active.service);
  const run = await active.service.startRun(token, 'endless', { minerId: 7 });
  const rejected = await active.service.terminateEndlessRun('endless-admin-key', run.runId, {
    reason: 'Reject suspicious behavior during an operations review.'
  });
  assert.equal(rejected.status, 'rejected');
  const state = await active.database.read();
  assert.equal(state.endlessCompetition.runs[run.runId].status, 'rejected');
  assert.equal(state.endlessCompetition.runs[run.runId].adminReview.decision, 'rejected');
  assert.equal(state.audit.at(-1).action, 'ENDLESS_RUN_REJECTED');
  await active.service.updateEndlessOperations('endless-admin-key', {
    patch: { newEntriesEnabled: true },
    reason: 'Confirm the rejected run released the active slot.'
  });
  const prepared = await active.service.prepareEndlessEntry(token, { minerId: 7 });
  assert.equal(prepared.eligible, true);
});
