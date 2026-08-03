import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  DirectRoninRevivePaymentVerifier,
  HmacAdvertisementVerifier
} from '../server/external-verifiers.js';
import { MemoryCompetitiveReplayStore } from '../server/competitive-replay-store.js';
import { CompetitiveReplayService } from '../server/competitive-replay-service.js';
import {
  applyReplayCommand,
  buildArenaChallenge,
  replayArenaTranscript
} from '../server/arena-engine.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import { PaidCompetitionEligibilityPolicy } from '../server/eligibility.js';
import { RoninRpcPool } from '../server/ronin-rpc.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SAFE = '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc';

test('Ronin safe reads fail over while unsafe methods are never retried or broadcast', async () => {
  const calls = [];
  const pool = new RoninRpcPool({
    urls: ['https://first.invalid/rpc', 'https://second.invalid/rpc'],
    breakAfter: 1,
    fetch: async (url) => {
      calls.push(url);
      if (url.includes('first')) throw new Error('endpoint unavailable');
      return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x7e4' }) };
    }
  });
  assert.equal(await pool.request({ method: 'eth_chainId' }), '0x7e4');
  assert.deepEqual(calls, ['https://first.invalid/rpc', 'https://second.invalid/rpc']);
  assert.equal(pool.health().endpoints[0].failures, 1);
  await assert.rejects(
    pool.request({ method: 'eth_sendRawTransaction', params: ['0xdead'] }),
    (error) => error.code === 'rpc_unsafe_method_refused'
  );
  assert.equal(calls.length, 2);
});

test('paid competition eligibility defaults closed while leaving an explicit approved boundary', () => {
  const denied = new PaidCompetitionEligibilityPolicy();
  assert.throws(() => denied.assertEligible(ADDRESS), (error) => error.code === 'paid_competition_eligibility_unconfigured');
  const allowed = new PaidCompetitionEligibilityPolicy({
    counselApproved: true,
    rulesVersion: 'rules-2026-07-31',
    allowedWallets: [ADDRESS]
  });
  assert.deepEqual(allowed.assertEligible(ADDRESS, { mode: 'arena' }), {
    eligible: true,
    rulesVersion: 'rules-2026-07-31',
    mode: 'arena',
    enforcement: 'server_wallet_allowlist'
  });
});

test('public Arena eligibility removes the wallet allowlist but requires and signs the approved one-time acknowledgement', () => {
  let timestamp = Date.UTC(2026, 7, 1, 12, 0, 0);
  const rulesHash = '084962441aa1291864fde13c28aaa63eebbc0b15be92cb5e3e0e4feaea6deb2e';
  const policy = new PaidCompetitionEligibilityPolicy({
    counselApproved: true,
    rulesVersion: '0.01',
    rulesHash,
    rulesUrl: '/legal/matt-mine-arena-rules-v0.01.txt',
    publicModes: ['arena'],
    receiptSecret: 'x'.repeat(32),
    now: () => timestamp,
    randomHex: () => 'a'.repeat(32)
  });
  assert.throws(
    () => policy.assertEligible(ADDRESS, { mode: 'arena' }),
    (error) => error.code === 'paid_competition_attestation_required'
  );
  const acknowledgement = {
    age18OrOlder: true,
    locatedInJurisdiction: true,
    notProhibited: true,
    acceptedRules: true,
    jurisdiction: 'WA',
    rulesVersion: '0.01',
    rulesHash
  };
  const issued = policy.assertEligible(ADDRESS, { mode: 'arena', attestation: acknowledgement });
  assert.equal(issued.enforcement, 'public_attestation');
  assert.equal(issued.jurisdiction, 'WA');
  assert.ok(issued.receiptToken);
  const verified = policy.verifyReceipt(ADDRESS, issued.receiptToken, { mode: 'arena' });
  assert.equal(verified.receiptId, issued.receiptId);
  assert.equal(verified.rulesHash, rulesHash);
  timestamp += 31 * 60_000;
  const reused = policy.assertEligible(ADDRESS, {
    mode: 'arena',
    attestation: { ...acknowledgement, acceptedAt: issued.acceptedAt }
  });
  assert.equal(reused.acceptedAt, issued.acceptedAt);
  assert.ok(reused.expiresAt > timestamp);
  assert.equal(policy.verifyReceipt(ADDRESS, reused.receiptToken, { mode: 'arena' }).acceptedAt, issued.acceptedAt);
  assert.equal(policy.publicStatus().configured, true);
});

