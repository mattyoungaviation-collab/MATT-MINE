import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  parsePngDimensions,
  validateChainInventory,
  validateCollectionMetadata,
  validateMarketImage,
  validateMarketplace,
  validateMinerMetadata
} from '../scripts/validate-nft-marketplace.mjs';

function png(width = 960, height = 960) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  typeBytes.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return result;
}

function crc32(input) {
  let checksum = 0xffffffff;
  for (const byte of input) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

function numeric(traitType, value) {
  return { display_type: 'number', trait_type: traitType, value };
}

function trait(traitType, value) {
  return { trait_type: traitType, value };
}

function minerMetadata(minerId) {
  return {
    name: 'MATT Mine Miner #' + minerId,
    description: 'An evolving MATT Mine character.',
    image: 'http://localhost:4173/api/nft/v2/miners/' + minerId + '/image.png?v=0123456789abcdef',
    external_url: 'http://localhost:4173/?miner=' + minerId,
    background_color: '10243F',
    attributes: [
      trait('Level', 1),
      trait('Evolution', 'Rookie Miner'),
      numeric('Banked XP', 0),
      numeric('Base Health', 50),
      numeric('Maximum Health', 50),
      numeric('Armor Shield', 0),
      numeric('Pickaxe Attack', 15),
      numeric('Blaster Attack', 5),
      numeric('Dynamite Attack', 20),
      numeric('Heal', 10),
      numeric('Crystal Carry Capacity', 750),
      trait('Crystal Death Retention', '10%'),
      numeric('Crystals Per Hour', 0),
      trait('Earning Status', 'Not Eligible'),
      trait('Pickaxe', 'Starter Pickaxe'),
      trait('Blaster', 'None'),
      trait('Dynamite', 'None'),
      trait('Backpack', 'None'),
      trait('Helmet', 'None'),
      trait('Armor', 'None'),
      trait('Armor State', 'None')
    ]
  };
}

test('PNG validation reads dimensions and enforces marketplace response rules', () => {
  const valid = png();
  const digest = createHash('sha256').update(valid).digest('hex');
  assert.deepEqual(parsePngDimensions(valid), { width: 960, height: 960 });
  assert.deepEqual(validateMarketImage(valid, {
    'content-type': 'image/png',
    etag: '\"' + digest + '\"'
  }, {
    width: 960,
    height: 960,
    requireEtag: true
  }), []);
  assert.match(
    validateMarketImage(png(512, 512), { 'content-type': 'text/plain' }, {
      width: 960,
      height: 960,
      requireEtag: true
    }).join(' '),
    /content-type.*width.*height.*ETag/
  );
  assert.throws(() => parsePngDimensions(valid.subarray(0, 33)), /IEND|valid PNG/);
  const headerOnly = Buffer.concat([valid.subarray(0, 33), pngChunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => parsePngDimensions(headerOnly), /missing image data/);
});

test('Miner metadata validates exact identity, schema, URLs, and initial state', () => {
  const valid = minerMetadata(77);
  assert.deepEqual(validateMinerMetadata(valid, 77, {
    expectedPublicOrigin: 'http://localhost:4173/',
    expectInitialState: true
  }), []);

  const invalid = structuredClone(valid);
  invalid.name = 'Wrong Miner';
  invalid.external_url = 'http://localhost:4173/?miner=78&unexpected=true';
  invalid.attributes.push(trait('Armor', 'Duplicate'));
  invalid.attributes.find((entry) => entry.trait_type === 'Level').value = 2;
  const errors = validateMinerMetadata(invalid, 77, {
    expectedPublicOrigin: 'http://localhost:4173/',
    expectInitialState: true
  }).join(' ');
  assert.match(errors, /Name must be/);
  assert.match(errors, /external_url must identify only Miner #77/);
  assert.match(errors, /Duplicate trait_type: Armor/);
  assert.match(errors, /Level expected 1/);
});

test('Collection metadata validates both collection identities', () => {
  assert.deepEqual(validateCollectionMetadata({
    name: 'MATT Mine Miners',
    description: 'Fixed collection.',
    image: 'https://mattmine.com/assets/nft/miner.png',
    external_link: 'https://mattmine.com/'
  }, '/api/nft/v2/contracts/miners.json'), []);
  assert.match(
    validateCollectionMetadata({
      name: 'Wrong',
      description: '',
      image: 'javascript:alert(1)',
      external_link: ''
    }, '/api/nft/v2/contracts/equipment.json').join(' '),
    /description.*HTTPS.*external_link.*Equipment collection/
  );
});

test('Bulk marketplace validation checks every metadata and image response', async () => {
  const imageBody = png();
  const collectionImage = png(1254, 1254);
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.pathname);
    if (url.pathname === '/api/nft/v2/contracts/miners.json') {
      return jsonResponse({
        name: 'MATT Mine Miners',
        description: 'Fixed collection.',
        image: 'http://localhost:4173/assets/nft/miner.png',
        external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname === '/api/nft/v2/contracts/equipment.json') {
      return jsonResponse({
        name: 'MATT Mine Equipment',
        description: 'Equipment collection.',
        image: 'http://localhost:4173/assets/nft/equipment.png',
        external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname.startsWith('/assets/nft/')) {
      return imageResponse(collectionImage, false);
    }
    const metadataMatch = url.pathname.match(/^\/api\/nft\/v2\/miners\/(\d+)\.json$/);
    if (metadataMatch) return jsonResponse(minerMetadata(Number(metadataMatch[1])));
    if (/^\/api\/nft\/v2\/miners\/\d+\/image\.png$/.test(url.pathname)) {
      return imageResponse(imageBody, true);
    }
    return new Response('missing', { status: 404 });
  };

  const report = await validateMarketplace({
    origin: 'http://localhost:4173',
    expectedPublicOrigin: 'http://localhost:4173',
    from: 1,
    to: 3,
    concurrency: 2,
    retries: 0,
    expectInitialState: true,
    fetchImpl
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.summary, {
    errors: 0,
    warnings: 0,
    collectionsValidated: 2,
    tokensValidated: 3,
    imagesValidated: 5,
    chainTokensValidated: 0,
    chainMetadataValidated: 0,
    chainId: null
  });
  assert.deepEqual(report.validationScope, {
    images: true,
    chain: false,
    initialState: true,
    salesWallet: false,
    tokenUriOrigin: 'http://localhost:4173/'
  });
  assert.equal(calls.filter((path) => path.endsWith('.json')).length, 5);
  assert.equal(calls.filter((path) => path.endsWith('image.png')).length, 3);
});

test('Bulk validation records per-token failures and returns a failing report', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname.includes('/contracts/miners')) {
      return jsonResponse({
        name: 'MATT Mine Miners',
        description: 'Fixed collection.',
        image: 'http://localhost:4173/assets/nft/miner.png',
        external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname.includes('/contracts/equipment')) {
      return jsonResponse({
        name: 'MATT Mine Equipment',
        description: 'Equipment.',
        image: 'http://localhost:4173/assets/nft/equipment.png',
        external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname.startsWith('/assets/nft/')) return imageResponse(png(1254, 1254), false);
    if (url.pathname.endsWith('/1.json')) return jsonResponse({ name: 'broken' });
    return new Response('missing', { status: 404 });
  };

  const report = await validateMarketplace({
    origin: 'http://localhost:4173',
    from: 1,
    to: 1,
    retries: 0,
    skipImages: true,
    fetchImpl
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => entry.scope === 'miner'));
  assert.ok(report.errors.some((entry) => /attributes|Description|image/.test(entry.message)));
});

test('Chain inventory validation matches final URIs and never exposes RPC credentials', async () => {
  const owner = '0x3333333333333333333333333333333333333333';
  const expectedOwner = '0x2222222222222222222222222222222222222222';
  const publicClient = {
    async getChainId() { return 2020; },
    async readContract({ functionName }) {
      if (functionName === 'MAX_SUPPLY') return 1_000n;
      if (functionName === 'nextTokenId') return 2n;
      if (functionName === 'contractURI') {
        return 'https://matt-mine.onrender.com/api/nft/v2/contracts/miners.json';
      }
      throw new Error('Unexpected read: ' + functionName);
    },
    async multicall() {
      return [
        { status: 'success', result: owner },
        { status: 'success', result: 'https://matt-mine.onrender.com/api/nft/v2/miners/1.json?v=1' },
        {
          status: 'success',
          result: {
            bankedXp: 0n,
            baseHealth: 50,
            pickaxeAttack: 15,
            blasterAttack: 5,
            dynamiteAttack: 20,
            healAmount: 10,
            baseCarryCapacity: 750,
            deathRetentionBps: 1_000,
            level: 1,
            evolution: 0,
            crystalsPerHour: 0,
            lastVerifiedPlay: 0,
            activeUntil: 0,
            cphAssignedAt: 0,
            earningStatus: 0,
            runLocked: false
          }
        }
      ];
    }
  };
  const exactMetadata = minerMetadata(1);
  exactMetadata.image = 'https://mattmine.com/api/nft/v2/miners/1/image.png?v=0123456789abcdef';
  exactMetadata.external_url = 'https://mattmine.com/?miner=1';
  const result = await validateChainInventory({
    rpcUrl: 'https://rpc.example/private-key?token=secret',
    minerAddress: '0x1111111111111111111111111111111111111111',
    salesWallet: expectedOwner,
    expectedPublicOrigin: 'https://mattmine.com',
    expectedTokenUriOrigin: 'https://matt-mine.onrender.com',
    from: 1,
    to: 1,
    expectInitialState: true,
    fetchImpl: async () => jsonResponse(exactMetadata),
    publicClient
  });
  assert.equal(result.tokensValidated, 1);
  assert.equal(result.metadataValidated, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'owner_mismatch');
  assert.equal(result.errors[0].url, 'https://rpc.example');
  assert.doesNotMatch(JSON.stringify(result), /private-key|secret/);
});

test('Bulk validation never follows metadata-controlled image origins or redirects', async () => {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    calls.push(url.href);
    if (url.pathname === '/api/nft/v2/contracts/miners.json') {
      return jsonResponse({
        name: 'MATT Mine Miners', description: 'Collection.',
        image: 'https://attacker.invalid/private', external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname === '/api/nft/v2/contracts/equipment.json') {
      return jsonResponse({
        name: 'MATT Mine Equipment', description: 'Collection.',
        image: 'http://localhost:4173/redirect.png', external_link: 'http://localhost:4173/'
      });
    }
    if (url.pathname === '/redirect.png') {
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    }
    if (url.pathname.endsWith('/1.json')) {
      const metadata = minerMetadata(1);
      metadata.image = 'https://attacker.invalid/miner.png';
      return jsonResponse(metadata);
    }
    return new Response('missing', { status: 404 });
  };

  const report = await validateMarketplace({
    origin: 'http://localhost:4173', from: 1, to: 1, retries: 0, fetchImpl
  });
  assert.equal(report.ok, false);
  assert.equal(calls.some((url) => url.startsWith('https://attacker.invalid')), false);
  assert.equal(calls.some((url) => url.startsWith('http://169.254.169.254')), false);
  assert.ok(report.errors.some((entry) => /origin must be/.test(entry.message)));
  assert.ok(report.errors.some((entry) => /Redirect HTTP 302/.test(entry.message)));
});

test('Marketplace validation rejects oversized metadata before buffering it', async () => {
  const fetchImpl = async () => new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'content-length': String(129 * 1024)
    }
  });
  const report = await validateMarketplace({
    origin: 'http://localhost:4173', from: 1, to: 1, retries: 0, skipImages: true, fetchImpl
  });
  assert.equal(report.ok, false);
  assert.ok(report.errors.every((entry) => /exceeds 131072 bytes/.test(entry.message)));
});

test('Chain validation rejects the wrong network before reading inventory', async () => {
  let reads = 0;
  await assert.rejects(() => validateChainInventory({
    rpcUrl: 'https://rpc.example/key',
    minerAddress: '0x1111111111111111111111111111111111111111',
    from: 1,
    to: 1,
    publicClient: {
      async getChainId() { return 202601; },
      async readContract() { reads += 1; return 0n; }
    }
  }), /chain ID 2020/);
  assert.equal(reads, 0);
});

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function imageResponse(body, etag) {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'image/png',
      ...(etag ? { etag: '\"' + createHash('sha256').update(body).digest('hex') + '\"' } : {})
    }
  });
}
