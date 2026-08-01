import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import {
  ArenaTranscript,
  retryRunFinalization
} from '../src/game/arenaTranscript.js';

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

test('Arena client recognizes deterministic input replay readiness', () => {
  const config = normalizeArenaConfig({
    configured: true,
    previewAvailable: true,
    enabled: true,
    replayReady: true,
    status: 'open',
    verificationMode: 'deterministic-input-replay',
    liveBlocker: '',
    transcriptVersion: 'matt-arena-input-v2'
  });

  assert.equal(config.configured, true);
  assert.equal(config.previewAvailable, true);
  assert.equal(config.enabled, true);
  assert.equal(config.replayReady, true);
  assert.equal(config.verificationMode, 'deterministic-input-replay');
  assert.equal(config.transcriptVersion, 'matt-arena-input-v2');
});

test('Render pins the exact verified Arena deployment and requests live replay mode', () => {
  const blueprint = fs.readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
  const rulesUrl = new URL('../legal/matt-mine-arena-rules-v0.01.txt', import.meta.url);
  const rules = fs.readFileSync(rulesUrl);
  const rulesHash = createHash('sha256').update(rules).digest('hex');
  assert.match(blueprint, /healthCheckPath:\s*\/api\/live/);
  assert.doesNotMatch(blueprint, /healthCheckPath:\s*\/api\/ready/);
  assert.match(blueprint, /databases:\s*\n\s*-\s*name:\s*matt-mine-db[\s\S]*?plan:\s*basic-1gb/);
  assert.doesNotMatch(blueprint, /plan:\s*basic-256mb/);
  assert.match(blueprint, /MATT_MINE_ARENA_CONTRACT_ADDRESS[\s\S]*0x506f969279F8264fd629BBB0Df861Ab91343b12C/);
  assert.match(blueprint, /MATT_MINE_ARENA_RUNTIME_CODE_HASH[\s\S]*0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a/);
  assert.match(blueprint, /MATT_MINE_ARENA_SAFE_ADDRESS[\s\S]*0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc/);
  assert.match(blueprint, /MATT_MINE_ARENA_PAUSER_ADDRESS[\s\S]*0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4/);
  assert.match(blueprint, /MATT_MINE_ARENA_DEPLOYER_ADDRESS[\s\S]*0xeED0491B506C78EA7fD10988B1E98A3C88e1C630/);
  assert.match(blueprint, /MATT_MINE_ARENA_RECEIPT_SECRET\s*\n\s*generateValue: true/);
  assert.match(blueprint, /MATT_MINE_ARENA_SEED_SECRET\s*\n\s*generateValue: true/);
  assert.match(blueprint, /MATT_MINE_ARENA_LIVE\s*\n\s*value: "true"/);
  assert.match(blueprint, new RegExp(`MATT_MINE_ELIGIBILITY_RULES_SHA256[\\s\\S]*${rulesHash}`));
  assert.match(blueprint, /MATT_MINE_ELIGIBILITY_RULES_URL[\s\S]*matt-mine-arena-rules-v0\.01\.txt/);
  assert.doesNotMatch(blueprint, /matt-mine-arena-rules-v0\.01\.pdf/);
  assert.equal(
    fs.existsSync(new URL('../legal/matt-mine-arena-rules-v0.01.pdf', import.meta.url)),
    false
  );
  assert.doesNotMatch(rules.toString('utf8'), /signature|bar number|attorney|legal counsel|license number/i);
});

