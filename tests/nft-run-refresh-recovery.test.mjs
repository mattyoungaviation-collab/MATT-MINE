import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';
import { resolveCompetitionSnapshot } from '../src/game/competitionStudio.js';

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

function createHarness({ ownsMiner = true, initialLocked = false, lockContract = 'standard' } = {}) {
  let randomCounter = 0;
  let standardLocked = initialLocked && lockContract === 'standard';
  let endlessLocked = initialLocked && lockContract === 'endless';
  let unknownLocked = initialLocked && lockContract === 'unknown';
  const cancellations = [];
  const endlessCancellations = [];
  const finalized = [];
  const database = new MemoryDatabase();
  const nftGameplayService = {
    publicStatus: () => ({ enabled: true, chainId: 202601 }),
    async activeMap(mode) {
      const normalizedMode = String(mode).toLowerCase() === 'arena' ? 'arena' : 'paid';
      const slot = normalizedMode === 'arena' ? 'arena' : 'pass';
      const state = await database.read();
      const snapshot = resolveCompetitionSnapshot(state.competitionStudio, slot, START);
      const seed = String(snapshot.id || `${slot}-${START}`);
      const fingerprint = String(snapshot.fingerprint || '').replace(/^0x/, '');
      return {
        approved: true,
        retired: false,
        mapId: `0x${createHash('sha256').update(`matt-mine-map:${normalizedMode}:${seed}`).digest('hex')}`,
        contentHash: /^[a-f0-9]{64}$/i.test(fingerprint)
          ? `0x${fingerprint.toLowerCase()}`
          : `0x${createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}`
      };
    },
    async playerMiner(_address, requestedMinerId = 0) {
      if (!ownsMiner) return null;
      return minerProfile(standardLocked || endlessLocked || unknownLocked, requestedMinerId || 1);
    },
    async beginRun({ serverRunId }) {
      standardLocked = true;
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
      const cancelled = standardLocked;
      standardLocked = false;
      return { cancelled, minerId };
    }
  };
  const endlessRewardSettler = {
    async cancelRun({ minerId }) {
      endlessCancellations.push(minerId);
      const cancelled = endlessLocked;
      endlessLocked = false;
      return { cancelled, minerId };
    }
  };
  const competitiveReplayValidator = {
    publicStatus: () => ({ modes: [SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.PAID] }),
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
    endlessRewardSettler,
    competitiveReplayValidator,
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    service,
    cancellations,
    endlessCancellations,
    finalized,
    unlockStandard() { standardLocked = false; }
  };
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

test('an owned Miner with an orphaned on-chain run can be explicitly unlocked', async () => {
  const harness = createHarness({ initialLocked: true });
  const session = await signIn(harness.service);

  const result = await harness.service.recoverLockedMinerRun(session.token, { minerId: 1 });

  assert.equal(result.recovered, true);
  assert.equal(result.minerId, 1);
  assert.equal(result.profile.gameplay.runLocked, false);
  assert.deepEqual(harness.cancellations, [1]);
  const state = await harness.database.read();
  assert.equal(state.audit.at(-1).action, 'NFT_V2_ORPHAN_RUN_RECOVERED');
});

test('a progressed Endless Miner stays recoverable after Admin already ended its server run', async () => {
  const harness = createHarness({ initialLocked: true, lockContract: 'endless' });
  const session = await signIn(harness.service);
  const runId = `run_${'6'.repeat(24)}`;
  await harness.database.transact((state) => {
    const run = {
      id: runId,
      address: session.address,
      mode: 'endless',
      status: 'expired',
      minerId: 1,
      chainRun: { runId: `0x${'7'.repeat(64)}` },
      startedAt: START - 60_000,
      expiresAt: START,
      finishedAt: START,
      result: null
    };
    state.runs[runId] = structuredClone(run);
    state.endlessCompetition.runs[runId] = structuredClone(run);
  });

  const result = await harness.service.recoverLockedMinerRun(session.token, { minerId: 1 });

  assert.equal(result.recovered, true);
  assert.equal(result.settlementRoute, 'endless');
  assert.equal(result.profile.gameplay.runLocked, false);
  assert.deepEqual(result.reconciledRunIds, [runId]);
  assert.deepEqual(harness.cancellations, [1]);
  assert.deepEqual(harness.endlessCancellations, [1]);
  assert.equal((await harness.database.read()).runs[runId].status, 'expired');
});

test('locked-run recovery never reports success while Ronin still reports the Miner locked', async () => {
  const harness = createHarness({ initialLocked: true, lockContract: 'unknown' });
  const session = await signIn(harness.service);

  await assert.rejects(
    () => harness.service.recoverLockedMinerRun(session.token, { minerId: 1 }),
    (error) => error.code === 'nft_run_recovery_incomplete'
  );

  assert.deepEqual(harness.cancellations, [1]);
  assert.deepEqual(harness.endlessCancellations, [1]);
  assert.equal((await harness.database.read()).audit.some((entry) => entry.action === 'NFT_V2_ORPHAN_RUN_RECOVERED'), false);
});

test('orphan recovery rejects a Miner that the signed-in wallet does not own', async () => {
  const harness = createHarness({ ownsMiner: false, initialLocked: true });
  const session = await signIn(harness.service);

  await assert.rejects(
    () => harness.service.recoverLockedMinerRun(session.token, { minerId: 1 }),
    (error) => error.code === 'miner_nft_required'
  );
  assert.deepEqual(harness.cancellations, []);
});

test('reward-bearing mines reject a wallet without a selected owned Miner before consuming its run', async () => {
  const harness = createHarness({ ownsMiner: false });
  const session = await signIn(harness.service);
  await harness.service.setPlayerIdentity(session.token, { name: 'GateTester' });

  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PAID, { minerId: 1 }),
    (error) => error.code === 'miner_nft_required'
  );

  const state = await harness.database.read();
  assert.equal(Object.keys(state.runs).length, 0);
});

