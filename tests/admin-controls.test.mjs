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
import { normalizeServerState } from '../server/state.js';

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
    adminWallets: options.adminWallets || [],
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

test('mine operations pause one mine surface without losing an active run', async () => {
  const harness = serviceHarness();
  const session = await signIn(harness.service);

  await harness.service.updateMineOperations(
    'admin-secret',
    'practice',
    { entriesPaused: true },
    'Close Practice entry while testing controls'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE),
    (error) => error.code === 'practice_entries_paused'
  );

  await harness.service.updateMineOperations(
    'admin-secret',
    'practice',
    { entriesPaused: false },
    'Reopen Practice entry'
  );
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  harness.advance(60_000);
  await harness.service.updateMineOperations(
    'admin-secret',
    'practice',
    { resultsPaused: true },
    'Temporarily stop result processing'
  );
  await assert.rejects(
    () => harness.service.finishRun(session.token, {
      runId: run.runId,
      runToken: run.runToken,
      result: {
        extracted: true,
        projected: 1_000,
        banked: 1_000,
        depth: 1,
        kills: 5,
        oreBroken: 5,
        elapsed: 60
      }
    }),
    (error) => error.code === 'practice_results_paused'
  );
  let snapshot = await harness.database.read();
  assert.equal(snapshot.runs[run.runId].status, 'active');

  await harness.service.updateMineOperations(
    'admin-secret',
    'practice',
    { resultsPaused: false },
    'Resume result processing'
  );
  const finished = await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result: {
      extracted: true,
      projected: 1_000,
      banked: 1_000,
      depth: 1,
      kills: 5,
      oreBroken: 5,
      elapsed: 60
    }
  });
  assert.equal(finished.run.status, 'finished');
  const audit = await harness.service.adminAudit('admin-secret', { action: 'MINE_OPERATIONS_UPDATED' });
  assert.equal(audit.entries.length, 4);
});

test('mine-wide termination also clears stale active records immediately', async () => {
  const harness = serviceHarness();
  const session = await signIn(harness.service);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  await harness.database.transact((state) => {
    state.runs[run.runId].expiresAt = START - 1;
  });

  const result = await harness.service.adminTerminateMineRuns(
    'admin-secret',
    'practice',
    'Clear every stranded Practice run'
  );
  const state = await harness.database.read();
  assert.equal(result.affected, 1);
  assert.deepEqual(result.runIds, [run.runId]);
  assert.equal(state.runs[run.runId].status, 'expired');
  assert.equal(state.runs[run.runId].adminTerminationReason, 'Clear every stranded Practice run');
});

test('legacy global pause state migrates into the matching mine controls', () => {
  const migrated = normalizeServerState({
    version: 14,
    operations: {
      freeRankedPaused: true,
      passRankedPaused: true,
      purchasesPaused: true,
      claimsPaused: true
    }
  });
  assert.equal(migrated.operations.mines.daily.entriesPaused, true);
  assert.equal(migrated.operations.mines.pass.entriesPaused, true);
  assert.equal(migrated.operations.mines.practice.paymentsPaused, true);
  assert.equal(migrated.operations.mines.pass.paymentsPaused, true);
  assert.equal(migrated.operations.mines.daily.rewardsPaused, true);
  assert.equal(migrated.operations.mines.pass.rewardsPaused, true);
  assert.equal(migrated.operations.mines.arena.entriesPaused, false);
});

test('mine operations reject controls that have no real flow to pause', async () => {
  const harness = serviceHarness();
  await assert.rejects(
    () => harness.service.updateMineOperations(
      'admin-secret',
      'daily',
      { paymentsPaused: true },
      'Daily Mine is free and has no payment flow'
    ),
    (error) => error.code === 'mine_operation_not_applicable'
  );
  await assert.rejects(
    () => harness.service.updateMineOperations(
      'admin-secret',
      'weekly',
      { rewardsPaused: true },
      'Seven-Day Mine has no separate MATT claim flow'
    ),
    (error) => error.code === 'mine_operation_not_applicable'
  );
});

