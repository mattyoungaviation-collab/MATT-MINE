import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  createAdminSafeTransactionFile,
  MATT_MINE_ADMIN_CONTRACTS,
  prepareAdminContractTransaction,
  prepareAdminContractTransactions
} from '../server/admin-controls.js';
import {
  calculateSafeTransactionBuilderChecksum,
  createSafeTransactionBuilderFile
} from '../server/safe-transaction-builder.js';
import { MemoryDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { MattMineService } from '../server/service.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const account = privateKeyToAccount(PRIVATE_KEY);
const START = Date.UTC(2026, 6, 25, 12, 0, 0);
const ORIGIN = 'http://localhost:4173';

function serviceHarness(options = {}) {
  let timestamp = START;
  let counter = 0;
  const database = new MemoryDatabase();
  const service = new MattMineService(database, {
    now: () => timestamp,
    publicOrigin: ORIGIN,
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    mainnetTransactionsEnabled: options.payments === true,
    paymentVerifier: options.payments ? fakePayments() : null,
    randomHex(bytes) {
      counter += 1;
      return counter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return { database, service, advance: (ms) => { timestamp += ms; } };
}

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await service.verifyChallenge({ address: account.address, nonce: challenge.nonce, signature });
  if (session.identity.requiresSetup) {
    const created = await service.setPlayerIdentity(session.token, { name: 'AdminTester' });
    session.identity = created.identity;
    session.entitlements.freeRunAvailable = true;
  }
  return session;
}

test('server operations are authenticated, audited, and gate each production surface independently', async () => {
  const harness = serviceHarness({ payments: true });
  const session = await signIn(harness.service);
  await assert.rejects(
    () => harness.service.updateOperations('wrong', { maintenanceMode: true }, 'Planned maintenance'),
    (error) => error.code === 'admin_key_rejected'
  );
  await assert.rejects(
    () => harness.service.updateOperations('admin-secret', { hardMaxBoardMatt: 99 }, 'Trying locked field'),
    (error) => error.code === 'operations_field_locked'
  );

  await harness.service.updateOperations('admin-secret', {
    freeRankedPaused: true,
    passRankedPaused: true,
    purchasesPaused: true,
    claimsPaused: true,
    announcement: 'Ranked competition is paused for review.'
  }, 'Weekly competition review');

  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'free_ranked_paused'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PAID),
    (error) => error.code === 'pass_ranked_paused'
  );
  await assert.rejects(
    () => harness.service.quotePaidRun(session.token),
    (error) => error.code === 'server_purchases_paused'
  );
  const practice = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.equal(practice.mode, SERVER_RUN_MODES.PRACTICE);

  const audit = await harness.service.adminAudit('admin-secret', { action: 'OPERATIONS' });
  assert.equal(audit.entries.length, 1);
  assert.match(audit.entries[0].details, /Weekly competition review/);
});

test('maintenance blocks new play and player controls preserve payment and score records', async () => {
  const harness = serviceHarness();
  const session = await signIn(harness.service);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);

  const revoked = await harness.service.adminWalletAction(
    'admin-secret',
    account.address,
    'revoke_sessions',
    'User requested account sign-out'
  );
  assert.equal(revoked.affected, 1);
  await assert.rejects(() => harness.service.me(session.token), (error) => error.code === 'session_missing');

  const expired = await harness.service.adminWalletAction(
    'admin-secret',
    account.address,
    'expire_active_runs',
    'Run was stuck after browser crash'
  );
  assert.equal(expired.affected, 1);
  const snapshot = await harness.database.read();
  assert.equal(snapshot.runs[run.runId].status, 'expired');

  await harness.service.updateOperations('admin-secret', { maintenanceMode: true }, 'Emergency server maintenance');
  const replacement = await signIn(harness.service);
  await assert.rejects(
    () => harness.service.startRun(replacement.token, SERVER_RUN_MODES.PRACTICE),
    (error) => error.code === 'maintenance_mode'
  );
});

test('contract controls prepare exact calldata without signing or broadcasting', () => {
  const paused = prepareAdminContractTransaction({ action: 'rewards_pause', arguments: [] });
  assert.equal(paused.to, MATT_MINE_ADMIN_CONTRACTS.rewards);
  assert.equal(paused.broadcast, false);
  assert.equal(paused.requiredSigner, 'Emergency pauser');

  const price = prepareAdminContractTransaction({ action: 'run_price', arguments: ['10'] });
  const decoded = decodeFunctionData({
    abi: [{
      type: 'function',
      name: 'setPaidRunPriceRon',
      stateMutability: 'nonpayable',
      inputs: [{ name: 'newPriceRon', type: 'uint256' }],
      outputs: []
    }],
    data: price.data
  });
  assert.equal(decoded.functionName, 'setPaidRunPriceRon');
  assert.equal(decoded.args[0], 10n * 10n ** 18n);

  assert.throws(
    () => prepareAdminContractTransaction({ action: 'rewards_recover_unallocated', arguments: ['0'] }),
    (error) => error.code === 'matt_amount_invalid'
  );
});

