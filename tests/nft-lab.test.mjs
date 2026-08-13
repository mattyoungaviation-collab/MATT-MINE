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
  preferredMinerId,
  splitAbiWords,
  uintWord,
  waitForTokenIdIncrease
} from '../src/nftLab.js';
import { validatedNftLabImageUrl, validatedNftLabMetadataUrl, validatedNftLabRpcRequest } from '../server/http.js';

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

  it('preserves the Miner selected on the main character screen', () => {
    assert.equal(preferredMinerId('?miner=2'), 2);
    assert.equal(preferredMinerId('?miner=0'), 0);
    assert.equal(preferredMinerId('?miner=not-a-token'), 0);
  });

  it('keeps Saigon RPC reads on the same-origin server proxy', () => {
    assert.deepEqual(
      validatedNftLabRpcRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'eth_call',
        params: [{ to: '0x545d5d4c714eB4d2242BBFE82C31fe9a1E5Cff29', data: ABI_SELECTORS.nextTokenId }, 'latest']
      }),
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'eth_call',
        params: [{ to: '0x545d5d4c714eb4d2242bbfe82c31fe9a1e5cff29', data: ABI_SELECTORS.nextTokenId }, 'latest']
      }
    );
    assert.throws(
      () => validatedNftLabRpcRequest({ id: 8, method: 'eth_sendTransaction', params: [] }),
      /Only approved Saigon NFT read methods/
    );
    assert.throws(
      () => validatedNftLabRpcRequest({ id: 9, method: 'eth_call', params: [{ to: '0x1DAb596D0121C250a24B00137E84170FA6874be6', data: '0x12345678' }, 'latest'] }),
      /Only MATT Mine Saigon NFT contracts/
    );
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

  it('waits for the equipment token minted by the randomness keeper', async () => {
    const observed = [8n, 8n, 9n];
    const delays = [];
    const result = await waitForTokenIdIncrease(
      async () => observed.shift(),
      8n,
      { attempts: 3, delayMs: 1, delay: async (milliseconds) => delays.push(milliseconds) }
    );
    assert.equal(result, 9n);
    assert.deepEqual(delays, [1, 1]);
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
