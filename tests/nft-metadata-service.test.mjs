import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { createMattMineHttpServer } from '../server/http.js';
import { NftMetadataService } from '../server/nft-metadata-service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '0x1DAb596D0121C250a24B00137E84170FA6874be6';
const ADDRESSES = Object.freeze({
  miner: '0x545d5d4c714eB4d2242BBFE82C31fe9a1E5Cff29',
  equipment: '0x73A4Ad9a2b4bfeeE1b98F5D99AaB24B702dEb093',
  loadout: '0x6cf168cdD198D0d111faE2286aE6dcD86FA960d8'
});

async function createService() {
  return new NftMetadataService({
    enabled: true,
    root: ROOT,
    publicOrigin: 'https://matt-mine.onrender.com',
    chainId: 202601,
    addresses: ADDRESSES,
    chainReader: {
      async miner(minerId) {
        assert.equal(minerId, 1);
        return {
          owner: OWNER,
          progression: { bankedXp: 0, level: 1, evolution: 0, prestigeXp: 0 },
          loadout: {
            weapon: 0,
            backpackHead: 0,
            backpackTail: 0,
            helmet: 0,
            armor: 0,
            backpackCount: 0,
            runLocked: false
          },
          equipment: {}
        };
      },
      async equipment(tokenId) {
        assert.equal(tokenId, 7);
        return {
          owner: OWNER,
          definitionId: 103,
          armorHp: 0,
          itemType: 0,
          rarity: 2,
          damaged: false,
          equippedToMiner: 0
        };
      }
    }
  }).init();
}

describe('NFT metadata service', function () {
  it('builds wallet metadata and a composited Miner PNG with the starter pickaxe', async function () {
    const service = await createService();
    const metadata = await service.minerMetadata(1);
    assert.equal(metadata.name, 'MATT Mine Miner #1');
    assert.equal('properties' in metadata, false);
    assert.match(metadata.image, /^https:\/\/matt-mine\.onrender\.com\/api\/nft\/miners\/1\/image\.png\?v=[a-f0-9]{16}$/);
    assert.deepEqual(metadata.attributes.slice(0, 2), [
      { trait_type: 'Level', value: 1 },
      { trait_type: 'Evolution', value: 'Rookie Miner' }
    ]);
    assert.deepEqual(metadata.attributes.find(({ trait_type }) => trait_type === 'Weapon'), {
      trait_type: 'Weapon',
      value: 'Starter Pickaxe'
    });

    const image = await service.minerImage(1);
    const info = await sharp(image.body).metadata();
    assert.equal(info.format, 'png');
    assert.equal(info.width, 960);
    assert.equal(info.height, 960);
    assert.ok(image.body.length < 1_000_000);
    assert.match(image.etag, /^"[a-f0-9]{64}"$/);
    assert.equal((await service.minerImage(1)).body, image.body);

    const sprite = await service.minerSprite(1);
    const spriteImage = sharp(sprite.body);
    const spriteInfo = await spriteImage.metadata();
    const spriteStats = await spriteImage.stats();
    assert.equal(spriteInfo.width, 512);
    assert.equal(spriteInfo.height, 512);
    assert.equal(spriteInfo.hasAlpha, true);
    assert.equal(spriteStats.channels[3].min, 0);
    assert.equal(spriteStats.channels[3].max, 255);
  });

  it('builds equipment and collection metadata from the locked definition manifest', async function () {
    const service = await createService();
    const equipment = await service.equipmentMetadata(7);
    assert.equal(equipment.name, 'Crystal Fang Pick #7');
    assert.equal('properties' in equipment, false);
    assert.deepEqual(equipment.attributes.slice(0, 3), [
      { trait_type: 'Type', value: 'Weapon' },
      { trait_type: 'Rarity', value: 'Rare' },
      { display_type: 'number', trait_type: 'Definition', value: 103 }
    ]);
    assert.equal(service.minerContractMetadata().name, 'MATT Mine Miners');
    assert.equal(service.equipmentContractMetadata().name, 'MATT Mine Equipment');
  });

  it('serves public metadata and cacheable PNG responses through the production HTTP router', async function (context) {
    const nftMetadataService = await createService();
    const server = createMattMineHttpServer({
      root: ROOT,
      service: { publicOrigin: null, nftMetadataService }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    context.after(() => new Promise((resolve) => server.close(resolve)));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;

    const metadataResponse = await fetch(`${origin}/api/nft/miners/1.json?v=1`);
    assert.equal(metadataResponse.status, 200);
    assert.match(metadataResponse.headers.get('cache-control'), /max-age=30/);
    assert.equal((await metadataResponse.json()).name, 'MATT Mine Miner #1');

    const imageResponse = await fetch(`${origin}/api/nft/miners/1/image.png`);
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('content-type'), 'image/png');
    assert.match(imageResponse.headers.get('etag'), /^"[a-f0-9]{64}"$/);
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 100_000);

    const spriteResponse = await fetch(`${origin}/api/nft/miners/1/sprite.png`);
    assert.equal(spriteResponse.status, 200);
    assert.equal(spriteResponse.headers.get('content-type'), 'image/png');
    assert.ok((await spriteResponse.arrayBuffer()).byteLength > 10_000);

    const cachedResponse = await fetch(`${origin}/api/nft/miners/1/image.png`, {
      headers: { 'if-none-match': imageResponse.headers.get('etag') }
    });
    assert.equal(cachedResponse.status, 304);
  });
});