test('competitive replay checkpoints are signed, ordered, persisted, and bound to the run token', async () => {
  let now = 1_000_000;
  const store = await new MemoryCompetitiveReplayStore().init();
  const replay = await new CompetitiveReplayService({
    store,
    secret: 'competitive-replay-test-secret-that-is-long-enough',
    now: () => now
  }).init();
  const run = {
    id: 'run_111111111111111111111111',
    address: ADDRESS,
    mode: 'weekly',
    seed: 'MATT-WEEKLY-TEST',
    startedAt: now,
    expiresAt: now + 60_000
  };
  const checkpoint = await replay.register(run, 'a'.repeat(48));
  assert.equal(checkpoint.throughSeq, 0);
  const readEvents = store.getEvents.bind(store);
  let replayReads = 0;
  store.getEvents = async (...args) => {
    replayReads += 1;
    return readEvents(...args);
  };
  now += 1_000;
  const next = await replay.append(ADDRESS, {
    runId: run.id,
    runToken: 'a'.repeat(48),
    previousCheckpoint: checkpoint,
    events: [{
      seq: 1,
      tick: 0,
      type: 'input',
      moveX: 0,
      moveY: 0,
      aim: null,
      attack: false,
      dash: false,
      weapon: ''
    }]
  });
  assert.equal(next.throughSeq, 1);
  assert.equal((await store.getEvents(run.id)).length, 1);
  assert.equal(replayReads, 1);
  await assert.rejects(
    replay.append(ADDRESS, {
      runId: run.id,
      runToken: 'b'.repeat(48),
      previousCheckpoint: next,
      events: [{ seq: 2, tick: 20, type: 'finish' }]
    }),
    (error) => error.code === 'run_token_rejected'
  );
  await assert.rejects(
    replay.append(ADDRESS, {
      runId: run.id,
      runToken: 'a'.repeat(48),
      previousCheckpoint: next,
      events: [{ seq: 2, tick: 20, type: 'command', command: 'extract' }]
    }),
    (error) => error.code === 'arena_guardian_required'
  );
  assert.equal(replayReads, 2);
});

