import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEndlessPhaseCheckpoint,
  createEndlessRunRecord,
  endlessLeaderboard,
  endlessSmartEngineRecommendation,
  publicEndlessCheckpoint,
  signEndlessCheckpoint,
  validEndlessCheckpoint,
  verifyEndlessPhaseEvents
} from '../server/endless-engine.js';
import { defaultEndlessConfig } from '../src/game/endlessMine.js';

function configured() {
  const config = defaultEndlessConfig();
  config.rewards = { ...config.rewards, enabled: false, crystalsEnabled: false, minerXpEnabled: false };
  return config;
}

function run() {
  return createEndlessRunRecord({
    id: 'run_aaaaaaaaaaaaaaaaaaaaaaaa',
    tokenHash: 'hash',
    address: '0x0000000000000000000000000000000000000001',
    minerId: 7,
    minerProfile: { traits: { level: 3, crystalCarryCapacity: 2 } },
    runSeed: 'server-random-run-seed',
    configVersion: 2,
    config: configured(),
    startedAt: 1_000,
    expiresAt: 100_000
  });
}

function completeEvents(manifest) {
  let tick = 1_000;
  const events = [];
  for (const enemy of manifest.map.objects.filter((object) => object.classification === 'natural')) {
    events.push({ type: 'enemy_killed', targetId: enemy.id, tick: tick += 100 });
  }
  for (const ore of manifest.map.objects.filter((object) => object.classification === 'ore')) {
    events.push({ type: 'ore_broken', targetId: ore.id, tick: tick += 100 });
    if (ore.mattCrystal) events.push({ type: 'crystal_collected', targetId: ore.id, tick: tick += 1 });
  }
  const boss = manifest.map.objects.find((object) => object.classification === 'boss');
  events.push({ type: 'guardian_defeated', targetId: boss.id, tick: tick += 100 });
  events.push({ type: 'phase_completed', tick: tick += 100 });
  return events;
}

test('server phase checkpoint reconstructs the manifest and credits its exact maximum', () => {
  const active = run();
  const verification = verifyEndlessPhaseEvents(active, completeEvents(active.manifest), 20_000);
  assert.equal(verification.score, active.manifest.pointBudget);
  assert.equal(verification.requiredKills, active.manifest.gate.requiredCount);
  assert.equal(verification.crystalsAdded, 2, 'real Miner carry capacity clips crystals');
  const firstFingerprint = active.manifest.fingerprint;
  const next = applyEndlessPhaseCheckpoint(active, verification, 'descend', 20_000);
  assert.equal(active.completedPhases, 1);
  assert.equal(active.currentPhase, 2);
  assert.notEqual(next.fingerprint, firstFingerprint);
  assert.equal(active.phaseHistory.length, 1);
});

test('server rejects Guardian bypasses, duplicate targets, fabricated crystals, and replayed checkpoints', () => {
  const active = run();
  const events = completeEvents(active.manifest);
  const bossIndex = events.findIndex((event) => event.type === 'guardian_defeated');
  assert.throws(
    () => verifyEndlessPhaseEvents(active, [events[bossIndex], ...events.slice(0, bossIndex), ...events.slice(bossIndex + 1)], 20_000),
    (error) => error.code === 'endless_guardian_locked'
  );
  assert.throws(
    () => verifyEndlessPhaseEvents(active, [events[0], events[0], ...events.slice(1)], 20_000),
    (error) => error.code === 'endless_event_duplicate'
  );
  const forged = completeEvents(active.manifest);
  forged.splice(1, 0, { type: 'crystal_collected', targetId: 'ore-does-not-exist', tick: forged[0].tick + 1 });
  assert.throws(
    () => verifyEndlessPhaseEvents(active, forged, 20_000),
    (error) => error.code === 'endless_crystal_unknown'
  );

  active.checkpointSignature = signEndlessCheckpoint(active, 'secret');
  const checkpoint = publicEndlessCheckpoint(active);
  assert.equal(validEndlessCheckpoint(active, checkpoint, 'secret'), true);
  const verification = verifyEndlessPhaseEvents(active, completeEvents(active.manifest), 20_000);
  applyEndlessPhaseCheckpoint(active, verification, 'descend');
  active.checkpointSignature = signEndlessCheckpoint(active, 'secret');
  assert.equal(validEndlessCheckpoint(active, checkpoint, 'secret'), false);
});

