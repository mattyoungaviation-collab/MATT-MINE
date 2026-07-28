import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData } from 'viem';

import { MattMineApiClient, SESSION_STORAGE_KEY } from '../src/game/apiClient.js';
import { RoninWalletAdapter, parseChainId } from '../src/game/walletAdapter.js';
import { JsonFileDatabase, MemoryDatabase, PostgresDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import {
  MATT_MINE_PASS_ABI,
  MATT_MINE_RUNS_ABI,
  RONIN_PAYMENT_CONTRACTS,
  RoninPaymentVerifier
} from '../server/payment-verifier.js';
import { MattMineService } from '../server/service.js';
import { AUTH_CHALLENGE_TTL_MS, RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';
import { PASS_CHEST_ID } from '../src/game/passRewards.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_PRIVATE_KEY = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const account = privateKeyToAccount(PRIVATE_KEY);
const otherAccount = privateKeyToAccount(OTHER_PRIVATE_KEY);
const START = Date.UTC(2026, 6, 25, 12, 0, 0);
const ORIGIN = 'http://localhost:4173';
const UNSUPPORTED_CHAIN_ID = 1;
const VALID_AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function createHarness(options = {}) {
  let timestamp = options.timestamp ?? START;
  let randomCounter = 0;
  const database = options.database || new MemoryDatabase();
  const service = new MattMineService(database, {
    now: () => timestamp,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: options.adminKey || 'test-admin-key',
    mainnetTransactionsEnabled: options.mainnetTransactionsEnabled === true,
    paymentVerifier: options.paymentVerifier,
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

async function signIn(harness, signer = account, options = {}) {
  const challenge = await harness.service.createChallenge({
    address: signer.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await signer.signMessage({ message: challenge.message });
  const session = await harness.service.verifyChallenge({
    address: signer.address,
    nonce: challenge.nonce,
    signature
  });
  if (!options.skipIdentity) {
    const created = await harness.service.setPlayerIdentity(
      session.token,
      { name: `Miner_${signer.address.slice(2, 8)}` }
    );
    session.identity = created.identity;
    session.entitlements.freeRunAvailable = true;
  }
  return { challenge, signature, session };
}

test('wallet identities require one permanent unique name and serve validated leaderboard avatars', async () => {
  const harness = createHarness();
  const first = await signIn(harness, account, { skipIdentity: true });
  assert.equal(first.session.identity.requiresSetup, true);
  assert.equal(first.session.entitlements.freeRunAvailable, false);
  await assert.rejects(
    () => harness.service.startRun(first.session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'miner_identity_required'
  );

  const created = await harness.service.setPlayerIdentity(first.session.token, {
    name: 'Rock_Runner',
    avatarDataUrl: VALID_AVATAR
  });
  assert.deepEqual(created.identity.name, 'Rock_Runner');
  assert.match(created.identity.avatarUrl, /^\/api\/profiles\/0x[a-f0-9]{40}\/avatar\?v=\d+$/);
  assert.equal(created.identity.requiresSetup, false);
  const avatar = await harness.service.profileAvatar(account.address);
  assert.equal(avatar.contentType, 'image/png');
  assert.equal(avatar.body.subarray(1, 4).toString('ascii'), 'PNG');

  const second = await signIn(harness, otherAccount, { skipIdentity: true });
  await assert.rejects(
    () => harness.service.setPlayerIdentity(second.session.token, { name: 'rock_runner' }),
    (error) => error.code === 'username_taken'
  );
  await assert.rejects(
    () => harness.service.setPlayerIdentity(first.session.token, { name: 'DifferentName' }),
    (error) => error.code === 'username_permanent'
  );
  await assert.rejects(
    () => harness.service.updatePlayerAvatar(first.session.token, 'data:image/png;base64,bm90LWFuLWltYWdl'),
    (error) => error.code === 'avatar_signature'
  );
  const controls = await harness.service.updatePlayerKeybindings(first.session.token, {
    moveUp: 'ArrowUp',
    moveDown: 'ArrowDown',
    moveLeft: 'ArrowLeft',
    moveRight: 'ArrowRight',
    attack: 'KeyF',
    dash: 'KeyE',
    pickaxe: 'Digit1',
    dynamite: 'Digit2',
    blaster: 'Digit3'
  });
  assert.equal(controls.keybindings.attack, 'KeyF');
  await assert.rejects(
    () => harness.service.updatePlayerKeybindings(first.session.token, {
      ...controls.keybindings,
      dash: 'KeyF'
    }),
    (error) => error.code === 'invalid_keybindings'
  );
  const savedPlayer = await harness.service.me(first.session.token);
  assert.equal(savedPlayer.keybindings.moveUp, 'ArrowUp');

  const run = await harness.service.startRun(first.session.token, SERVER_RUN_MODES.FREE);
  harness.advance(61_000);
  await finish(harness.service, first.session, run, extractedResult());
  const leaderboard = await harness.service.leaderboard(first.session.token, SERVER_RUN_MODES.FREE);
  assert.equal(leaderboard.rows[0].walletId, 'Rock_Runner');
  assert.equal(leaderboard.rows[0].identity.name, 'Rock_Runner');
  assert.equal(leaderboard.rows[0].identity.avatarUrl, created.identity.avatarUrl);
});

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

async function finish(service, session, run, result) {
  return service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result
  });
}

function createFakePaymentVerifier(options = {}) {
  let counter = 0;
  const active = options.active !== false;
  return {
    publicConfig() {
      return {
        contracts: {
          pass: RONIN_PAYMENT_CONTRACTS.pass,
          runs: RONIN_PAYMENT_CONTRACTS.runs,
          matt: RONIN_PAYMENT_CONTRACTS.matt
        },
        confirmations: 3
      };
    },
    async status() {
      return {
        pass: {
          active,
          expiresAt: START + 30 * 86_400_000,
          priceRonWei: '95000000000000000000',
          paused: false,
          transaction: {
            to: RONIN_PAYMENT_CONTRACTS.pass,
            value: '0x5265c00a7b1c2d0000',
            data: '0xdeadbeef'
          }
        },
        paidRuns: {
          priceRonWei: '10000000000000000000',
          purchasedToday: 0,
          dailyLimit: 10,
          paused: options.paused === true
        }
      };
    },
    async quotePaidRun() {
      if (options.paused === true) {
        const error = new Error('Paid-run purchases are currently paused.');
        error.code = 'paid_runs_paused';
        throw error;
      }
      return {
        quotedMattOut: '1000000000000000000000',
        minMattOut: '950000000000000000000',
        slippageBps: 500,
        deadline: Math.floor(START / 1000) + 300,
        transaction: {
          to: RONIN_PAYMENT_CONTRACTS.runs,
          value: '0x8ac7230489e80000',
          data: '0x12345678'
        }
      };
    },
    async verifyPassPurchase(transactionHash, address) {
      return {
        key: `${transactionHash.toLowerCase()}:0`,
        transactionHash: transactionHash.toLowerCase(),
        logIndex: 0,
        blockNumber: '58780000',
        address: address.toLowerCase(),
        priceRon: '95000000000000000000',
        expiresAt: START + 30 * 86_400_000
      };
    },
    async verifyPaidRunPurchase(transactionHash, address) {
      counter += 1;
      return {
        key: `${transactionHash.toLowerCase()}:0`,
        transactionHash: transactionHash.toLowerCase(),
        logIndex: 0,
        blockNumber: '58780000',
        address: address.toLowerCase(),
        entitlementId: String(counter),
        ronPaid: '10000000000000000000',
        mattBought: '1000000000000000000000',
        currentPoolMatt: '700000000000000000000',
        futureRewardsMatt: '200000000000000000000',
        reserveMatt: '100000000000000000000'
      };
    }
  };
}

test('Ronin SIWE-style challenges bind origin, chain, address, expiry, and one-time use', async () => {
  assert.throws(
    () => new MattMineService(new MemoryDatabase(), { chainId: UNSUPPORTED_CHAIN_ID }),
    (error) => error.code === 'invalid_server_chain'
  );
  const harness = createHarness();
  const { challenge, signature, session } = await signIn(harness);
  assert.match(challenge.message, /wants you to sign in with your Ronin account/);
  assert.match(challenge.message, new RegExp(`Chain ID: ${RONIN_CHAINS.MAINNET}`));
  assert.match(challenge.message, /does not initiate a transaction or spend RON or MATT/);
  assert.equal(session.address, account.address.toLowerCase());
  assert.equal(session.entitlements.freeRunAvailable, true);
  assert.equal(session.token.length, 64);

  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: challenge.nonce,
      signature
    }),
    (error) => error.code === 'challenge_not_found'
  );

  await assert.rejects(
    () => harness.service.createChallenge({
      address: account.address,
      chainId: UNSUPPORTED_CHAIN_ID,
      origin: ORIGIN
    }),
    (error) => error.code === 'wrong_chain'
  );
  await assert.rejects(
    () => harness.service.createChallenge({
      address: account.address,
      chainId: RONIN_CHAINS.MAINNET,
      origin: 'https://evil.example'
    }),
    (error) => error.code === 'origin_mismatch'
  );
});

test('wrong-wallet and expired signatures cannot create sessions', async () => {
  const harness = createHarness();
  const challenge = await harness.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const wrongSignature = await otherAccount.signMessage({ message: challenge.message });
  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: challenge.nonce,
      signature: wrongSignature
    }),
    (error) => error.code === 'signature_rejected'
  );

  const expiring = await harness.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: expiring.message });
  harness.advance(AUTH_CHALLENGE_TTL_MS + 1);
  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: expiring.nonce,
      signature
    }),
    (error) => error.code === 'challenge_expired'
  );
});