test('legacy retired run modes remain closed after Endless becomes permanent', async () => {
  const harness = createHarness();
  const session = await signIn(harness.service);

  for (const mode of [SERVER_RUN_MODES.FREE, SERVER_RUN_MODES.WEEKLY]) {
    await assert.rejects(
      () => harness.service.startRun(session.token, mode, { minerId: 1 }),
      (error) => error.code === 'mine_retired'
    );
  }
  assert.equal(Object.keys((await harness.database.read()).runs).length, 0);
});

test('a Pass Mine credit is restored when the NFT transaction definitely never starts', async () => {
  const harness = createHarness();
  const runId = `run_${'a'.repeat(24)}`;
  const address = account.address.toLowerCase();
  await harness.database.transact((state) => {
    state.runs[runId] = {
      id: runId,
      address,
      mode: SERVER_RUN_MODES.PAID,
      status: 'active',
      startedAt: START,
      expiresAt: START + 60_000,
      result: null
    };
    state.paidEntitlements.credit = {
      key: 'credit',
      transactionHash: `0x${'9'.repeat(64)}`,
      logIndex: 0,
      blockNumber: '1',
      address,
      entitlementId: '1',
      ronPaid: '1',
      mattBought: '0',
      currentPoolMatt: '0',
      futureRewardsMatt: '0',
      reserveMatt: '0',
      confirmedAt: START - 1,
      consumedAt: START,
      usedRunId: runId
    };
  });

  await harness.service.rollbackUnstartedPaidNftRun(address, runId);
  const state = await harness.database.read();
  assert.equal(state.runs[runId].status, 'expired');
  assert.equal(state.paidEntitlements.credit.consumedAt, 0);
  assert.equal(state.paidEntitlements.credit.usedRunId, '');
  assert.equal(
    state.audit.at(-1).action,
    'NFT_V2_START_ROLLED_BACK'
  );
});

test('orphan recovery reconciles a pending Pass reservation even after the Miner is already unlocked', async () => {
  const harness = createHarness({ initialLocked: false });
  const session = await signIn(harness.service);
  const runId = `run_${'b'.repeat(24)}`;
  const address = account.address.toLowerCase();
  await harness.database.transact((state) => {
    state.runs[runId] = {
      id: runId,
      address,
      mode: SERVER_RUN_MODES.PAID,
      status: 'active',
      startedAt: START,
      expiresAt: START + 60_000,
      result: null,
      pendingNftRun: { minerId: 1, mode: 'paid', mapVersion: 'map', reservedAt: START }
    };
    state.paidEntitlements.pending = {
      key: 'pending',
      transactionHash: `0x${'8'.repeat(64)}`,
      logIndex: 0,
      blockNumber: '1',
      address,
      entitlementId: '2',
      ronPaid: '1',
      mattBought: '0',
      currentPoolMatt: '0',
      futureRewardsMatt: '0',
      reserveMatt: '0',
      confirmedAt: START - 1,
      consumedAt: START,
      usedRunId: runId
    };
  });

  const recovered = await harness.service.recoverLockedMinerRun(session.token, { minerId: 1 });
  const state = await harness.database.read();
  assert.equal(recovered.recovered, true);
  assert.deepEqual(recovered.reconciledRunIds, [runId]);
  assert.equal(recovered.restoredPassCredits, 1);
  assert.equal(state.runs[runId].status, 'expired');
  assert.equal(state.runs[runId].pendingNftRun, undefined);
  assert.equal(state.paidEntitlements.pending.consumedAt, 0);
  assert.equal(state.paidEntitlements.pending.usedRunId, '');
  assert.deepEqual(harness.cancellations, []);
});