test('Treasury vault funding always creates an ordered approve-and-fund Safe batch', () => {
  const transactions = prepareAdminContractTransactions({
    action: 'rewards_fund_vault',
    arguments: ['1500000']
  });
  const transaction = transactions.at(-1);
  const file = createAdminSafeTransactionFile(transactions, START);

  assert.equal(file.version, '1.0');
  assert.equal(file.chainId, '2020');
  assert.equal(file.createdAt, START);
  assert.equal(file.meta.createdFromSafeAddress, MATT_MINE_ADMIN_CONTRACTS.safe);
  assert.match(file.meta.checksum, /^0x[a-f0-9]{64}$/);
  assert.equal(file.transactions.length, 2);
  assert.deepEqual(file.transactions[0], {
    to: MATT_MINE_ADMIN_CONTRACTS.matt,
    value: '0',
    data: transactions[0].data,
    contractMethod: null,
    contractInputsValues: null
  });
  assert.deepEqual(file.transactions[1], {
    to: MATT_MINE_ADMIN_CONTRACTS.rewards,
    value: '0',
    data: transaction.data,
    contractMethod: null,
    contractInputsValues: null
  });
  assert.equal(calculateSafeTransactionBuilderChecksum(file), file.meta.checksum);

  const directRole = prepareAdminContractTransaction({ action: 'rewards_pause', arguments: [] });
  assert.equal(createAdminSafeTransactionFile(directRole, START), null);
});

test('Safe builder JSON preserves ordered batches and checksum detects calldata changes', () => {
  const first = prepareAdminContractTransaction({
    action: 'matt_approve_reward_vault',
    arguments: ['1500000']
  });
  const second = prepareAdminContractTransaction({
    action: 'rewards_fund_vault',
    arguments: ['1500000']
  });
  const file = createSafeTransactionBuilderFile([first, second], {
    chainId: 2020,
    createdAt: START,
    safeAddress: MATT_MINE_ADMIN_CONTRACTS.safe,
    name: 'MATT Mine reward funding'
  });
  assert.deepEqual(file.transactions.map((entry) => entry.to), [
    MATT_MINE_ADMIN_CONTRACTS.matt,
    MATT_MINE_ADMIN_CONTRACTS.rewards
  ]);

  const changed = structuredClone(file);
  changed.transactions[1].data = '0x1234';
  assert.notEqual(calculateSafeTransactionBuilderChecksum(changed), file.meta.checksum);
});

test('Safe checksum matches the official Transaction Builder test vector', () => {
  const officialSafeVector = {
    version: '1.0',
    chainId: '4',
    createdAt: 1646321521061,
    meta: {
      name: 'test batch file',
      txBuilderVersion: '1.4.0',
      checksum: '',
      createdFromSafeAddress: '0xDF8a1Ce35c9a6ACE153B4e0767942f1E2291a1Aa',
      createdFromOwnerAddress: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6'
    },
    transactions: [
      {
        to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
        value: '0',
        contractMethod: {
          inputs: [{ internalType: 'address', name: 'paramAddress', type: 'address' }],
          name: 'testAddress',
          payable: false
        },
        contractInputsValues: {
          paramAddress: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6'
        }
      },
      {
        to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
        value: '0',
        contractMethod: {
          inputs: [{ internalType: 'bool', name: 'paramBool', type: 'bool' }],
          name: 'testBool',
          payable: false
        },
        contractInputsValues: { paramAddress: '', paramBool: 'false' }
      },
      {
        to: '0x49d4450977E2c95362C13D3a31a09311E0Ea26A6',
        value: '2000000000000000000',
        data: '0x42f4579000000000000000000000000049d4450977e2c95362c13d3a31a09311e0ea26a6'
      }
    ]
  };
  assert.equal(
    calculateSafeTransactionBuilderChecksum(officialSafeVector),
    '0x86c81826dbf7e8a37612153294cc85fdf5c81998dd0a44b86d945502a7eace7c'
  );
});

test('private command center is a separate noindex page with no embedded secrets', async () => {
  const [html, script] = await Promise.all([
    readFile(`${ROOT}admin.html`, 'utf8'),
    readFile(`${ROOT}src/admin.js`, 'utf8')
  ]);
  assert.match(html, /noindex,nofollow/);
  assert.match(html, /MATT Mine Command Center/);
  assert.doesNotMatch(html + script, /MATT_MINE_ADMIN_KEY|admin-secret/);
  assert.match(script, /sessionStorage/);
  assert.match(script, /Download Safe JSON/);
  assert.match(script, /new Blob/);
  assert.match(script, /link\.download/);
});

test('admin HTTP routes reject missing credentials and apply audited controls', async (context) => {
  const harness = serviceHarness();
  const server = createMattMineHttpServer({ root: ROOT, service: harness.service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const rejected = await fetch(`${base}/api/admin/overview`);
  assert.equal(rejected.status, 401);

  const updated = await fetch(`${base}/api/admin/operations`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-matt-admin-key': 'admin-secret'
    },
    body: JSON.stringify({
      patch: { freeRankedPaused: true },
      reason: 'HTTP control route test'
    })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).operations.freeRankedPaused, true);

  const overview = await fetch(`${base}/api/admin/overview`, {
    headers: { 'x-matt-admin-key': 'admin-secret' }
  });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.operations.freeRankedPaused, true);
  assert.equal(payload.immutable.hardMaxBoardMatt, 5_000_000);
});

function fakePayments() {
  return {
    publicConfig: () => ({ contracts: {}, confirmations: 3 }),
    publicStatus: async () => ({ live: true, pass: { paused: false }, paidRuns: { paused: false } }),
    status: async () => ({
      pass: { active: true },
      paidRuns: { paused: false }
    }),
    quotePaidRun: async () => ({ transaction: { to: MATT_MINE_ADMIN_CONTRACTS.runs } })
  };
}
