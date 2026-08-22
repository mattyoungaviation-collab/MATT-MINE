import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi
} from 'viem';
import { ronin } from 'viem/chains';

const COLLECTION_PATHS = Object.freeze([
  '/api/nft/v2/contracts/miners.json',
  '/api/nft/v2/contracts/equipment.json'
]);
const REQUIRED_MINER_TRAITS = Object.freeze([
  'Level',
  'Evolution',
  'Banked XP',
  'Base Health',
  'Maximum Health',
  'Armor Shield',
  'Pickaxe Attack',
  'Blaster Attack',
  'Dynamite Attack',
  'Heal',
  'Crystal Carry Capacity',
  'Crystal Death Retention',
  'Crystals Per Hour',
  'Earning Status',
  'Pickaxe',
  'Blaster',
  'Dynamite',
  'Backpack',
  'Helmet',
  'Armor',
  'Armor State'
]);
const NUMERIC_MINER_TRAITS = new Set([
  'Banked XP',
  'Base Health',
  'Maximum Health',
  'Armor Shield',
  'Pickaxe Attack',
  'Blaster Attack',
  'Dynamite Attack',
  'Heal',
  'Crystal Carry Capacity',
  'Crystals Per Hour'
]);
const INITIAL_TRAITS = Object.freeze({
  'Level': 1,
  'Evolution': 'Rookie Miner',
  'Banked XP': 0,
  'Base Health': 50,
  'Maximum Health': 50,
  'Armor Shield': 0,
  'Pickaxe Attack': 15,
  'Blaster Attack': 5,
  'Dynamite Attack': 20,
  'Heal': 10,
  'Crystal Carry Capacity': 750,
  'Crystal Death Retention': '10%',
  'Crystals Per Hour': 0,
  'Earning Status': 'Not Eligible',
  'Pickaxe': 'Starter Pickaxe',
  'Blaster': 'None',
  'Dynamite': 'None',
  'Backpack': 'None',
  'Helmet': 'None',
  'Armor': 'None',
  'Armor State': 'None'
});
const MINER_ABI = parseAbi([
  'function MAX_SUPPLY() view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'function contractURI() view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function traitsOf(uint256 tokenId) view returns ((uint128 bankedXp,uint16 baseHealth,uint16 pickaxeAttack,uint16 blasterAttack,uint16 dynamiteAttack,uint16 healAmount,uint16 baseCarryCapacity,uint16 deathRetentionBps,uint8 level,uint8 evolution,uint8 crystalsPerHour,uint40 lastVerifiedPlay,uint40 activeUntil,uint40 cphAssignedAt,uint8 earningStatus,bool runLocked))'
]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_MARKET_IMAGE_BYTES = 1_000_000;
const RONIN_MAINNET_CHAIN_ID = 2_020;
const EVOLUTION_NAMES = Object.freeze([
  'Rookie Miner',
  'Apprentice Miner',
  'Crystal Hunter',
  'Veteran Miner',
  'Vault Raider',
  'Elite Miner',
  'Mine Legend'
]);
const EARNING_STATUS_NAMES = Object.freeze(['Not Eligible', 'Earning', 'Inactive']);
const PNG_COLOR_CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });
const PNG_BIT_DEPTHS = Object.freeze({
  0: new Set([1, 2, 4, 8, 16]),
  2: new Set([8, 16]),
  3: new Set([1, 2, 4, 8]),
  4: new Set([8, 16]),
  6: new Set([8, 16])
});
const CRC32_TABLE = createCrc32Table();

