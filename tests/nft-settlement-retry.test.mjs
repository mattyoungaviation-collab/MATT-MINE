import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryDatabase } from '../server/database.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 7, 22, 12);
const account = privateKeyToAccount(
  `0x${createHash('sha256').update('nft-settlement-retry-player').digest('hex')}`
);

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
  await service.setPlayerIdentity(session.token, { name: 'SettlementRetry' });
  return session;
}

test('an already-settled retry with unknown rewards does not create a zero Crystal mirror entry', async () => {
  let now = START;
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => now,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    },
    nftGameplayService: {
      async settleRun({ minerId, result }) {
        return {
          version: 2,
          minerId,
          outcome: result.extracted === true ? 'extraction' : 'death',
          transactionHash: null,
          alreadySettled: true,
          profile: {
            minerId,
            owner: account.address,
            progression: { bankedXp: 100, level: 2 }
          }
        };
      }
    }
  });
  const session = await signIn(service);
  const started = await service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  await database.transact((state) => {
    state.runs[started.runId].nftRun = {
      minerId: 1,
      runId: `0x${'a1'.repeat(32)}`,
      phaseXp: [10, 20, 30, 40, 50]
    };
    state.runs[started.runId].tuning.nftCrystalCarryLimit = 750;
  });
  now += 1_000;

  const accepted = await service.finishRun(session.token, {
    runId: started.runId,
    runToken: started.runToken,
    result: {
      extracted: true,
      projected: 100,
      banked: 100,
      depth: 1,
      kills: 0,
      oreBroken: 0,
      elapsed: 1,
      crystalsCarried: 10,
      completedPhases: 1
    }
  });

  const state = await database.read();
  const wallet = state.wallets[account.address.toLowerCase()];
  assert.equal(accepted.nftSettlement.alreadySettled, true);
  assert.equal(accepted.nftSettlement.crystalsBanked, undefined);
  assert.equal(wallet.nftCrystalBalance, 0);
  assert.deepEqual(wallet.nftCrystalLedger, []);
});

test('a Pass result retries on-chain settlement after the server result has already committed', async () => {
  let now = START;
  let randomCounter = 0;
  let settlementAttempts = 0;
  const verifiedRunResult = {
    extracted: true,
    projected: 100,
    banked: 100,
    depth: 1,
    kills: 0,
    oreBroken: 0,
    elapsed: 1,
    crystalsCarried: 25,
    completedPhases: 1
  };
  const database = new MemoryDatabase();
  const nftGameplayService = {
    async settleRun({ minerId, result }) {
      settlementAttempts += 1;
      if (settlementAttempts === 1) throw new Error('temporary operator RPC failure');
      return {
        version: 2,
        minerId,
        outcome: result.extracted === true ? 'extraction' : 'death',
        crystalsBanked: 25,
        xpBanked: 10,
        transactionHash: `0x${'b2'.repeat(32)}`,
        profile: {
          minerId,
          owner: account.address,
          progression: { bankedXp: 10, level: 1 }
        }
      };
    }
  };
  const createService = () => new CompleteProductionMattMineService(database, {
    now: () => now,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    },
    nftGameplayService
  });
  const service = createService();
  const session = await signIn(service);
  const started = await service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  await database.transact((state) => {
    const run = state.runs[started.runId];
    run.mode = SERVER_RUN_MODES.PAID;
    run.passActiveAtStart = true;
    run.nftRun = {
      minerId: 2,
      runId: `0x${'c3'.repeat(32)}`,
      phaseXp: [10, 20, 30, 40, 50]
    };
    run.tuning.nftCrystalCarryLimit = 750;
  });
  now += 1_000;
  const submission = {
    runId: started.runId,
    runToken: started.runToken,
    result: structuredClone(verifiedRunResult)
  };

  await assert.rejects(
    () => service.finishRun(session.token, submission),
    /temporary operator RPC failure/
  );
  const committed = await database.read();
  const committedWallet = committed.wallets[account.address.toLowerCase()];
  assert.equal(committed.runs[started.runId].status, 'finished');
  assert.equal(committed.runs[started.runId].mode, SERVER_RUN_MODES.PAID);
  assert.equal(committed.runs[started.runId].nftRun, undefined);
  assert.deepEqual(committed.runs[started.runId].nftSettlement, {
    minerId: 2,
    runId: `0x${'c3'.repeat(32)}`,
    phaseXp: [10, 20, 30, 40, 50]
  });
  assert.equal(committedWallet.profile.totalRuns, 1);
  assert.ok(committedWallet.passProgress.xp > 0);
  assert.deepEqual(committedWallet.nftCrystalLedger, []);
  const committedPassXp = committedWallet.passProgress.xp;

  const restartedService = createService();
  const accepted = await restartedService.finishRun(session.token, submission);
  const recovered = await database.read();
  const recoveredWallet = recovered.wallets[account.address.toLowerCase()];
  assert.equal(settlementAttempts, 2);
  assert.equal(accepted.alreadyFinished, true);
  assert.equal(accepted.nftSettlement.crystalsBanked, 25);
  assert.equal(recoveredWallet.profile.totalRuns, 1);
  assert.equal(recoveredWallet.passProgress.xp, committedPassXp);
  assert.equal(recoveredWallet.nftCrystalBalance, 25);
  assert.equal(recoveredWallet.nftCrystalLedger.length, 1);
  assert.equal(recoveredWallet.nftCrystalLedger[0].runId, started.runId);
  assert.equal(recovered.runs[started.runId].nftSettlement, undefined);
});
