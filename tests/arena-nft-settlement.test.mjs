import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryDatabase } from '../server/database.js';
import { RONIN_CHAINS } from '../server/constants.js';

const START = Date.UTC(2026, 7, 22, 12);
const ORIGIN = 'http://localhost:4173';
const account = privateKeyToAccount(
  `0x${createHash('sha256').update('arena-nft-settlement-player').digest('hex')}`
);
const ABANDON_RUN_ID = `arena_run_${'d'.repeat(24)}`;
const ABANDON_RUN_TOKEN = 'e'.repeat(64);
const ABANDON_CHAIN_RUN_ID = `0x${'f'.repeat(64)}`;

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await service.verifyChallenge({
    address: account.address,
    nonce: challenge.nonce,
    signature
  });
  await service.setPlayerIdentity(session.token, { name: 'ArenaNftPlayer' });
  return session;
}

test('accepted Arena results settle the stored on-chain Miner run after public progression is stripped', async () => {
  const runId = `arena_run_${'a'.repeat(24)}`;
  const nftRun = {
    minerId: 77,
    runId: `0x${'b'.repeat(64)}`,
    phaseXp: [10, 20, 30, 40, 50]
  };
  const settlementCalls = [];
  const arenaService = {
    publicConfig: () => ({ enabled: true }),
    store: {
      async getRun(requestedRunId) {
        assert.equal(requestedRunId, runId);
        return {
          runId,
          address: account.address.toLowerCase(),
          tuning: { _nftRun: structuredClone(nftRun) }
        };
      }
    },
    async finishRun() {
      return {
        accepted: true,
        result: {
          extracted: true,
          score: 12_345,
          depth: 5,
          completedPhases: 0x1f,
          crystalsCarried: 250
        },
        leaderboard: { rows: [], playerScore: 12_345, playerRank: 1 },
        progression: {
          runId,
          passActiveAtStart: false,
          passXpMultiplier: 1,
          nftRun: structuredClone(nftRun)
        }
      };
    }
  };
  const nftGameplayService = {
    async settleRun(input) {
      settlementCalls.push(structuredClone(input));
      return {
        minerId: input.minerId,
        outcome: 'extraction',
        crystalsBanked: 250,
        xpBanked: 150,
        transactionHash: `0x${'c'.repeat(64)}`
      };
    }
  };
  const service = new CompleteProductionMattMineService(new MemoryDatabase(), {
    now: () => START,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    arenaService,
    nftGameplayService
  });
  const session = await signIn(service);

  const result = await service.finishArenaRun(session.token, {
    runId,
    runToken: 'arena-run-token',
    checkpoint: {}
  });

  assert.equal(settlementCalls.length, 1);
  assert.equal(settlementCalls[0].minerId, 77);
  assert.equal(settlementCalls[0].runId, nftRun.runId);
  assert.deepEqual(settlementCalls[0].phaseXp, nftRun.phaseXp);
  assert.equal(settlementCalls[0].completedPhases, 5);
  assert.equal(result.nftSettlement.transactionHash, `0x${'c'.repeat(64)}`);
  assert.equal('progression' in result, false);
});