test('orphan recovery uses the lifecycle mutation barrier and cannot overtake Admin termination', async () => {
  const harness = createHarness({ initialLocked: true });
  const session = await signIn(harness.service);
  const runId = `run_${'d'.repeat(24)}`;
  const address = account.address.toLowerCase();
  let mutationEntries = 0;
  const originalMutation = harness.database.withNftLifecycleMutation.bind(harness.database);
  harness.database.withNftLifecycleMutation = async (operation) => {
    mutationEntries += 1;
    return originalMutation(operation);
  };
  await harness.database.transact((state) => {
    state.runs[runId] = {
      id: runId,
      address,
      mode: SERVER_RUN_MODES.PAID,
      status: 'awaiting-revive',
      startedAt: START,
      expiresAt: START + 60_000,
      result: null,
      nftRun: { minerId: 1, runId: `0x${'3'.repeat(64)}` },
      pendingRevive: { id: 'revive-admin-race', status: 'pending' },
      adminTerminationPending: {
        id: 'adminterm-recovery',
        requestedAt: START,
        context: 'Support termination'
      }
    };
  });

  await assert.rejects(
    () => harness.service.recoverLockedMinerRun(session.token, { minerId: 1 }),
    (error) => error.code === 'run_admin_termination_pending'
  );

  const run = (await harness.database.read()).runs[runId];
  assert.equal(mutationEntries, 1);
  assert.equal(run.status, 'awaiting-revive');
  assert.equal(run.pendingRevive.status, 'pending');
  assert.deepEqual(harness.cancellations, []);
});

test('orphan recovery refuses to clear a reservation that changed during cancellation', async () => {
  const harness = createHarness({ initialLocked: true });
  const session = await signIn(harness.service);
  const runId = `run_${'e'.repeat(24)}`;
  const address = account.address.toLowerCase();
  await harness.database.transact((state) => {
    state.runs[runId] = {
      id: runId,
      address,
      mode: SERVER_RUN_MODES.PAID,
      status: 'active',
      startedAt: START,
      expiresAt: START + 60_000,
      result: null,
      nftRun: { minerId: 1, runId: `0x${'4'.repeat(64)}` }
    };
  });
  harness.service.nftGameplayService.cancelRun = async () => {
    harness.unlockStandard();
    await harness.database.transact((state) => {
      state.runs[runId].nftRun.runId = `0x${'5'.repeat(64)}`;
    });
    return { cancelled: true, minerId: 1 };
  };

  await assert.rejects(
    () => harness.service.recoverLockedMinerRun(session.token, { minerId: 1 }),
    (error) => error.code === 'nft_run_recovery_reservation_changed'
  );

  const run = (await harness.database.read()).runs[runId];
  assert.equal(run.status, 'active');
  assert.equal(run.nftRun.runId, `0x${'5'.repeat(64)}`);
});

test('post-begin attachment only succeeds for the exact active pending reservation', async () => {
  const harness = createHarness();
  const runId = `run_${'c'.repeat(24)}`;
  const address = account.address.toLowerCase();
  await harness.database.transact((state) => {
    state.runs[runId] = {
      id: runId,
      address,
      mode: SERVER_RUN_MODES.PAID,
      status: 'expired',
      startedAt: START,
      expiresAt: START,
      finishedAt: START,
      result: null,
      pendingNftRun: { minerId: 1, mode: 'paid', mapVersion: 'map', reservedAt: START }
    };
  });

  await assert.rejects(
    () => harness.service.attachStartedPaidNftRun(address, runId, 1, {
      minerId: 1,
      runId: `0x${'1'.repeat(64)}`
    }, {}),
    (error) => error.code === 'nft_server_run_not_active'
  );
  const state = await harness.database.read();
  assert.equal(state.runs[runId].nftRun, undefined);
  assert.equal(state.runs[runId].pendingNftRun.minerId, 1);
});