export function parsePngDimensions(input) {
  const body = Buffer.from(input);
  if (body.length < 45 || !body.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Image is not a valid PNG.');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = -1;
  let chunkIndex = 0;
  let foundHeader = false;
  let foundPalette = false;
  let foundImageData = false;
  let foundEnd = false;
  let imageDataEnded = false;
  const imageDataChunks = [];
  while (offset + 12 <= body.length) {
    const chunkLength = body.readUInt32BE(offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (chunkEnd > body.length) throw new Error('PNG contains a truncated chunk.');
    const typeBytes = body.subarray(offset + 4, offset + 8);
    const chunkType = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(chunkType)) throw new Error('PNG contains an invalid chunk type.');
    const chunkData = body.subarray(offset + 8, offset + 8 + chunkLength);
    const expectedCrc = body.readUInt32BE(offset + 8 + chunkLength);
    const actualCrc = crc32(Buffer.concat([typeBytes, chunkData]));
    if (actualCrc !== expectedCrc) throw new Error('PNG contains an invalid ' + chunkType + ' checksum.');

    if (chunkIndex === 0 && chunkType !== 'IHDR') throw new Error('PNG is missing its IHDR header.');
    if (chunkType === 'IHDR') {
      if (foundHeader || chunkIndex !== 0 || chunkLength !== 13) throw new Error('PNG has an invalid IHDR chunk.');
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      const compression = chunkData[10];
      const filter = chunkData[11];
      interlace = chunkData[12];
      if (!width || !height) throw new Error('PNG dimensions must be positive.');
      if (width > 4096 || height > 4096) {
        throw new Error('PNG dimensions exceed the 4096px validation ceiling.');
      }
      if (!PNG_BIT_DEPTHS[colorType]?.has(bitDepth)) throw new Error('PNG has an invalid color type or bit depth.');
      if (compression !== 0 || filter !== 0 || ![0, 1].includes(interlace)) {
        throw new Error('PNG uses unsupported header methods.');
      }
      foundHeader = true;
    } else if (!foundHeader) {
      throw new Error('PNG is missing its IHDR header.');
    } else if (chunkType === 'PLTE') {
      if (foundImageData || chunkLength === 0 || chunkLength % 3 !== 0 || chunkLength > 768) {
        throw new Error('PNG has an invalid PLTE chunk.');
      }
      foundPalette = true;
    } else if (chunkType === 'IDAT') {
      if (imageDataEnded) throw new Error('PNG IDAT chunks must be consecutive.');
      foundImageData = true;
      imageDataChunks.push(chunkData);
    } else if (foundImageData) {
      imageDataEnded = true;
    }
    if (chunkType === 'IEND') {
      if (chunkLength !== 0 || chunkEnd !== body.length) {
        throw new Error('PNG has an invalid IEND chunk.');
      }
      foundEnd = true;
      break;
    }
    chunkIndex += 1;
    offset = chunkEnd;
  }
  if (!foundHeader) throw new Error('PNG is missing its IHDR header.');
  if (colorType === 3 && !foundPalette) throw new Error('Indexed PNG is missing its PLTE chunk.');
  if (!foundImageData || imageDataChunks.every((chunk) => chunk.length === 0)) {
    throw new Error('PNG is missing image data.');
  }
  if (!foundEnd) throw new Error('PNG is missing its IEND chunk.');
  validateInflatedPngData(imageDataChunks, { width, height, bitDepth, colorType, interlace });
  return { width, height };
}

function validateInflatedPngData(imageDataChunks, header) {
  const bitsPerPixel = PNG_COLOR_CHANNELS[header.colorType] * header.bitDepth;
  const passes = header.interlace === 0
    ? [[0, 0, 1, 1]]
    : [
        [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]
      ];
  const rows = [];
  let expectedLength = 0;
  for (const [xStart, yStart, xStep, yStep] of passes) {
    const passWidth = header.width <= xStart ? 0 : Math.ceil((header.width - xStart) / xStep);
    const passHeight = header.height <= yStart ? 0 : Math.ceil((header.height - yStart) / yStep);
    if (!passWidth || !passHeight) continue;
    const rowBytes = Math.ceil(passWidth * bitsPerPixel / 8);
    expectedLength += passHeight * (rowBytes + 1);
    rows.push({ passHeight, rowBytes });
  }

  let inflated;
  try {
    inflated = inflateSync(Buffer.concat(imageDataChunks), { maxOutputLength: expectedLength + 1 });
  } catch {
    throw new Error('PNG image data is not valid zlib data.');
  }
  if (inflated.length !== expectedLength) {
    throw new Error('PNG image data length does not match its dimensions.');
  }
  let offset = 0;
  for (const { passHeight, rowBytes } of rows) {
    for (let row = 0; row < passHeight; row += 1) {
      if (inflated[offset] > 4) throw new Error('PNG contains an invalid scanline filter.');
      offset += rowBytes + 1;
    }
  }
}

function createCrc32Table() {
  return Uint32Array.from({ length: 256 }, (_value, index) => {
    let checksum = index;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = checksum & 1 ? 0xedb88320 ^ (checksum >>> 1) : checksum >>> 1;
    }
    return checksum >>> 0;
  });
}

function crc32(input) {
  let checksum = 0xffffffff;
  for (const byte of input) {
    checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  }
  return (checksum ^ 0xffffffff) >>> 0;
}

