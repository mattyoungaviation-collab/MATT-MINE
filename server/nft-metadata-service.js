import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createPublicClient, getAddress, http, parseAbi } from 'viem';
import { ApiError } from './errors.js';
import { compileMinerNftProfile } from './nft-profile-compiler.js';
import { compileNftRenderPlan } from './nft-render-plan.js';

const MINER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function progressionOf(uint256 tokenId) view returns (uint256 bankedXp, uint8 level, uint8 evolution, uint256 prestigeXp)'
]);
const LOADOUT_ABI = parseAbi([
  'function loadoutOf(uint256 minerId) view returns ((uint256 weapon, uint256 backpackHead, uint256 backpackTail, uint256 helmet, uint256 armor, uint32 backpackCount, bool runLocked))'
]);
const EQUIPMENT_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function equipmentData(uint256 tokenId) view returns ((uint32 definitionId, uint16 armorHp, uint8 itemType, uint8 rarity, bool damaged, uint256 equippedToMiner))'
]);
const ITEM_TYPES = Object.freeze(['Weapon', 'Backpack', 'Helmet', 'Armor']);
const RARITIES = Object.freeze(['Common', 'Uncommon', 'Rare', 'Mythic', 'Legendary']);
const MARKET_IMAGE_SIZE = 960;
const MARKET_IMAGE_MAX_BYTES = 1_000_000;
const MARKET_PNG_OPTIONS = Object.freeze({
  compressionLevel: 9,
  palette: true,
  quality: 100,
  colours: 256,
  effort: 10
});
const EVOLUTION_NAMES = Object.freeze([
  'Rookie Miner',
  'Apprentice Miner',
  'Crystal Hunter',
  'Veteran Miner',
  'Vault Raider',
  'Elite Miner',
  'Mine Legend'
]);

