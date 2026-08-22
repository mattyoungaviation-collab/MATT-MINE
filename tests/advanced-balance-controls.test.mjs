import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/game/config.js';
import {
  ADMIN_GAME_TUNING_SCHEMA,
  defaultGameTuning,
  normalizeGameTuning,
  tuningSchemaForLobby
} from '../src/game/tuning.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

const NOOP_AUDIO = {
  startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
};

function emptySpawnPlan(tuning) {
  for (let depth = 1; depth <= 5; depth += 1) {
    for (const suffix of ['StartEnemies', 'MiningEnemies', 'CombatEnemies', 'MixedEnemies', 'TreasureEnemies', 'GuardianEnemies']) {
      tuning[`depth${depth}${suffix}`] = 0;
    }
  }
  return tuning;
}

function gameFor(tuning, mode = 'practice') {
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode, seed: `ADVANCED-${mode}`, tuning });
  return game;
}

test('Admin exposes only tuning controls consumed by active gameplay', () => {
  const ids = new Set(ADMIN_GAME_TUNING_SCHEMA.map((entry) => entry.id));
  assert.equal(ids.has('scoreMultiplier'), true);
  assert.equal(ids.has('xpMultiplier'), true);
  assert.equal(ids.has('playerMaxHealth'), false);
  assert.equal(tuningSchemaForLobby('paid').some((entry) => entry.id === 'playerBaseDamage'), false);
  assert.equal(tuningSchemaForLobby('practice').some((entry) => entry.id === 'playerBaseDamage'), true);
});

test('Admin point modifiers change the authoritative in-game score calculation', () => {
  const tuning = emptySpawnPlan({
    ...normalizeGameTuning().practice,
    scoreMultiplier: 2,
    depthScoreMultiplier: 1.5,
    killPointValue: 17,
    xpMultiplier: 2
  });
  const game = gameFor(tuning);
  game.run.depth = 3;
  game.run.rawScore = 100;
  assert.equal(game.projectedPayout(), 800);
  game.player.xp = 0;
  game.player.nextXp = 1_000;
  game.killEnemy({ id: 99, isBoss: false, x: game.player.x, y: game.player.y, radius: 10, xp: 9 });
  assert.equal(game.run.rawScore, 117);
  assert.equal(game.player.xp, 18);
  assert.equal(game.projectedPayout(), 936);
});

test('Blaster focused core and split-volley tuning remains deterministic', () => {
  const tuning = emptySpawnPlan(normalizeGameTuning().free);
  const game = gameFor(tuning, 'free');
  assert.equal(CONFIG.blasterDamageScale, .60);
  game.player.blasterEnergy = 1_000;
  game.player.blasterVolley = 2;
  game.fireBlaster();
  const bolts = game.projectiles.filter((entry) => entry.kind === 'crystalBolt');
  assert.equal(bolts.length, 2);
  assert.ok(bolts.every((entry) => Math.abs(entry.damage - game.player.damage * .60 * .66) < 1e-9));
});

test('depth spawn plans can require multiple Guardians before extraction', () => {
  const tuning = emptySpawnPlan(normalizeGameTuning().free);
  tuning.spawnSlimes = true;
  tuning.depth1GuardianBosses = 2;
  const game = gameFor(tuning, 'free');
  game.run.bossReady = true;
  game.awakenGuardian(game.layout.guardianRoom);
  const guardians = game.enemies.filter((enemy) => enemy.isBoss);
  assert.equal(guardians.length, 2);
  for (const guardian of guardians) guardian.xp = 0;
  game.killEnemy(guardians[0]);
  assert.equal(game.run.bossKilled, false);
  game.killEnemy(game.enemies.find((enemy) => enemy.isBoss));
  assert.equal(game.run.bossKilled, true);
});

test('the paid revive limit reaches the game engine', () => {
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode: 'arena', seed: 'TWO-PAID-REVIVES', allowPaidRevive: true, reviveLimitPerRun: 2 });
  game.endRun(false);
  assert.equal(game.applyPaidRevive({ record: false }), true);
  game.endRun(false);
  assert.equal(game.applyPaidRevive({ record: false }), true);
  game.endRun(false);
  assert.equal(game.state, 'ended');
});