export function validateMinerMetadata(metadata, minerId, options = {}) {
  const errors = [];
  if (!isRecord(metadata)) return ['Metadata must be a JSON object.'];
  if (metadata.name !== 'MATT Mine Miner #' + minerId) {
    errors.push('Name must be MATT Mine Miner #' + minerId + '.');
  }
  if (!nonempty(metadata.description)) errors.push('Description is missing.');
  if (!/^[0-9A-F]{6}$/i.test(String(metadata.background_color || ''))) {
    errors.push('background_color must be a six-character hex value without #.');
  }
  validateUrlField(metadata.image, 'image', errors, {
    expectedOrigin: options.expectedPublicOrigin,
    pathname: '/api/nft/v2/miners/' + minerId + '/image.png'
  });
  try {
    const imageUrl = new URL(String(metadata.image || ''));
    if (!/^[a-f0-9]{8,64}$/i.test(imageUrl.searchParams.get('v') || '')
        || [...imageUrl.searchParams.keys()].some((key) => key !== 'v')) {
      errors.push('image must carry only a hexadecimal render revision.');
    }
  } catch {
    // validateUrlField reports the malformed URL.
  }
  validateUrlField(metadata.external_url, 'external_url', errors, {
    expectedOrigin: options.expectedPublicOrigin,
    pathname: '/'
  });
  try {
    const externalUrl = new URL(String(metadata.external_url || ''));
    if (externalUrl.searchParams.get('miner') !== String(minerId)
        || [...externalUrl.searchParams.keys()].some((key) => key !== 'miner')) {
      errors.push('external_url must identify only Miner #' + minerId + '.');
    }
  } catch {
    // validateUrlField reports the malformed URL.
  }

  if (!Array.isArray(metadata.attributes)) {
    errors.push('attributes must be an array.');
    return errors;
  }
  const traits = new Map();
  for (const attribute of metadata.attributes) {
    const name = String(attribute?.trait_type || '');
    if (!name) {
      errors.push('Every attribute needs trait_type.');
      continue;
    }
    if (traits.has(name)) errors.push('Duplicate trait_type: ' + name + '.');
    traits.set(name, attribute);
  }
  for (const name of REQUIRED_MINER_TRAITS) {
    const attribute = traits.get(name);
    if (!attribute) {
      errors.push('Missing trait: ' + name + '.');
      continue;
    }
    if (name === 'Level') {
      if (!Number.isSafeInteger(attribute.value) || attribute.value < 1 || attribute.value > 100) {
        errors.push('Level must be a safe integer from 1 to 100.');
      }
    } else if (NUMERIC_MINER_TRAITS.has(name)) {
      if (attribute.display_type !== 'number') {
        errors.push(name + ' must use display_type number.');
      }
      if (!Number.isSafeInteger(attribute.value) || attribute.value < 0) {
        errors.push(name + ' must be a safe non-negative integer.');
      }
    } else if (!nonempty(attribute.value)) {
      errors.push(name + ' must have a non-empty value.');
    }
  }
  if (options.expectInitialState === true) {
    for (const [name, expected] of Object.entries(INITIAL_TRAITS)) {
      const actual = traits.get(name)?.value;
      if (actual !== expected) {
        errors.push(name + ' expected ' + JSON.stringify(expected) + ', received ' + JSON.stringify(actual) + '.');
      }
    }
  }
  return errors;
}

export function validateCollectionMetadata(metadata, path, options = {}) {
  const errors = [];
  if (!isRecord(metadata)) return ['Collection metadata must be a JSON object.'];
  if (!nonempty(metadata.name)) errors.push('Collection name is missing.');
  if (!nonempty(metadata.description)) errors.push('Collection description is missing.');
  validateUrlField(metadata.image, 'image', errors, {
    expectedOrigin: options.expectedPublicOrigin
  });
  validateUrlField(metadata.external_link, 'external_link', errors, {
    expectedOrigin: options.expectedPublicOrigin
  });
  if (path.includes('miners') && metadata.name !== 'MATT Mine Miners') {
    errors.push('Miner collection name is unexpected.');
  }
  if (path.includes('equipment') && metadata.name !== 'MATT Mine Equipment') {
    errors.push('Equipment collection name is unexpected.');
  }
  return errors;
}

