import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MattMineService } from '../server/service.js';
import { MemoryNuggetEconomyStore } from '../server/nugget-economy.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const account = privateKeyToAccount(PRIVATE_KEY);
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 28, 12, 0, 0);

function createHarness() {
  let timestamp = START;
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => timestamp,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    nuggetEconomyStore: new MemoryNuggetEconomyStore(),
    nuggetPaymentsEnabled: false,
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    service,
    advance(milliseconds) {
      timestamp += milliseconds;
    }
  };
}

async function signIn(harness) {
  const challenge = await harness.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await harness.service.verifyChallenge({
    address: account.address,
    nonce: challenge.nonce,
    signature
  });
  await harness.service.setPlayerIdentity(session.token, { name: 'CompleteLedger' });
  return session;
}

test('legacy knockout records remain replayable after the old Free mine is retired', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  const run = await MattMineService.prototype.startRun.call(
    harness.service,
    session.token,
    SERVER_RUN_MODES.FREE
  );
  harness.advance(60_000);
  const result = {
    extracted: false,
    projected: 1_000,
    banked: 500,
    depth: 1,
    kills: 5,
    oreBroken: 5,
    elapsed: 60
  };
  const finished = await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result
  });
  assert.equal(finished.profile.bankedNuggets, 500);

  const persisted = await harness.database.read();
  const wallet = persisted.wallets[account.address.toLowerCase()];
  assert.equal(wallet.profile.bankedNuggets, 500);
  assert.deepEqual(
    wallet.nuggetLedger.map((entry) => [entry.type, entry.direction, entry.amount]),
    [
      ['RUN_EXTRACTION', 'credit', 500],
      ['ADMIN_ADJUSTMENT', 'debit', 500],
      ['RUN_DEATH_RETENTION', 'credit', 500]
    ]
  );
  assert.equal(wallet.nuggetLedger.at(-1).runId, run.runId);
  assert.equal(wallet.activity.at(-1).action, 'RUN_DEATH_RETENTION_RECORDED');

  const retry = await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result: { ...result, projected: 999_999, banked: 999_999 }
  });
  assert.equal(retry.accepted, true);
  assert.equal(retry.alreadyFinished, true);
  assert.equal(retry.run.result.banked, 500);
  const repeated = await harness.database.read();
  assert.equal(repeated.wallets[account.address.toLowerCase()].nuggetLedger.length, 3);
});

test('public Practice runs never create wallet rewards or pending claims', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  harness.advance(60_000);
  await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result: {
      extracted: true,
      projected: 2_000,
      banked: 2_000,
      depth: 1,
      kills: 5,
      oreBroken: 5,
      elapsed: 60
    }
  });
  const player = await harness.service.me(session.token);
  assert.equal(player.profile.bankedNuggets, 0);
  assert.deepEqual(player.nuggetEconomy.pendingPracticeClaims, []);
});