test('signed advertisement completions bind provider, wallet, run, expiry, and percent', async () => {
  const secret = 'advertisement-test-secret-that-is-long-enough';
  const verifier = new HmacAdvertisementVerifier({ secret, provider: 'test-provider' });
  const payload = {
    provider: 'test-provider',
    completionId: 'completion_12345',
    address: ADDRESS,
    runId: 'run_123',
    expiresAt: 2_000_000,
    percent: 5
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const token = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('hex')}`;
  const verified = await verifier.verifyCompletion(
    { token },
    { address: ADDRESS, runId: 'run_123' }
  );
  assert.equal(verified.completionId, payload.completionId);
  await assert.rejects(
    verifier.verifyCompletion({ token }, { address: ADDRESS, runId: 'run_other' }),
    (error) => error.code === 'advertisement_completion_mismatch'
  );
});

test('paid revive creates an exact direct-RON Treasury transaction and delegates receipt verification', async () => {
  const calls = [];
  const verifier = new DirectRoninRevivePaymentVerifier({
    recipient: SAFE,
    verifier: {
      transactionForQuote(quote) {
        calls.push(['quote', quote]);
        return { to: quote.recipient, value: `0x${BigInt(quote.amountAtomic).toString(16)}`, data: '0x' };
      },
      async verifyExactTransfer(hash, address, quote) {
        calls.push(['verify', hash, address, quote]);
        return {
          transactionHash: hash,
          amountAtomic: quote.amountAtomic,
          recipient: quote.recipient.toLowerCase(),
          blockNumber: '123'
        };
      }
    }
  });
  const transaction = verifier.transactionForPayment('10000000000000000000');
  assert.deepEqual(transaction, {
    to: SAFE,
    value: '0x8ac7230489e80000',
    data: '0x'
  });
  const verified = await verifier.verifyPayment({
    transactionHash: `0x${'ab'.repeat(32)}`,
    address: ADDRESS,
    amountWei: '10000000000000000000'
  });
  assert.equal(verified.amountWei, '10000000000000000000');
  assert.equal(calls[1][3].asset, 'RON');
  assert.equal(calls[1][3].recipient, SAFE);
});

test('paid revive preserves the same run and resumes once at a safe full-health position', () => {
  const events = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: {
      startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
    },
    onArenaInput(event) { events.push(event); }
  });
  game.startRun({
    mode: 'free',
    seed: 'MATT-REVIVE-TEST',
    allowPaidRevive: true,
    reviveInvulnerabilitySeconds: 4
  });
  const run = game.run;
  game.run.bossTelemetry.encounterStartedAt = 1;
  game.player.health = 1;
  game.player.invulnerable = 0;
  game.damagePlayer(10, 0, { bossId: 1 });
  assert.equal(game.state, 'awaitingrevive');
  assert.equal(game.run.bossTelemetry.playerDeaths, 1);
  assert.equal(events.at(-1).command, 'death');
  assert.equal(game.applyPaidRevive(), true);
  assert.equal(game.run, run);
  assert.equal(game.player.health, game.player.maxHealth);
  assert.equal(game.player.invulnerable, 4);
  assert.equal(game.state, 'playing');
  assert.equal(events.at(-1).command, 'revive');
  game.player.health = 1;
  game.player.invulnerable = 0;
  game.damagePlayer(10, 0, { bossId: 1 });
  assert.equal(game.state, 'ended');
  assert.equal(game.run.bossTelemetry.playerDeaths, 2);
  assert.equal(events.at(-1).type, 'finish');
});

test('competitive replay uses the server-owned permanent-upgrade snapshot', () => {
  const profile = defaultProfile();
  profile.meta.health = 2;
  const replayed = replayArenaTranscript(
    buildArenaChallenge('a'.repeat(64)),
    [],
    { mode: 'free', profile }
  );

  assert.equal(replayed.maximumHealth, 116);
});

test('queued Blaster offers remain deterministic after choosing a run upgrade', () => {
  const createGame = () => {
    const game = new MattMineGame(null, defaultProfile(), {
      headless: true,
      audio: {
        startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
      }
    });
    game.startRun({ mode: 'free', seed: 'MATT-UPGRADE-REPLAY-TEST' });
    game.state = 'levelup';
    game.pendingUpgradeIds = ['power'];
    game.pendingBlasterUpgrade = true;
    return game;
  };
  const first = createGame();
  const second = createGame();
  const originalRandom = Math.random;
  try {
    Math.random = () => 0;
    first.chooseRunUpgrade('power');
    Math.random = () => 0.999999;
    second.chooseRunUpgrade('power');
  } finally {
    Math.random = originalRandom;
  }

  assert.equal(first.state, 'levelup');
  assert.deepEqual(first.pendingUpgradeIds, second.pendingUpgradeIds);
});

test('ranked replay accepts a queued Blaster offer only after applying the chosen upgrade', () => {
  const createGame = (mode) => {
    const game = new MattMineGame(null, defaultProfile(), {
      headless: true,
      audio: {
        startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
      }
    });
    game.startRun({ mode, seed: `MATT-QUEUED-UPGRADE-${mode}` });
    game.state = 'levelup';
    game.pendingUpgradeIds = ['power'];
    game.pendingBlasterUpgrade = true;
    return game;
  };

  for (const mode of ['free', 'paid', 'arena']) {
    const game = createGame(mode);
    applyReplayCommand(game, { command: 'upgrade', value: 'power' });
    assert.equal(game.player.runUpgradeCounts.power, 1, `${mode} applies the original upgrade`);
    assert.equal(game.state, 'levelup', `${mode} opens the queued Blaster offer`);
    assert.ok(game.pendingUpgradeIds.length > 0);
    assert.equal(game.pendingUpgradeIds.includes('power'), false);

    const blasterUpgrade = game.pendingUpgradeIds[0];
    applyReplayCommand(game, { command: 'upgrade', value: blasterUpgrade });
    assert.equal(game.player.runUpgradeCounts[blasterUpgrade], 1);
    assert.equal(game.state, 'playing');
  }

  const rejected = createGame('paid');
  rejected.runContext.tuning.disableRunUpgrades = true;
  assert.throws(
    () => applyReplayCommand(rejected, { command: 'upgrade', value: 'power' }),
    (error) => error.code === 'arena_upgrade_rejected'
  );
});
