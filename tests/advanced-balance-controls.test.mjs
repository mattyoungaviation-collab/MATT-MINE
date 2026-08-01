import test from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG } from '../src/game/config.js';
import {
  GAME_TUNING_SCHEMA,
  defaultGameTuning,
  normalizeGameTuning
} from '../src/game/tuning.js';
import { normalizeServerState } from '../server/state.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

const NOOP_AUDIO = {
  startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
};

function emptySpawnPlan(tuning) {
  for (let depth = 1; depth <= 5; depth += 1) {
    for (const suffix of [
      'StartEnemies',
      'MiningEnemies',
      'CombatEnemies',
      'MixedEnemies',
      'TreasureEnemies',
      'GuardianEnemies'
    ]) tuning[`depth${depth}${suffix}`] = 0;
  }
  return tuning;
}

function gameFor(tuning, profile = defaultProfile(), mode = 'free') {
  const game = new MattMineGame(null, profile, { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode, seed: `ADVANCED-${mode}`, tuning });
  return game;
}

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should be close to ${expected}`);
}

test('command-center tuning exposes the requested Blaster, armor, beta, and per-depth spawn controls', () => {
  const ids = new Set(GAME_TUNING_SCHEMA.map((entry) => entry.id));
  for (const id of [
    'blasterFocusedCoreBonus',
    'blasterVolleyTwoDamageMultiplier',
    'blasterVolleyThreeDamageMultiplier',
    'armorUpgradePerLevel',
    'armorMaximum',
    'ignorePermanentUpgrades',
    'disableRunUpgrades',
    'disableBlasterUpgrades',
    'depth2CombatEnemies',
    'depth2GuardianBosses',
    'depth5GuardianBosses'
  ]) assert.equal(ids.has(id), true, `${id} should be available in admin tuning`);

  const presets = defaultGameTuning();
  assert.equal(presets.free.blasterDamageMultiplier, .60);
  assert.equal(presets.free.blasterFocusedCoreBonus, .10);
  assert.equal(presets.free.blasterVolleyTwoDamageMultiplier, .66);
  assert.equal(presets.free.blasterVolleyThreeDamageMultiplier, .60);
  assert.equal(presets.free.blasterBeams, 3);
  assert.equal(presets.free.armorUpgradePerLevel, .08);
  assert.equal(presets.free.armorMaximum, .45);
  assert.equal(presets.free.usePerDepthRoomSpawns, true);

  assert.equal(presets.arena.blasterDamageMultiplier, .56);
  assert.equal(presets.arena.blasterFocusedCoreBonus, .25);
  assert.equal(presets.arena.blasterBeams, 2);
  assert.equal(presets.arena.usePerDepthRoomSpawns, false);
});

test('state migration applies the recommended base Blaster bump without changing legacy Arena rules', () => {
  const state = normalizeServerState({
    version: 8,
    gameTuning: {
      practice: { blasterDamageMultiplier: .56 },
      free: { blasterDamageMultiplier: .56 },
      paid: { blasterDamageMultiplier: .56 },
      arena: { blasterDamageMultiplier: .56 }
    }
  });
  assert.equal(state.gameTuning.practice.blasterDamageMultiplier, .60);
  assert.equal(state.gameTuning.free.blasterDamageMultiplier, .60);
  assert.equal(state.gameTuning.paid.blasterDamageMultiplier, .60);
  assert.equal(state.gameTuning.arena.blasterDamageMultiplier, .56);
});

test('Focused Core is 10 percent and split volleys deal 66 and 60 percent per projectile', () => {
  const tuning = emptySpawnPlan(normalizeGameTuning().free);
  const game = gameFor(tuning);
  assert.equal(CONFIG.blasterDamageScale, .60);
  closeTo(game.player.blasterDamageScale, .60);

  game.player.blasterEnergy = 1_000;
  game.player.blasterVolley = 1;
  game.fireBlaster();
  const single = game.projectiles.filter((entry) => entry.kind === 'crystalBolt');
  assert.equal(single.length, 1);
  closeTo(single[0].damage, game.player.damage * .60);

  game.projectiles = [];
  game.player.blasterEnergy = 1_000;
  game.player.blasterVolley = 2;
  game.fireBlaster();
  const double = game.projectiles.filter((entry) => entry.kind === 'crystalBolt');
  assert.equal(double.length, 2);
  assert.ok(double.every((entry) => Math.abs(entry.damage - game.player.damage * .60 * .66) < 1e-9));

  game.projectiles = [];
  game.player.blasterEnergy = 1_000;
  game.player.blasterVolley = 3;
  game.fireBlaster();
  const triple = game.projectiles.filter((entry) => entry.kind === 'crystalBolt');
  assert.equal(triple.length, 3);
  assert.ok(triple.every((entry) => Math.abs(entry.damage - game.player.damage * .60 * .60) < 1e-9));

  const beforeCore = game.player.blasterDamageScale;
  game.state = 'levelup';
  game.pendingUpgradeIds = ['blasterpower'];
  game.chooseRunUpgrade('blasterpower');
  closeTo(game.player.blasterDamageScale, beforeCore * 1.10);
});

test('beta toggles provide a true new-player baseline without deleting saved progression', () => {
  const profile = defaultProfile();
  profile.meta.health = 20;
  profile.meta.damage = 20;
  profile.meta.armor = 15;
  profile.meta.blaster = 20;
  const saved = structuredClone(profile);
  const tuning = emptySpawnPlan(normalizeGameTuning().practice);
  tuning.ignorePermanentUpgrades = true;
  tuning.disableRunUpgrades = true;
  tuning.disableBlasterUpgrades = true;

  const game = gameFor(tuning, profile, 'practice');
  assert.equal(game.player.maxHealth, tuning.playerMaxHealth);
  assert.equal(game.player.damage, tuning.playerBaseDamage);
  assert.equal(game.player.armor, 0);
  assert.equal(game.player.blasterDamageScale, tuning.blasterDamageMultiplier);
  assert.deepEqual(profile, saved, 'the saved profile must not be mutated by the beta toggle');

  game.player.xp = game.player.nextXp;
  game.gainXp(0);
  assert.equal(game.state, 'playing');
  assert.deepEqual(game.pendingUpgradeIds, []);
  game.offerBlasterUpgrade();
  assert.equal(game.state, 'playing');
});

test('armor uses the tunable permanent rank, per-level value, and total cap', () => {
  const profile = defaultProfile();
  profile.meta.armor = 15;
  const tuning = emptySpawnPlan(normalizeGameTuning().free);
  tuning.permanentArmorPerRank = .008;
  tuning.armorUpgradePerLevel = .08;
  tuning.armorMaximum = .30;
  const game = gameFor(tuning, profile);
  closeTo(game.player.armor, .12);

  game.state = 'levelup';
  game.pendingUpgradeIds = ['armor'];
  game.chooseRunUpgrade('armor');
  closeTo(game.player.armor, .20);
  game.state = 'levelup';
  game.pendingUpgradeIds = ['armor'];
  game.chooseRunUpgrade('armor');
  game.state = 'levelup';
  game.pendingUpgradeIds = ['armor'];
  game.chooseRunUpgrade('armor');
  closeTo(game.player.armor, .30);
});

test('room spawn plans are exact and a depth can require multiple Guardians before extraction', () => {
  const tuning = emptySpawnPlan(normalizeGameTuning().free);
  tuning.spawnSlimes = true;
  tuning.spawnBats = false;
  tuning.spawnCrawlers = false;
  tuning.spawnBeetles = false;
  tuning.spawnExploders = false;
  tuning.spawnRanged = false;
  tuning.depth1StartEnemies = 2;
  tuning.depth1GuardianBosses = 2;
  tuning.depth2StartEnemies = 3;
  tuning.depth2GuardianBosses = 2;

  const game = gameFor(tuning);
  const startEnemies = game.enemies.filter((enemy) => enemy.roomId === game.layout.startRoom.id);
  assert.equal(startEnemies.length, 2);
  assert.equal(game.run.bossGoal, 2);

  game.run.bossReady = true;
  game.awakenGuardian(game.layout.guardianRoom);
  let guardians = game.enemies.filter((enemy) => enemy.isBoss);
  assert.equal(guardians.length, 2);
  for (const guardian of guardians) guardian.xp = 0;

  game.killEnemy(guardians[0]);
  assert.equal(game.run.bossKilled, false);
  assert.equal(game.enemies.filter((enemy) => enemy.isBoss).length, 1);
  game.killEnemy(game.enemies.find((enemy) => enemy.isBoss));
  assert.equal(game.run.bossKilled, true);
  assert.ok(game.portal, 'extraction should unlock only after the final configured Guardian');

  game.run.depth = 2;
  game.generateDepth();
  assert.equal(game.run.bossGoal, 2);
  assert.equal(game.enemies.filter((enemy) => enemy.roomId === game.layout.startRoom.id).length, 3);
});

test('Daily Arena applies permanent upgrades when its authoritative tuning enables them', () => {
  const profile = defaultProfile();
  profile.meta.damage = 25;
  profile.meta.armor = 15;
  profile.meta.blaster = 20;
  const arena = defaultGameTuning().arena;
  const game = gameFor(arena, profile, 'arena');
  assert.equal(game.player.damage, arena.playerBaseDamage);
  assert.equal(game.player.armor, 0.15);
  assert.equal(game.player.blasterDamageScale, .56 * 1.6);
  assert.equal(game.runContext.tuning.usePerDepthRoomSpawns, false);
});
