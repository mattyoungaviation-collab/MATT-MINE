import test from 'node:test';
import assert from 'node:assert/strict';

import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import { normalizeGameTuning } from '../src/game/tuning.js';
import { nftCarryCapacity, nftGameplayTraits } from '../src/game/nftTraits.js';

const NOOP_AUDIO = {
  startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
};

const TRAITS = Object.freeze({
  maximumHealth: 125,
  armorShield: 75,
  pickaxeAttack: 27,
  blasterAttack: 19,
  dynamiteAttack: 61,
  healAmount: 24,
  carryCapacity: 1_875,
  deathRetentionBps: 3_400,
  level: 60,
  crystalsPerHour: 0
});

function v2Run() {
  return {
    version: 2,
    minerId: 1,
    profile: {
      version: 2,
      minerId: 1,
      progression: { level: 60 },
      gameplay: { effectiveTraits: { ...TRAITS } }
    }
  };
}

function emptySpawnPlan(tuning) {
  for (let depth = 1; depth <= 5; depth += 1) {
    for (const suffix of [
      'StartEnemies', 'MiningEnemies', 'CombatEnemies', 'MixedEnemies',
      'TreasureEnemies', 'GuardianEnemies'
    ]) tuning[`depth${depth}${suffix}`] = 0;
  }
  return tuning;
}

function gameFor(overrides = {}) {
  const tuning = emptySpawnPlan({
    ...normalizeGameTuning().paid,
    pickaxeDamageMultiplier: 1.25,
    blasterDamageMultiplier: .75,
    dynamiteDamageMultiplier: 1.5,
    ...overrides
  });
  const profile = defaultProfile();
  profile.meta = {
    health: 25,
    damage: 25,
    speed: 25,
    luck: 25,
    magnet: 25,
    dash: 25,
    armor: 15,
    blaster: 20
  };
  const game = new MattMineGame(null, profile, { headless: true, audio: NOOP_AUDIO });
  game.startRun({
    mode: 'paid',
    seed: 'NFT-V2-RUNTIME',
    tuning,
    character: {
      baseHealth: 200,
      movementSpeed: 2,
      pickaxeDamage: 2,
      blasterDamage: 2,
      armor: .5
    },
    nftRun: v2Run()
  });
  return game;
}

test('V2 Miner traits replace legacy profile power while Admin multipliers remain active', () => {
  const game = gameFor();
  assert.equal(game.player.maxHealth, TRAITS.maximumHealth);
  assert.equal(game.player.health, TRAITS.maximumHealth);
  assert.equal(game.player.maxShield, TRAITS.armorShield);
  assert.equal(game.player.shield, TRAITS.armorShield);
  assert.equal(game.player.damage, TRAITS.pickaxeAttack);
  assert.equal(game.player.blasterBaseDamage, TRAITS.blasterAttack);
  assert.equal(game.player.dynamiteBaseDamage, TRAITS.dynamiteAttack);
  assert.equal(game.player.armor, 0);
  assert.equal(game.player.crystalCarryCapacity, TRAITS.carryCapacity);
  assert.equal(game.player.crystalDeathRetentionBps, TRAITS.deathRetentionBps);

  let pickaxeDamage = 0;
  game.player.critChance = 0;
  game.player.angle = 0;
  game.ores = [];
  game.enemies = [{ x: game.player.x + 1, y: game.player.y, radius: 1 }];
  game.damageTarget = (_target, damage) => { pickaxeDamage = damage; };
  game.swingPickaxe();
  assert.equal(pickaxeDamage, TRAITS.pickaxeAttack * 1.25);

  game.player.blasterEnergy = 1_000;
  game.fireBlaster();
  assert.equal(game.projectiles[0].damage, TRAITS.blasterAttack * .75);

  game.projectiles = [];
  game.player.dynamiteAmmo = 1;
  game.throwDynamite();
  assert.equal(game.projectiles[0].damage, TRAITS.dynamiteAttack * 1.5);
});

test('V2 Armor shield depletes before Base Health and reports both pools to the HUD', () => {
  let hud = null;
  const game = gameFor();
  game.hooks.onHud = (value) => { hud = value; };
  game.damagePlayer(50, 0);
  assert.equal(game.player.shield, 25);
  assert.equal(game.player.health, TRAITS.maximumHealth);
  game.player.invulnerable = 0;
  game.damagePlayer(40, 0);
  assert.equal(game.player.shield, 0);
  assert.equal(game.player.health, TRAITS.maximumHealth - 15);
  game.updateHud();
  assert.equal(hud.shield, 0);
  assert.equal(hud.maxShield, TRAITS.armorShield);
  assert.equal(hud.minerLevel, TRAITS.level);
});

test('V2 health pickups and completed phases restore the fixed Miner Heal trait', () => {
  const game = gameFor();
  game.player.health = 40;
  game.pickups = [{
    id: 999,
    type: 'health',
    x: game.player.x,
    y: game.player.y,
    vx: 0,
    vy: 0,
    radius: 10,
    value: 999
  }];
  game.updatePickups(0);
  assert.equal(game.player.health, 40 + TRAITS.healAmount);

  game.player.health = 50;
  game.run.depth = 2;
  game.generateDepth();
  assert.equal(game.player.health, 50 + TRAITS.healAmount);
});

test('V2 carry and retention normalize from the selected Miner snapshot', () => {
  const context = { nftRun: v2Run(), tuning: { nftCrystalCarryLimit: 10 } };
  assert.deepEqual(nftGameplayTraits(context), { version: 2, ...TRAITS });
  assert.equal(nftCarryCapacity(context), TRAITS.carryCapacity);
});