test('bank closes a run and bounded history keeps only recent phase audit data', () => {
  const active = run();
  active.phaseHistory = Array.from({ length: 500 }, (_, index) => ({ phase: index + 1 }));
  const verification = verifyEndlessPhaseEvents(active, completeEvents(active.manifest), 20_000);
  const next = applyEndlessPhaseCheckpoint(active, verification, 'bank', 40_000);
  assert.equal(next, null);
  assert.equal(active.status, 'banked');
  assert.equal(active.phaseHistory.length, 25);
  assert.equal(active.phaseHistory.at(-1).phase, 1);
});

test('daily, weekly, season, and all-time boards use deterministic tie breakers', () => {
  const now = Date.UTC(2026, 7, 26, 12);
  const entries = [
    { runId: 'b', address: '0x2', deepestPhase: 8, score: 9_000, crystalsBanked: 4, survivalMs: 10_000, finishedAt: now, verified: true },
    { runId: 'a', address: '0x1', deepestPhase: 8, score: 10_000, crystalsBanked: 1, survivalMs: 9_000, finishedAt: now, verified: true },
    { runId: 'c', address: '0x1', deepestPhase: 2, score: 1, crystalsBanked: 0, survivalMs: 1, finishedAt: now, verified: true },
    { runId: 'fake', address: '0x3', deepestPhase: 999, score: 999, crystalsBanked: 999, survivalMs: 999, finishedAt: now, verified: false }
  ];
  for (const scope of ['daily', 'weekly', 'season', 'all-time']) {
    const rows = endlessLeaderboard(entries, scope, now, 30);
    assert.deepEqual(rows.map((row) => row.runId), ['a', 'b']);
  }
  const depthRows = endlessLeaderboard(entries, 'all-time', now, 30, 'deepest');
  assert.deepEqual(depthRows.map((row) => row.runId), ['a', 'b']);
});

test('highest-score and deepest-descent boards use separate primary ranking rules', () => {
  const now = Date.UTC(2026, 7, 26, 12);
  const entries = [
    { runId: 'score', address: '0x1', deepestPhase: 4, score: 50_000, maximumDifficulty: 10, survivalMs: 20_000, finishedAt: now, verified: true },
    { runId: 'depth', address: '0x2', deepestPhase: 12, score: 12_000, maximumDifficulty: 20, survivalMs: 30_000, finishedAt: now, verified: true }
  ];
  assert.equal(endlessLeaderboard(entries, 'all-time', now, 30, 'score')[0].runId, 'score');
  assert.equal(endlessLeaderboard(entries, 'all-time', now, 30, 'deepest')[0].runId, 'depth');
});

test('Endless ties use difficulty, shortest duration, enemies, then ore', () => {
  const now = Date.UTC(2026, 7, 26, 12);
  const base = { deepestPhase: 5, score: 50_000, crystalsBanked: 0, finishedAt: now, verified: true };
  const winner = (left, right) => endlessLeaderboard([left, right], 'all-time', now, 30, 'score')[0].runId;
  assert.equal(winner(
    { ...base, runId: 'difficulty', address: '0x1', maximumDifficulty: 11, survivalMs: 50_000 },
    { ...base, runId: 'other', address: '0x2', maximumDifficulty: 10, survivalMs: 1_000 }
  ), 'difficulty');
  assert.equal(winner(
    { ...base, runId: 'duration', address: '0x1', maximumDifficulty: 10, survivalMs: 40_000 },
    { ...base, runId: 'other', address: '0x2', maximumDifficulty: 10, survivalMs: 50_000, requiredKills: 999 }
  ), 'duration');
  assert.equal(winner(
    { ...base, runId: 'enemies', address: '0x1', maximumDifficulty: 10, survivalMs: 40_000, requiredKills: 8, oreBroken: 1 },
    { ...base, runId: 'other', address: '0x2', maximumDifficulty: 10, survivalMs: 40_000, requiredKills: 7, oreBroken: 99 }
  ), 'enemies');
  assert.equal(winner(
    { ...base, runId: 'ore', address: '0x1', maximumDifficulty: 10, survivalMs: 40_000, requiredKills: 8, oreBroken: 9 },
    { ...base, runId: 'other', address: '0x2', maximumDifficulty: 10, survivalMs: 40_000, requiredKills: 8, oreBroken: 8 }
  ), 'ore');
});

test('Smart Engine produces recommendations but never mutates the live config', () => {
  const config = configured();
  config.smartEngine.minimumSamples = 5;
  const frozen = structuredClone(config);
  const recommendation = endlessSmartEngineRecommendation(
    Array.from({ length: 5 }, (_, index) => ({ verified: true, phaseCount: 10, averagePhaseSeconds: 600 + index })),
    config,
    123
  );
  assert.equal(recommendation.status, 'recommendation-only');
  assert.ok(recommendation.suggestedDifficultyAdjustmentBps > 0);
  assert.deepEqual(config, frozen);
});
