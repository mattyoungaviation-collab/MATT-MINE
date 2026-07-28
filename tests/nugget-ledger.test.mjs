import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { normalizeServerState } from '../server/state.js';
import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta,
} from '../server/nugget-ledger.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const account = privateKeyToAccount(PRIVATE_KEY);
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 25, 12, 0, 0);

function createHarness(options = {}) {
  let timestamp = options.timestamp ?? START;
  let randomCounter = 0;
  const database = options.database || new MemoryDatabase();
  const service = new MattMineService(database, {
    now: () => timestamp,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: options.adminKey || 'test-admin-key',
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    service,
    now: () => timestamp,
    advance(milliseconds) {
      timestamp += milliseconds;
      return timestamp;
    }
  };
}

function extractedResult(overrides = {}) {
  return {
    extracted: true,
    projected: 1_000,
    banked: 1_000,
    depth: 1,
    kills: 8,
    oreBroken: 5,
    elapsed: 60,
    ...overrides
  };
}

async function signIn(harness, signer = account) {
  const challenge = await harness.service.createChallenge({
    address: signer.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await signer.signMessage({ message: challenge.message });
  return harness.service.verifyChallenge({
    address: signer.address,
    nonce: challenge.nonce,
    signature
  });
}

test('run rewards create immutable run extraction ledger entries', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(60_000);
  const finished = await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result: extractedResult()
  });

  const persisted = await harness.database.read();
  const wallet = persisted.wallets[account.address.toLowerCase()];
  assert.equal(finished.profile.bankedNuggets, 1_000);
  assert.equal(wallet.nuggetLedger.length, 1);
  const entry = wallet.nuggetLedger.at(-1);
  assert.equal(entry.type, NUGGET_LEDGER_TYPES.RUN_EXTRACTION);
  assert.equal(entry.direction, 'credit');
  assert.equal(entry.amount, 1_000);
  assert.equal(entry.runId, run.runId);
  assert.equal(entry.newBalance, 1_000);
});

test('ledger update idempotency keys prevent duplicate nugget mutations', () => {
  const wallet = {
    address: account.address.toLowerCase(),
    profile: { bankedNuggets: 100 },
    nuggetLedger: []
  };
  const first = applyNuggetLedgerDelta(wallet, 25, {
    type: NUGGET_LEDGER_TYPES.CHEST_REWARD,
    idempotencyKey: 'duplicate-test'
  });
  const second = applyNuggetLedgerDelta(wallet, 25, {
    type: NUGGET_LEDGER_TYPES.CHEST_REWARD,
    idempotencyKey: 'duplicate-test'
  });
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.entry?.id, first.entry?.id);
  assert.equal(wallet.profile.bankedNuggets, 125);
});

test('ledger enforces non-negative balance invariants', () => {
  const wallet = {
    address: account.address.toLowerCase(),
    profile: { bankedNuggets: 5 },
    nuggetLedger: []
  };
  assert.throws(
    () => applyNuggetLedgerDelta(wallet, -10, {
      type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT
    }),
    (error) => error.message === 'Nugget ledger balance cannot become negative.'
  );
  assert.equal(wallet.profile.bankedNuggets, 5);
});

test('legacy profile balances migrate to a canonical single MIGRATION ledger row', () => {
  const address = account.address.toLowerCase();
  const normalized = normalizeServerState({
    version: 9,
    wallets: {
      [address]: {
        profile: { bankedNuggets: 2_500 },
        activity: [],
        passProgress: { xp: 0 },
        passInventory: {},
        keybindings: { moveUp: 'ArrowUp', moveDown: 'ArrowDown', moveLeft: 'ArrowLeft', moveRight: 'ArrowRight', attack: 'Space', dash: 'KeyE', pickaxe: 'Key1', dynamite: 'Key2', blaster: 'Key3' },
        createdAt: START,
        updatedAt: START
      }
    }
  });
  const migratedWallet = normalized.wallets[address];
  assert.equal(migratedWallet.nuggetLedger.length, 1);
  assert.equal(migratedWallet.nuggetLedger[0].type, NUGGET_LEDGER_TYPES.MIGRATION);
  assert.equal(migratedWallet.profile.bankedNuggets, 2_500);
  assert.equal(migratedWallet.nuggetLedger[0].idempotencyKey, `migration-${address}`);

  const again = normalizeServerState(normalized);
  assert.equal(again.wallets[address].nuggetLedger.length, 1);
  assert.equal(again.wallets[address].profile.bankedNuggets, 2_500);
});