export function validateMarketImage(input, headers = {}, options = {}) {
  const errors = [];
  const body = Buffer.from(input);
  const contentType = headerValue(headers, 'content-type');
  if (!/^image\/png(?:;|$)/i.test(contentType)) errors.push('Image content-type must be image/png.');
  if (!body.length) errors.push('Image body is empty.');
  if (body.length >= MAX_MARKET_IMAGE_BYTES) {
    errors.push('Image must be below the 1,000,000-byte marketplace limit.');
  }
  try {
    const dimensions = parsePngDimensions(body);
    if (options.width && dimensions.width !== options.width) {
      errors.push('Image width must be ' + options.width + 'px, received ' + dimensions.width + 'px.');
    }
    if (options.height && dimensions.height !== options.height) {
      errors.push('Image height must be ' + options.height + 'px, received ' + dimensions.height + 'px.');
    }
    if (dimensions.width > 4096 || dimensions.height > 4096) {
      errors.push('Image dimensions exceed the 4096px validation ceiling.');
    }
  } catch (error) {
    errors.push(error.message);
  }
  if (options.requireEtag === true) {
    const etag = headerValue(headers, 'etag');
    const match = etag.match(/^(?:W\/)?\"([a-f0-9]{64})\"$/i);
    if (!match) {
      errors.push('Image ETag must contain a SHA-256 digest.');
    } else {
      const actualDigest = createHash('sha256').update(body).digest('hex');
      if (match[1].toLowerCase() !== actualDigest) {
        errors.push('Image ETag SHA-256 digest does not match the response body.');
      }
    }
  }
  return errors;
}

export async function validateMarketplace(input = {}) {
  const options = normalizedOptions(input);
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    target: options.origin,
    publicOrigin: options.expectedPublicOrigin || null,
    tokenRange: { from: options.from, to: options.to },
    expectInitialState: options.expectInitialState,
    collectionsValidated: 0,
    tokensValidated: 0,
    imagesValidated: 0,
    chainTokensValidated: 0,
    chainMetadataValidated: 0,
    chainId: null,
    validationScope: {
      images: !options.skipImages,
      chain: Boolean(options.rpcUrl && options.minerAddress),
      initialState: options.expectInitialState,
      salesWallet: Boolean(options.salesWallet),
      tokenUriOrigin: options.expectedTokenUriOrigin
    },
    errors: [],
    warnings: []
  };
  const names = new Set();
  const metadataById = new Map();

  await mapLimit(COLLECTION_PATHS, 2, async (path) => {
    const url = new URL(path, options.origin).href;
    try {
      const metadata = await readJson(url, options);
      pushIssues(report.errors, 'collection', path, url, validateCollectionMetadata(metadata, path, options));
      report.collectionsValidated += 1;
      if (!options.skipImages && nonempty(metadata.image) && allowedAssetUrl(metadata.image, options)) {
        const image = await readImage(metadata.image, options, {});
        pushIssues(report.errors, 'collection-image', path, metadata.image, image.errors);
        report.imagesValidated += 1;
      }
    } catch (error) {
      report.errors.push(issue('collection', path, url, 'collection_unreachable', error.message));
    }
  });

  const ids = Array.from(
    { length: options.to - options.from + 1 },
    (_value, index) => options.from + index
  );
  await mapLimit(ids, options.concurrency, async (minerId) => {
    const path = '/api/nft/v2/miners/' + minerId + '.json';
    const url = new URL(path, options.origin).href;
    try {
      const metadata = await readJson(url, options);
      const metadataErrors = validateMinerMetadata(metadata, minerId, options);
      pushIssues(report.errors, 'miner', minerId, url, metadataErrors);
      metadataById.set(minerId, metadata);
      if (names.has(metadata.name)) {
        report.errors.push(issue('miner', minerId, url, 'duplicate_name', 'Duplicate token name: ' + metadata.name + '.'));
      }
      names.add(metadata.name);
      report.tokensValidated += 1;
      if (!options.skipImages && nonempty(metadata.image) && allowedAssetUrl(metadata.image, options)) {
        const image = await readImage(metadata.image, options, {
          width: 960,
          height: 960,
          requireEtag: true
        });
        pushIssues(report.errors, 'miner-image', minerId, metadata.image, image.errors);
        report.imagesValidated += 1;
      }
    } catch (error) {
      report.errors.push(issue('miner', minerId, url, 'miner_unreachable', error.message));
    }
  });

  if (options.rpcUrl || options.minerAddress) {
    try {
      const chain = await validateChainInventory({ ...options, metadataById });
      report.chainTokensValidated = chain.tokensValidated;
      report.chainMetadataValidated = chain.metadataValidated;
      report.chainId = chain.chainId;
      report.errors.push(...chain.errors);
      report.warnings.push(...chain.warnings);
    } catch (error) {
      report.errors.push(issue(
        'chain',
        'inventory',
        safeEndpointLabel(options.rpcUrl),
        'chain_validation_failed',
        'Ronin Mainnet inventory validation failed. Verify the RPC network, credentials, and contract address.'
      ));
    }
  }
  report.completedAt = new Date().toISOString();
  report.ok = report.errors.length === 0;
  report.summary = {
    errors: report.errors.length,
    warnings: report.warnings.length,
    collectionsValidated: report.collectionsValidated,
    tokensValidated: report.tokensValidated,
    imagesValidated: report.imagesValidated,
    chainTokensValidated: report.chainTokensValidated,
    chainMetadataValidated: report.chainMetadataValidated,
    chainId: report.chainId
  };
  return report;
}

