import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  backfillEndlessState,
  persistEndlessCheckpoint,
  persistEndlessConfig,
  persistEndlessLeaderboardEntry,
  persistEndlessPayment,
  persistEndlessRun,
  validateEndlessState
} from '../server/endless-persistence.js';
import { applyEndlessPhaseCheckpoint, createEndlessRunRecord } from '../server/endless-engine.js';
import { defaultEndlessConfig } from '../src/game/endlessMine.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'22'.repeat(32)}`;

function fixture() {
  const config = defaultEndlessConfig();
  const configRecord = {
    version: 1,
    config,
    publishedAt: 1_000,
    publishedBy: 'SERVER_ADMIN',
    reason: 'Persistence test configuration'
  };
  const payment = {
    transactionHash: HASH,
    payer: ADDRESS,
    recipient: '0x0fff5f8f650f90ee7c0b9de5d88e776e99dc3c04',
    amountRaw: '2500000000000000000000000',
    blockNumber: '1234',
    confirmations: 5,
    transactionBlockAt: 900
  };
  const run = createEndlessRunRecord({
    id: 'run_1234567890abcdef12345678',
    tokenHash: 'ab'.repeat(32),
    address: ADDRESS,
    minerId: 7,
    minerProfile: { progression: { level: 6 }, traits: { level: 6 } },
    runSeed: 'MATT-ENDLESS-PERSISTENCE',
    configVersion: 1,
    config,
    startedAt: 1_000,
    expiresAt: 50_000,
    payment
  });
  run.updatedAt = 2_000;
  return { configRecord, run, payment };
}

test('Endless persistence projects configs, runs, checkpoints, payments, and leaderboard rows idempotently', async () => {
  const calls = [];
  const client = { async query(sql, params = []) { calls.push({ sql, params }); return { rows: [] }; } };
  const { configRecord, run, payment } = fixture();
  const verification = {
    phase: 1,
    checkpointSequence: 1,
    manifestFingerprint: run.manifest.fingerprint,
    phaseSeed: run.manifest.seed,
    previousCheckpoint: run.rollingDigest,
    digest: 'cd'.repeat(32),
    score: 4_000,
    grossCrystalsEarned: 3,
    crystalsCarried: 2,
    minerXp: 10,
    phaseStartedAt: 1_000,
    phaseCompletedAt: 2_000,
    integrityState: { phaseAttempt: 1 }
  };
  const leaderboard = {
    runId: run.id,
    address: run.address,
    minerId: run.minerId,
    configVersion: 1,
    deepestPhase: 1,
    score: 4_000,
    crystalsBanked: 2,
    survivalMs: 1_000,
    finishedAt: 2_000
  };

  await persistEndlessConfig(client, configRecord, true);
  await persistEndlessRun(client, run);
  await persistEndlessPayment(client, run, { ...payment, consumedAt: 1_000 });
  await persistEndlessCheckpoint(client, { ...run, checkpointSequence: 1 }, verification);
  await persistEndlessLeaderboardEntry(client, leaderboard, run);

  const sql = calls.map((call) => call.sql.replace(/\s+/g, ' ')).join('\n');
  assert.match(sql, /UPDATE matt_mine_endless\.config_versions SET active=FALSE/);
  assert.match(sql, /INSERT INTO matt_mine_endless\.runs/);
  assert.match(sql, /INSERT INTO matt_mine_endless\.entry_payments/);
  assert.match(sql, /INSERT INTO matt_mine_endless\.phase_checkpoints/);
  assert.match(sql, /ON CONFLICT\(run_id,phase\) DO NOTHING/);
  assert.match(sql, /INSERT INTO matt_mine_endless\.leaderboard_entries/);
  assert.equal(calls.find((call) => call.sql.includes('entry_payments')).params[0], HASH);
});

