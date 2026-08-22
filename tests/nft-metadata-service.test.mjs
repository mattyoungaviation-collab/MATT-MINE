import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import { createMattMineHttpServer } from '../server/http.js';
import { NftMetadataService, ViemNftChainReader } from '../server/nft-metadata-service.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '0x1DAb596D0121C250a24B00137E84170FA6874be6';
const ADDRESSES = Object.freeze({
  miner: '0x545d5d4c714eB4d2242BBFE82C31fe9a1E5Cff29',
  equipment: '0x73A4Ad9a2b4bfeeE1b98F5D99AaB24B702dEb093',
  loadout: '0x6cf168cdD198D0d111faE2286aE6dcD86FA960d8'
});

function minerState(level = 1) {
  return {
    owner: OWNER,
    version: 2,
    traits: {
      bankedXp: 0, baseHealth: 50, pickaxeAttack: 15, blasterAttack: 5,
      dynamiteAttack: 20, healAmount: 10, baseCarryCapacity: 750,
      deathRetentionBps: 1000, level, evolution: 0, crystalsPerHour: 0,
      lastVerifiedPlay: 0, activeUntil: 0, cphAssignedAt: 0,
      earningStatus: 0, runLocked: false
    },
    effectiveTraits: {
      maximumHealth: 50, armorShield: 0, pickaxeAttack: 15, blasterAttack: 5,
      dynamiteAttack: 20, healAmount: 10, carryCapacity: 750,
      deathRetentionBps: 1000, level, crystalsPerHour: 0
    },
    loadout: { armor: 0, pickaxe: 0, blaster: 0, dynamite: 0, helmet: 0, backpack: 0 },
    equipment: {}
  };
}

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
        return minerState();
      },
      async equipment(tokenId) {
        assert.equal(tokenId, 7);
        return {
          owner: OWNER,
          definitionId: 1102,
          slot: 1,
          rarity: 2,
          damaged: false,
          equippedToMiner: 0,
          bonus: 5
        };
      }
    }
  }).init();
}

describe('NFT metadata service', function () {
  it('configures Ronin Multicall3 for production wallet ownership scans', function () {
    const reader = new ViemNftChainReader({
      chainId: 2020,
      rpcUrl: 'https://example.invalid',
      addresses: ADDRESSES
    });
    assert.equal(reader.client.chain.id, 2020);
    assert.equal(
      reader.client.chain.contracts.multicall3.address.toLowerCase(),
      '0xca11bde05977b3631167028862be2a173976ca11'
    );
  });

  it('indexes up to 1,000 minted Miners in bounded Ronin multicalls instead of sequential profile reads', async function () {
    const batches = [];
    const reader = new ViemNftChainReader({
      chainId: 2020,
      rpcUrl: 'https://example.invalid',
      addresses: ADDRESSES,
      client: {
        async readContract({ functionName }) {
          if (functionName === 'balanceOf') return 2n;
          if (functionName === 'nextTokenId') return 202n;
          throw new Error(`Unexpected ${functionName}`);
        },
        async multicall({ contracts }) {
          batches.push(contracts.length);
          return contracts.map(({ args }) => ({
            status: 'success',
            result: [7n, 201n].includes(args[0]) ? OWNER : '0x0000000000000000000000000000000000000001'
          }));
        }
      }
    });
    assert.deepEqual(await reader.minerIdsForOwner(OWNER), [7, 201]);
    assert.deepEqual(batches, [100, 100, 1]);
  });

  it('returns every Miner owned by a wallet for character selection', async function () {
    const service = new NftMetadataService({
      enabled: true,
      root: ROOT,
      publicOrigin: 'https://matt-mine.onrender.com',
      chainId: 202601,
      addresses: ADDRESSES,
      chainReader: {
        async miner(minerId) {
          if (minerId > 2) throw Object.assign(new Error('missing'), { status: 404 });
          return minerState(minerId);
        }
      }
    });
    await service.init();
    const miners = await service.playerMiners(OWNER);
    assert.deepEqual(miners.map(({ minerId }) => minerId), [1, 2]);
    assert.equal((await service.playerMiner(OWNER)).minerId, 1);
  });

  it('loads one Miner by number only when the connected wallet owns it', async function () {
    const otherOwner = '0x0000000000000000000000000000000000000001';
    const service = new NftMetadataService({
      enabled: true,
      root: ROOT,
      publicOrigin: 'https://mattmine.com',
      chainId: 2020,
      addresses: ADDRESSES,
      chainReader: {
        async miner(minerId) {
          return { ...minerState(), owner: minerId === 7 ? OWNER : otherOwner };
        }
      }
    });
    await service.init();
    assert.equal((await service.playerMinerById(OWNER, 7)).minerId, 7);
    await assert.rejects(
      () => service.playerMinerById(OWNER, 8),
      (error) => error.status === 403 && error.code === 'nft_miner_not_owned'
    );
  });

  it('builds wallet metadata and a composited Miner PNG with the starter pickaxe', async function () {
    const service = await createService();
    const metadata = await service.minerMetadata(1);
    assert.equal(metadata.name, 'MATT Mine Miner #1');
    assert.equal('properties' in metadata, false);
    assert.match(metadata.image, /^https:\/\/matt-mine\.onrender\.com\/api\/nft\/v2\/miners\/1\/image\.png\?v=[a-f0-9]{16}$/);
    assert.deepEqual(metadata.attributes.slice(0, 2), [
      { trait_type: 'Level', value: 1 },
      { trait_type: 'Evolution', value: 'Rookie Miner' }
    ]);
    assert.deepEqual(metadata.attributes.find(({ trait_type }) => trait_type === 'Pickaxe'), {
      trait_type: 'Pickaxe',
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
    assert.equal(equipment.name, 'Rare Crystal Fang Pickaxe #7');
    assert.equal('properties' in equipment, false);
    assert.deepEqual(equipment.attributes.slice(0, 3), [
      { trait_type: 'Type', value: 'Pickaxe' },
      { trait_type: 'Rarity', value: 'Rare' },
      { display_type: 'number', trait_type: 'Definition', value: 1102 }
    ]);
    const minerCollection = service.minerContractMetadata();
    assert.equal(minerCollection.name, 'MATT Mine Miners');
    assert.match(minerCollection.image, /rookie-miner-collection-960-v1\.png$/);
    const collectionImagePath = resolve(ROOT, new URL(minerCollection.image).pathname.slice(1));
    const [collectionFile, collectionImage] = await Promise.all([
      stat(collectionImagePath),
      sharp(collectionImagePath).metadata()
    ]);
    assert.ok(collectionFile.size < 1_000_000);
    assert.equal(collectionImage.width, 960);
    assert.equal(collectionImage.height, 960);
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

    const collectionResponse = await fetch(`${origin}/api/nft/v2/contracts/miners.json`);
    assert.equal(collectionResponse.status, 200);
    const collection = await collectionResponse.json();
    const collectionImageResponse = await fetch(`${origin}${new URL(collection.image).pathname}`);
    assert.equal(collectionImageResponse.status, 200);
    assert.equal(collectionImageResponse.headers.get('access-control-allow-origin'), '*');
    assert.ok((await collectionImageResponse.arrayBuffer()).byteLength < 1_000_000);

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