export async function validateChainInventory(input = {}) {
  const options = normalizedOptions({
    ...input,
    origin: input.origin || input.expectedTokenUriOrigin || input.expectedPublicOrigin || 'https://mattmine.com'
  });
  if (!options.rpcUrl || !options.minerAddress) {
    throw new Error('Both rpcUrl and minerAddress are required for chain validation.');
  }
  const address = getAddress(options.minerAddress);
  const client = input.publicClient || createPublicClient({
    chain: ronin,
    transport: http(options.rpcUrl, { timeout: options.timeoutMs })
  });
  const errors = [];
  const warnings = [];
  const chainSource = safeEndpointLabel(options.rpcUrl);
  const chainId = Number(await client.getChainId());
  if (chainId !== RONIN_MAINNET_CHAIN_ID) {
    throw new Error('RPC must be connected to Ronin Mainnet chain ID ' + RONIN_MAINNET_CHAIN_ID + '.');
  }
  const [maximumSupply, nextTokenId, contractUri] = await Promise.all([
    client.readContract({ address, abi: MINER_ABI, functionName: 'MAX_SUPPLY' }),
    client.readContract({ address, abi: MINER_ABI, functionName: 'nextTokenId' }),
    client.readContract({ address, abi: MINER_ABI, functionName: 'contractURI' })
  ]);
  if (maximumSupply !== 1_000n) {
    errors.push(issue('chain', 'MAX_SUPPLY', chainSource, 'supply_mismatch', 'MAX_SUPPLY is not 1,000.'));
  }
  if (options.from === 1 && options.to === 1_000 && nextTokenId !== 1_001n) {
    errors.push(issue('chain', 'nextTokenId', chainSource, 'inventory_incomplete', 'nextTokenId is not 1,001.'));
  }
  const contractUriErrors = [];
  validateUrlField(contractUri, 'contractURI', contractUriErrors, {
    expectedOrigin: options.expectedTokenUriOrigin,
    pathname: '/api/nft/v2/contracts/miners.json'
  });
  pushIssues(errors, 'chain', 'contractURI', contractUri, contractUriErrors);

  let tokensValidated = 0;
  let metadataValidated = 0;
  for (let start = options.from; start <= options.to; start += 50) {
    const ids = Array.from(
      { length: Math.min(50, options.to - start + 1) },
      (_value, index) => start + index
    );
    const calls = ids.flatMap((minerId) => [
      { address, abi: MINER_ABI, functionName: 'ownerOf', args: [BigInt(minerId)] },
      { address, abi: MINER_ABI, functionName: 'tokenURI', args: [BigInt(minerId)] },
      { address, abi: MINER_ABI, functionName: 'traitsOf', args: [BigInt(minerId)] }
    ]);
    const results = await client.multicall({ allowFailure: true, contracts: calls });
    const width = 3;
    await mapLimit(ids, options.concurrency, async (minerId, index) => {
      const ownerResult = results[index * width];
      const uriResult = results[index * width + 1];
      const traitResult = results[index * width + 2];
      if (ownerResult.status !== 'success') {
        errors.push(issue('chain-miner', minerId, chainSource, 'owner_read_failed', 'ownerOf failed.'));
      } else if (options.salesWallet && getAddress(ownerResult.result) !== getAddress(options.salesWallet)) {
        errors.push(issue('chain-miner', minerId, chainSource, 'owner_mismatch', 'Owner does not match the expected inventory wallet.'));
      }
      let exactMetadata = null;
      if (uriResult.status !== 'success') {
        errors.push(issue('chain-miner', minerId, chainSource, 'token_uri_read_failed', 'tokenURI failed.'));
      } else {
        const uriErrors = validateTokenUri(uriResult.result, minerId, options.expectedTokenUriOrigin);
        pushIssues(errors, 'chain-miner', minerId, uriResult.result, uriErrors);
        if (uriErrors.length === 0) {
          try {
            exactMetadata = await readJson(uriResult.result, options);
            metadataValidated += 1;
            pushIssues(errors, 'chain-metadata', minerId, uriResult.result, validateMinerMetadata(exactMetadata, minerId, options));
            const canonicalMetadata = options.metadataById?.get?.(minerId);
            if (canonicalMetadata && stableJson(canonicalMetadata) !== stableJson(exactMetadata)) {
              errors.push(issue('chain-metadata', minerId, uriResult.result, 'token_metadata_mismatch', 'The exact tokenURI response differs from the canonical metadata response.'));
            }
          } catch (error) {
            errors.push(issue('chain-metadata', minerId, uriResult.result, 'token_metadata_unreachable', error.message));
          }
        }
      }
      if (traitResult.status !== 'success') {
        errors.push(issue('chain-miner', minerId, chainSource, 'traits_read_failed', 'traitsOf failed.'));
      } else {
        if (options.expectInitialState) {
          pushIssues(errors, 'chain-miner', minerId, chainSource, validateInitialChainTraits(traitResult.result));
        }
        if (exactMetadata) {
          pushIssues(errors, 'chain-metadata', minerId, uriResult.result, validateMetadataAgainstChainTraits(exactMetadata, traitResult.result));
        }
      }
      tokensValidated += 1;
    });
  }
  if (!options.salesWallet && options.expectInitialState) {
    warnings.push(issue('chain', 'salesWallet', chainSource, 'sales_wallet_not_checked', 'No sales wallet was supplied; owner equality was not checked.'));
  }
  return { chainId, tokensValidated, metadataValidated, errors, warnings };
}