test('production migration pauses full-state normalized writes on request transactions', () => {
  const migration = fs.readFileSync(
    new URL('../migrations/005_pause_normalized_dual_write.up.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /read_source\s*=\s*'legacy'/i);
  assert.match(migration, /dual_write_enabled\s*=\s*FALSE/i);
  assert.doesNotMatch(migration, /DROP\s+(?:TABLE|SCHEMA)/i);
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

test('Arena transcript sends only changed raw controls and commands with ordered checkpoints', async () => {
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

  transcript.record({
    type: 'input', tick: 0, moveX: 0, moveY: -1_000,
    aim: null, attack: true, dash: false, weapon: ''
  });
  transcript.record({
    type: 'input', tick: 20, moveX: 0, moveY: -1_000,
    aim: null, attack: true, dash: false, weapon: ''
  });
  transcript.record({
    type: 'command', tick: 200, command: 'upgrade', value: 'power'
  });
  transcript.record({ type: 'finish', tick: 7_240 });
  transcript.record({ type: 'fake_score_total', tick: 951, amount: 99_999_999 });
  const checkpoint = await transcript.close();

  assert.equal(checkpoint.throughSeq, 3);
  assert.deepEqual(calls.flatMap((call) => call.events).map((event) => event.type), [
    'input',
    'command',
    'finish'
  ]);
  assert.deepEqual(calls.flatMap((call) => call.events).map((event) => event.seq), [1, 2, 3]);
  assert.equal(Object.hasOwn(calls[0].events[0], 'score'), false);
});

test('Arena honors the Admin permanent-upgrade switch instead of forcing upgrades off', () => {
  const source = fs.readFileSync(new URL('../src/game/v3/arenaCompatibility.js', import.meta.url), 'utf8');
  assert.match(source, /ignorePermanentUpgrades:\s*suppliedTuning\.ignorePermanentUpgrades === true/);
  assert.doesNotMatch(source, /ignorePermanentUpgrades:\s*true/);
});

test('Arena transcript retries temporary server failures without losing or reordering events', async () => {
  let attempts = 0;
  const accepted = [];
  const temporaryFailure = Object.assign(new Error('Temporary database interruption.'), {
    status: 503,
    code: 'server_unavailable'
  });
  const transcript = new ArenaTranscript({}, {
    runId: 'arena_run_retry',
    runToken: 'token',
    checkpoint: { throughSeq: 0, transcriptHash: 'genesis', signature: 'start' }
  }, {
    flushSize: 2,
    retryDelays: [0],
    wait: async () => undefined,
    async appendEvents(runId, runToken, checkpoint, events) {
      attempts += 1;
      if (attempts === 1) throw temporaryFailure;
      accepted.push(...events);
      return {
        throughSeq: events.at(-1).seq,
        transcriptHash: `hash-${events.at(-1).seq}`,
        signature: `sig-${events.at(-1).seq}`
      };
    }
  });

  transcript.record({
    type: 'input', tick: 0, moveX: 1_000, moveY: 0,
    aim: null, attack: false, dash: false, weapon: ''
  });
  transcript.record({ type: 'finish', tick: 20 });
  const checkpoint = await transcript.close();

  assert.equal(attempts, 2);
  assert.equal(checkpoint.throughSeq, 2);
  assert.deepEqual(accepted.map((event) => event.seq), [1, 2]);
  assert.deepEqual(accepted.map((event) => event.type), ['input', 'finish']);
});

test('Arena transcript never retries a replay-validation rejection', async () => {
  let attempts = 0;
  const validationFailure = Object.assign(new Error('The replayed upgrade was rejected.'), {
    status: 422,
    code: 'arena_upgrade_rejected'
  });
  const transcript = new ArenaTranscript({}, {
    runId: 'arena_run_invalid',
    runToken: 'token',
    checkpoint: { throughSeq: 0, transcriptHash: 'genesis', signature: 'start' }
  }, {
    retryDelays: [0, 0],
    wait: async () => undefined,
    async appendEvents() {
      attempts += 1;
      throw validationFailure;
    }
  });

  transcript.record({ type: 'finish', tick: 20 });

  await assert.rejects(() => transcript.close(), (error) =>
    error === validationFailure
  );
  assert.equal(attempts, 1);
});

test('run finalization retries database recovery but never retries replay rejection', async () => {
  let attempts = 0;
  const recovered = await retryRunFinalization(async () => {
    attempts += 1;
    if (attempts < 3) {
      throw Object.assign(new Error('PostgreSQL is reconnecting.'), {
        status: 503,
        code: 'database_temporarily_unavailable'
      });
    }
    return { accepted: true };
  }, {
    retryDelays: [0, 0],
    wait: async () => undefined
  });
  assert.equal(recovered.accepted, true);
  assert.equal(attempts, 3);

  attempts = 0;
  await assert.rejects(
    () => retryRunFinalization(async () => {
      attempts += 1;
      throw Object.assign(new Error('Replay mismatch.'), {
        status: 422,
        code: 'arena_upgrade_rejected'
      });
    }, { retryDelays: [0, 0], wait: async () => undefined }),
    (error) => error.code === 'arena_upgrade_rejected'
  );
  assert.equal(attempts, 1);
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

test('production run selection has four clear lobbies, a full mine map, and official Ronin branding', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/production.css', import.meta.url), 'utf8');
  const roninLogo = fs.statSync(new URL('../assets/ronin-mark-official.png', import.meta.url));

  assert.match(html, /Choose one of four play lobbies/i);
  assert.match(html, /FREE DAILY MINE/);
  assert.match(html, /PASS MINE/);
  assert.match(html, /MATT ARENA/);
  assert.match(html, /PRACTICE MINE/);
  assert.equal((html.match(/class="lobby-number"/g) || []).length, 4);
  assert.match(html, /ACTUAL FREE DAILY MAP/);
  assert.match(html, /7 rooms → beat the boss → return to the lift/);
  assert.equal((html.match(/data-daily-mine-preview/g) || []).length, 2);
  assert.match(html, /ronin-mark-official\.png/);
  assert.match(html, /BUILT ON RONIN/);
  assert.ok(roninLogo.size > 1_000);
  assert.match(css, /--type-label: 0\.07em/);
  assert.doesNotMatch(html, /SECURITY PREVIEW|SAFE TEST MODE|VIEW PREVIEW/i);
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

test('production lobby exposes wallet-saved custom gameplay controls', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /id="controls-button"[^>]*>CONTROLS</);
  assert.match(html, /id="keybind-editor"/);
  assert.match(html, /id="reset-keybinds-button"/);
  assert.match(html, /id="save-keybinds-button"/);
  assert.match(html, /id="profile-close-button"[^>]*>&times;<\/button>/);
  assert.doesNotMatch(html, /Ã—/);
});

test('unscheduled Arena days do not request unavailable leaderboard or player endpoints', () => {
  const source = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const refreshSource = source.slice(
    source.indexOf('async function refreshArena('),
    source.indexOf('function renderArena()')
  );

  assert.match(refreshSource, /if \(!arenaConfig\.enabled\)/);
  assert.ok(
    refreshSource.indexOf('if (!arenaConfig.enabled)') <
    refreshSource.indexOf('apiClient.arenaLeaderboard')
  );
  assert.ok(
    refreshSource.indexOf('if (!arenaConfig.enabled)') <
    refreshSource.indexOf('apiClient.arenaMe')
  );
});
