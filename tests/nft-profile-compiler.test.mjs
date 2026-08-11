import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileMinerNftProfile } from '../server/nft-profile-compiler.js';

const OWNER = '0x1111111111111111111111111111111111111111';

function baseInput() {
  return {
    minerId: 7,
    owner: OWNER,
    progression: { bankedXp: 4200, level: 35, evolution: 3, prestigeXp: 0 },
    loadout: {
      weapon: 101,
      backpackHead: 202,
      backpackTail: 203,
      helmet: 301,
      armor: 401,
      backpackCount: 2,
      runLocked: false
    },
    equipment: {
      101: { itemType: 0, rarity: 4, definitionId: 9001, armorHp: 0, damaged: false, equippedToMiner: 7 },
      202: { itemType: 1, rarity: 0, definitionId: 2001, armorHp: 0, damaged: false, equippedToMiner: 7 },
      301: { itemType: 2, rarity: 2, definitionId: 3001, armorHp: 0, damaged: false, equippedToMiner: 7 },
      401: { itemType: 3, rarity: 1, definitionId: 4001, armorHp: 150, damaged: false, equippedToMiner: 7 }
    }
  };
}

describe('Miner NFT profile compiler', function () {
  it('shows the equipped diamond pickaxe, backpack, helmet, and armor in the fixed NFT/game layout', function () {
    const profile = compileMinerNftProfile(baseInput());
    assert.equal(profile.render.baseEvolution, 'veteran-miner');
    assert.deepEqual(profile.render.layers.map(({ slot, definitionId }) => ({ slot, definitionId })), [
      { slot: 'armor', definitionId: 4001 },
      { slot: 'backpack', definitionId: 2001 },
      { slot: 'helmet', definitionId: 3001 },
      { slot: 'weapon', definitionId: 9001 }
    ]);
    assert.equal(profile.gameplay.maximumHealth, 150);
    assert.equal(profile.gameplay.crystalCarryMultiplier, 2);
    assert.equal(profile.render.damagedArmorFlashRed, false);
  });

  it('keeps damaged armor visible, disables its HP, and asks the renderer to flash faint red', function () {
    const input = baseInput();
    input.equipment[401].damaged = true;
    const profile = compileMinerNftProfile(input);
    assert.equal(profile.gameplay.maximumHealth, 100);
    assert.equal(profile.gameplay.armorEffective, false);
    assert.equal(profile.render.damagedArmorFlashRed, true);
    assert.equal(profile.render.layers.find(({ slot }) => slot === 'armor').state, 'damaged');
  });

  it('rejects equipment that is not assigned to the selected Miner', function () {
    const input = baseInput();
    input.equipment[101].equippedToMiner = 8;
    assert.throws(() => compileMinerNftProfile(input), /assigned to another Miner/);
  });
});
