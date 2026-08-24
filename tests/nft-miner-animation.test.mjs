import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import test from 'node:test';
import {
  NFT_MINER_ACTION_DURATION,
  nftMinerAnimationFrame,
  nftMinerAtlasAssetForLevel,
  nftMinerAtlasSourceForLevel,
  nftMinerMotionTransform,
  nftMinerVisualDirection
} from '../src/game/v3/nftMinerAnimation.js';

const EVOLUTION_ASSETS = Object.freeze([
  [1, 'nftRookieAtlas', 'rookie-atlas-v1.png'],
  [10, 'nftApprenticeAtlas', 'apprentice-atlas-v1.png'],
  [25, 'nftCrystalHunterAtlas', 'crystal-hunter-atlas-v1.png'],
  [35, 'nftVeteranAtlas', 'veteran-atlas-v1.png'],
  [50, 'nftVaultRaiderAtlas', 'vault-raider-atlas-v1.png'],
  [75, 'nftEliteAtlas', 'elite-atlas-v1.png'],
  [100, 'nftMineLegendAtlas', 'mine-legend-atlas-v1.png']
]);

test('Miner levels select the correct immutable evolution milestone', () => {
  for (const [level, asset] of EVOLUTION_ASSETS) {
    assert.equal(nftMinerAtlasAssetForLevel(level), asset);
  }
  assert.equal(nftMinerAtlasAssetForLevel(9), 'nftRookieAtlas');
  assert.equal(nftMinerAtlasAssetForLevel(74), 'nftVaultRaiderAtlas');
  assert.equal(nftMinerAtlasAssetForLevel(999), 'nftMineLegendAtlas');
  assert.equal(nftMinerAtlasSourceForLevel(25), '/assets/game/nft-evolution/crystal-hunter-atlas-v1.png');
});

test('every evolution atlas is present in the production asset tree', async () => {
  await Promise.all(EVOLUTION_ASSETS.map(([, , file]) => (
    access(new URL(`../assets/game/nft-evolution/${file}`, import.meta.url))
  )));
});

test('NFT animation maps movement, damage, knockout, and weapons to atlas frames', () => {
  const player = {
    health: 50,
    hitFlash: 0,
    swingTimer: 0,
    dashTimer: 0,
    weapon: 'pickaxe'
  };

  assert.deepEqual(nftMinerAnimationFrame(player, 0, 0), { row: 0, column: 0, progress: 0 });
  assert.equal(nftMinerAnimationFrame(player, 100, 0).column, 1);
  assert.equal(nftMinerAnimationFrame(player, 100, 0.15).column, 2);

  player.swingTimer = NFT_MINER_ACTION_DURATION.pickaxe;
  assert.equal(nftMinerAnimationFrame(player, 0, 0).row, 1);
  player.weapon = 'blaster';
  player.swingTimer = NFT_MINER_ACTION_DURATION.blaster / 2;
  assert.deepEqual(nftMinerAnimationFrame(player, 0, 0), { row: 2, column: 3, progress: 0.5 });
  player.weapon = 'dynamite';
  player.swingTimer = NFT_MINER_ACTION_DURATION.dynamite * 0.01;
  assert.equal(nftMinerAnimationFrame(player, 0, 0).column, 5);

  player.swingTimer = 0;
  player.hitFlash = 0.1;
  assert.equal(nftMinerAnimationFrame(player, 0, 0).column, 4);
  player.health = 0;
  assert.equal(nftMinerAnimationFrame(player, 0, 0).column, 5);
});

test('directional presentation commits attacks, preserves vertical facing, and holds a dash slide', () => {
  const player = {
    health: 50,
    hitFlash: 0,
    swingTimer: NFT_MINER_ACTION_DURATION.pickaxe / 2,
    dashTimer: 0,
    weapon: 'pickaxe',
    angle: 0,
    actionAngle: -Math.PI / 2,
    visualAngle: 0,
    visualFacingSign: -1,
    vx: 100,
    vy: 0,
    walkCycle: 0.25
  };

  assert.deepEqual(
    nftMinerVisualDirection(player, 100),
    {
      angle: -Math.PI / 2,
      direction: 'north',
      facingSign: -1,
      verticalFacing: true,
      depth: -1
    }
  );
  const strike = nftMinerMotionTransform(player, 100, 1, 0.5);
  assert.equal(strike.offsetY < -6, true);
  assert.equal(strike.scaleY < 1, true);

  player.swingTimer = 0;
  player.dashTimer = 0.12;
  player.dashAngle = Math.PI;
  const slide = nftMinerMotionTransform(player, 500, 1, 0);
  assert.equal(nftMinerAnimationFrame(player, 500, 1).column, 3);
  assert.equal(slide.facingSign, -1);
  assert.equal(slide.scaleX > 1, true);
  assert.equal(slide.scaleY < 1, true);
  assert.equal(slide.shadowStretch > 1, true);
});
