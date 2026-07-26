import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

import { AUDIO_SETTINGS_KEY, GameAudio } from '../src/game/audio.js';

test('Ore Reactor is packaged as a non-empty MP3 gameplay asset', async () => {
  const assetUrl = new URL('../assets/audio/ore-reactor.mp3', import.meta.url);
  const info = await stat(assetUrl);
  const header = await readFile(assetUrl).then((buffer) => buffer.subarray(0, 3).toString('ascii'));

  assert.ok(info.size > 1_000_000);
  assert.equal(header, 'ID3');
});

test('gameplay music loops, keeps its mix level, and reuses one media element', () => {
  let factoryCalls = 0;
  const track = {
    loop: false,
    preload: '',
    volume: 0,
    currentTime: 19,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
    }
  };
  const audio = new GameAudio({
    musicUrl: '/assets/audio/ore-reactor.mp3',
    musicVolume: 0.32,
    audioFactory(url) {
      factoryCalls += 1;
      assert.equal(url, '/assets/audio/ore-reactor.mp3');
      return track;
    }
  });

  audio.startMusic();
  audio.startMusic();

  assert.equal(factoryCalls, 1);
  assert.equal(track.playCalls, 2);
  assert.equal(track.loop, true);
  assert.equal(track.preload, 'auto');
  assert.equal(track.volume, 0.32);
});

test('gameplay music stops and resets when a run ends', () => {
  const track = {
    currentTime: 42,
    play() {},
    pauseCalls: 0,
    pause() {
      this.pauseCalls += 1;
    }
  };
  const audio = new GameAudio({ audioFactory: () => track });

  audio.startMusic();
  audio.stopMusic();

  assert.equal(track.pauseCalls, 1);
  assert.equal(track.currentTime, 0);
});

test('sound controls persist mute, music, and combat-effect levels', () => {
  const values = new Map();
  const storage = {
    getItem(key) {
      return values.get(key) || null;
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
  const track = { volume: 0, play() {}, pause() {} };
  const audio = new GameAudio({ storage, audioFactory: () => track });
  audio.startMusic();
  audio.setMusicVolume(0.45);
  audio.setEffectsVolume(0.6);
  audio.setMuted(true);

  assert.equal(track.volume, 0);
  assert.deepEqual(JSON.parse(values.get(AUDIO_SETTINGS_KEY)), {
    muted: true,
    musicVolume: 0.45,
    effectsVolume: 0.6
  });

  const restored = new GameAudio({ storage });
  assert.deepEqual(restored.settings(), {
    muted: true,
    musicVolume: 0.45,
    effectsVolume: 0.6
  });
});