export class NftMetadataService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.root = resolve(options.root || '.');
    this.publicOrigin = String(options.publicOrigin || '').replace(/\/+$/, '');
    this.chainId = positiveInteger(options.chainId || 202601, 'NFT chain ID');
    this.addresses = Object.freeze({
      miner: requiredAddress(options.addresses?.miner, 'NFT Miner address'),
      equipment: requiredAddress(options.addresses?.equipment, 'NFT Equipment address'),
      loadout: requiredAddress(options.addresses?.loadout, 'NFT Loadout address')
    });
    this.manifestPath = resolve(
      options.manifestPath || resolve(this.root, 'assets', 'nft', 'layer-manifest.json')
    );
    this.chainReader = options.chainReader || new ViemNftChainReader({
      chainId: this.chainId,
      rpcUrl: options.rpcUrl,
      timeoutMs: options.timeoutMs,
      addresses: this.addresses
    });
    this.manifest = null;
    this.imageCache = new Map();
    this.spriteCache = new Map();
  }

  async init() {
    if (!this.enabled) return this;
    this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    return this;
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      chainId: this.chainId,
      contracts: this.enabled ? this.addresses : null
    };
  }

  async minerMetadata(minerIdInput) {
    this.assertEnabled();
    const profile = await this.minerProfile(minerIdInput);
    const plan = compileNftRenderPlan(profile, this.manifest, { publicOrigin: this.publicOrigin });
    const revision = renderRevision(profile, plan);
    const equippedNames = equipmentNames(profile, this.manifest);
    return {
      name: `MATT Mine Miner #${profile.minerId}`,
      description: 'An evolving MATT Mine character. XP, level, evolution, and equipped NFT gear follow this Miner when it is transferred.',
      image: `${this.publicOrigin}/api/nft/miners/${profile.minerId}/image.png?v=${revision}`,
      external_url: `${this.publicOrigin}/?miner=${profile.minerId}`,
      background_color: '10243F',
      attributes: [
        trait('Level', profile.progression.level),
        trait('Evolution', EVOLUTION_NAMES[profile.progression.evolution]),
        numericTrait('Banked XP', profile.progression.bankedXp),
        numericTrait('Prestige XP', profile.progression.prestigeXp),
        numericTrait('Maximum Health', profile.gameplay.maximumHealth),
        trait('Crystal Carry', `${profile.gameplay.crystalCarryMultiplier}x`),
        trait('Weapon', equippedNames.weapon),
        trait('Backpack', equippedNames.backpack),
        trait('Helmet', equippedNames.helmet),
        trait('Armor', equippedNames.armor),
        trait('Armor State', profile.equipped.armor
          ? profile.gameplay.armorEffective ? 'Active' : 'Damaged'
          : 'None')
      ]
    };
  }

  async minerImage(minerIdInput) {
    this.assertEnabled();
    const profile = await this.minerProfile(minerIdInput);
    const plan = compileNftRenderPlan(profile, this.manifest);
    const revision = renderRevision(profile, plan);
    const cached = this.imageCache.get(revision);
    if (cached) return cached;
    const body = await renderPlanToPng(plan, this.root);
    const result = Object.freeze({
      body,
      contentType: 'image/png',
      etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      revision
    });
    if (this.imageCache.size >= 50) this.imageCache.delete(this.imageCache.keys().next().value);
    this.imageCache.set(revision, result);
    return result;
  }

  async minerSprite(minerIdInput) {
    this.assertEnabled();
    const profile = await this.minerProfile(minerIdInput);
    const plan = compileNftRenderPlan(profile, this.manifest);
    const revision = `sprite-${renderRevision(profile, plan)}`;
    const cached = this.spriteCache.get(revision);
    if (cached) return cached;
    const body = await renderPlanToSpritePng(plan, this.root);
    const result = Object.freeze({
      body,
      contentType: 'image/png',
      etag: `"${createHash('sha256').update(body).digest('hex')}"`,
      revision
    });
    if (this.spriteCache.size >= 50) this.spriteCache.delete(this.spriteCache.keys().next().value);
    this.spriteCache.set(revision, result);
    return result;
  }

  async equipmentMetadata(tokenIdInput) {
    this.assertEnabled();
    const tokenId = tokenIdValue(tokenIdInput, 'equipment token ID');
    const item = await this.chainReader.equipment(tokenId);
    const definition = this.manifest.equipmentDefinitions[String(item.definitionId)];
    if (!definition) throw new ApiError(502, 'nft_definition_missing', `Equipment definition ${item.definitionId} is not configured.`);
    const itemType = ITEM_TYPES[item.itemType];
    const rarity = RARITIES[item.rarity];
    return {
      name: `${definition.name} #${tokenId}`,
      description: `${rarity} ${itemType.toLowerCase()} for MATT Mine Miner NFTs.`,
      image: assetUrl(this.publicOrigin, this.manifest, definition.image),
      external_url: `${this.publicOrigin}/?equipment=${tokenId}`,
      background_color: '10243F',
      attributes: [
        trait('Type', itemType),
        trait('Rarity', rarity),
        numericTrait('Definition', item.definitionId),
        ...(item.itemType === 3 ? [numericTrait('Maximum Health', item.armorHp)] : []),
        ...(item.itemType === 3 ? [trait('Armor State', item.damaged ? 'Damaged' : 'Active')] : []),
        trait('Equipped', item.equippedToMiner ? `Miner #${item.equippedToMiner}` : 'No')
      ]
    };
  }

  minerContractMetadata() {
    this.assertEnabled();
    return {
      name: 'MATT Mine Miners',
      description: 'A fixed collection of 1,000 evolving Miner NFTs for MATT Mine.',
      image: assetUrl(this.publicOrigin, this.manifest, this.manifest.baseEvolutions['rookie-miner'].image),
      external_link: this.publicOrigin
    };
  }

  equipmentContractMetadata() {
    this.assertEnabled();
    return {
      name: 'MATT Mine Equipment',
      description: 'Tradable weapons, backpacks, helmets, and armor for MATT Mine Miner NFTs.',
      image: assetUrl(this.publicOrigin, this.manifest, this.manifest.equipmentDefinitions['105'].image),
      external_link: this.publicOrigin
    };
  }

  async minerProfile(minerIdInput) {
    const minerId = tokenIdValue(minerIdInput, 'Miner token ID');
    const state = await this.chainReader.miner(minerId);
    return compileMinerNftProfile({ minerId, ...state });
  }

  async playerMiner(addressInput) {
    const miners = await this.playerMiners(addressInput);
    return miners[0] || null;
  }

  async playerMiners(addressInput) {
    this.assertEnabled();
    const owner = getAddress(addressInput);
    const miners = [];
    for (let minerId = 1; minerId <= 1_000; minerId += 1) {
      try {
        const profile = await this.minerProfile(minerId);
        if (getAddress(profile.owner) === owner) miners.push(profile);
      } catch (error) {
        if (error?.status === 404 || error?.code === 'nft_not_found') break;
        throw error;
      }
    }
    return miners;
  }

  assertEnabled() {
    if (!this.enabled || !this.manifest) {
      throw new ApiError(503, 'nft_metadata_disabled', 'NFT metadata is not enabled on this server.');
    }
  }
}