function validateInitialChainTraits(value) {
  const names = [
    'bankedXp', 'baseHealth', 'pickaxeAttack', 'blasterAttack', 'dynamiteAttack',
    'healAmount', 'baseCarryCapacity', 'deathRetentionBps', 'level', 'evolution',
    'crystalsPerHour', 'lastVerifiedPlay', 'activeUntil', 'cphAssignedAt',
    'earningStatus', 'runLocked'
  ];
  const traits = Object.fromEntries(names.map((name, index) => [name, value[name] ?? value[index]]));
  const expected = {
    bankedXp: 0n,
    baseHealth: 50,
    pickaxeAttack: 15,
    blasterAttack: 5,
    dynamiteAttack: 20,
    healAmount: 10,
    baseCarryCapacity: 750,
    deathRetentionBps: 1000,
    level: 1,
    evolution: 0,
    crystalsPerHour: 0,
    lastVerifiedPlay: 0,
    activeUntil: 0,
    cphAssignedAt: 0,
    earningStatus: 0,
    runLocked: false
  };
  const errors = [];
  for (const [name, expectedValue] of Object.entries(expected)) {
    const actual = typeof traits[name] === 'bigint' ? traits[name] : traits[name];
    if (typeof expectedValue === 'bigint') {
      if (BigInt(actual) !== expectedValue) errors.push('Initial chain trait mismatch: ' + name + '.');
    } else if (actual !== expectedValue && Number(actual) !== expectedValue) {
      errors.push('Initial chain trait mismatch: ' + name + '.');
    }
  }
  return errors;
}

function validateMetadataAgainstChainTraits(metadata, value) {
  const names = [
    'bankedXp', 'baseHealth', 'pickaxeAttack', 'blasterAttack', 'dynamiteAttack',
    'healAmount', 'baseCarryCapacity', 'deathRetentionBps', 'level', 'evolution',
    'crystalsPerHour', 'lastVerifiedPlay', 'activeUntil', 'cphAssignedAt',
    'earningStatus', 'runLocked'
  ];
  const chainTraits = Object.fromEntries(names.map((name, index) => [name, value[name] ?? value[index]]));
  const metadataTraits = new Map((metadata.attributes || []).map((attribute) => [attribute.trait_type, attribute.value]));
  const expected = {
    'Level': Number(chainTraits.level),
    'Evolution': EVOLUTION_NAMES[Number(chainTraits.evolution)],
    'Banked XP': Number(chainTraits.bankedXp),
    'Base Health': Number(chainTraits.baseHealth),
    'Heal': Number(chainTraits.healAmount),
    'Crystal Death Retention': Number(chainTraits.deathRetentionBps) / 100 + '%',
    'Crystals Per Hour': Number(chainTraits.crystalsPerHour),
    'Earning Status': EARNING_STATUS_NAMES[Number(chainTraits.earningStatus)]
  };
  const errors = [];
  for (const [name, expectedValue] of Object.entries(expected)) {
    const actual = metadataTraits.get(name);
    if (actual !== expectedValue) {
      errors.push(name + ' does not match the authoritative traitsOf value.');
    }
  }
  return errors;
}

function stableJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isRecord(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function validateTokenUri(value, minerId, expectedTokenUriOrigin) {
  const errors = [];
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') errors.push('tokenURI must use HTTPS.');
    if (expectedTokenUriOrigin && url.origin !== new URL(expectedTokenUriOrigin).origin) {
      errors.push('tokenURI origin must be ' + new URL(expectedTokenUriOrigin).origin + '.');
    }
    if (url.pathname !== '/api/nft/v2/miners/' + minerId + '.json') {
      errors.push('tokenURI path does not match Miner #' + minerId + '.');
    }
    if (!/^\d+$/.test(url.searchParams.get('v') || '')) {
      errors.push('tokenURI must carry a numeric metadata revision.');
    }
    if ([...url.searchParams.keys()].some((key) => key !== 'v') || url.hash) {
      errors.push('tokenURI must carry only its numeric metadata revision.');
    }
  } catch {
    errors.push('tokenURI is not a valid absolute URL.');
  }
  return errors;
}

async function readJson(url, options) {
  const response = await fetchWithRetry(url, options, {
    headers: { accept: 'application/json' }
  });
  if (!response.ok) throw new Error('HTTP ' + response.status + '.');
  const contentType = response.headers.get('content-type') || '';
  if (!/^application\/json(?:;|$)/i.test(contentType)) {
    throw new Error('Expected application/json, received ' + (contentType || 'no content-type') + '.');
  }
  const body = (await readResponseBody(response, MAX_METADATA_BYTES, 'Metadata')).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('Response is not valid JSON.');
  }
}

async function readImage(url, options, validationOptions) {
  const response = await fetchWithRetry(url, options, {
    headers: { accept: 'image/png' }
  });
  if (!response.ok) return { errors: ['Image returned HTTP ' + response.status + '.'] };
  const body = await readResponseBody(response, MAX_MARKET_IMAGE_BYTES, 'Image');
  return { errors: validateMarketImage(body, response.headers, validationOptions) };
}

async function readResponseBody(response, maximumBytes, label) {
  const declaredLength = Number(response.headers?.get?.('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error(label + ' exceeds ' + maximumBytes + ' bytes.');
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(label + ' exceeds ' + maximumBytes + ' bytes.');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > maximumBytes) throw new Error(label + ' exceeds ' + maximumBytes + ' bytes.');
  return body;
}

async function fetchWithRetry(url, options, init) {
  let lastError;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetchImpl(url, {
        ...init,
        redirect: 'manual',
        signal: controller.signal
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error('Redirect HTTP ' + response.status + ' is not allowed.');
      }
      if (response.status >= 500 && attempt < options.retries) {
        throw new Error('HTTP ' + response.status + '.');
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt >= options.retries) break;
      await delay(150 * (attempt + 1));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError?.name === 'AbortError'
    ? 'Request timed out after ' + options.timeoutMs + 'ms.'
    : String(lastError?.message || lastError || 'Request failed.'));
}

async function mapLimit(values, concurrency, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length || 1) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index], index);
    }
  });
  await Promise.all(workers);
}

function normalizedOptions(input) {
  const origin = normalizedOrigin(input.origin);
  const expectedPublicOrigin = input.expectedPublicOrigin
    ? normalizedOrigin(input.expectedPublicOrigin)
    : origin;
  const expectedTokenUriOrigin = input.expectedTokenUriOrigin
    ? normalizedOrigin(input.expectedTokenUriOrigin)
    : origin;
  const from = positiveInteger(input.from ?? 1, 'from');
  const to = positiveInteger(input.to ?? 1_000, 'to');
  if (from > to || to > 1_000) throw new Error('Token range must stay within 1-1000.');
  return {
    ...input,
    origin,
    expectedPublicOrigin,
    expectedTokenUriOrigin,
    from,
    to,
    concurrency: boundedInteger(input.concurrency ?? 8, 'concurrency', 1, 32),
    timeoutMs: boundedInteger(input.timeoutMs ?? 15_000, 'timeoutMs', 1_000, 120_000),
    retries: boundedInteger(input.retries ?? 2, 'retries', 0, 5),
    skipImages: input.skipImages === true,
    expectInitialState: input.expectInitialState === true,
    fetchImpl: input.fetchImpl || globalThis.fetch,
    rpcUrl: input.rpcUrl ? httpsUrl(input.rpcUrl, 'rpcUrl') : '',
    minerAddress: input.minerAddress || '',
    salesWallet: input.salesWallet || ''
  };
}

function normalizedOrigin(value) {
  const url = new URL(String(value || ''));
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Origin must use HTTPS, except for localhost validation.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.href;
}

function httpsUrl(value, label) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error(label + ' must use HTTPS.');
  return url.href;
}

