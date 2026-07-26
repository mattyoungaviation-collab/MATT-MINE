import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ARENA_PAYOUT_BPS,
  MATT_SCALE,
  arenaTimeRemaining,
  formatMattRaw,
  normalizeArenaConfig,
  normalizeArenaLeaderboard,
  normalizeArenaPlayer,
  projectedArenaPayouts
} from '../src/game/arena.js';
import { ArenaTranscript } from '../src/game/arenaTranscript.js';

test('Arena config separates unlimited player entries, Treasury seed, and total pool', () => {
  const config = normalizeArenaConfig({
    day: '2026-07-25',
    status: 'open',
    chainStatus: 1,
    snapshotAt: Date.UTC(2026, 6, 26),
    entryCutoffAt: Date.UTC(2026, 6, 25, 23, 35),
    entriesPaused: true,
    settlementPaused: false,
    fee: { raw: String(100_000n * MATT_SCALE), matt: 100_000 },
    seed: {
      raw: String(10_000_000n * MATT_SCALE),
      matt: 10_000_000,
      capMatt: 10_000_000
    },
    entryPoolRaw: String(14_600_000n * MATT_SCALE),
    prizePoolRaw: String(24_600_000n * MATT_SCALE),
    entryCount: 146,
    uniquePlayers: 38
  });

  assert.equal(config.enabled, true);
  assert.equal(config.chainStatus, 1);
  assert.equal(config.entriesPaused, true);
  assert.equal(config.settlementPaused, false);
  assert.equal(config.entryCutoffAt, Date.UTC(2026, 6, 25, 23, 35));
  assert.equal(config.feeMatt, 100_000);
  assert.equal(config.entryPoolMatt, 14_600_000);
  assert.equal(config.seedMatt, 10_000_000);
  assert.equal(config.prizePoolMatt, 24_600_000);
  assert.equal(config.entryCount, 146);
  assert.equal(config.uniquePlayers, 38);
  assert.equal(formatMattRaw(config.prizePoolRaw), '24,600,000 MATT');
});

test('Arena top-ten weights allocate exactly 100 percent and raw remainder goes to first', () => {
  assert.equal(ARENA_PAYOUT_BPS.reduce((total, value) => total + value, 0), 10_000);
  const pool = 7_300_000n * MATT_SCALE + 7n;
  const payouts = projectedArenaPayouts(pool, 10);
  assert.equal(payouts.length, 10);
  assert.equal(payouts.reduce((total, value) => total + value, 0n), pool);
  assert.equal(payouts[0], pool - payouts.slice(1).reduce((total, value) => total + value, 0n));
  assert.ok(payouts[0] >= 2_190_000n * MATT_SCALE);
});

test('Arena payouts normalize to the full pool with fewer than ten wallets', () => {
  const pool = 1_000_000n * MATT_SCALE;
  const payouts = projectedArenaPayouts(pool, 3);
  assert.deepEqual(payouts, [
    500_000n * MATT_SCALE,
    300_000n * MATT_SCALE,
    200_000n * MATT_SCALE
  ]);
});

test('Arena player and leaderboard normalization keep one row per wallet shape', () => {
  const player = normalizeArenaPlayer({
    entryCount: 12,
    unusedAttempts: 3,
    bestScore: 98_765,
    rank: 2,
    refundable: false
  });
  const board = normalizeArenaLeaderboard({
    day: '2026-07-25',
    participantCount: 1,
    entryCount: 12,
    prizePoolRaw: String(5_000n * MATT_SCALE),
    rows: [{
      rank: 2,
      address: '0x1111111111111111111111111111111111111111',
      score: 98_765,
      entryCount: 12,
      projectedRaw: String(1_800n * MATT_SCALE),
      isPlayer: true
    }]
  });

  assert.equal(player.entries, 12);
  assert.equal(player.unusedAttempts, 3);
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].entries, 12);
  assert.equal(board.rows[0].isPlayer, true);
  assert.equal(board.participantCount, 1);
  assert.equal(board.entryCount, 12);
  assert.equal(board.rows[0].projectedRaw, 1_800n * MATT_SCALE);
});

test('Arena security preview remains configured but cannot be mistaken for live paid entry', () => {
  const config = normalizeArenaConfig({
    configured: true,
    previewAvailable: true,
    enabled: false,
    status: 'open',
    verificationMode: 'preview-milestone-transcript',
    liveBlocker: 'input_replay_not_ready',
    transcriptVersion: 'matt-arena-transcript-v1'
  });

  assert.equal(config.configured, true);
  assert.equal(config.previewAvailable, true);
  assert.equal(config.enabled, false);
  assert.equal(config.replayReady, false);
  assert.equal(config.liveBlocker, 'input_replay_not_ready');
  assert.equal(config.transcriptVersion, 'matt-arena-transcript-v1');
});

