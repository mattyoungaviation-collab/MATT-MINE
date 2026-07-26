import test from 'node:test';
import assert from 'node:assert/strict';

import { MattMineGame } from '../src/game/Game.js';
import {
  GAMEPLAY_PREFERENCES_KEY,
  loadGameplayPreferences,
  saveGameplayPreferences
} from '../src/game/preferences.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    value(key) {
      return values.get(key);
    }
  };
}

test('screen shake defaults on, persists off, and recovers corrupt preferences', () => {
  const storage = memoryStorage();
  assert.deepEqual(loadGameplayPreferences(storage), { screenShake: true });

  assert.deepEqual(saveGameplayPreferences({ screenShake: false }, storage), {
    screenShake: false
  });
  assert.deepEqual(loadGameplayPreferences(storage), { screenShake: false });
  assert.deepEqual(JSON.parse(storage.value(GAMEPLAY_PREFERENCES_KEY)), {
    screenShake: false
  });

  const corrupt = memoryStorage({ [GAMEPLAY_PREFERENCES_KEY]: '{bad-json' });
  assert.deepEqual(loadGameplayPreferences(corrupt), { screenShake: true });
});

test('turning screen shake off immediately clears active shake', () => {
  const game = new MattMineGame(null, {}, { headless: true });
  game.camera.shake = 15;

  assert.equal(game.setScreenShakeEnabled(false), false);
  assert.equal(game.camera.shake, 0);
  assert.equal(game.screenShakeEnabled, false);
  assert.equal(game.setScreenShakeEnabled(true), true);
});