test('the server owns the free entitlement, run token, replay protection, profile, and leaderboard score', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  assert.equal(run.seed, 'MATT-MINE-2026-07-25-FREE');
  harness.advance(60_000);
  const accepted = await finish(harness.service, session, run, extractedResult());
  assert.equal(accepted.run.result.score, 1_000);
  assert.equal(accepted.profile.bankedNuggets, 1_000);
  assert.equal(accepted.profile.totalRuns, 1);
  assert.equal(accepted.leaderboard.playerRank, 1);
  assert.equal(accepted.leaderboard.playerScore, 1_000);
  const historical = await harness.service.leaderboard(
    session.token,
    SERVER_RUN_MODES.FREE,
    harness.now(),
    '2026-07-20'
  );
  assert.equal(historical.playerScore, 1_000);
  await assert.rejects(
    () => harness.service.leaderboard(
      session.token,
      SERVER_RUN_MODES.FREE,
      harness.now(),
      '2026-07-21'
    ),
    (error) => error.code === 'invalid_leaderboard_week'
  );

  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult()),
    (error) => error.code === 'run_already_finished'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'free_run_used'
  );

  const player = await harness.service.me(session.token);
  assert.equal(player.entitlements.freeRunAvailable, false);
  assert.equal(player.scores.free, 1_000);
});

test('abandoning a server run releases it without recording profile or leaderboard progress', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  const abandoned = await harness.service.abandonRun(session.token, {
    runId: run.runId,
    runToken: run.runToken
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.run.status, 'expired');

  const state = await harness.database.read();
  assert.equal(state.runs[run.runId].status, 'expired');
  assert.equal(state.runs[run.runId].result, null);
  const player = await harness.service.me(session.token);
  assert.equal(player.profile.totalRuns, 0);
  assert.equal(player.scores.free, 0);

  await assert.rejects(
    () => harness.service.finishRun(session.token, {
      runId: run.runId,
      runToken: run.runToken,
      result: extractedResult()
    }),
    (error) => error.code === 'run_already_finished'
  );
  const replacement = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.notEqual(replacement.runId, run.runId);
});

