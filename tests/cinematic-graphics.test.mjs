import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
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

test('the official animated MATT Dyno sprite sheet is packaged for gameplay', async () => {
  const dyno = await stat(`${root}assets/game/matt-dyno-spritesheet.png`);
  assert.ok(dyno.size > 100_000);
  assert.ok(dyno.size < 500_000);
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
  assert.equal(assets.mattDyno.src, '/assets/game/matt-dyno-spritesheet.png');
  assert.equal(imageIsReady(assets.floor), true);
  assert.deepEqual(loadVisualAssets(null), {});
});

test('responsive production lobby stays hidden while gameplay is active', async () => {
  const css = await readFile(`${root}src/production.css`, 'utf8');
  assert.match(css, /#menu\.menu-v4:not\(\.active\)\s*\{\s*display:\s*none;/);
});
