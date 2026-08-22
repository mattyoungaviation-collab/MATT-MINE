import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import { AdminMattMineService } from '../server/admin-service.js';
import { MemoryDatabase } from '../server/database.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 7, 22, 0, 0, 0);
const TEST_PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const account = privateKeyToAccount(TEST_PRIVATE_KEY);
const ON_CHAIN_RUN_ID = `0x${'ab'.repeat(32)}`;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(cancelRun) {
  let counter = 0;
  const database = new MemoryDatabase();
  const service = new AdminMattMineService(database, {
    now: () => START,
    publicOrigin: ORIGIN,
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftGameplayService: { cancelRun },
    randomHex(bytes) {
      counter += 1;
      return counter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return { database, service };
}

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await service.verifyChallenge({ address: account.address, nonce: challenge.nonce, signature });
  await service.setPlayerIdentity(session.token, { name: 'ReleaseMiner' });
  return session;
}

async function lockedRun(database, service, mode = SERVER_RUN_MODES.PRACTICE) {
  const session = await signIn(service);
  const started = await service.startRun(session.token, mode);
  await database.transact((state) => {
    state.runs[started.runId].nftRun = {
      minerId: 1000,
      runId: ON_CHAIN_RUN_ID
    };
  });
  return { session, started };
}

test('wallet run termination releases the Miner on-chain before expiring the server run', async () => {
  const calls = [];
  const { database, service } = harness(async (input) => {
    calls.push(input);
    return { cancelled: true, minerId: input.minerId };
  });
  const { started } = await lockedRun(database, service);

  const result = await service.adminWalletAction(
    'admin-secret',
    account.address,
    'expire_active_runs',
    'Recover locked Miner'
  );

  assert.deepEqual(calls, [{
    address: account.address.toLowerCase(),
    minerId: 1000,
    runId: ON_CHAIN_RUN_ID
  }]);
  assert.equal(result.affected, 1);
  assert.equal((await database.read()).runs[started.runId].status, 'expired');
});

test('wallet run termination also releases a Miner waiting on a paid revive', async () => {
  const calls = [];
  const { database, service } = harness(async (input) => {
    calls.push(input);
    return { cancelled: true, minerId: input.minerId };
  });
  const { started } = await lockedRun(database, service);
  await database.transact((state) => {
    const run = state.runs[started.runId];
    run.status = 'awaiting-revive';
    run.pendingRevive = {
      id: 'revive-awaiting-admin',
      status: 'pending',
      requestedAt: START
    };
  });

  const result = await service.adminWalletAction(
    'admin-secret',
    account.address,
    'expire_active_runs',
    'End knocked-out Miner run'
  );

  const run = (await database.read()).runs[started.runId];
  assert.equal(result.affected, 1);
  assert.equal(run.status, 'expired');
  assert.equal(run.pendingRevive.status, 'cancelled');
  assert.equal(run.pendingRevive.cancelledAt, START);
  assert.deepEqual(calls, [{
    address: account.address.toLowerCase(),
    minerId: 1000,
    runId: ON_CHAIN_RUN_ID
  }]);
});

test('an on-chain release failure leaves the authoritative server run active', async () => {
  const { database, service } = harness(async () => {
    throw new Error('operator out of gas');
  });
  const { started } = await lockedRun(database, service);

  await assert.rejects(
    () => service.adminWalletAction(
      'admin-secret',
      account.address,
      'expire_active_runs',
      'Recover locked Miner'
    ),
    (error) => error.code === 'admin_nft_run_release_failed'
  );

  assert.equal((await database.read()).runs[started.runId].status, 'active');
});

test('player-state correction also releases a locked Miner before editing progression', async () => {
  const calls = [];
  const { database, service } = harness(async (input) => {
    calls.push(input);
    return { cancelled: true, minerId: input.minerId };
  });
  await lockedRun(database, service);

  const result = await service.adminAwardPlayer('admin-secret', account.address, {
    type: 'state_patch',
    patch: {
      terminateActiveRuns: true,
      profile: { bestScore: 42 }
    },
    reason: 'Support correction'
  }, 'Support correction');

  assert.equal(calls.length, 1);
  assert.equal(result.wallet.profile.bestScore, 42);
  assert.equal(result.terminatedActiveRuns, 1);
});

test('Admin termination cannot expire a pending Miner reservation before its chain start resolves', async () => {
  const { database, service } = harness(async () => ({ cancelled: false, minerId: 1000 }));
  const { started } = await lockedRun(database, service);
  await database.transact((state) => {
    delete state.runs[started.runId].nftRun;
    state.runs[started.runId].pendingNftRun = {
      minerId: 1000,
      mode: 'paid',
      mapVersion: `0x${'12'.repeat(32)}`,
      reservedAt: START
    };
  });

  await assert.rejects(
    () => service.adminWalletAction(
      'admin-secret',
      account.address,
      'expire_active_runs',
      'Recover locked Miner'
    ),
    (error) => error.code === 'admin_nft_run_start_in_progress'
  );

  const state = await database.read();
  assert.equal(state.runs[started.runId].status, 'active');
  assert.equal(state.runs[started.runId].pendingNftRun.minerId, 1000);
  assert.equal(state.runs[started.runId].adminTerminationPending, undefined);
});

test('partial administrative cancellation expires completed runs and blocks the uncertain run until retry', async () => {
  let failSecond = true;
  const calls = [];
  const { database, service } = harness(async (input) => {
    calls.push(input);
    if (input.minerId === 999 && failSecond) throw new Error('temporary RPC failure');
    return { cancelled: input.minerId !== 999, minerId: input.minerId };
  });
  const first = await lockedRun(database, service);
  const second = await service.startRun(first.session.token, SERVER_RUN_MODES.PRACTICE);
  await database.transact((state) => {
    state.runs[second.runId].nftRun = {
      minerId: 999,
      runId: `0x${'cd'.repeat(32)}`
    };
  });

  await assert.rejects(
    () => service.adminWalletAction(
      'admin-secret',
      account.address,
      'expire_active_runs',
      'Recover both locked Miners'
    ),
    (error) => {
      assert.equal(error.code, 'admin_nft_run_release_failed');
      assert.deepEqual(error.terminatedRunIds, [first.started.runId]);
      return true;
    }
  );

  let state = await database.read();
  assert.equal(state.runs[first.started.runId].status, 'expired');
  assert.equal(state.runs[second.runId].status, 'active');
  assert.ok(state.runs[second.runId].adminTerminationPending);
  await assert.rejects(
    () => service.finishRun(first.session.token, {
      runId: second.runId,
      runToken: second.runToken,
      result: {}
    }),
    (error) => error.code === 'run_admin_termination_pending'
  );

  failSecond = false;
  const retried = await service.adminWalletAction(
    'admin-secret',
    account.address,
    'expire_active_runs',
    'Retry uncertain Miner release'
  );
  state = await database.read();
  assert.equal(retried.affected, 1);
  assert.equal(state.runs[second.runId].status, 'expired');
  assert.deepEqual(calls.map(({ minerId }) => minerId), [1000, 999, 999]);
});

test('mine termination waits for an in-flight lifecycle start before taking its candidate snapshot', async () => {
  const { database, service } = harness(async () => ({ cancelled: false }));
  const session = await signIn(service);
  const entered = deferred();
  const release = deferred();
  const starting = database.withNftLifecycleStart(async () => {
    entered.resolve();
    await release.promise;
    return service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  });
  await entered.promise;

  const terminating = service.adminTerminateMineRuns(
    'admin-secret',
    'practice',
    'Close every in-flight Practice run'
  );
  await nextTurn();
  release.resolve();

  const [started, result] = await Promise.all([starting, terminating]);
  assert.equal(result.affected, 1);
  assert.deepEqual(result.runIds, [started.runId]);
  assert.equal((await database.read()).runs[started.runId].status, 'expired');
});

test('player-state edits cannot pass an Arena recheck while an Arena start holds the shared lifecycle lock', async () => {
  const { database, service } = harness(async () => ({ cancelled: false }));
  await signIn(service);
  let arenaRunActive = false;
  service.arenaService = {
    async adminActiveRuns(address) {
      return arenaRunActive ? [{
        runId: 'arena_run_1234567890abcdef12345678',
        address,
        status: 'active'
      }] : [];
    }
  };
  const entered = deferred();
  const release = deferred();
  const starting = database.withNftLifecycleStart(async () => {
    entered.resolve();
    await release.promise;
    arenaRunActive = true;
  });
  await entered.promise;

  const editing = service.adminUpdatePlayerState(
    'admin-secret',
    account.address,
    { profile: { bestScore: 42 } },
    'Concurrent Arena safety check'
  ).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await nextTurn();
  release.resolve();
  await starting;

  const outcome = await editing;
  assert.equal(outcome.error?.code, 'player_state_active_run');
  assert.equal((await database.read()).wallets[account.address.toLowerCase()].profile.bestScore, 0);
});

test('score overrides cannot commit ahead of an in-flight NFT run start', async () => {
  const { database, service } = harness(async () => ({ cancelled: false }));
  await signIn(service);
  const entered = deferred();
  const release = deferred();
  const starting = database.withNftLifecycleStart(async () => {
    entered.resolve();
    await release.promise;
    await database.transact((state) => {
      state.runs.concurrent_score_run = {
        id: 'concurrent_score_run',
        address: account.address.toLowerCase(),
        mode: SERVER_RUN_MODES.PAID,
        status: 'active',
        expiresAt: START + 60_000
      };
    });
  });
  await entered.promise;

  const editing = service.adminOverrideLeaderboardScore(
    'admin-secret',
    account.address,
    { mode: SERVER_RUN_MODES.PAID, score: 42, terminateActiveRuns: false },
    'Concurrent score safety check'
  ).then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  await nextTurn();
  release.resolve();
  await starting;

  const outcome = await editing;
  assert.equal(outcome.error?.code, 'score_override_active_run');
  assert.deepEqual((await database.read()).leaderboardOverrides, {});
});