test('ranked entries close before weekly zero while Practice remains available', async () => {
  const harness = createHarness({
    timestamp: Date.UTC(2026, 6, 26, 23, 56, 0)
  });
  const { session } = await signIn(harness);

  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'ranked_window_closing'
  );
  const practice = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.equal(practice.mode, SERVER_RUN_MODES.PRACTICE);
});

test('paid server runs stay disabled while authenticated Practice remains unlimited', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PAID),
    (error) => error.code === 'paid_runs_disabled'
  );
  const first = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  const second = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.notEqual(first.runId, second.runId);
});

test('live Pass confirmation is idempotent and server-owned Pass XP follows ranked play', async () => {
  const harness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier()
  });
  const { session } = await signIn(harness);
  const passHash = `0x${'9'.repeat(64)}`;

  const confirmed = await harness.service.confirmPassPurchase(session.token, passHash);
  assert.equal(confirmed.alreadyConfirmed, false);
  assert.equal(confirmed.passProgress.xp, 0);
  assert.equal(confirmed.passProgress.level, 1);
  const duplicate = await harness.service.confirmPassPurchase(session.token, passHash);
  assert.equal(duplicate.alreadyConfirmed, true);
  const stored = await harness.database.read();
  assert.equal(Object.keys(stored.passPurchases).length, 1);

  const freeRun = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(60_000);
  const freeResult = await finish(harness.service, session, freeRun, extractedResult());
  assert.equal(freeResult.run.passXpAwarded, 25);
  assert.equal(freeResult.passProgress.xp, 25);

  await harness.service.confirmPaidRunPurchase(session.token, `0x${'8'.repeat(64)}`);
  const paidRun = await harness.service.startRun(session.token, SERVER_RUN_MODES.PAID);
  harness.advance(60_000);
  const paidResult = await finish(harness.service, session, paidRun, extractedResult());
  assert.equal(paidResult.run.passXpAwarded, 100);
  assert.equal(paidResult.passProgress.xp, 125);

  const player = await harness.service.me(session.token);
  assert.equal(player.passProgress.xp, 125);
  assert.equal(player.passProgress.level, 1);
});

test('Pass levels permanently deliver cosmetics, chest contents, and server-owned loadouts', async () => {
  const harness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier()
  });
  const { session } = await signIn(harness);
  const confirmed = await harness.service.confirmPassPurchase(session.token, `0x${'7'.repeat(64)}`);
  assert.deepEqual(confirmed.passInventory.claimedLevels, [1]);
  assert.deepEqual(confirmed.passInventory.cosmetics, ['starter_badge']);
  assert.equal(confirmed.passInventory.equipped.badge, 'starter_badge');

  await harness.database.transact((state) => {
    state.wallets[account.address.toLowerCase()].passProgress.xp = 3_800;
  });
  const synced = await harness.service.syncPassRewards(session.token);
  assert.deepEqual(synced.passInventory.claimedLevels, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(synced.passInventory.chests[PASS_CHEST_ID].available, 1);
  assert.equal(synced.passInventory.cosmetics.includes('molten_pickaxe'), false);
  assert.equal(synced.passInventory.equipped.skin, 'crystal_skin');
  assert.equal(synced.passInventory.equipped.frame, 'founder_frame');

  const chest = await harness.service.openPassChest(session.token, PASS_CHEST_ID);
  assert.equal(chest.rewards.cosmetic.id, 'molten_pickaxe');
  assert.equal(chest.rewards.nuggets, 250_000);
  assert.equal(chest.profile.bankedNuggets, 250_000);
  assert.equal(chest.passInventory.chests[PASS_CHEST_ID].available, 0);
  assert.equal(chest.passInventory.chests[PASS_CHEST_ID].opened, 1);
  assert.equal(chest.passInventory.cosmetics.length, 8);
  assert.equal(chest.passInventory.equipped.weapon, 'molten_pickaxe');

  const unequipped = await harness.service.equipPassCosmetic(session.token, 'trail', '');
  assert.equal(unequipped.passInventory.equipped.trail, '');
  const equipped = await harness.service.equipPassCosmetic(session.token, 'trail', 'gold_trail');
  assert.equal(equipped.passInventory.equipped.trail, 'gold_trail');
  await assert.rejects(
    () => harness.service.equipPassCosmetic(session.token, 'skin', 'molten_pickaxe'),
    (error) => error.code === 'cosmetic_not_owned'
  );
  await assert.rejects(
    () => harness.service.openPassChest(session.token, PASS_CHEST_ID),
    (error) => error.code === 'pass_chest_unavailable'
  );

  const permanent = await harness.service.passRewards(session.token);
  assert.equal(permanent.passInventory.cosmetics.includes('season_trophy'), true);
  assert.equal(permanent.passInventory.equipped.title, 'ore_reactor_title');

  const freeRun = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(60_000);
  const scored = await finish(harness.service, session, freeRun, extractedResult());
  assert.equal(scored.leaderboard.rows[0].appearance.frame, 'founder_frame');
  assert.equal(scored.leaderboard.rows[0].appearance.title, 'ore_reactor_title');
  assert.equal(scored.leaderboard.rows[0].appearance.trophy, 'season_trophy');
});

