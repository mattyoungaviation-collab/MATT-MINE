import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AbiCoder } from 'ethers';
import {
  ABI_SELECTORS,
  CHEST_PRODUCTS,
  addressWord,
  decodeAbiAddress,
  decodeAbiString,
  decodeAbiUint,
  encodeCall,
  equippedTokenForItem,
  formatTokenUnits,
  splitAbiWords,
  uintWord
} from '../src/nftLab.js';
import { validatedNftLabImageUrl, validatedNftLabMetadataUrl } from '../server/http.js';

describe('Saigon NFT Lab ABI helpers', () => {
  it('encodes Miner and Loadout calls without a browser dependency', () => {
    assert.equal(
      encodeCall(ABI_SELECTORS.equip, uintWord(1), uintWord(7)),
      `0x28257532${'1'.padStart(64, '0')}${'7'.padStart(64, '0')}`
    );
    assert.equal(addressWord('0x1DAb596D0121C250a24B00137E84170FA6874be6').length, 64);
  });

  it('decodes dynamic metadata URLs and fixed ABI words', () => {
    const coder = AbiCoder.defaultAbiCoder();
    const metadataUrl = 'https://matt-mine.onrender.com/api/nft/miners/1.json?v=2';
    assert.equal(decodeAbiString(coder.encode(['string'], [metadataUrl])), metadataUrl);
    assert.equal(decodeAbiUint(coder.encode(['uint256'], [125n])), 125n);
    assert.equal(
      decodeAbiAddress(coder.encode(['address'], ['0x1DAb596D0121C250a24B00137E84170FA6874be6'])),
      '0x1dab596d0121c250a24b00137e84170fa6874be6'
    );
    assert.equal(splitAbiWords(coder.encode(['uint256', 'bool'], [2n, true])).length, 2);
  });

  it('formats test MATT prices without floating point loss', () => {
    assert.equal(formatTokenUnits(5_000_000_000_000_000_000n), '5');
    assert.equal(formatTokenUnits(350_000_000_000_000_000n), '0.35');
  });

  it('maps all five chest products to the deployed chest ABI', () => {
    assert.deepEqual(CHEST_PRODUCTS.map(({ type, label }) => ({ type, label })), [
      { type: 0, label: 'Pickaxe Chest' },
      { type: 1, label: 'Helmet Chest' },
      { type: 2, label: 'Common Armor' },
      { type: 3, label: 'Rare Armor' },
      { type: 4, label: 'Mythic Armor' }
    ]);
    assert.equal(encodeCall(ABI_SELECTORS.openChest, uintWord(4)), `0x99ae54a9${'4'.padStart(64, '0')}`);
    assert.equal(encodeCall(ABI_SELECTORS.chestPrice, uintWord(3)), `0xdb79e06f${'3'.padStart(64, '0')}`);
  });

  it('finds occupied single-item slots while allowing queued backpacks', () => {
    const miner = { loadout: { weapon: 11, backpackHead: 12, helmet: 13, armor: 14 } };
    assert.equal(equippedTokenForItem(miner, 0), 11);
    assert.equal(equippedTokenForItem(miner, 1), 0);
    assert.equal(equippedTokenForItem(miner, 2), 13);
    assert.equal(equippedTokenForItem(miner, 3), 14);
    assert.throws(() => equippedTokenForItem(miner, 9), /Unknown equipment item type/);
  });

  it('limits the same-origin proxy to public MATT Mine NFT JSON', () => {
    assert.equal(
      validatedNftLabMetadataUrl('https://matt-mine.onrender.com/api/nft/miners/1.json?v=2'),
      'https://matt-mine.onrender.com/api/nft/miners/1.json?v=2'
    );
    assert.throws(
      () => validatedNftLabMetadataUrl('https://example.com/private.json'),
      /Only public MATT Mine Miner and Equipment metadata/
    );
  });

  it('limits the image proxy to dynamic renders and locked NFT layers', () => {
    assert.equal(
      validatedNftLabImageUrl('https://matt-mine.onrender.com/api/nft/miners/1/image.png?v=608c879d65fb32de'),
      'https://matt-mine.onrender.com/api/nft/miners/1/image.png?v=608c879d65fb32de'
    );
    assert.equal(
      validatedNftLabImageUrl('https://matt-mine.onrender.com/assets/nft/layers/backpacks/crystal-hauler-overlay-v1.png'),
      'https://matt-mine.onrender.com/assets/nft/layers/backpacks/crystal-hauler-overlay-v1.png'
    );
    assert.throws(
      () => validatedNftLabImageUrl('https://matt-mine.onrender.com/admin.html'),
      /Only public MATT Mine NFT PNGs/
    );
  });
});