export class ViemNftChainReader {
  constructor(options = {}) {
    this.chainId = positiveInteger(options.chainId, 'NFT chain ID');
    this.addresses = options.addresses;
    const rpcUrl = String(options.rpcUrl || '').trim();
    if (!/^https:\/\//i.test(rpcUrl)) throw new Error('NFT RPC URL must use HTTPS.');
    this.client = createPublicClient({
      transport: http(rpcUrl, { timeout: positiveInteger(options.timeoutMs || 10_000, 'NFT RPC timeout') })
    });
  }

  async miner(minerId) {
    try {
      const [owner, progression, loadout] = await Promise.all([
        this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'ownerOf', args: [BigInt(minerId)] }),
        this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'progressionOf', args: [BigInt(minerId)] }),
        this.client.readContract({ address: this.addresses.loadout, abi: LOADOUT_ABI, functionName: 'loadoutOf', args: [BigInt(minerId)] })
      ]);
      const normalizedLoadout = normalizeLoadout(loadout);
      const equipment = {};
      const ids = [
        normalizedLoadout.weapon,
        normalizedLoadout.backpackHead,
        normalizedLoadout.helmet,
        normalizedLoadout.armor
      ].filter(Boolean);
      await Promise.all(ids.map(async (tokenId) => {
        equipment[tokenId] = await this.equipment(tokenId);
      }));
      return {
        owner,
        progression: {
          bankedXp: safeInteger(progression[0], 'banked XP'),
          level: safeInteger(progression[1], 'level'),
          evolution: safeInteger(progression[2], 'evolution'),
          prestigeXp: safeInteger(progression[3], 'prestige XP')
        },
        loadout: normalizedLoadout,
        equipment
      };
    } catch (error) {
      throw chainReadError(error, `Miner #${minerId}`);
    }
  }

  async equipment(tokenId) {
    try {
      const [owner, data] = await Promise.all([
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] }),
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'equipmentData', args: [BigInt(tokenId)] })
      ]);
      return {
        owner,
        definitionId: safeInteger(data.definitionId ?? data[0], 'definition ID'),
        armorHp: safeInteger(data.armorHp ?? data[1], 'armor HP'),
        itemType: safeInteger(data.itemType ?? data[2], 'item type'),
        rarity: safeInteger(data.rarity ?? data[3], 'rarity'),
        damaged: Boolean(data.damaged ?? data[4]),
        equippedToMiner: safeInteger(data.equippedToMiner ?? data[5], 'equipped Miner ID')
      };
    } catch (error) {
      throw chainReadError(error, `Equipment #${tokenId}`);
    }
  }
}