test('historical Pass XP remains claimable after expiry while non-buyers cannot unlock level one', async () => {
  const expiredHarness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier({ active: false })
  });
  const { session } = await signIn(expiredHarness);
  await expiredHarness.service.confirmPassPurchase(session.token, `0x${'6'.repeat(64)}`);
  await expiredHarness.database.transact((state) => {
    state.wallets[account.address.toLowerCase()].passProgress.xp = 500;
    state.wallets[account.address.toLowerCase()].passInventory.claimedLevels = [1];
    state.wallets[account.address.toLowerCase()].passInventory.cosmetics = ['starter_badge'];
  });
  const recovered = await expiredHarness.service.syncPassRewards(session.token);
  assert.deepEqual(recovered.passInventory.claimedLevels, [1, 2, 3]);
  assert.equal(recovered.passInventory.chests[PASS_CHEST_ID].available, 1);

  const noPassHarness = createHarness();
  const noPassSession = await signIn(noPassHarness);
  await assert.rejects(
    () => noPassHarness.service.syncPassRewards(noPassSession.session.token),
    (error) => error.code === 'pass_not_owned'
  );
});

test('confirmed Ronin purchases create one-time paid-run entitlements and daily-best Pass scores', async () => {
  const paymentVerifier = createFakePaymentVerifier();
  const harness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier
  });
  const { session } = await signIn(harness);
  assert.equal(harness.service.config().realPaymentsEnabled, true);

  const status = await harness.service.paymentStatus(session.token);
  assert.equal(status.pass.active, true);
  assert.equal(status.confirmedCredits, 0);
  const quote = await harness.service.quotePaidRun(session.token);
  assert.equal(quote.minMattOut, '950000000000000000000');

  const firstHash = `0x${'1'.repeat(64)}`;
  const firstConfirmation = await harness.service.confirmPaidRunPurchase(session.token, firstHash);
  assert.equal(firstConfirmation.confirmedCredits, 1);
  assert.equal(firstConfirmation.alreadyConfirmed, false);
  const duplicate = await harness.service.confirmPaidRunPurchase(session.token, firstHash);
  assert.equal(duplicate.confirmedCredits, 1);
  assert.equal(duplicate.alreadyConfirmed, true);

  const firstRun = await harness.service.startRun(session.token, SERVER_RUN_MODES.PAID);
  assert.equal(firstRun.seed, 'MATT-MINE-2026-07-25-PAID');
  assert.equal(firstRun.rewardWeight, 2);
  harness.advance(60_000);
  await finish(harness.service, session, firstRun, extractedResult({ projected: 1_000, banked: 1_000 }));
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PAID),
    (error) => error.code === 'paid_run_credit_required'
  );

  const secondHash = `0x${'2'.repeat(64)}`;
  await harness.service.confirmPaidRunPurchase(session.token, secondHash);
  const secondRun = await harness.service.startRun(session.token, SERVER_RUN_MODES.PAID);
  harness.advance(60_000);
  const accepted = await finish(
    harness.service,
    session,
    secondRun,
    extractedResult({ projected: 1_500, banked: 1_500 })
  );
  assert.equal(accepted.leaderboard.playerScore, 1_500);
  const finalStatus = await harness.service.paymentStatus(session.token);
  assert.equal(finalStatus.confirmedCredits, 0);
});

test('pass state, contract pause, and server suspension block paid access safely', async () => {
  const noPassHarness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier({ active: false })
  });
  const { session: noPassSession } = await signIn(noPassHarness);
  await assert.rejects(
    () => noPassHarness.service.startRun(noPassSession.token, SERVER_RUN_MODES.PAID),
    (error) => error.code === 'active_pass_required'
  );

  const pausedHarness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier({ paused: true })
  });
  const { session: pausedSession } = await signIn(pausedHarness);
  await assert.rejects(
    () => pausedHarness.service.quotePaidRun(pausedSession.token),
    (error) => error.code === 'paid_runs_paused'
  );

  const suspendedHarness = createHarness({
    mainnetTransactionsEnabled: true,
    paymentVerifier: createFakePaymentVerifier()
  });
  const { session: suspendedSession } = await signIn(suspendedHarness);
  await suspendedHarness.service.setWalletSuspension('test-admin-key', account.address, true);
  await assert.rejects(
    () => suspendedHarness.service.confirmPaidRunPurchase(suspendedSession.token, `0x${'3'.repeat(64)}`),
    (error) => error.code === 'wallet_suspended'
  );
});

