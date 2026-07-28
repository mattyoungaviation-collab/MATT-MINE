import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  DirectRoninRevivePaymentVerifier,
  HmacAdvertisementVerifier
} from '../server/external-verifiers.js';
import { MemoryCompetitiveReplayStore } from '../server/competitive-replay-store.js';
import { CompetitiveReplayService } from '../server/competitive-replay-service.js';
import { buildArenaChallenge, replayArenaTranscript } from '../server/arena-engine.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SAFE = '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc';

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
  await assert.rejects(
    replay.append(ADDRESS, {
      runId: run.id,
      runToken: 'b'.repeat(48),
      previousCheckpoint: next,
      events: [{ seq: 2, tick: 20, type: 'finish' }]
    }),
    (error) => error.code === 'run_token_rejected'
  );
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
  game.player.health = 0;
  game.endRun(false);
  assert.equal(game.state, 'awaitingrevive');
  assert.equal(events.at(-1).command, 'death');
  assert.equal(game.applyPaidRevive(), true);
  assert.equal(game.run, run);
  assert.equal(game.player.health, game.player.maxHealth);
  assert.equal(game.player.invulnerable, 4);
  assert.equal(game.state, 'playing');
  assert.equal(events.at(-1).command, 'revive');
  game.player.health = 0;
  game.endRun(false);
  assert.equal(game.state, 'ended');
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