async function renderPlanToPng(plan, root) {
  const composed = await composeRenderPlan(plan, root);
  const body = await sharp(composed.data, {
    raw: {
      width: composed.info.width,
      height: composed.info.height,
      channels: composed.info.channels
    }
  })
    .resize(MARKET_IMAGE_SIZE, MARKET_IMAGE_SIZE, { fit: 'fill', kernel: sharp.kernel.nearest })
    .png(MARKET_PNG_OPTIONS)
    .toBuffer();
  if (body.length > MARKET_IMAGE_MAX_BYTES) {
    throw new Error(`Ronin Market NFT image exceeds ${MARKET_IMAGE_MAX_BYTES} bytes.`);
  }
  return body;
}

async function renderPlanToSpritePng(plan, root) {
  const composed = await composeRenderPlan(plan, root);
  const width = composed.info.width;
  const height = composed.info.height;
  const channels = composed.info.channels;
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const source = pixel * channels;
    const target = pixel * 4;
    rgba[target] = composed.data[source];
    rgba[target + 1] = composed.data[source + 1];
    rgba[target + 2] = composed.data[source + 2];
    rgba[target + 3] = channels >= 4 ? composed.data[source + 3] : 255;
  }
  removeConnectedNavyBackground(rgba, width, height);
  return sharp(rgba, { raw: { width, height, channels: 4 } })
    .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .resize(512, 512, {
      fit: 'contain',
      position: 'bottom',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      kernel: sharp.kernel.nearest
    })
    .png({ compressionLevel: 9, palette: true, quality: 100, effort: 10 })
    .toBuffer();
}

async function composeRenderPlan(plan, root) {
  const basePath = localAssetPath(root, plan.base.image);
  const composites = [];
  for (const layer of [...plan.underlays, ...plan.layers]) {
    composites.push(await transformedLayer(root, layer, plan.canvas));
  }
  if (plan.effect) {
    composites.push({
      input: Buffer.from(`<svg width="${plan.canvas.width}" height="${plan.canvas.height}"><rect width="100%" height="100%" fill="${plan.effect.tint}" fill-opacity="${plan.effect.maximumOpacity}"/></svg>`),
      left: 0,
      top: 0
    });
  }
  return sharp(basePath)
    .resize(plan.canvas.width, plan.canvas.height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .composite(composites)
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function removeConnectedNavyBackground(rgba, width, height) {
  const visited = new Uint8Array(width * height);
  const queue = new Uint32Array(width * height);
  let head = 0;
  let tail = 0;
  const enqueue = (pixel) => {
    if (visited[pixel]) return;
    const offset = pixel * 4;
    if (!isNavyBackground(rgba[offset], rgba[offset + 1], rgba[offset + 2])) return;
    visited[pixel] = 1;
    queue[tail] = pixel;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }
  while (head < tail) {
    const pixel = queue[head];
    head += 1;
    rgba[pixel * 4 + 3] = 0;
    const x = pixel % width;
    if (x > 0) enqueue(pixel - 1);
    if (x + 1 < width) enqueue(pixel + 1);
    if (pixel >= width) enqueue(pixel - width);
    if (pixel + width < width * height) enqueue(pixel + width);
  }
}

function isNavyBackground(red, green, blue) {
  return red < 85 && green < 100 && blue < 135 && blue >= green * 1.02 && blue >= red * 1.15;
}

async function transformedLayer(root, layer, canvas) {
  const sourcePath = localAssetPath(root, layer.image);
  const scale = Number(layer.transform?.scale || 1);
  const width = Math.max(1, Math.round(canvas.width * scale));
  const height = Math.max(1, Math.round(canvas.height * scale));
  const x = Math.round(Number(layer.transform?.x || 0));
  const y = Math.round(Number(layer.transform?.y || 0));
  const cropLeft = Math.max(0, -x);
  const cropTop = Math.max(0, -y);
  const outputLeft = Math.max(0, x);
  const outputTop = Math.max(0, y);
  const cropWidth = Math.min(width - cropLeft, canvas.width - outputLeft);
  const cropHeight = Math.min(height - cropTop, canvas.height - outputTop);
  if (cropWidth <= 0 || cropHeight <= 0) throw new Error(`NFT layer ${layer.image} is outside the canvas.`);
  let pipeline = sharp(sourcePath).resize(width, height, { fit: 'fill', kernel: sharp.kernel.nearest });
  if (cropLeft || cropTop || cropWidth !== width || cropHeight !== height) {
    pipeline = pipeline.extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight });
  }
  return { input: await pipeline.png().toBuffer(), left: outputLeft, top: outputTop };
}