test('Pass receipt verifier requires the approved purchasePass call and activation event', async () => {
  const transactionHash = `0x${'6'.repeat(64)}`;
  const priceRon = 95n * 10n ** 18n;
  const expiresAt = BigInt(Math.floor(START / 1000) + 30 * 86_400);
  const topics = encodeEventTopics({
    abi: MATT_MINE_PASS_ABI,
    eventName: 'PassPurchased',
    args: { player: account.address }
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint64' }],
    [priceRon, expiresAt]
  );
  const receipt = {
    status: 'success',
    to: RONIN_PAYMENT_CONTRACTS.pass,
    blockNumber: 58_780_000n,
    logs: [{
      address: RONIN_PAYMENT_CONTRACTS.pass,
      topics,
      data,
      logIndex: 3
    }]
  };
  const transaction = {
    from: account.address,
    to: RONIN_PAYMENT_CONTRACTS.pass,
    value: priceRon,
    input: encodeFunctionData({
      abi: MATT_MINE_PASS_ABI,
      functionName: 'purchasePass'
    })
  };
  const verifier = new RoninPaymentVerifier({
    confirmations: 1,
    client: {
      waitForTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction
    }
  });

  const verified = await verifier.verifyPassPurchase(transactionHash, account.address);
  assert.equal(verified.key, `${transactionHash}:3`);
  assert.equal(verified.priceRon, String(priceRon));
  assert.equal(verified.expiresAt, Number(expiresAt) * 1000);

  const wrongWalletVerifier = new RoninPaymentVerifier({
    confirmations: 1,
    client: {
      waitForTransactionReceipt: async () => receipt,
      getTransaction: async () => ({ ...transaction, from: otherAccount.address })
    }
  });
  await assert.rejects(
    () => wrongWalletVerifier.verifyPassPurchase(transactionHash, account.address),
    (error) => error.code === 'payment_wallet_mismatch'
  );
});

test('receipt verifier accepts only the approved Runs call and matching PaidRunPurchased event', async () => {
  const transactionHash = `0x${'4'.repeat(64)}`;
  const ronPaid = 10n * 10n ** 18n;
  const minMattOut = 900n * 10n ** 18n;
  const deadline = BigInt(Math.floor(START / 1000) + 300);
  const topics = encodeEventTopics({
    abi: MATT_MINE_RUNS_ABI,
    eventName: 'PaidRunPurchased',
    args: { player: account.address, entitlementId: 7n }
  });
  const data = encodeAbiParameters(
    [
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' },
      { type: 'uint256' }
    ],
    [
      ronPaid,
      1_000n * 10n ** 18n,
      700n * 10n ** 18n,
      200n * 10n ** 18n,
      100n * 10n ** 18n
    ]
  );
  const receipt = {
    status: 'success',
    to: RONIN_PAYMENT_CONTRACTS.runs,
    blockNumber: 58_780_000n,
    logs: [{
      address: RONIN_PAYMENT_CONTRACTS.runs,
      topics,
      data,
      logIndex: 4
    }]
  };
  const transaction = {
    from: account.address,
    to: RONIN_PAYMENT_CONTRACTS.runs,
    value: ronPaid,
    input: encodeFunctionData({
      abi: MATT_MINE_RUNS_ABI,
      functionName: 'purchasePaidRun',
      args: [minMattOut, deadline]
    })
  };
  const verifier = new RoninPaymentVerifier({
    confirmations: 1,
    client: {
      waitForTransactionReceipt: async () => receipt,
      getTransaction: async () => transaction
    }
  });
  const verified = await verifier.verifyPaidRunPurchase(transactionHash, account.address);
  assert.equal(verified.key, `${transactionHash}:4`);
  assert.equal(verified.entitlementId, '7');
  assert.equal(verified.ronPaid, String(ronPaid));
  assert.equal(verified.currentPoolMatt, String(700n * 10n ** 18n));

  const wrongWalletVerifier = new RoninPaymentVerifier({
    confirmations: 1,
    client: {
      waitForTransactionReceipt: async () => receipt,
      getTransaction: async () => ({ ...transaction, from: otherAccount.address })
    }
  });
  await assert.rejects(
    () => wrongWalletVerifier.verifyPaidRunPurchase(transactionHash, account.address),
    (error) => error.code === 'payment_wallet_mismatch'
  );
});

test('live quote uses current contract prices, Katana output, slippage protection, and a short deadline', async () => {
  const paidRunPrice = 10n * 10n ** 18n;
  const quotedMatt = 2_000n * 10n ** 18n;
  const blockTimestamp = BigInt(Math.floor(START / 1000));
  const client = {
    async readContract({ functionName }) {
      if (functionName === 'hasActivePass') return true;
      if (functionName === 'passExpiresAt') return blockTimestamp + 86_400n;
      if (functionName === 'passPriceRon') return 95n * 10n ** 18n;
      if (functionName === 'paidRunPriceRon') return paidRunPrice;
      if (functionName === 'paidRunsToday') return 2;
      if (functionName === 'paused') return false;
      if (functionName === 'getAmountsOut') return [paidRunPrice, quotedMatt];
      throw new Error(`Unexpected read ${functionName}`);
    },
    async getBlock() {
      return { timestamp: blockTimestamp };
    }
  };
  const verifier = new RoninPaymentVerifier({
    client,
    slippageBps: 500,
    quoteLifetimeSeconds: 300
  });
  const quote = await verifier.quotePaidRun(account.address);
  assert.equal(quote.quotedMattOut, String(quotedMatt));
  assert.equal(quote.minMattOut, String((quotedMatt * 9_500n) / 10_000n));
  assert.equal(quote.deadline, Number(blockTimestamp + 300n));
  assert.equal(BigInt(quote.transaction.value), paidRunPrice);
  const decoded = decodeFunctionData({
    abi: MATT_MINE_RUNS_ABI,
    data: quote.transaction.data
  });
  assert.equal(decoded.functionName, 'purchasePaidRun');
  assert.equal(decoded.args[0], (quotedMatt * 9_500n) / 10_000n);
  assert.equal(decoded.args[1], blockTimestamp + 300n);
});

test('impossible telemetry is rejected without consuming the active run submission', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(1_000);
  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult({ elapsed: 100 })),
    (error) => error.code === 'elapsed_time_impossible'
  );
  harness.advance(59_000);
  const accepted = await finish(harness.service, session, run, extractedResult());
  assert.equal(accepted.accepted, true);
});

test('ranked knockouts score only the exact secured 50 percent loot amount', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(30_000);
  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult({
      extracted: false,
      projected: 1_001,
      banked: 501,
      elapsed: 30
    })),
    (error) => error.code === 'knockout_mismatch'
  );
  const accepted = await finish(harness.service, session, run, extractedResult({
    extracted: false,
    projected: 1_001,
    banked: 500,
    elapsed: 30
  }));
  assert.equal(accepted.run.result.score, 500);
  assert.equal(accepted.profile.bankedNuggets, 500);
});

