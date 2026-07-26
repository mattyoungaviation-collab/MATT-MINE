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