test('Endless backfill reconstructs every durable projection from the compatibility state', async () => {
  const calls = [];
  const client = { async query(sql, params = []) { calls.push({ sql, params }); return { rows: [] }; } };
  const { configRecord, run, payment } = fixture();
  run.phaseHistory = [{
    phase: 1, checkpointSequence: 1, manifestFingerprint: run.manifest.fingerprint,
    phaseSeed: run.manifest.seed, previousCheckpoint: run.rollingDigest,
    digest: 'ef'.repeat(32), score: 1, grossCrystalsEarned: 0,
    crystalsCarried: 0, minerXp: 0, phaseStartedAt: 1_000,
    phaseCompletedAt: 2_000, integrityState: { phaseAttempt: 1 }
  }];
  await backfillEndlessState(client, {
    activeConfigVersion: 1,
    configVersions: { 1: configRecord },
    runs: { [run.id]: run },
    paymentTransactions: { [HASH]: { ...payment, consumedAt: 1_000 } },
    leaderboardEntries: [{
      runId: run.id, address: run.address, minerId: 7, configVersion: 1,
      deepestPhase: 1, score: 1, crystalsBanked: 0, survivalMs: 1_000, finishedAt: 2_000
    }]
  });
  const sql = calls.map((call) => call.sql).join('\n');
  for (const table of ['config_versions', 'runs', 'entry_payments', 'phase_checkpoints', 'leaderboard_entries']) {
    assert.match(sql, new RegExp(`matt_mine_endless\\.${table}`));
  }
});

test('the additive migration provides indexed durable models without changing database technology', async () => {
  const sql = await readFile(new URL('../migrations/007_endless_persistence.up.sql', import.meta.url), 'utf8');
  const replayStore = await readFile(new URL('../server/competitive-replay-store.js', import.meta.url), 'utf8');
  for (const table of [
    'config_versions', 'runs', 'phase_checkpoints', 'entry_payments',
    'leaderboard_entries', 'integrity_events', 'settlement_transactions'
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS matt_mine_endless\\.${table}`));
  }
  for (const index of [
    'endless_runs_wallet_status', 'endless_runs_miner_status', 'endless_runs_status_updated',
    'endless_runs_verification_started', 'endless_runs_config', 'endless_phases_run_phase',
    'endless_leaderboard_period_rank', 'endless_payments_wallet_time'
  ]) assert.match(sql, new RegExp(index));
  assert.doesNotMatch(sql, /DROP TABLE|DROP SCHEMA|TRUNCATE/i);
  assert.match(replayStore, /competitive_endless_parent_status/);
  assert.match(replayStore, /competitive_events_run_tick/);
});

test('migration validation detects a missing durable Endless projection', async () => {
  const client = {
    async query(sql) {
      const count = sql.includes('config_versions') ? 1 :
        sql.includes('phase_checkpoints') ? 0 :
        sql.includes('entry_payments') ? 0 :
        sql.includes('leaderboard_entries') ? 0 :
        sql.includes('matt_mine_endless.runs') ? 0 : 0;
      return { rows: [{ count }] };
    }
  };
  const { configRecord, run } = fixture();
  const result = await validateEndlessState(client, {
    configVersions: { 1: configRecord },
    runs: { [run.id]: { ...run, phaseHistory: [{}] } },
    paymentTransactions: {},
    leaderboardEntries: []
  });
  assert.equal(result.ok, false);
  assert.match(result.discrepancies.join(' '), /runs.*durable 0.*phases.*durable 0/i);
});

test('deep runs retain only a bounded hot checkpoint tail while durable phase rows keep full history', () => {
  const { run } = fixture();
  for (let phase = 1; phase <= 100; phase += 1) {
    applyEndlessPhaseCheckpoint(run, {
      phase: run.currentPhase,
      score: 1,
      crystalsAdded: 0,
      requiredKills: 0,
      bossKills: 1,
      oreBroken: 0,
      digest: phase.toString(16).padStart(64, '0'),
      inputReplay: { continuation: { version: 1, player: {}, run: {} } }
    }, 'descend', 2_000 + phase);
  }
  assert.equal(run.currentPhase, 101);
  assert.equal(run.completedPhases, 100);
  assert.equal(run.phaseHistory.length, 25);
  assert.equal(run.phaseHistory[0].phase, 76);
});
