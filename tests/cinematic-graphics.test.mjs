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
  const assetNames = [
    'matt-dyno-spritesheet.png',
    'matt-dyno-blaster-spritesheet.png',
    'matt-dyno-dynamite-spritesheet.png',
    'matt-dyno-pickaxe-vertical-spritesheet.png',
    'matt-dyno-blaster-vertical-spritesheet.png',
    'matt-dyno-dynamite-vertical-spritesheet.png'
  ];
  for (const assetName of assetNames) {
    const dyno = await stat(`${root}assets/game/${assetName}`);
    assert.ok(dyno.size > 80_000);
    assert.ok(dyno.size < 700_000);
  }
});

test('Ronke, Axie, and Orc ship as optimized high-resolution weapon sprite packs', async () => {
  const assetNames = [
    'ronke-character-spritesheet.webp',
    'axie-character-spritesheet.webp',
    'orc-character-spritesheet.webp'
  ];
  for (const assetName of assetNames) {
    const sprite = await stat(`${root}assets/game/${assetName}`);
    const header = await readFile(`${root}assets/game/${assetName}`);
    assert.ok(sprite.size > 100_000);
    assert.ok(sprite.size < 300_000);
    assert.equal(header.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(header.subarray(8, 12).toString('ascii'), 'WEBP');
  }
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
  assert.equal(assets.mattDynoBlaster.src, '/assets/game/matt-dyno-blaster-spritesheet.png');
  assert.equal(assets.mattDynoDynamite.src, '/assets/game/matt-dyno-dynamite-spritesheet.png');
  assert.equal(assets.mattDynoPickaxeVertical.src, '/assets/game/matt-dyno-pickaxe-vertical-spritesheet.png');
  assert.equal(assets.mattDynoBlasterVertical.src, '/assets/game/matt-dyno-blaster-vertical-spritesheet.png');
  assert.equal(assets.mattDynoDynamiteVertical.src, '/assets/game/matt-dyno-dynamite-vertical-spritesheet.png');
  assert.equal(assets.ronkeCharacter.src, '/assets/game/ronke-character-spritesheet.webp');
  assert.equal(assets.axieCharacter.src, '/assets/game/axie-character-spritesheet.webp');
  assert.equal(assets.orcCharacter.src, '/assets/game/orc-character-spritesheet.webp');
  assert.equal(imageIsReady(assets.floor), true);
  assert.deepEqual(loadVisualAssets(null), {});
});

test('normal MATT Dyno animation avoids expensive live canvas filters', async () => {
  const renderer = await readFile(`${root}src/game/v3/renderPlayer.js`, 'utf8');
  assert.doesNotMatch(renderer, /drop-shadow\(/);
  assert.doesNotMatch(renderer, /ctx\.filter\s*=\s*['"]blur/);
  assert.match(renderer, /: 'none';/);
});

test('responsive production lobby stays hidden while gameplay is active', async () => {
  const css = await readFile(`${root}src/production.css`, 'utf8');
  assert.match(css, /#menu\.menu-v4:not\(\.active\)\s*\{\s*display:\s*none;/);
});
