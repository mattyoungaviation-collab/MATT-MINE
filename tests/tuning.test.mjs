import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GAMEPLAY_LOBBIES,
  GAME_TUNING_SCHEMA,
  defaultGameTuning,
  normalizeGameTuning,
  normalizeTuningPatch
} from '../src/game/tuning.js';
import {
  defaultKeybindings,
  normalizeKeybindings
} from '../src/game/keybindings.js';
import { normalizeServerState } from '../server/state.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import { resolveEnemySpawnType } from '../src/game/enemyDepthTuning.js';

const NOOP_AUDIO = {
  startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
};

test('game tuning exposes bounded controls and separate presets for all four lobbies', () => {
  assert.deepEqual(GAMEPLAY_LOBBIES, ['practice', 'free', 'paid', 'arena']);
  assert.ok(GAME_TUNING_SCHEMA.length >= 60);
  const tuning = defaultGameTuning();
  tuning.practice.playerSpeed = 400;
  assert.notEqual(tuning.free.playerSpeed, 400);
  const patch = normalizeTuningPatch({ playerSpeed: 9999, spawnBats: false });
  assert.equal(patch.playerSpeed, 700);
  assert.equal(patch.spawnBats, false);
  assert.throws(() => normalizeTuningPatch({ contractPrizeCap: 9 }), /Unknown game setting/);
});

test('state recovery preserves valid tuning and resets corrupt keybindings safely', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const state = normalizeServerState({
    gameTuning: { paid: { bossHealthMultiplier: 4 } },
    wallets: {
      [address]: {
        address,
        keybindings: { ...defaultKeybindings(), attack: 'not-a-key' },
        activity: [{ action: 'RUN_STARTED', details: 'paid run', timestamp: 10 }]
      }
    }
  });
  assert.equal(state.gameTuning.paid.bossHealthMultiplier, 4);
  assert.equal(state.wallets[address].keybindings.attack, 'Space');
  assert.equal(state.wallets[address].activity.length, 1);
});

test('custom keybindings reject duplicates and a tuned run applies player, weapon, boss, and room values', () => {
  assert.throws(
    () => normalizeKeybindings({ ...defaultKeybindings(), dash: 'Space' }),
    /assigned more than once/
  );
  const tuning = normalizeGameTuning().paid;
  Object.assign(tuning, {
    playerMaxHealth: 240,
    playerSpeed: 360,
    pickaxeRange: 180,
    blasterRange: 720,
    bossRoomWidth: 1000,
    bossRoomHeight: 700,
    bossHealthMultiplier: 3,
    enemyMaximum: 4
  });
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode: 'paid', seed: 'TUNING-TEST', tuning });
  assert.equal(game.player.maxHealth, 240);
  assert.equal(game.player.speed, 360);
  assert.equal(game.player.attackRange, 180);
  assert.ok(game.layout.guardianRoom.width >= 1000);
  assert.ok(game.layout.guardianRoom.height >= 700);
  assert.ok(game.enemies.length <= 4);
  const guardian = game.spawnEnemy(true, game.layout.guardianRoom);
  assert.equal(guardian.maxHp, 820 * 3);
});

test('every creature supports exact validated stats and behavior at every configured depth', () => {
  const expectedFields = ['Health', 'Damage', 'Speed', 'Xp', 'Radius', 'AwarenessRange', 'ContactCooldown'];
  for (let depth = 1; depth <= 5; depth += 1) {
    for (const type of ['Slime', 'Bat', 'Crawler', 'Beetle', 'Exploder', 'Spitter', 'Guardian']) {
      for (const field of expectedFields) {
        assert.ok(
          GAME_TUNING_SCHEMA.some((entry) => entry.id === `depth${depth}${type}${field}`),
          `missing depth${depth}${type}${field}`
        );
      }
    }
  }
  const patch = normalizeTuningPatch({
    depth1SlimeHealth: 100,
    depth2SlimeHealth: 200,
    depth5GuardianHealth: 12_500,
    depth3SpitterDamage: 999_999
  });
  assert.equal(patch.depth1SlimeHealth, 100);
  assert.equal(patch.depth2SlimeHealth, 200);
  assert.equal(patch.depth5GuardianHealth, 12_500);
  assert.equal(patch.depth3SpitterDamage, 100_000);
});

test('per-depth exact stats replace calculated values for normal enemies and Guardians', () => {
  const tuning = normalizeGameTuning().paid;
  Object.assign(tuning, {
    depth1SlimeHealth: 100,
    depth1SlimeDamage: 21,
    depth1SlimeSpeed: 111,
    depth1SlimeXp: 55,
    depth1SlimeRadius: 33,
    depth1SlimeAwarenessRange: 777,
    depth1SlimeContactCooldown: 2.5,
    depth1SlimeSlimeBurstSpeed: 4.2,
    depth2SlimeHealth: 200,
    depth2GuardianHealth: 4_000,
    depth2GuardianDamage: 40,
    depth2GuardianSpeed: 90,
    depth2GuardianXp: 500
  });
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode: 'paid', seed: 'PER-DEPTH-ENEMY-STATS', tuning });
  const room = game.layout.rooms.find((entry) => !['start', 'guardian'].includes(entry.type));
  const depthOneSlime = game.spawnEnemy(false, room, 'slime');
  assert.deepEqual(
    {
      health: depthOneSlime.maxHp,
      damage: depthOneSlime.damage,
      speed: depthOneSlime.speed,
      xp: depthOneSlime.xp
    },
    { health: 100, damage: 21, speed: 111, xp: 55 }
  );
  assert.equal(depthOneSlime.radius, 33);
  assert.equal(depthOneSlime.behavior.awarenessRange, 777);
  assert.equal(depthOneSlime.behavior.contactCooldown, 2.5);
  assert.equal(depthOneSlime.behavior.slimeBurstSpeed, 4.2);

  game.run.depth = 2;
  const depthTwoSlime = game.spawnEnemy(false, room, 'slime');
  const depthTwoGuardian = game.spawnEnemy(true, game.layout.guardianRoom);
  assert.equal(depthTwoSlime.maxHp, 200);
  assert.deepEqual(
    {
      health: depthTwoGuardian.maxHp,
      damage: depthTwoGuardian.damage,
      speed: depthTwoGuardian.speed,
      xp: depthTwoGuardian.xp
    },
    { health: 4_000, damage: 40, speed: 90, xp: 500 }
  );
});

test('per-depth spawn switches and weights select only configured creature types', () => {
  const tuning = normalizeGameTuning().free;
  Object.assign(tuning, {
    depth3SlimeSpawnWeight: 0,
    depth3BatSpawnWeight: 0,
    depth3CrawlerSpawnWeight: 0,
    depth3BeetleSpawnWeight: 0,
    depth3ExploderSpawnWeight: 0,
    depth3SpitterSpawnWeight: 100,
    depth3SpitterEnabled: true
  });
  for (const roll of [0, .2, .5, .999]) {
    assert.equal(resolveEnemySpawnType({
      roll,
      depth: 3,
      tuning,
      legacySelector: () => 'slime'
    }), 'spitter');
  }
  tuning.depth3SpitterEnabled = false;
  assert.equal(resolveEnemySpawnType({
    roll: .9,
    depth: 3,
    tuning,
    legacySelector: () => 'bat'
  }), 'bat');
});