test('server suspension blocks ranked issuance and submission but keeps Practice available', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const ranked = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  await harness.service.setWalletSuspension('test-admin-key', account.address, true);
  harness.advance(60_000);
  await assert.rejects(
    () => finish(harness.service, session, ranked, extractedResult()),
    (error) => error.code === 'wallet_suspended'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'wallet_suspended'
  );
  const practice = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.equal(practice.mode, SERVER_RUN_MODES.PRACTICE);
  await assert.rejects(
    () => harness.service.setWalletSuspension('wrong-key', account.address, false),
    (error) => error.code === 'admin_key_rejected'
  );
});

test('permanent upgrades spend only server-owned banked nuggets', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(60_000);
  await finish(harness.service, session, run, extractedResult());
  const upgraded = await harness.service.purchaseUpgrade(session.token, 'health');
  assert.equal(upgraded.cost, 110);
  assert.equal(upgraded.rank, 1);
  assert.equal(upgraded.profile.bankedNuggets, 890);
  assert.equal(upgraded.profile.meta.health, 1);
});

test('competitive runs preserve the authoritative player profile for replay', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  await harness.database.transact((state) => {
    state.wallets[account.address.toLowerCase()].profile.meta.health = 3;
  });

  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  const state = await harness.database.read();

  assert.equal(state.runs[run.runId].playerProfile.meta.health, 3);
  assert.notEqual(state.runs[run.runId].playerProfile, state.wallets[account.address.toLowerCase()].profile);
});

test('JSON server storage persists profiles and recovers corrupt state safely', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'matt-mine-v6-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'store.json');
  const database = await new JsonFileDatabase(filePath, { now: () => START }).init();
  const harness = createHarness({ database });
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(60_000);
  await finish(harness.service, session, run, extractedResult());

  const reloaded = await new JsonFileDatabase(filePath).init();
  const persisted = await reloaded.read();
  assert.equal(persisted.wallets[account.address.toLowerCase()].profile.bankedNuggets, 1_000);

  await writeFile(filePath, '{broken-json', 'utf8');
  const recovered = await new JsonFileDatabase(filePath, { now: () => START + 1 }).init();
  assert.ok(recovered.recoveredFile?.endsWith(`.corrupt-${START + 1}`));
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).wallets, {});
});

test('PostgreSQL storage initializes, serializes transactions, and reports readiness', async () => {
  const fakePool = createFakePostgresPool();
  const database = await new PostgresDatabase(null, { pool: fakePool }).init();
  const result = await database.transact((state) => {
    state.audit.push({ action: 'POSTGRES_WRITE', timestamp: START });
    return { saved: true };
  });
  assert.deepEqual(result, { saved: true });

  const persisted = await database.read();
  assert.equal(persisted.audit[0].action, 'POSTGRES_WRITE');
  assert.equal(fakePool.transactionLog.includes('BEGIN'), true);
  assert.equal(fakePool.transactionLog.includes('COMMIT'), true);
  assert.equal(fakePool.transactionLog.includes('ROLLBACK'), false);

  const health = await database.healthCheck();
  assert.equal(health.ok, true);
  assert.equal(health.kind, 'postgresql');
  assert.equal(Number.isSafeInteger(health.latencyMs), true);
});

test('the HTTP server exposes same-origin APIs, security headers, and authenticated player data', async (context) => {
  const harness = createHarness();
  const server = createMattMineHttpServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    service: harness.service
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const healthResponse = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthResponse.status, 200);
  const healthPayload = await healthResponse.json();
  assert.equal(healthPayload.version, 17);
  assert.equal(healthPayload.database.kind, 'memory');

  const launchResponse = await fetch(baseUrl);
  assert.equal(launchResponse.status, 200);
  assert.equal(launchResponse.headers.get('cache-control'), 'no-cache');
  assert.equal(launchResponse.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.match(launchResponse.headers.get('content-security-policy'), /img-src 'self' data: blob:/);
  const launchHtml = await launchResponse.text();
  assert.match(launchHtml, /id="launch" class="screen active launch-screen"/);
  assert.match(launchHtml, /0x4B5D10f6DA960436c5E3c23F40C52d36E2225555/);
  assert.match(launchHtml, /MATT Mine — Dig\. Fight\. Extract\./);

  const heroResponse = await fetch(`${baseUrl}/assets/launch/matt-mine-hero.png`);
  assert.equal(heroResponse.status, 200);
  assert.equal(heroResponse.headers.get('content-type'), 'image/png');
  assert.equal(heroResponse.headers.get('cache-control'), 'public, max-age=86400');

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.headers.get('x-frame-options'), 'DENY');
  const configPayload = await configResponse.json();
  assert.equal(configPayload.config.chainId, RONIN_CHAINS.MAINNET);
  assert.equal(configPayload.config.chainName, 'Ronin Mainnet');
  assert.equal(configPayload.config.paidRunsEnabled, false);
  assert.equal(configPayload.config.realPaymentsEnabled, false);
  assert.equal(configPayload.config.mattClaimsEnabled, false);
  assert.equal(configPayload.config.mainnetTransactionsEnabled, false);

  const publicPaymentResponse = await fetch(`${baseUrl}/api/payments/public-status`);
  assert.equal(publicPaymentResponse.status, 200);
  const publicPaymentPayload = await publicPaymentResponse.json();
  assert.equal(publicPaymentPayload.status.live, false);
  assert.equal(publicPaymentPayload.status.pass.priceRonWei, String(95n * 10n ** 18n));
  assert.equal(publicPaymentPayload.status.paidRuns.priceRonWei, String(10n * 10n ** 18n));

  const crossOrigin = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({
      address: account.address,
      chainId: RONIN_CHAINS.MAINNET,
      origin: 'https://evil.example'
    })
  });
  assert.equal(crossOrigin.status, 403);

  const { session } = await signIn(harness);
  const updated = await harness.service.updatePlayerAvatar(session.token, VALID_AVATAR);
  const avatarResponse = await fetch(`${baseUrl}${updated.identity.avatarUrl}`);
  assert.equal(avatarResponse.status, 200);
  assert.equal(avatarResponse.headers.get('content-type'), 'image/png');
  assert.match(avatarResponse.headers.get('cache-control'), /immutable/);
  const avatarBytes = new Uint8Array(await avatarResponse.arrayBuffer());
  assert.equal(Buffer.from(avatarBytes.subarray(1, 4)).toString('ascii'), 'PNG');
});