function localAssetPath(root, asset) {
  const pathname = new URL(String(asset), 'https://matt-mine.invalid').pathname;
  if (!pathname.startsWith('/assets/nft/')) throw new Error(`NFT image is outside the public asset pack: ${asset}`);
  const assetRoot = resolve(root, 'assets', 'nft');
  const path = resolve(assetRoot, pathname.slice('/assets/nft/'.length));
  const local = relative(assetRoot, path);
  if (local === '..' || local.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(local)) {
    throw new Error(`Unsafe NFT asset path: ${asset}`);
  }
  return path;
}

function normalizeLoadout(value) {
  return {
    weapon: safeInteger(value.weapon ?? value[0], 'loadout weapon'),
    backpackHead: safeInteger(value.backpackHead ?? value[1], 'loadout backpack head'),
    backpackTail: safeInteger(value.backpackTail ?? value[2], 'loadout backpack tail'),
    helmet: safeInteger(value.helmet ?? value[3], 'loadout helmet'),
    armor: safeInteger(value.armor ?? value[4], 'loadout armor'),
    backpackCount: safeInteger(value.backpackCount ?? value[5], 'loadout backpack count'),
    runLocked: Boolean(value.runLocked ?? value[6])
  };
}

function equipmentNames(profile, manifest) {
  const names = { weapon: 'Starter Pickaxe', backpack: 'None', helmet: 'None', armor: 'None' };
  for (const layer of profile.render.layers) {
    names[layer.slot] = manifest.equipmentDefinitions[String(layer.definitionId)]?.name || `Definition ${layer.definitionId}`;
  }
  return names;
}

function renderRevision(profile, plan) {
  return createHash('sha256').update(JSON.stringify({
    minerId: profile.minerId,
    progression: profile.progression,
    equipped: profile.equipped,
    damaged: profile.render.damagedArmorFlashRed,
    images: [plan.base, ...plan.underlays, ...plan.layers]
  })).digest('hex').slice(0, 16);
}

function assetUrl(origin, manifest, path) {
  const base = `/${String(manifest.publicBaseUrl || '/assets/nft').replace(/^\/+|\/+$/g, '')}`;
  return `${origin}${base}/${String(path).replace(/^\/+/, '')}`;
}

function trait(traitType, value) {
  return { trait_type: traitType, value };
}

function numericTrait(traitType, value) {
  return { display_type: 'number', trait_type: traitType, value };
}

function tokenIdValue(value, label) {
  return positiveInteger(value, label);
}

function positiveInteger(value, label) {
  const number = safeInteger(value, label);
  if (number === 0) throw new ApiError(400, 'invalid_nft_token_id', `${label} must be greater than zero.`);
  return number;
}

function safeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new ApiError(400, 'invalid_nft_value', `${label} must be a safe non-negative integer.`);
  }
  return number;
}

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || ''));
  } catch {
    throw new Error(`${label} is invalid.`);
  }
}

function chainReadError(error, label) {
  if (error instanceof ApiError) return error;
  const message = String(error?.shortMessage || error?.message || error);
  if (/nonexistent|does not exist|ERC721NonexistentToken/i.test(message)) {
    return new ApiError(404, 'nft_not_found', `${label} does not exist.`);
  }
  return new ApiError(502, 'nft_chain_read_failed', `Unable to read ${label} from Saigon.`);
}