test('Render pins the exact verified Arena deployment while paid entry remains disabled', () => {
  const blueprint = fs.readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  assert.match(blueprint, /MATT_MINE_ARENA_CONTRACT_ADDRESS[\s\S]*0x506f969279F8264fd629BBB0Df861Ab91343b12C/);
  assert.match(blueprint, /MATT_MINE_ARENA_RUNTIME_CODE_HASH[\s\S]*0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a/);
  assert.match(blueprint, /MATT_MINE_ARENA_SAFE_ADDRESS[\s\S]*0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc/);
  assert.match(blueprint, /MATT_MINE_ARENA_PAUSER_ADDRESS[\s\S]*0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4/);
  assert.match(blueprint, /MATT_MINE_ARENA_DEPLOYER_ADDRESS[\s\S]*0xeED0491B506C78EA7fD10988B1E98A3C88e1C630/);
  assert.match(blueprint, /MATT_MINE_ARENA_RECEIPT_SECRET\s*\n\s*generateValue: true/);
  assert.match(blueprint, /MATT_MINE_ARENA_SEED_SECRET\s*\n\s*generateValue: true/);
  assert.match(blueprint, /MATT_MINE_ARENA_LIVE\s*\n\s*value: "false"/);
});

test('Arena leaderboard derives an exact projected full-pool split when the server returns scores only', () => {
  const pool = 1_000_000n * MATT_SCALE;
  const board = normalizeArenaLeaderboard({
    prizePoolRaw: String(pool),
    rows: [
      { address: '0x1111111111111111111111111111111111111111', score: 20 },
      { address: '0x2222222222222222222222222222222222222222', score: 10 }
    ]
  });

  assert.deepEqual(
    board.rows.map((row) => row.projectedRaw),
    projectedArenaPayouts(pool, 2)
  );
});

test('Arena countdown is UTC snapshot based and never negative', () => {
  assert.deepEqual(
    arenaTimeRemaining(Date.UTC(2026, 6, 26), Date.UTC(2026, 6, 25, 23, 59, 58)),
    { remainingMs: 2_000, complete: false, label: '00:00:02' }
  );
  assert.equal(
    arenaTimeRemaining(Date.UTC(2026, 6, 26), Date.UTC(2026, 6, 26, 0, 0, 1)).label,
    '00:00:00'
  );
});

test('Arena transcript sends ordered signed checkpoint batches and never client totals', async () => {
  const calls = [];
  const api = {
    async appendArenaEvents(runId, runToken, checkpoint, events) {
      calls.push({ runId, runToken, checkpoint, events });
      return {
        throughSeq: events.at(-1).seq,
        transcriptHash: `hash-${events.at(-1).seq}`,
        signature: `sig-${events.at(-1).seq}`
      };
    }
  };
  const transcript = new ArenaTranscript(api, {
    runId: 'arena_run_1',
    runToken: 'token',
    checkpoint: { throughSeq: 0, transcriptHash: 'genesis', signature: 'start' }
  }, { flushSize: 2 });

  transcript.record({ type: 'ore_broken', tick: 120, targetId: 8 });
  transcript.record({ type: 'enemy_killed', tick: 320, targetId: 12 });
  transcript.record({ type: 'extract', tick: 950 });
  transcript.record({ type: 'fake_score_total', tick: 951, amount: 99_999_999 });
  const checkpoint = await transcript.close();

  assert.equal(checkpoint.throughSeq, 3);
  assert.deepEqual(calls.flatMap((call) => call.events).map((event) => event.type), [
    'ore_broken',
    'enemy_killed',
    'extract'
  ]);
  assert.deepEqual(calls.flatMap((call) => call.events).map((event) => event.seq), [1, 2, 3]);
});

test('Arena screen promises the locked economic rules without test-token copy', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /Unlimited entries/);
  assert.match(html, /Up to 10,000,000 MATT daily/);
  assert.match(html, /Every accepted entry · No ceiling/);
  assert.match(html, /100% distributed · 0 burned · 0 house fee/);
  assert.match(html, /MATT entry closes 23:35 UTC/);
  assert.doesNotMatch(html, /TEST MATT/i);
});

test('production admin separates Treasury Safe packages from direct emergency-pauser controls', () => {
  const html = fs.readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../src/admin.js', import.meta.url), 'utf8');
  assert.match(html, /Entry price \(MATT\)/);
  assert.match(html, /max="1000000"/);
  assert.match(html, /max="10000000"/);
  assert.match(html, /Prepare full-pool settlement/);
  assert.match(source, /matt-mine-arena-\$\{day\}-settlement\.json/);
  assert.match(source, /Download Safe JSON/);
  assert.match(html, /direct calldata for the separate emergency-pauser wallet/);
  assert.match(source, /Download direct transaction JSON/);
  assert.doesNotMatch(source, /result\.control\?\.safe/);
  assert.match(source, /button\.disabled = !replayReady/);
  assert.match(source, /Blocked by replay gate/);
  assert.match(source, /\/api\/admin\/arena\/days\/\$\{encodeURIComponent\(day\)\}\/cancel/);
});

test('Arena UI closes cleanly for review while already-purchased attempts survive an entry pause', () => {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const startRunSource = source.slice(
    source.indexOf('async function startArenaRun()'),
    source.indexOf('async function claimArenaRefund()')
  );

  assert.match(source, /Awaiting reviewed settlement/);
  assert.match(source, /Awaiting Safe settlement/);
  assert.match(source, /const settled = config\.chainStatus === 2/);
  assert.doesNotMatch(source, /config\.status === 'settled' \|\| leaderboard\.finalized/);
  assert.match(source, /!config\.entriesPaused/);
  assert.doesNotMatch(startRunSource, /entriesPaused|arenaConfig\.paused/);
  assert.match(startRunSource, /serverPlayer\.suspended/);
});