function createFakePostgresPool() {
  let data = null;
  const transactionLog = [];

  async function query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    if (
      normalized.startsWith('CREATE TABLE')
      || normalized.startsWith('CREATE INDEX')
      || normalized.startsWith('DO $$')
    ) {
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO MATT_MINE_STATE')) {
      if (!data) data = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (normalized === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (normalized.startsWith('SELECT DATA FROM MATT_MINE_STATE')) {
      return { rows: data ? [{ data: structuredClone(data) }] : [] };
    }
    if (normalized.startsWith('UPDATE MATT_MINE_STATE')) {
      data = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SCORES')) return { rows: [] };
    if (normalized.startsWith('SELECT DISTINCT WEEK_KEY, MODE FROM MATT_MINE_WEEKLY_SCORES')) {
      return { rows: [] };
    }
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) {
      transactionLog.push(normalized);
      return { rows: [] };
    }
    throw new Error(`Unexpected fake PostgreSQL query: ${normalized}`);
  }

  return {
    transactionLog,
    query,
    async connect() {
      return { query, release() {} };
    },
    async end() {}
  };
}

test('the browser API client stores sessions only in session storage and clears them on 401', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const client = new MattMineApiClient({
    storage,
    fetch: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'session_expired', message: 'Expired' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  });
  client.setToken('a'.repeat(64));
  assert.equal(values.get(SESSION_STORAGE_KEY), 'a'.repeat(64));
  await assert.rejects(() => client.me(), (error) => error.code === 'session_expired');
  assert.equal(values.has(SESSION_STORAGE_KEY), false);
});