function validateUrlField(value, label, errors, options = {}) {
  try {
    const url = new URL(String(value || ''));
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
      errors.push(label + ' must use HTTPS.');
    }
    if (options.expectedOrigin && url.origin !== new URL(options.expectedOrigin).origin) {
      errors.push(label + ' origin must be ' + new URL(options.expectedOrigin).origin + '.');
    }
    if (options.pathname && url.pathname !== options.pathname) {
      errors.push(label + ' path must be ' + options.pathname + '.');
    }
  } catch {
    errors.push(label + ' must be a valid absolute URL.');
  }
}

function allowedAssetUrl(value, options) {
  const errors = [];
  validateUrlField(value, 'asset', errors, {
    expectedOrigin: options.expectedPublicOrigin || options.origin
  });
  return errors.length === 0;
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers || {}).find((entry) => entry.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

function pushIssues(target, scope, id, url, messages) {
  for (const message of messages) target.push(issue(scope, id, url, 'validation_failed', message));
}

function issue(scope, id, url, code, message) {
  return { scope, id, url, code, message: String(message || '') };
}

function safeEndpointLabel(value) {
  try {
    return new URL(String(value || '')).origin;
  } catch {
    return 'ronin-rpc';
  }
}

function nonempty(value) {
  return typeof value === 'string' ? value.trim().length > 0 : value !== undefined && value !== null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value, label) {
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(label + ' must be an integer from ' + minimum + ' to ' + maximum + '.');
  }
  return number;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseCli(argumentsList, environment = process.env) {
  const result = {
    origin: environment.MATT_MINE_NFT_METADATA_VALIDATION_ORIGIN
      || environment.MATT_MINE_NFT_PUBLIC_BASE_URL
      || environment.MATT_MINE_PUBLIC_ORIGIN
      || '',
    expectedPublicOrigin: environment.MATT_MINE_NFT_PUBLIC_BASE_URL || '',
    expectedTokenUriOrigin: environment.MATT_MINE_NFT_TOKEN_URI_ORIGIN
      || environment.MATT_MINE_NFT_METADATA_VALIDATION_ORIGIN
      || '',
    rpcUrl: environment.MATT_MINE_NFT_RPC_URL || '',
    minerAddress: environment.MATT_MINE_NFT_MINER_ADDRESS || '',
    salesWallet: environment.MATT_MINE_NFT_V2_SALES_WALLET_ADDRESS || ''
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const next = () => {
      index += 1;
      if (!argumentsList[index]) throw new Error('Missing value after ' + argument + '.');
      return argumentsList[index];
    };
    if (argument === '--origin') result.origin = next();
    else if (argument === '--public-origin') result.expectedPublicOrigin = next();
    else if (argument === '--token-uri-origin') result.expectedTokenUriOrigin = next();
    else if (argument === '--from') result.from = Number(next());
    else if (argument === '--to') result.to = Number(next());
    else if (argument === '--concurrency') result.concurrency = Number(next());
    else if (argument === '--timeout-ms') result.timeoutMs = Number(next());
    else if (argument === '--retries') result.retries = Number(next());
    else if (argument === '--rpc-url') result.rpcUrl = next();
    else if (argument === '--miner-address') result.minerAddress = next();
    else if (argument === '--sales-wallet') result.salesWallet = next();
    else if (argument === '--skip-images') result.skipImages = true;
    else if (argument === '--expect-initial-state') result.expectInitialState = true;
    else if (argument === '--json') result.json = true;
    else throw new Error('Unknown argument: ' + argument + '.');
  }
  if (!result.origin) {
    throw new Error('Set --origin or MATT_MINE_NFT_METADATA_VALIDATION_ORIGIN.');
  }
  return result;
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const report = await validateMarketplace(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('MATT Mine NFT marketplace validation: ' + (report.ok ? 'PASS' : 'FAIL'));
    console.log('Target: ' + report.target);
    console.log('Collections: ' + report.collectionsValidated);
    console.log('Metadata: ' + report.tokensValidated);
    console.log('Images: ' + report.imagesValidated);
    console.log('Chain records: ' + report.chainTokensValidated);
    console.log('Errors: ' + report.errors.length + ' | Warnings: ' + report.warnings.length);
    for (const entry of [...report.errors, ...report.warnings].slice(0, 100)) {
      console.log('[' + entry.code + '] ' + entry.scope + ' ' + entry.id + ': ' + entry.message);
    }
    if (report.errors.length > 100) {
      console.log('Additional errors omitted: ' + (report.errors.length - 100));
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('NFT marketplace validation failed: ' + String(error?.message || error));
    process.exitCode = 1;
  });
}