test('an Arena result retries on-chain settlement after the server result has already committed', async () => {
  const runId = `arena_run_${'1'.repeat(24)}`;
  const nftRun = {
    minerId: 79,
    runId: `0x${'2'.repeat(64)}`,
    phaseXp: [10, 20, 30, 40, 50]
  };
  let serverFinishCalls = 0;
  let serverCommits = 0;
  let settlementAttempts = 0;
  let serverFinished = false;
  const arenaService = {
    publicConfig: () => ({ enabled: true }),
    store: {
      async getRun(requestedRunId) {
        assert.equal(requestedRunId, runId);
        return {
          runId,
          address: account.address.toLowerCase(),
          status: serverFinished ? 'finished' : 'active',
          tuning: { _nftRun: structuredClone(nftRun) }
        };
      }
    },
    async finishRun() {
      serverFinishCalls += 1;
      const alreadyFinished = serverFinished;
      if (!serverFinished) {
        serverFinished = true;
        serverCommits += 1;
      }
      return {
        accepted: true,
        alreadyFinished,
        result: {
          extracted: true,
          score: 22_222,
          depth: 5,
          completedPhases: 0x1f,
          crystalsCarried: 400
        },
        leaderboard: { rows: [], playerScore: 22_222, playerRank: 1 },
        progression: {
          runId,
          passActiveAtStart: true,
          passXpMultiplier: 1,
          nftRun: structuredClone(nftRun)
        }
      };
    }
  };
  const nftGameplayService = {
    async settleRun(input) {
      settlementAttempts += 1;
      if (settlementAttempts === 1) throw new Error('temporary Arena operator RPC failure');
      return {
        minerId: input.minerId,
        outcome: 'extraction',
        crystalsBanked: 400,
        xpBanked: 150,
        transactionHash: `0x${'3'.repeat(64)}`,
        profile: {
          minerId: input.minerId,
          owner: account.address,
          progression: { bankedXp: 150, level: 2 }
        }
      };
    }
  };
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => START,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    arenaService,
    nftGameplayService
  });
  const session = await signIn(service);
  const submission = { runId, runToken: 'arena-run-token', checkpoint: {} };

  await assert.rejects(
    () => service.finishArenaRun(session.token, submission),
    /temporary Arena operator RPC failure/
  );
  const committed = await database.read();
  const committedWallet = committed.wallets[account.address.toLowerCase()];
  assert.equal(serverFinished, true);
  assert.equal(serverCommits, 1);
  assert.ok(committedWallet.passProgress.xp > 0);
  const committedPassXp = committedWallet.passProgress.xp;

  const accepted = await service.finishArenaRun(session.token, submission);
  const recovered = await database.read();
  const recoveredWallet = recovered.wallets[account.address.toLowerCase()];
  assert.equal(serverFinishCalls, 2);
  assert.equal(serverCommits, 1);
  assert.equal(settlementAttempts, 2);
  assert.equal(accepted.alreadyFinished, true);
  assert.equal(accepted.nftSettlement.crystalsBanked, 400);
  assert.equal(recoveredWallet.passProgress.xp, committedPassXp);
});

function abandonmentHarness({ cancelFails = false } = {}) {
  const calls = [];
  const database = new MemoryDatabase();
  const run = {
    runId: ABANDON_RUN_ID,
    address: account.address.toLowerCase(),
    tokenHash: createHash('sha256').update(ABANDON_RUN_TOKEN).digest('hex'),
    status: 'active',
    tuning: {
      _nftRun: {
        minerId: 88,
        runId: ABANDON_CHAIN_RUN_ID
      }
    }
  };
  const expire = async () => {
    calls.push('expire');
    run.status = 'expired';
    return { abandoned: true, runId: run.runId, status: run.status, entryConsumed: true };
  };
  const arenaService = {
    publicConfig: () => ({ enabled: true }),
    assertLive() {},
    store: {
      async getRun(runId) { return runId === run.runId ? structuredClone(run) : null; },
      async activeRun(address) {
        return address === run.address && run.status === 'active' ? structuredClone(run) : null;
      }
    },
    async abandonRun() { return expire(); },
    async abandonActiveRun() { return expire(); }
  };
  const nftGameplayService = {
    async cancelRun(input) {
      calls.push('cancel');
      assert.deepEqual(input, {
        address: run.address,
        minerId: 88,
        runId: ABANDON_CHAIN_RUN_ID
      });
      if (cancelFails) throw new Error('operator RPC unavailable');
      return { cancelled: true, minerId: input.minerId };
    }
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => START,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    arenaService,
    nftGameplayService
  });
  return { calls, run, service };
}

for (const operation of ['token', 'active']) {
  test(`${operation} Arena abandonment releases the Miner on-chain before expiring the server run`, async () => {
    const harness = abandonmentHarness();
    const session = await signIn(harness.service);

    const result = operation === 'token'
      ? await harness.service.abandonArenaRun(session.token, {
          runId: ABANDON_RUN_ID,
          runToken: ABANDON_RUN_TOKEN
        })
      : await harness.service.abandonActiveArenaRun(session.token);

    assert.deepEqual(harness.calls, ['cancel', 'expire']);
    assert.equal(harness.run.status, 'expired');
    assert.equal(result.runId, ABANDON_RUN_ID);
  });

  test(`${operation} Arena abandonment keeps the server run active when on-chain release fails`, async () => {
    const harness = abandonmentHarness({ cancelFails: true });
    const session = await signIn(harness.service);

    const action = operation === 'token'
      ? () => harness.service.abandonArenaRun(session.token, {
          runId: ABANDON_RUN_ID,
          runToken: ABANDON_RUN_TOKEN
        })
      : () => harness.service.abandonActiveArenaRun(session.token);
    await assert.rejects(action, /operator RPC unavailable/);

    assert.deepEqual(harness.calls, ['cancel']);
    assert.equal(harness.run.status, 'active');
  });
}