test('the browser API client reaches every authenticated Pass collection action', async () => {
  const requests = [];
  const client = new MattMineApiClient({
    storage: {
      getItem: () => 'session-token',
      setItem() {},
      removeItem() {}
    },
    fetch: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null,
        authorization: options.headers.authorization
      });
      return new Response(JSON.stringify({ ok: true, passInventory: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await client.passRewards();
  await client.syncPassRewards();
  await client.equipPassCosmetic('trail', 'gold_trail');
  await client.openPassChest(PASS_CHEST_ID);
  assert.deepEqual(requests.map((request) => [request.method, request.url]), [
    ['GET', '/api/pass/rewards'],
    ['POST', '/api/pass/rewards/sync'],
    ['PUT', '/api/pass/loadout'],
    ['POST', '/api/pass/chests/open']
  ]);
  assert.equal(requests.every((request) => request.authorization === 'Bearer session-token'), true);
  assert.deepEqual(requests[2].body, { slot: 'trail', cosmeticId: 'gold_trail' });
  assert.deepEqual(requests[3].body, { chestId: PASS_CHEST_ID });
});

test('the browser API client creates permanent identities and replaces profile pictures', async () => {
  const requests = [];
  const client = new MattMineApiClient({
    storage: {
      getItem: () => 'session-token',
      setItem() {},
      removeItem() {}
    },
    fetch: async (url, options) => {
      requests.push({
        url,
        method: options.method,
        body: JSON.parse(options.body),
        authorization: options.headers.authorization
      });
      return new Response(JSON.stringify({ ok: true, identity: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  await client.setIdentity('MinerOne', avatar);
  await client.updateAvatar(avatar);
  assert.deepEqual(requests, [
    {
      url: '/api/profile/identity',
      method: 'POST',
      body: { name: 'MinerOne', avatarDataUrl: avatar },
      authorization: 'Bearer session-token'
    },
    {
      url: '/api/profile/avatar',
      method: 'PUT',
      body: { avatarDataUrl: avatar },
      authorization: 'Bearer session-token'
    }
  ]);
});

test('the Ronin adapter switches to Mainnet, signs the server message, and invalidates on account change', async () => {
  const calls = [];
  const listeners = new Map();
  const provider = {
    async request(payload) {
      calls.push(payload);
      if (payload.method === 'eth_requestAccounts') return [account.address];
      if (payload.method === 'eth_chainId') {
        const switched = calls.some((entry) => entry.method === 'wallet_switchEthereumChain');
        return switched ? `0x${RONIN_CHAINS.MAINNET.toString(16)}` : `0x${UNSUPPORTED_CHAIN_ID.toString(16)}`;
      }
      if (payload.method === 'wallet_switchEthereumChain') return null;
      if (payload.method === 'personal_sign') return `0x${'1'.repeat(130)}`;
      if (payload.method === 'eth_sendTransaction') return `0x${'5'.repeat(64)}`;
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error(`Unexpected method ${payload.method}`);
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event) {
      listeners.delete(event);
    }
  };
  let cleared = false;
  let invalidated = '';
  const api = {
    hasSession: () => false,
    config: async () => ({ chainId: RONIN_CHAINS.MAINNET, chainName: 'Ronin Mainnet' }),
    createChallenge: async () => ({ nonce: 'a'.repeat(24), message: 'Sign in safely' }),
    verifyChallenge: async () => ({ address: account.address.toLowerCase(), profile: {}, entitlements: {} }),
    clearSession() {
      cleared = true;
    }
  };
  const adapter = new RoninWalletAdapter({
    api,
    window: { ronin: { provider }, location: { origin: ORIGIN } },
    onInvalidated(reason) {
      invalidated = reason;
    }
  });
  const player = await adapter.connect();
  assert.equal(player.address, account.address.toLowerCase());
  assert.equal(calls.some((entry) => entry.method === 'wallet_switchEthereumChain'), true);
  assert.equal(calls.some((entry) => entry.method === 'personal_sign'), true);
  const paymentHash = await adapter.purchasePass({
    to: RONIN_PAYMENT_CONTRACTS.pass,
    value: '0x5265c00a7b1c2d0000',
    data: '0x12345678'
  });
  assert.equal(paymentHash, `0x${'5'.repeat(64)}`);
  const sent = calls.find((entry) => entry.method === 'eth_sendTransaction');
  assert.equal(sent.params[0].to, RONIN_PAYMENT_CONTRACTS.pass);
  assert.equal(sent.params[0].from, account.address.toLowerCase());
  assert.equal(sent.params[0].value, '0x5265c00a7b1c2d0000');
  listeners.get('accountsChanged')?.([otherAccount.address]);
  assert.equal(cleared, true);
  assert.match(invalidated, /account changed/i);
  assert.equal(parseChainId('0x7e4'), RONIN_CHAINS.MAINNET);
});

test('the Ronin adapter submits a zero-value reward claim from the actively selected signed-in account', async () => {
  const calls = [];
  const provider = {
    async request(payload) {
      calls.push(payload);
      if (payload.method === 'eth_requestAccounts') return [account.address];
      if (payload.method === 'eth_chainId') return `0x${RONIN_CHAINS.MAINNET.toString(16)}`;
      if (payload.method === 'eth_sendTransaction') return `0x${'6'.repeat(64)}`;
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error(`Unexpected method ${payload.method}`);
    }
  };
  const adapter = new RoninWalletAdapter({
    api: { hasSession: () => true },
    window: { ronin: { provider } }
  });
  adapter.player = { address: account.address.toLowerCase() };
  adapter.provider = provider;

  const transactionHash = await adapter.claimReward({
    to: '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619',
    value: '0x0',
    data: '0x12345678'
  });

  assert.equal(transactionHash, `0x${'6'.repeat(64)}`);
  const sent = calls.find((entry) => entry.method === 'eth_sendTransaction');
  assert.equal(sent.params[0].from, account.address.toLowerCase());
  assert.equal(sent.params[0].to, '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619');
  assert.equal(sent.params[0].value, '0x0');
});

test('the Ronin adapter reports a revive payment hash immediately after wallet broadcast', async () => {
  const transactionHash = `0x${'4'.repeat(64)}`;
  const broadcasts = [];
  const provider = {
    async request(payload) {
      if (payload.method === 'eth_requestAccounts') return [account.address];
      if (payload.method === 'eth_chainId') return `0x${RONIN_CHAINS.MAINNET.toString(16)}`;
      if (payload.method === 'eth_sendTransaction') return transactionHash;
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error(`Unexpected method ${payload.method}`);
    }
  };
  const adapter = new RoninWalletAdapter({
    api: { hasSession: () => true },
    window: { ronin: { provider } }
  });
  adapter.player = { address: account.address.toLowerCase() };
  adapter.provider = provider;

  const returned = await adapter.sendPreparedTransaction({
    to: '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc',
    value: '0x8ac7230489e80000',
    data: '0x'
  }, {
    onBroadcast(hash) {
      broadcasts.push(hash);
    }
  });

  assert.equal(returned, transactionHash);
  assert.deepEqual(broadcasts, [transactionHash]);
});

test('the Ronin adapter sends Arena approval and entry transactions to the wallet in order', async () => {
  const calls = [];
  const transactionHashes = [
    `0x${'7'.repeat(64)}`,
    `0x${'8'.repeat(64)}`
  ];
  const provider = {
    async request(payload) {
      calls.push(payload);
      if (payload.method === 'eth_requestAccounts') return [account.address];
      if (payload.method === 'eth_chainId') return `0x${RONIN_CHAINS.MAINNET.toString(16)}`;
      if (payload.method === 'eth_sendTransaction') return transactionHashes.shift();
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      throw new Error(`Unexpected method ${payload.method}`);
    }
  };
  const adapter = new RoninWalletAdapter({
    api: { hasSession: () => true },
    window: { ronin: { provider } }
  });
  adapter.player = { address: account.address.toLowerCase() };
  adapter.provider = provider;

  const hashes = await adapter.purchaseArenaEntry([
    {
      to: RONIN_PAYMENT_CONTRACTS.matt,
      value: '0x0',
      data: '0x095ea7b3'
    },
    {
      to: '0x506f969279F8264fd629BBB0Df861Ab91343b12C',
      value: '0x0',
      data: '0x2ff2e9dc'
    }
  ]);

  assert.deepEqual(hashes, [
    `0x${'7'.repeat(64)}`,
    `0x${'8'.repeat(64)}`
  ]);
  const sent = calls.filter((entry) => entry.method === 'eth_sendTransaction');
  assert.equal(sent.length, 2);
  assert.equal(sent.every((entry) => entry.params[0].from === account.address.toLowerCase()), true);
  assert.equal(sent.every((entry) => entry.params[0].value === '0x0'), true);
});

test('the Ronin adapter blocks a claim when the wallet account differs from the signed-in account', async () => {
  const provider = {
    async request(payload) {
      if (payload.method === 'eth_requestAccounts') return [otherAccount.address];
      throw new Error(`Unexpected method ${payload.method}`);
    }
  };
  const adapter = new RoninWalletAdapter({
    api: { hasSession: () => true },
    window: { ronin: { provider } }
  });
  adapter.player = { address: account.address.toLowerCase() };
  adapter.provider = provider;

  await assert.rejects(
    () => adapter.claimReward({
      to: '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619',
      value: '0x0',
      data: '0x12345678'
    }),
    /different account/i
  );
});