test('game tuning is lobby-specific, audited, and applies immediately to every new run', async () => {
  const harness = serviceHarness();
  const free = await harness.service.updateAdminGameTuning(
    'admin-secret',
    'free',
    { playerMaxHealth: 175 },
    'Raise Free lobby survivability'
  );
  assert.equal(free.preset.playerMaxHealth, 175);
  assert.equal(free.effectiveAt, START);

  const arena = await harness.service.updateAdminGameTuning(
    'admin-secret',
    'arena',
    { bossHealthMultiplier: 2.5 },
    'Apply boss test now'
  );
  assert.equal(arena.effectiveAt, START);
  const state = await harness.database.read();
  assert.equal(state.gameTuning.arena.bossHealthMultiplier, 2.5);
  assert.equal(Object.hasOwn(state, 'arenaTuningSchedule'), false);
  assert.equal((await harness.service.publicGameTuning('free')).preset.playerMaxHealth, 175);
  const audit = await harness.service.adminAudit('admin-secret', { action: 'GAME_TUNING_UPDATED' });
  assert.equal(audit.entries.length, 2);
  assert.ok(audit.entries.every((entry) => entry.details.includes('effective immediately for new runs')));
});

test('player search uses permanent names and audited awards appear in individual activity', async () => {
  const harness = serviceHarness();
  await signIn(harness.service);
  const search = await harness.service.adminWallets('admin-secret', 'AdminTester');
  assert.equal(search.wallets.length, 1);
  assert.equal(search.wallets[0].address, account.address.toLowerCase());
  await harness.service.adminAwardPlayer(
    'admin-secret',
    account.address,
    { type: 'nuggets', amount: 250 },
    'Community event award'
  );
  const detail = await harness.service.adminWallet('admin-secret', account.address);
  assert.equal(detail.wallet.profile.bankedNuggets, 250);
  assert.ok(detail.activity.some((entry) => entry.action === 'ADMIN_AWARD'));
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
  assert.doesNotMatch(script, /mattMineAdminKey|x-matt-admin-key/);
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
  const playerSession = await signIn(harness.service);
  const activeRun = await harness.service.startRun(playerSession.token, SERVER_RUN_MODES.PRACTICE);

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

  const mineUpdated = await fetch(`${base}/api/admin/mine-operations/practice`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-matt-admin-key': 'admin-secret'
    },
    body: JSON.stringify({
      patch: { entriesPaused: true },
      reason: 'HTTP mine control route test'
    })
  });
  assert.equal(mineUpdated.status, 200);
  assert.equal((await mineUpdated.json()).controls.entriesPaused, true);

  const mineOverview = await fetch(`${base}/api/admin/mine-operations?week=2026-07-13`, {
    headers: { 'x-matt-admin-key': 'admin-secret' }
  });
  assert.equal(mineOverview.status, 200);
  const minePayload = await mineOverview.json();
  assert.equal(minePayload.mines.find((mine) => mine.id === 'practice').controls.entriesPaused, true);
  assert.deepEqual(
    minePayload.mines.find((mine) => mine.id === 'daily').availableControls,
    ['entries', 'results', 'rewards']
  );

  const terminated = await fetch(`${base}/api/admin/mine-operations/practice/terminate-runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-matt-admin-key': 'admin-secret'
    },
    body: JSON.stringify({ reason: 'End this mine immediately for incident response' })
  });
  assert.equal(terminated.status, 200);
  const termination = await terminated.json();
  assert.equal(termination.affected, 1);
  assert.deepEqual(termination.runIds, [activeRun.runId]);
  assert.equal((await harness.database.read()).runs[activeRun.runId].status, 'expired');

  const overview = await fetch(`${base}/api/admin/overview`, {
    headers: { 'x-matt-admin-key': 'admin-secret' }
  });
  assert.equal(overview.status, 200);
  const payload = await overview.json();
  assert.equal(payload.operations.freeRankedPaused, true);
  assert.equal(payload.immutable.hardMaxBoardMatt, 5_000_000);
});

test('wallet-authenticated Admin controls update mine gates, tuning, and exact published maps', async (context) => {
  const harness = serviceHarness({ adminWallets: [account.address] });
  const server = createMattMineHttpServer({ root: ROOT, service: harness.service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const playerSession = await signIn(harness.service);

  const created = await fetch(`${base}/api/admin/auth/session`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${playerSession.token}`,
      origin: ORIGIN
    }
  });
  assert.equal(created.status, 201);
  const adminSession = await created.json();
  assert.equal(adminSession.admin.expiresAt - START, 8 * 60 * 60 * 1000);
  const cookie = created.headers.get('set-cookie')?.split(';')[0];
  assert.match(cookie || '', /^__Host-matt_admin=[a-f0-9]{64}$/);
  const mutationHeaders = {
    cookie,
    origin: ORIGIN,
    'content-type': 'application/json',
    'x-matt-csrf': adminSession.csrfToken
  };

  const paused = await fetch(`${base}/api/admin/mine-operations/practice`, {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      patch: { entriesPaused: true },
      reason: 'Verify wallet Admin Practice pause control'
    })
  });
  assert.equal(paused.status, 200, JSON.stringify(await paused.clone().json()));
  assert.equal((await paused.json()).controls.entriesPaused, true);
  await assert.rejects(
    () => harness.service.startRun(playerSession.token, SERVER_RUN_MODES.PRACTICE),
    (error) => error.code === 'practice_entries_paused'
  );

  const resumed = await fetch(`${base}/api/admin/mine-operations/practice`, {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      patch: { entriesPaused: false },
      reason: 'Verify wallet Admin Practice resume control'
    })
  });
  assert.equal(resumed.status, 200, JSON.stringify(await resumed.clone().json()));

  const tuned = await fetch(`${base}/api/admin/game-tuning/practice`, {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      patch: { permanentHealthPerRank: 20 },
      reason: 'Verify permanent upgrade scaling control'
    })
  });
  assert.equal(tuned.status, 200, JSON.stringify(await tuned.clone().json()));
  assert.equal((await tuned.json()).preset.permanentHealthPerRank, 20);

  const studioResponse = await fetch(`${base}/api/admin/competition-studio`, {
    headers: { cookie }
  });
  assert.equal(studioResponse.status, 200);
  const studio = await studioResponse.json();
  const draft = structuredClone(studio.studio.slots.practice.draft);
  draft.name = 'Wallet Admin Exact Practice Mine';
  draft.depths[0].map.name = 'Wallet Admin Depth One';
  draft.depths[0].map.rooms[0].width = 1.5;
  draft.map = structuredClone(draft.depths[0].map);
  draft._requestSizeRegressionPadding = 'x'.repeat(110 * 1024);

  const oversizedControl = await fetch(`${base}/api/admin/operations`, {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      patch: { freeRankedPaused: false },
      reason: 'Verify the standard API request limit remains protected',
      padding: 'x'.repeat(110 * 1024)
    })
  });
  assert.equal(oversizedControl.status, 413);
  assert.equal((await oversizedControl.json()).error.code, 'request_too_large');

  const saved = await fetch(`${base}/api/admin/competition-studio/practice/draft`, {
    method: 'PUT',
    headers: mutationHeaders,
    body: JSON.stringify({
      draft,
      reason: 'Verify wallet Admin exact map draft control'
    })
  });
  assert.equal(saved.status, 200, JSON.stringify(await saved.clone().json()));

  const challengeResponse = await fetch(`${base}/api/admin/auth/step-up/challenge`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({})
  });
  assert.equal(challengeResponse.status, 201, JSON.stringify(await challengeResponse.clone().json()));
  const challenge = (await challengeResponse.json()).challenge;
  const signature = await account.signMessage({ message: challenge.message });
  const verified = await fetch(`${base}/api/admin/auth/step-up/verify`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ nonce: challenge.nonce, signature })
  });
  assert.equal(verified.status, 200, JSON.stringify(await verified.clone().json()));

  const publishedResponse = await fetch(`${base}/api/admin/competition-studio/practice/publish`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ reason: 'Publish verified wallet Admin exact map now' })
  });
  assert.equal(publishedResponse.status, 201, JSON.stringify(await publishedResponse.clone().json()));
  const published = await publishedResponse.json();
  assert.equal(published.snapshot.depths[0].map.rooms[0].width, 1.5);

  const run = await harness.service.startRun(playerSession.token, SERVER_RUN_MODES.PRACTICE);
  assert.equal(run.tuning.permanentHealthPerRank, 20);
  assert.equal(run.competitionSnapshot.id, published.snapshot.id);
  assert.equal(run.competitionSnapshot.depths[0].map.rooms[0].width, 1.5);
  assert.equal(run.competitionSnapshot.depths[0].map.name, 'Wallet Admin Depth One');
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
