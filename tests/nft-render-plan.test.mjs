import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { compileNftRenderPlan } from '../server/nft-render-plan.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(ROOT, 'assets/nft/layer-manifest.json');
const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));

function profile({ damaged = false } = {}) {
  return {
    render: {
      baseEvolution: 'veteran-miner',
      damagedArmorFlashRed: damaged,
      layers: [
        { slot: 'armor', tokenId: 40, definitionId: 403, rarity: 2, state: damaged ? 'damaged' : 'active' },
        { slot: 'backpack', tokenId: 20, definitionId: 201, rarity: 0, state: 'active' },
        { slot: 'helmet', tokenId: 30, definitionId: 303, rarity: 2, state: 'active' },
        { slot: 'weapon', tokenId: 10, definitionId: 103, rarity: 2, state: 'active' }
      ]
    }
  };
}

describe('NFT render plan', function () {
  it('uses armor as the base and visibly stacks backpack, helmet, and pickaxe', function () {
    const plan = compileNftRenderPlan(profile(), manifest, { publicOrigin: 'https://matt-mine.onrender.com' });
    assert.equal(plan.base.source, 'equipped-armor');
    assert.equal(plan.base.definitionId, 403);
    assert.equal(plan.base.image, 'https://matt-mine.onrender.com/assets/nft/armor-bases/175hp-crystalbreaker-plate-v1.png');
    assert.deepEqual(plan.underlays, []);
    assert.deepEqual(plan.layers.map(({ slot, definitionId }) => ({ slot, definitionId })), [
      { slot: 'backpack-front', definitionId: 201 },
      { slot: 'helmet', definitionId: 303 },
      { slot: 'weapon', definitionId: 103 }
    ]);
    assert.equal(plan.effect, null);
  });

  it('keeps damaged armor visible and applies the editable faint-red-flash effect', function () {
    const plan = compileNftRenderPlan(profile({ damaged: true }), manifest);
    assert.equal(plan.base.image, '/assets/nft/armor-bases/175hp-crystalbreaker-plate-v1.png');
    assert.deepEqual(plan.effect, {
      type: 'faint-red-flash',
      tint: '#ff3b30',
      maximumOpacity: 0.18,
      flashPeriodMilliseconds: 1200
    });
  });

  it('uses the level evolution when no armor is equipped', function () {
    const input = profile();
    input.render.layers = input.render.layers.filter(({ slot }) => slot !== 'armor');
    const plan = compileNftRenderPlan(input, manifest);
    assert.equal(plan.base.source, 'level-evolution');
    assert.equal(plan.base.image, '/assets/nft/renders/veteran-miner-level-35-v1.png');
  });

  it('shows the held starter pickaxe when no weapon NFT is equipped', function () {
    const input = profile();
    input.render.baseEvolution = 'rookie-miner';
    input.render.layers = [];
    const plan = compileNftRenderPlan(input, manifest);
    assert.deepEqual(plan.layers.map(({ slot, tokenId, definitionId, starter }) => ({
      slot,
      tokenId,
      definitionId,
      starter
    })), [{ slot: 'weapon', tokenId: 0, definitionId: 0, starter: true }]);
    assert.equal(plan.layers[0].image, '/assets/nft/layers/weapons/starter-pickaxe-held-overlay-v2.png');
  });

  it('references only files that exist in the deployable asset pack', async function () {
    const images = [
      ...Object.values(manifest.baseEvolutions).map(({ image }) => image),
      manifest.starterEquipment.weapon.image,
      ...Object.values(manifest.equipmentDefinitions).flatMap(({ image, damagedImage, frontImage }) =>
        [image, damagedImage, frontImage].filter(Boolean))
    ];
    await Promise.all(images.map((image) => access(resolve(ROOT, 'assets/nft', image))));
  });

  it('rejects an on-chain definition ID that is missing from the manifest', function () {
    const input = profile();
    input.render.layers[3].definitionId = 999;
    assert.throws(() => compileNftRenderPlan(input, manifest), /unknown equipment definition: 999/);
  });
});
