import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { imageIsReady, loadVisualAssets } from '../src/game/v3/visualAssets.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('cinematic mine and Guardian assets are packaged as optimized WebP files', async () => {
  const floor = await stat(`${root}assets/game/mine-floor-cinematic.webp`);
  const guardian = await stat(`${root}assets/game/guardian-cinematic.webp`);
  assert.ok(floor.size > 100_000);
  assert.ok(guardian.size > 100_000);
  assert.ok(floor.size < 1_000_000);
  assert.ok(guardian.size < 1_000_000);
});

test('cinematic assets load lazily in browsers and remain safe in test environments', () => {
  class FakeImage {
    complete = true;
    naturalWidth = 1024;
    naturalHeight = 1024;
  }
  const assets = loadVisualAssets(FakeImage);
  assert.equal(assets.floor.src, '/assets/game/mine-floor-cinematic.webp');
  assert.equal(assets.guardian.src, '/assets/game/guardian-cinematic.webp');
  assert.equal(imageIsReady(assets.floor), true);
  assert.deepEqual(loadVisualAssets(null), {});
});
