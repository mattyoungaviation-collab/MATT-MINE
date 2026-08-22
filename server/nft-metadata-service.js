import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import sharp from 'sharp';
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem } from 'viem';
import { ronin, saigon } from 'viem/chains';
import { ApiError } from './errors.js';
import { compileMinerNftProfile } from './nft-profile-compiler.js';
import { compileNftRenderPlan } from './nft-render-plan.js';

const MINER_ABI = parseAbi([
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function nextTokenId() view returns (uint256)',
  'function traitsOf(uint256 tokenId) view returns ((uint128 bankedXp,uint16 baseHealth,uint16 pickaxeAttack,uint16 blasterAttack,uint16 dynamiteAttack,uint16 healAmount,uint16 baseCarryCapacity,uint16 deathRetentionBps,uint8 level,uint8 evolution,uint8 crystalsPerHour,uint40 lastVerifiedPlay,uint40 activeUntil,uint40 cphAssignedAt,uint8 earningStatus,bool runLocked))'
]);
const LOADOUT_ABI = parseAbi([
  'function loadoutOf(uint256 minerId) view returns (uint256[6])',
  'function effectiveTraits(uint256 minerId) view returns ((uint16 maximumHealth,uint16 armorShield,uint16 pickaxeAttack,uint16 blasterAttack,uint16 dynamiteAttack,uint16 healAmount,uint16 carryCapacity,uint16 deathRetentionBps,uint8 level,uint8 crystalsPerHour))'
]);
const EQUIPMENT_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function nextTokenId() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function equipmentData(uint256 tokenId) view returns ((uint32 definitionId,uint32 equippedToMiner,uint8 slot,uint8 rarity,bool damaged))',
  'function bonusFor(uint256 tokenId) view returns (uint16)'
]);
const EQUIPMENT_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const EQUIPMENT_ASSIGNMENT_EVENT = parseAbiItem('event EquipmentAssignmentChanged(uint256 indexed tokenId,uint256 indexed minerId)');
const MINER_TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)');
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEFAULT_MINER_DEPLOYMENT_BLOCK = 59_628_599n;
export const DEFAULT_EQUIPMENT_DEPLOYMENT_BLOCK = 59_628_601n;
const DEFAULT_EQUIPMENT_PAGE_SIZE = 50;
const MAX_EQUIPMENT_PAGE_SIZE = 100;
const DEFAULT_EQUIPMENT_SNAPSHOT_TTL_MS = 120_000;
const DEFAULT_EQUIPMENT_SNAPSHOT_LIMIT = 1_000;
const DEFAULT_EQUIPMENT_INDEX_CONFIRMATIONS = 12;
const DEFAULT_EQUIPMENT_INDEX_MAX_CHUNKS = 25;
const EQUIPMENT_INDEX_BOOTSTRAP_BATCH_SIZE = 100;
const MINER_MAX_SUPPLY = 1_000;
const ITEM_TYPES = Object.freeze(['Armor', 'Pickaxe', 'Blaster', 'Dynamite', 'Helmet', 'Backpack']);
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
    this.chainId = positiveInteger(options.chainId || 2020, 'NFT chain ID');
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
      addresses: this.addresses,
      minerDeploymentBlock: options.minerDeploymentBlock,
      equipmentDeploymentBlock: options.equipmentDeploymentBlock,
      equipmentIndexChunkSize: options.equipmentIndexChunkSize,
      equipmentIndexRefreshMs: options.equipmentIndexRefreshMs,
      equipmentIndexConfirmations: options.equipmentIndexConfirmations,
      equipmentIndexMaxChunks: options.equipmentIndexMaxChunks
    });
    this.manifest = null;
    this.imageCache = new Map();
    this.spriteCache = new Map();
    this.equipmentInventorySnapshots = new Map();
    this.equipmentSnapshotTtlMs = boundedPositiveInteger(
      options.equipmentSnapshotTtlMs ?? DEFAULT_EQUIPMENT_SNAPSHOT_TTL_MS,
      'Equipment inventory snapshot TTL',
      10 * 60_000
    );
    this.equipmentSnapshotLimit = boundedPositiveInteger(
      options.equipmentSnapshotLimit ?? DEFAULT_EQUIPMENT_SNAPSHOT_LIMIT,
      'Equipment inventory snapshot limit',
      5_000
    );
    this.equipmentIndexStartupWaitMs = boundedNonnegativeInteger(
      options.equipmentIndexStartupWaitMs ?? 1_500,
      'Equipment index startup wait',
      10_000
    );
    this.equipmentIndexWarmupPromise = null;
    this.equipmentIndexWarmupError = '';
  }

  async init() {
    if (!this.enabled) return this;
    this.manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
    if (typeof this.chainReader.prewarmEquipmentIndex === 'function') {
      const warmup = Promise.resolve(this.chainReader.prewarmEquipmentIndex());
      this.equipmentIndexWarmupPromise = warmup.catch((error) => {
        this.equipmentIndexWarmupError = String(error?.message || error);
        return null;
      });
      await settleWithin(this.equipmentIndexWarmupPromise, this.equipmentIndexStartupWaitMs);
    }
    return this;
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      chainId: this.chainId,
      contracts: this.enabled ? this.addresses : null
    };
  }

  async health() {
    if (!this.enabled) return { enabled: false, ok: true };
    if (!this.manifest) return { enabled: true, ok: false, error: 'manifest_not_loaded' };
    const startedAt = Date.now();
    try {
      const chain = typeof this.chainReader.health === 'function'
        ? await this.chainReader.health()
        : { ok: true, chainId: this.chainId };
      const equipmentIndex = typeof this.chainReader.inventoryIndexStatus === 'function'
        ? this.chainReader.inventoryIndexStatus()
        : { ready: typeof this.chainReader.equipmentInventorySnapshotForOwner === 'function' };
      return {
        enabled: true,
        ok: chain.ok === true && Number(chain.chainId) === this.chainId && equipmentIndex.ready === true,
        chainId: Number(chain.chainId || this.chainId),
        nextMinerTokenId: Number(chain.nextMinerTokenId || 0),
        latencyMs: Date.now() - startedAt,
        manifestLoaded: true,
        equipmentIndex,
        ...(this.equipmentIndexWarmupError ? { equipmentIndexError: this.equipmentIndexWarmupError } : {})
      };
    } catch {
      return {
        enabled: true,
        ok: false,
        chainId: this.chainId,
        latencyMs: Date.now() - startedAt,
        error: 'nft_metadata_health_failed'
      };
    }
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
      image: `${this.publicOrigin}/api/nft/v2/miners/${profile.minerId}/image.png?v=${revision}`,
      external_url: `${this.publicOrigin}/?miner=${profile.minerId}`,
      background_color: '10243F',
      attributes: [
        trait('Level', profile.progression.level),
        trait('Evolution', EVOLUTION_NAMES[profile.progression.evolution]),
        numericTrait('Banked XP', profile.progression.bankedXp),
        numericTrait('Base Health', profile.traits.baseHealth),
        numericTrait('Maximum Health', profile.effectiveTraits.maximumHealth),
        numericTrait('Armor Shield', profile.effectiveTraits.armorShield),
        numericTrait('Pickaxe Attack', profile.effectiveTraits.pickaxeAttack),
        numericTrait('Blaster Attack', profile.effectiveTraits.blasterAttack),
        numericTrait('Dynamite Attack', profile.effectiveTraits.dynamiteAttack),
        numericTrait('Heal', profile.effectiveTraits.healAmount),
        numericTrait('Crystal Carry Capacity', profile.effectiveTraits.carryCapacity),
        trait('Crystal Death Retention', `${profile.effectiveTraits.deathRetentionBps / 100}%`),
        numericTrait('Crystals Per Hour', profile.progression.crystalsPerHour),
        trait('Earning Status', profile.progression.earningStatus),
        trait('Pickaxe', equippedNames.pickaxe),
        trait('Blaster', equippedNames.blaster),
        trait('Dynamite', equippedNames.dynamite),
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
    return this.equipmentMetadataFromItem(tokenId, item);
  }

  equipmentMetadataFromItem(tokenId, item) {
    const definition = this.manifest.equipmentDefinitions[String(item.definitionId)];
    if (!definition) throw new ApiError(502, 'nft_definition_missing', `Equipment definition ${item.definitionId} is not configured.`);
    const itemType = ITEM_TYPES[item.slot];
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
        numericTrait('Fixed Bonus', item.bonus),
        ...(item.slot === 0 ? [trait('Armor State', item.damaged ? 'Damaged' : 'Active')] : []),
        trait('Equipped', item.equippedToMiner ? `Miner #${item.equippedToMiner}` : 'No')
      ]
    };
  }

  async playerEquipmentInventory(addressInput, options = {}) {
    this.assertEnabled();
    if (typeof this.chainReader.equipmentInventorySnapshotForOwner !== 'function') {
      throw new ApiError(503, 'nft_equipment_index_unavailable', 'The server Equipment ownership index is unavailable.');
    }
    const owner = getAddress(addressInput);
    const limit = equipmentPageLimit(options.limit);
    this.pruneEquipmentSnapshots();
    let snapshot;
    let offset = 0;
    if (options.cursor) {
      const cursor = equipmentSnapshotCursor(options.cursor);
      snapshot = this.equipmentInventorySnapshots.get(cursor.snapshotId);
      if (!snapshot || snapshot.owner !== owner || snapshot.expiresAt <= Date.now()) {
        throw equipmentInventoryChanged();
      }
      offset = cursor.offset;
      if (offset < 0 || offset >= snapshot.tokenIds.length) throw equipmentInventoryChanged();
    } else {
      const indexed = await this.chainReader.equipmentInventorySnapshotForOwner(owner);
      const priority = equipmentPriorityTokenIds(options.priorityTokenIds)
        .filter((tokenId) => indexed.tokenIds.includes(tokenId));
      const prioritySet = new Set(priority);
      const tokenIds = Object.freeze([
        ...priority,
        ...indexed.tokenIds.filter((tokenId) => !prioritySet.has(tokenId))
      ]);
      const snapshotId = randomBytes(18).toString('base64url');
      snapshot = Object.freeze({
        snapshotId,
        owner,
        indexedToBlock: BigInt(indexed.indexedToBlock),
        checkpointHash: String(indexed.checkpointHash || ''),
        tokenIds,
        directTokenIds: Object.freeze([...indexed.directTokenIds]),
        custodyTokenIds: Object.freeze([...indexed.custodyTokenIds]),
        ownedMinerIds: Object.freeze([...indexed.ownedMinerIds]),
        createdAt: Date.now(),
        expiresAt: Date.now() + this.equipmentSnapshotTtlMs
      });
      this.equipmentInventorySnapshots.set(snapshotId, snapshot);
      this.pruneEquipmentSnapshots();
    }
    const pageTokenIds = snapshot.tokenIds.slice(offset, offset + limit);
    const equipment = typeof this.chainReader.equipmentBatch === 'function'
      ? await this.chainReader.equipmentBatch(pageTokenIds, { blockNumber: snapshot.indexedToBlock })
      : await Promise.all(pageTokenIds.map((tokenId) => this.chainReader.equipment(tokenId, { blockNumber: snapshot.indexedToBlock })));
    const directTokenIds = new Set(snapshot.directTokenIds);
    const custodyTokenIds = new Set(snapshot.custodyTokenIds);
    const ownedMinerIdSet = new Set(snapshot.ownedMinerIds);
    const items = equipment.map((item, index) => {
      const tokenId = pageTokenIds[index];
      const itemOwner = getAddress(item.owner);
      const directCustody = directTokenIds.has(tokenId) && itemOwner === owner && item.equippedToMiner === 0;
      const equippedCustody = custodyTokenIds.has(tokenId) &&
        itemOwner === this.addresses.loadout &&
        ownedMinerIdSet.has(item.equippedToMiner);
      if (!directCustody && !equippedCustody) {
        throw equipmentInventoryChanged();
      }
      return {
        tokenId,
        ...item,
        metadata: this.equipmentMetadataFromItem(tokenId, item)
      };
    });
    if (typeof this.chainReader.assertEquipmentInventorySnapshot === 'function') {
      await this.chainReader.assertEquipmentInventorySnapshot({
        indexedToBlock: snapshot.indexedToBlock,
        checkpointHash: snapshot.checkpointHash
      });
    }
    const nextOffset = offset + pageTokenIds.length;
    const nextCursor = nextOffset < snapshot.tokenIds.length
      ? encodeEquipmentSnapshotCursor(snapshot.snapshotId, nextOffset)
      : '';
    return {
      owner,
      items,
      nextCursor,
      hasMore: Boolean(nextCursor),
      total: snapshot.tokenIds.length,
      indexedToBlock: snapshot.indexedToBlock.toString(),
      pageSize: limit
    };
  }

  pruneEquipmentSnapshots() {
    const timestamp = Date.now();
    for (const [snapshotId, snapshot] of this.equipmentInventorySnapshots) {
      if (snapshot.expiresAt <= timestamp) this.equipmentInventorySnapshots.delete(snapshotId);
    }
    while (this.equipmentInventorySnapshots.size > this.equipmentSnapshotLimit) {
      this.equipmentInventorySnapshots.delete(this.equipmentInventorySnapshots.keys().next().value);
    }
  }

  minerContractMetadata() {
    this.assertEnabled();
    return {
      name: 'MATT Mine Miners',
      description: 'A fixed collection of 1,000 evolving Miner NFTs for MATT Mine.',
      image: assetUrl(
        this.publicOrigin,
        this.manifest,
        this.manifest.collectionImages?.miners || this.manifest.baseEvolutions['rookie-miner'].image
      ),
      external_link: this.publicOrigin
    };
  }

  equipmentContractMetadata() {
    this.assertEnabled();
    return {
      name: 'MATT Mine Equipment',
      description: 'Tradable armor, weapons, helmets, and single-use backpacks for MATT Mine Miner NFTs.',
      image: assetUrl(this.publicOrigin, this.manifest, this.manifest.equipmentDefinitions['1104'].image),
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

  async playerMinerIds(addressInput) {
    this.assertEnabled();
    const owner = getAddress(addressInput);
    if (typeof this.chainReader.minerIdsForOwner === 'function') {
      return this.chainReader.minerIdsForOwner(owner);
    }
    const minerIds = [];
    for (let minerId = 1; minerId <= 1_000; minerId += 1) {
      try {
        const profile = await this.minerProfile(minerId);
        if (getAddress(profile.owner) === owner) minerIds.push(minerId);
      } catch (error) {
        if (error?.status === 404 || error?.code === 'nft_not_found') break;
        throw error;
      }
    }
    return minerIds;
  }

  async minerProfiles(minerIdsInput) {
    const minerIds = Array.from(minerIdsInput || []);
    const miners = [];
    for (let start = 0; start < minerIds.length; start += 20) {
      miners.push(...await Promise.all(minerIds.slice(start, start + 20).map((minerId) => this.minerProfile(minerId))));
    }
    return miners;
  }

  async playerMiners(addressInput, options = {}) {
    const minerIds = await this.playerMinerIds(addressInput);
    const limit = options.limit === undefined
      ? minerIds.length
      : Math.max(0, Math.min(minerIds.length, Number(options.limit) || 0));
    return this.minerProfiles(minerIds.slice(0, limit));
  }

  async playerMinerById(addressInput, minerIdInput) {
    this.assertEnabled();
    const owner = getAddress(addressInput);
    const profile = await this.minerProfile(minerIdInput);
    if (getAddress(profile.owner) !== owner) {
      throw new ApiError(403, 'nft_miner_not_owned', `Miner #${profile.minerId} is not owned by the connected wallet.`);
    }
    return profile;
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
    const chain = this.chainId === ronin.id ? ronin : this.chainId === saigon.id ? saigon : null;
    if (!chain) throw new Error(`Unsupported NFT chain ID ${this.chainId}.`);
    this.client = options.client || createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout: positiveInteger(options.timeoutMs || 10_000, 'NFT RPC timeout') })
    });
    this.minerDeploymentBlock = nonnegativeBigInt(
      options.minerDeploymentBlock ?? DEFAULT_MINER_DEPLOYMENT_BLOCK,
      'Miner deployment block'
    );
    this.equipmentDeploymentBlock = nonnegativeBigInt(
      options.equipmentDeploymentBlock ?? DEFAULT_EQUIPMENT_DEPLOYMENT_BLOCK,
      'Equipment deployment block'
    );
    this.equipmentIndexChunkSize = positiveInteger(
      options.equipmentIndexChunkSize || 1_000,
      'Equipment index chunk size'
    );
    this.equipmentIndexRefreshMs = boundedNonnegativeInteger(
      options.equipmentIndexRefreshMs ?? 5_000,
      'Equipment index refresh milliseconds',
      60_000
    );
    this.equipmentIndexConfirmations = boundedNonnegativeInteger(
      options.equipmentIndexConfirmations ?? DEFAULT_EQUIPMENT_INDEX_CONFIRMATIONS,
      'Equipment index confirmations',
      100
    );
    this.equipmentIndexMaxChunks = boundedPositiveInteger(
      options.equipmentIndexMaxChunks ?? DEFAULT_EQUIPMENT_INDEX_MAX_CHUNKS,
      'Equipment index maximum chunks',
      1_000
    );
    this.equipmentIndexStartBlock = minBigInt(this.minerDeploymentBlock, this.equipmentDeploymentBlock);
    this.equipmentIndexedToBlock = this.equipmentIndexStartBlock - 1n;
    this.equipmentConfirmedTargetBlock = this.equipmentIndexStartBlock - 1n;
    this.equipmentIndexCheckpointHash = '';
    this.equipmentIndexRevision = 0;
    this.equipmentIndexInitialized = false;
    this.equipmentIndexError = '';
    this.minerOwners = new Map();
    this.minerTokensByOwner = new Map();
    this.equipmentOwners = new Map();
    this.equipmentTokensByOwner = new Map();
    this.equipmentAssignments = new Map();
    this.equipmentTokensByMiner = new Map();
    this.equipmentIndexLastSyncAt = 0;
    this.equipmentIndexSyncPromise = null;
    this.equipmentIndexPrewarmPromise = null;
  }

  async health() {
    const [chainId, nextMinerTokenId] = await Promise.all([
      this.client.getChainId(),
      this.client.readContract({
        address: this.addresses.miner,
        abi: MINER_ABI,
        functionName: 'nextTokenId'
      }),
      this.syncEquipmentOwnershipIndex()
    ]);
    return {
      ok: chainId === this.chainId,
      chainId,
      nextMinerTokenId: Number(nextMinerTokenId),
      equipmentIndex: this.inventoryIndexStatus()
    };
  }

  async minerIdsForOwner(ownerInput) {
    const owner = getAddress(ownerInput);
    const index = this.inventoryIndexStatus();
    if (index.ready) {
      const owned = [...(this.minerTokensByOwner.get(owner.toLowerCase()) || [])].sort((left, right) => left - right);
      const balance = await this.client.readContract({
        address: this.addresses.miner,
        abi: MINER_ABI,
        functionName: 'balanceOf',
        args: [owner],
        blockNumber: this.equipmentIndexedToBlock
      });
      if (BigInt(owned.length) !== BigInt(balance)) {
        throw new ApiError(502, 'nft_owner_index_incomplete', 'The confirmed Ronin Miner ownership index was incomplete.');
      }
      return owned;
    }
    const [balance, nextTokenId] = await Promise.all([
      this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'balanceOf', args: [owner] }),
      this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'nextTokenId' })
    ]);
    if (balance === 0n) return [];
    const expected = Number(balance);
    const owned = [];
    const minted = Math.min(1_000, Number(nextTokenId) - 1);
    for (let start = 1; start <= minted && owned.length < expected; start += 100) {
      const ids = Array.from({ length: Math.min(100, minted - start + 1) }, (_value, index) => start + index);
      const results = await this.client.multicall({
        allowFailure: true,
        contracts: ids.map((minerId) => ({
          address: this.addresses.miner,
          abi: MINER_ABI,
          functionName: 'ownerOf',
          args: [BigInt(minerId)]
        }))
      });
      for (let index = 0; index < results.length; index += 1) {
        if (results[index].status === 'success' && getAddress(results[index].result) === owner) owned.push(ids[index]);
      }
    }
    if (owned.length !== expected) throw new ApiError(502, 'nft_owner_index_incomplete', 'The Ronin Miner ownership index was incomplete.');
    return owned;
  }

  async miner(minerId) {
    try {
      const [owner, traits, loadout, effectiveTraits] = await Promise.all([
        this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'ownerOf', args: [BigInt(minerId)] }),
        this.client.readContract({ address: this.addresses.miner, abi: MINER_ABI, functionName: 'traitsOf', args: [BigInt(minerId)] }),
        this.client.readContract({ address: this.addresses.loadout, abi: LOADOUT_ABI, functionName: 'loadoutOf', args: [BigInt(minerId)] }),
        this.client.readContract({ address: this.addresses.loadout, abi: LOADOUT_ABI, functionName: 'effectiveTraits', args: [BigInt(minerId)] })
      ]);
      const normalizedLoadout = normalizeLoadout(loadout);
      const equipment = {};
      const ids = Object.values(normalizedLoadout).filter(Boolean);
      await Promise.all(ids.map(async (tokenId) => {
        equipment[tokenId] = await this.equipment(tokenId);
      }));
      return {
        owner,
        version: 2,
        traits: normalizeStruct(traits, [
          'bankedXp', 'baseHealth', 'pickaxeAttack', 'blasterAttack', 'dynamiteAttack',
          'healAmount', 'baseCarryCapacity', 'deathRetentionBps', 'level', 'evolution',
          'crystalsPerHour', 'lastVerifiedPlay', 'activeUntil', 'cphAssignedAt',
          'earningStatus', 'runLocked'
        ], new Set(['runLocked'])),
        effectiveTraits: normalizeStruct(effectiveTraits, [
          'maximumHealth', 'armorShield', 'pickaxeAttack', 'blasterAttack',
          'dynamiteAttack', 'healAmount', 'carryCapacity', 'deathRetentionBps',
          'level', 'crystalsPerHour'
        ]),
        loadout: normalizedLoadout,
        equipment
      };
    } catch (error) {
      throw chainReadError(error, `Miner #${minerId}`);
    }
  }

  async equipmentTokenPageForOwner(ownerInput, options = {}) {
    const owner = getAddress(ownerInput);
    const cursor = equipmentCursor(options.cursor);
    const limit = equipmentPageLimit(options.limit);
    const snapshot = await this.equipmentInventorySnapshotForOwner(owner);
    if (cursor.indexedToBlock !== null && cursor.indexedToBlock !== BigInt(snapshot.indexedToBlock)) {
      throw equipmentInventoryChanged();
    }
    const sorted = snapshot.tokenIds;
    const afterCursor = sorted.filter((tokenId) => tokenId > cursor.tokenId);
    const page = afterCursor.slice(0, limit);
    return {
      tokenIds: page,
      nextCursor: afterCursor.length > page.length
        ? encodeEquipmentCursor(snapshot.indexedToBlock, page.at(-1))
        : '',
      total: sorted.length,
      limit,
      indexedToBlock: String(snapshot.indexedToBlock)
    };
  }

  async equipmentInventorySnapshotForOwner(ownerInput) {
    const owner = getAddress(ownerInput);
    await this.syncEquipmentOwnershipIndex();
    const status = this.inventoryIndexStatus();
    if (!status.ready) {
      void this.prewarmEquipmentIndex().catch(() => undefined);
      const error = new ApiError(
        503,
        'nft_equipment_index_warming',
        'The confirmed Ronin Equipment index is warming. Try again shortly.',
        status
      );
      error.retryAfter = 2;
      throw error;
    }
    const indexedToBlock = this.equipmentIndexedToBlock;
    const checkpointHash = this.equipmentIndexCheckpointHash;
    const indexRevision = this.equipmentIndexRevision;
    const ownerKey = owner.toLowerCase();
    const loadoutKey = this.addresses.loadout.toLowerCase();
    const directTokenIds = [...(this.equipmentTokensByOwner.get(ownerKey) || [])].sort((left, right) => left - right);
    const ownedMinerIds = [...(this.minerTokensByOwner.get(ownerKey) || [])].sort((left, right) => left - right);
    const loadoutTokenIds = [...(this.equipmentTokensByOwner.get(loadoutKey) || [])];
    const custodyTokenIds = [...new Set(ownedMinerIds.flatMap((minerId) => [
      ...(this.equipmentTokensByMiner.get(minerId) || [])
    ]))]
      .filter((tokenId) => this.equipmentOwners.get(tokenId) === loadoutKey)
      .sort((left, right) => left - right);
    const [indexedDirectBalance, indexedLoadoutBalance, indexedMinerBalance] = await Promise.all([
      this.client.readContract({
        address: this.addresses.equipment,
        abi: EQUIPMENT_ABI,
        functionName: 'balanceOf',
        args: [owner],
        blockNumber: indexedToBlock
      }),
      this.client.readContract({
        address: this.addresses.equipment,
        abi: EQUIPMENT_ABI,
        functionName: 'balanceOf',
        args: [this.addresses.loadout],
        blockNumber: indexedToBlock
      }),
      this.client.readContract({
        address: this.addresses.miner,
        abi: MINER_ABI,
        functionName: 'balanceOf',
        args: [owner],
        blockNumber: indexedToBlock
      })
    ]);
    if (
      indexRevision !== this.equipmentIndexRevision ||
      indexedToBlock !== this.equipmentIndexedToBlock ||
      checkpointHash !== this.equipmentIndexCheckpointHash
    ) {
      throw equipmentInventoryChanged();
    }
    if (
      BigInt(directTokenIds.length) !== BigInt(indexedDirectBalance) ||
      BigInt(loadoutTokenIds.length) !== BigInt(indexedLoadoutBalance) ||
      BigInt(ownedMinerIds.length) !== BigInt(indexedMinerBalance)
    ) {
      throw new ApiError(
        502,
        'nft_equipment_index_incomplete',
        'The confirmed NFT ownership index is not synchronized with Ronin. Try again shortly.'
      );
    }
    const tokenIds = [...new Set([...directTokenIds, ...custodyTokenIds])].sort((left, right) => left - right);
    return {
      indexedToBlock: indexedToBlock.toString(),
      checkpointHash,
      tokenIds: Object.freeze(tokenIds),
      directTokenIds: Object.freeze(directTokenIds),
      custodyTokenIds: Object.freeze(custodyTokenIds),
      ownedMinerIds: Object.freeze(ownedMinerIds)
    };
  }

  async assertEquipmentInventorySnapshot(snapshot = {}) {
    const indexedToBlock = nonnegativeBigInt(snapshot.indexedToBlock, 'Equipment snapshot block');
    const checkpointHash = String(snapshot.checkpointHash || '');
    if (!checkpointHash || typeof this.client.getBlock !== 'function') return true;
    const block = await this.client.getBlock({ blockNumber: indexedToBlock });
    if (String(block?.hash || '').toLowerCase() !== checkpointHash.toLowerCase()) {
      throw equipmentInventoryChanged();
    }
    return true;
  }

  inventoryIndexStatus() {
    const ready = this.equipmentIndexInitialized &&
      this.equipmentIndexedToBlock >= this.equipmentConfirmedTargetBlock;
    return {
      ready,
      warming: Boolean(this.equipmentIndexSyncPromise || this.equipmentIndexPrewarmPromise) && !ready,
      confirmations: this.equipmentIndexConfirmations,
      indexedToBlock: this.equipmentIndexedToBlock.toString(),
      confirmedBlock: this.equipmentConfirmedTargetBlock.toString(),
      remainingBlocks: this.equipmentConfirmedTargetBlock > this.equipmentIndexedToBlock
        ? (this.equipmentConfirmedTargetBlock - this.equipmentIndexedToBlock).toString()
        : '0',
      ...(this.equipmentIndexError ? { error: this.equipmentIndexError } : {})
    };
  }

  prewarmEquipmentIndex() {
    if (this.equipmentIndexPrewarmPromise) return this.equipmentIndexPrewarmPromise;
    const pending = (async () => {
      while (true) {
        await this.syncEquipmentOwnershipIndex({ force: true });
        const status = this.inventoryIndexStatus();
        if (status.ready) return status;
        await eventLoopTurn();
      }
    })();
    this.equipmentIndexPrewarmPromise = pending;
    pending.catch((error) => {
      this.equipmentIndexError = String(error?.message || error);
    }).finally(() => {
      if (this.equipmentIndexPrewarmPromise === pending) this.equipmentIndexPrewarmPromise = null;
    });
    return pending;
  }

  async syncEquipmentOwnershipIndex(options = {}) {
    const timestamp = Date.now();
    if (
      options.force !== true &&
      !this.equipmentIndexSyncPromise &&
      this.inventoryIndexStatus().ready &&
      this.equipmentIndexLastSyncAt > 0 &&
      timestamp - this.equipmentIndexLastSyncAt < this.equipmentIndexRefreshMs
    ) {
      return this.equipmentIndexedToBlock;
    }
    if (this.equipmentIndexSyncPromise) return this.equipmentIndexSyncPromise;
    const pending = this.#syncEquipmentOwnershipIndex(options.maxChunks || this.equipmentIndexMaxChunks);
    this.equipmentIndexSyncPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.equipmentIndexSyncPromise === pending) this.equipmentIndexSyncPromise = null;
    }
  }

  async #syncEquipmentOwnershipIndex(maxChunks) {
    await this.#verifyEquipmentIndexCheckpoint();
    const latestBlock = BigInt(await this.client.getBlockNumber());
    const confirmedBlock = latestBlock > BigInt(this.equipmentIndexConfirmations)
      ? latestBlock - BigInt(this.equipmentIndexConfirmations)
      : 0n;
    const targetBlock = confirmedBlock >= this.equipmentIndexStartBlock
      ? confirmedBlock
      : this.equipmentIndexStartBlock - 1n;
    if (targetBlock < this.equipmentIndexedToBlock) {
      throw new ApiError(
        503,
        'nft_equipment_index_checkpoint_ahead',
        'The Ronin RPC confirmed head is behind the NFT index checkpoint.'
      );
    }
    this.equipmentConfirmedTargetBlock = targetBlock;
    const firstUnindexedBlock = this.equipmentIndexedToBlock >= this.equipmentIndexStartBlock
      ? this.equipmentIndexedToBlock + 1n
      : this.equipmentIndexStartBlock;
    const replayBlocks = targetBlock >= firstUnindexedBlock
      ? targetBlock - firstUnindexedBlock + 1n
      : 0n;
    const replayCapacity = BigInt(this.equipmentIndexChunkSize) * BigInt(maxChunks);
    if (!this.equipmentIndexInitialized && replayBlocks > replayCapacity) {
      await this.#bootstrapEquipmentOwnershipIndex(targetBlock);
      this.equipmentIndexError = '';
      this.equipmentIndexLastSyncAt = Date.now();
      return this.equipmentIndexedToBlock;
    }
    let fromBlock = this.equipmentIndexedToBlock + 1n;
    if (fromBlock < this.equipmentIndexStartBlock) fromBlock = this.equipmentIndexStartBlock;
    let chunks = 0;
    while (fromBlock <= targetBlock && chunks < maxChunks) {
      const toBlock = minBigInt(
        targetBlock,
        fromBlock + BigInt(this.equipmentIndexChunkSize) - 1n
      );
      const [minerTransfers, transfers, assignments] = await Promise.all([
        this.client.getLogs({
          address: this.addresses.miner,
          event: MINER_TRANSFER_EVENT,
          fromBlock,
          toBlock
        }),
        this.client.getLogs({
          address: this.addresses.equipment,
          event: EQUIPMENT_TRANSFER_EVENT,
          fromBlock,
          toBlock
        }),
        this.client.getLogs({
          address: this.addresses.equipment,
          event: EQUIPMENT_ASSIGNMENT_EVENT,
          fromBlock,
          toBlock
        })
      ]);
      this.equipmentIndexRevision += 1;
      for (const log of sortedLogs(minerTransfers)) this.#applyMinerTransfer(log);
      for (const log of sortedLogs([
        ...transfers.map((entry) => ({ ...entry, equipmentIndexEvent: 'transfer' })),
        ...assignments.map((entry) => ({ ...entry, equipmentIndexEvent: 'assignment' }))
      ])) {
        if (log.equipmentIndexEvent === 'transfer') this.#applyEquipmentTransfer(log);
        else this.#applyEquipmentAssignment(log);
      }
      this.equipmentIndexedToBlock = toBlock;
      this.equipmentIndexRevision += 1;
      fromBlock = toBlock + 1n;
      chunks += 1;
    }
    if (targetBlock < this.equipmentIndexStartBlock) {
      this.equipmentIndexedToBlock = this.equipmentIndexStartBlock - 1n;
    }
    this.equipmentIndexInitialized = true;
    this.equipmentIndexCheckpointHash = await this.#blockHash(this.equipmentIndexedToBlock);
    this.equipmentIndexError = '';
    this.equipmentIndexLastSyncAt = Date.now();
    return this.equipmentIndexedToBlock;
  }

  async #bootstrapEquipmentOwnershipIndex(blockNumber) {
    const checkpointHash = await this.#blockHash(blockNumber);
    if (!checkpointHash) {
      throw new ApiError(
        503,
        'nft_equipment_index_bootstrap_unavailable',
        'Ronin did not return the confirmed block required to build the NFT ownership index.'
      );
    }
    const [nextMinerTokenIdRaw, nextEquipmentTokenIdRaw] = await Promise.all([
      this.client.readContract({
        address: this.addresses.miner,
        abi: MINER_ABI,
        functionName: 'nextTokenId',
        blockNumber
      }),
      this.client.readContract({
        address: this.addresses.equipment,
        abi: EQUIPMENT_ABI,
        functionName: 'nextTokenId',
        blockNumber
      })
    ]);
    const nextMinerTokenId = safeInteger(nextMinerTokenIdRaw, 'next Miner token ID');
    const nextEquipmentTokenId = safeInteger(nextEquipmentTokenIdRaw, 'next Equipment token ID');
    if (nextMinerTokenId < 1 || nextMinerTokenId > MINER_MAX_SUPPLY + 1) {
      throw new ApiError(
        502,
        'nft_miner_supply_invalid',
        `Ronin returned a Miner supply outside the fixed ${MINER_MAX_SUPPLY}-token collection.`
      );
    }
    if (nextEquipmentTokenId < 1) {
      throw new ApiError(502, 'nft_equipment_supply_invalid', 'Ronin returned an invalid Equipment supply.');
    }

    const state = emptyEquipmentOwnershipIndex();
    for (let start = 1; start <= MINER_MAX_SUPPLY; start += EQUIPMENT_INDEX_BOOTSTRAP_BATCH_SIZE) {
      const tokenIds = integerRange(
        start,
        Math.min(MINER_MAX_SUPPLY, start + EQUIPMENT_INDEX_BOOTSTRAP_BATCH_SIZE - 1)
      );
      const results = await this.client.multicall({
        allowFailure: true,
        blockNumber,
        contracts: tokenIds.map((tokenId) => ({
          address: this.addresses.miner,
          abi: MINER_ABI,
          functionName: 'ownerOf',
          args: [BigInt(tokenId)]
        }))
      });
      for (let index = 0; index < tokenIds.length; index += 1) {
        const result = results[index];
        if (result?.status !== 'success') continue;
        addIndexedOwnership(state.minerOwners, state.minerTokensByOwner, tokenIds[index], result.result);
      }
      await eventLoopTurn();
    }
    if (state.minerOwners.size !== nextMinerTokenId - 1) {
      throw new ApiError(
        502,
        'nft_owner_index_incomplete',
        'Ronin did not return every minted Miner at the confirmed bootstrap block.'
      );
    }

    const mintedEquipment = nextEquipmentTokenId - 1;
    for (let start = 1; start <= mintedEquipment; start += EQUIPMENT_INDEX_BOOTSTRAP_BATCH_SIZE) {
      const tokenIds = integerRange(
        start,
        Math.min(mintedEquipment, start + EQUIPMENT_INDEX_BOOTSTRAP_BATCH_SIZE - 1)
      );
      const results = await this.client.multicall({
        allowFailure: true,
        blockNumber,
        contracts: tokenIds.flatMap((tokenId) => ([
          {
            address: this.addresses.equipment,
            abi: EQUIPMENT_ABI,
            functionName: 'ownerOf',
            args: [BigInt(tokenId)]
          },
          {
            address: this.addresses.equipment,
            abi: EQUIPMENT_ABI,
            functionName: 'equipmentData',
            args: [BigInt(tokenId)]
          }
        ]))
      });
      for (let index = 0; index < tokenIds.length; index += 1) {
        const ownerResult = results[index * 2];
        const dataResult = results[index * 2 + 1];
        if (ownerResult?.status !== 'success' && dataResult?.status !== 'success') continue;
        if (ownerResult?.status !== 'success' || dataResult?.status !== 'success') {
          throw new ApiError(
            502,
            'nft_equipment_index_incomplete',
            `Ronin returned inconsistent confirmed state for Equipment #${tokenIds[index]}.`
          );
        }
        const tokenId = tokenIds[index];
        addIndexedOwnership(state.equipmentOwners, state.equipmentTokensByOwner, tokenId, ownerResult.result);
        const minerId = safeInteger(
          dataResult.result?.equippedToMiner ?? dataResult.result?.[1],
          `Equipment #${tokenId} assigned Miner ID`
        );
        if (minerId > 0) {
          state.equipmentAssignments.set(tokenId, minerId);
          addIndexedToken(state.equipmentTokensByMiner, minerId, tokenId);
        }
      }
      await eventLoopTurn();
    }

    const verifiedHash = await this.#blockHash(blockNumber);
    if (!verifiedHash || verifiedHash.toLowerCase() !== checkpointHash.toLowerCase()) {
      throw new ApiError(
        503,
        'nft_equipment_index_bootstrap_reorg',
        'The confirmed Ronin block changed while the NFT ownership index was being built. Retrying is safe.'
      );
    }
    this.equipmentIndexRevision += 1;
    this.minerOwners = state.minerOwners;
    this.minerTokensByOwner = state.minerTokensByOwner;
    this.equipmentOwners = state.equipmentOwners;
    this.equipmentTokensByOwner = state.equipmentTokensByOwner;
    this.equipmentAssignments = state.equipmentAssignments;
    this.equipmentTokensByMiner = state.equipmentTokensByMiner;
    this.equipmentIndexedToBlock = blockNumber;
    this.equipmentIndexCheckpointHash = verifiedHash;
    this.equipmentIndexInitialized = true;
    this.equipmentIndexRevision += 1;
  }

  async #verifyEquipmentIndexCheckpoint() {
    if (!this.equipmentIndexCheckpointHash || typeof this.client.getBlock !== 'function') return;
    const currentHash = await this.#blockHash(this.equipmentIndexedToBlock);
    if (currentHash && currentHash.toLowerCase() !== this.equipmentIndexCheckpointHash.toLowerCase()) {
      this.#resetEquipmentIndex();
    }
  }

  async #blockHash(blockNumber) {
    if (blockNumber < 0n || typeof this.client.getBlock !== 'function') return '';
    const block = await this.client.getBlock({ blockNumber });
    return String(block?.hash || '');
  }

  #resetEquipmentIndex() {
    this.equipmentIndexRevision += 1;
    this.equipmentIndexedToBlock = this.equipmentIndexStartBlock - 1n;
    this.equipmentConfirmedTargetBlock = this.equipmentIndexStartBlock - 1n;
    this.equipmentIndexCheckpointHash = '';
    this.equipmentIndexInitialized = false;
    this.minerOwners.clear();
    this.minerTokensByOwner.clear();
    this.equipmentOwners.clear();
    this.equipmentTokensByOwner.clear();
    this.equipmentAssignments.clear();
    this.equipmentTokensByMiner.clear();
    this.equipmentIndexRevision += 1;
  }

  #applyMinerTransfer(log) {
    applyOwnershipTransfer({
      log,
      owners: this.minerOwners,
      tokensByOwner: this.minerTokensByOwner,
      label: 'Miner Transfer token ID'
    });
  }

  #applyEquipmentTransfer(log) {
    const tokenId = tokenIdValue(log?.args?.tokenId, 'Equipment Transfer token ID');
    const previousOwner = this.equipmentOwners.get(tokenId);
    if (previousOwner) this.equipmentTokensByOwner.get(previousOwner)?.delete(tokenId);
    const nextOwner = getAddress(log?.args?.to).toLowerCase();
    if (nextOwner === ZERO_ADDRESS) {
      this.equipmentOwners.delete(tokenId);
      this.#setEquipmentAssignment(tokenId, 0);
      return;
    }
    this.equipmentOwners.set(tokenId, nextOwner);
    let bucket = this.equipmentTokensByOwner.get(nextOwner);
    if (!bucket) {
      bucket = new Set();
      this.equipmentTokensByOwner.set(nextOwner, bucket);
    }
    bucket.add(tokenId);
  }

  #applyEquipmentAssignment(log) {
    const tokenId = tokenIdValue(log?.args?.tokenId, 'Equipment assignment token ID');
    const minerId = Number(log?.args?.minerId || 0n);
    if (!Number.isSafeInteger(minerId) || minerId < 0) {
      throw new ApiError(502, 'nft_equipment_index_invalid', 'Ronin returned an invalid Equipment assignment.');
    }
    this.#setEquipmentAssignment(tokenId, minerId);
  }

  #setEquipmentAssignment(tokenId, minerId) {
    const previousMinerId = this.equipmentAssignments.get(tokenId);
    if (previousMinerId) this.equipmentTokensByMiner.get(previousMinerId)?.delete(tokenId);
    if (minerId === 0) {
      this.equipmentAssignments.delete(tokenId);
      return;
    }
    this.equipmentAssignments.set(tokenId, minerId);
    let bucket = this.equipmentTokensByMiner.get(minerId);
    if (!bucket) {
      bucket = new Set();
      this.equipmentTokensByMiner.set(minerId, bucket);
    }
    bucket.add(tokenId);
  }

  async equipment(tokenId, options = {}) {
    try {
      const blockNumber = options.blockNumber === undefined
        ? undefined
        : nonnegativeBigInt(options.blockNumber, 'Equipment read block');
      const [owner, data, bonus, tokenUri] = await Promise.all([
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)], blockNumber }),
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'equipmentData', args: [BigInt(tokenId)], blockNumber }),
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'bonusFor', args: [BigInt(tokenId)], blockNumber }),
        this.client.readContract({ address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'tokenURI', args: [BigInt(tokenId)], blockNumber })
      ]);
      return {
        owner,
        definitionId: safeInteger(data.definitionId ?? data[0], 'definition ID'),
        equippedToMiner: safeInteger(data.equippedToMiner ?? data[1], 'equipped Miner ID'),
        slot: safeInteger(data.slot ?? data[2], 'equipment slot'),
        rarity: safeInteger(data.rarity ?? data[3], 'rarity'),
        damaged: Boolean(data.damaged ?? data[4]),
        bonus: safeInteger(bonus, 'equipment bonus'),
        tokenUri: String(tokenUri || '')
      };
    } catch (error) {
      throw chainReadError(error, `Equipment #${tokenId}`);
    }
  }

  async equipmentBatch(tokenIdsInput, options = {}) {
    const tokenIds = Array.from(tokenIdsInput || []).map((value) => tokenIdValue(value, 'equipment token ID'));
    if (tokenIds.length === 0) return [];
    try {
      const calls = tokenIds.flatMap((tokenId) => [
        { address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] },
        { address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'equipmentData', args: [BigInt(tokenId)] },
        { address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'bonusFor', args: [BigInt(tokenId)] },
        { address: this.addresses.equipment, abi: EQUIPMENT_ABI, functionName: 'tokenURI', args: [BigInt(tokenId)] }
      ]);
      const blockNumber = options.blockNumber === undefined
        ? undefined
        : nonnegativeBigInt(options.blockNumber, 'Equipment batch block');
      const values = await this.client.multicall({ contracts: calls, allowFailure: false, blockNumber });
      return tokenIds.map((tokenId, index) => {
        const [owner, data, bonus, tokenUri] = values.slice(index * 4, index * 4 + 4);
        return {
          owner,
          definitionId: safeInteger(data.definitionId ?? data[0], 'equipment definition'),
          equippedToMiner: safeInteger(data.equippedToMiner ?? data[1], 'equipped Miner'),
          slot: safeInteger(data.slot ?? data[2], 'equipment slot'),
          rarity: safeInteger(data.rarity ?? data[3], 'rarity'),
          damaged: Boolean(data.damaged ?? data[4]),
          bonus: safeInteger(bonus, 'equipment bonus'),
          tokenUri: String(tokenUri || '')
        };
      });
    } catch (error) {
      throw chainReadError(error, 'Equipment inventory');
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
  return Object.fromEntries(['armor', 'pickaxe', 'blaster', 'dynamite', 'helmet', 'backpack']
    .map((slot, index) => [slot, safeInteger(value[index] ?? value[slot], `loadout ${slot}`)]));
}

function equipmentNames(profile, manifest) {
  const names = { armor: 'None', pickaxe: 'Starter Pickaxe', blaster: 'None', dynamite: 'None', helmet: 'None', backpack: 'None' };
  for (const [slot, item] of Object.entries(profile.equipment || {})) {
    if (item) names[slot] = manifest.equipmentDefinitions[String(item.definitionId)]?.name || `Definition ${item.definitionId}`;
  }
  return names;
}

function normalizeStruct(value, names, booleans = new Set()) {
  return Object.freeze(Object.fromEntries(names.map((name, index) => [
    name,
    booleans.has(name) ? Boolean(value[name] ?? value[index]) : safeInteger(value[name] ?? value[index], name)
  ])));
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

function equipmentCursor(value) {
  if (value === undefined || value === null || value === '') {
    return { indexedToBlock: null, tokenId: 0 };
  }
  try {
    const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
    const match = decoded.match(/^(\d+):(\d+)$/);
    if (!match) throw new Error('invalid cursor');
    return {
      indexedToBlock: nonnegativeBigInt(match[1], 'Equipment inventory cursor block'),
      tokenId: positiveInteger(match[2], 'Equipment inventory cursor token')
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_nft_equipment_cursor', 'The Equipment inventory cursor is invalid.');
  }
}

function equipmentSnapshotCursor(value) {
  try {
    const decoded = Buffer.from(String(value || ''), 'base64url').toString('utf8');
    const match = decoded.match(/^([A-Za-z0-9_-]{16,64}):(\d+)$/);
    if (!match) throw new Error('invalid cursor');
    return {
      snapshotId: match[1],
      offset: safeInteger(match[2], 'Equipment inventory cursor offset')
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_nft_equipment_cursor', 'The Equipment inventory cursor is invalid.');
  }
}

function encodeEquipmentSnapshotCursor(snapshotId, offset) {
  return Buffer.from(`${snapshotId}:${offset}`, 'utf8').toString('base64url');
}

function equipmentPriorityTokenIds(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(',').filter(Boolean);
  if (values.length > 6) {
    throw new ApiError(400, 'nft_equipment_priority_too_large', 'At most six active Loadout tokens can be prioritized.');
  }
  return [...new Set(values.map((entry) => tokenIdValue(entry, 'priority Equipment token ID')))];
}

function equipmentInventoryChanged() {
  return new ApiError(
    409,
    'nft_equipment_inventory_changed',
    'Equipment or Miner ownership changed while the inventory page was loading. Refresh and try again.'
  );
}

function encodeEquipmentCursor(indexedToBlock, tokenId) {
  return Buffer.from(`${indexedToBlock}:${tokenId}`, 'utf8').toString('base64url');
}

function equipmentPageLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_EQUIPMENT_PAGE_SIZE;
  const limit = positiveInteger(value, 'Equipment inventory page size');
  if (limit > MAX_EQUIPMENT_PAGE_SIZE) {
    throw new ApiError(
      400,
      'nft_equipment_page_too_large',
      `Equipment inventory pages are limited to ${MAX_EQUIPMENT_PAGE_SIZE} items.`
    );
  }
  return limit;
}

function nonnegativeBigInt(value, label) {
  try {
    const number = BigInt(value);
    if (number < 0n) throw new Error('negative');
    return number;
  } catch {
    throw new ApiError(400, 'invalid_nft_value', `${label} must be a non-negative integer.`);
  }
}

function boundedNonnegativeInteger(value, label, maximum) {
  const number = safeInteger(value, label);
  if (number > maximum) {
    throw new ApiError(400, 'invalid_nft_value', `${label} must not exceed ${maximum}.`);
  }
  return number;
}

function boundedPositiveInteger(value, label, maximum) {
  const number = positiveInteger(value, label);
  if (number > maximum) {
    throw new ApiError(400, 'invalid_nft_value', `${label} must not exceed ${maximum}.`);
  }
  return number;
}

function minBigInt(left, right) {
  return left < right ? left : right;
}

function sortedLogs(logs) {
  return [...(logs || [])].sort((left, right) => {
    for (const key of ['blockNumber', 'transactionIndex', 'logIndex']) {
      const difference = BigInt(left?.[key] ?? 0) - BigInt(right?.[key] ?? 0);
      if (difference < 0n) return -1;
      if (difference > 0n) return 1;
    }
    return 0;
  });
}

function emptyEquipmentOwnershipIndex() {
  return {
    minerOwners: new Map(),
    minerTokensByOwner: new Map(),
    equipmentOwners: new Map(),
    equipmentTokensByOwner: new Map(),
    equipmentAssignments: new Map(),
    equipmentTokensByMiner: new Map()
  };
}

function integerRange(start, end) {
  return Array.from({ length: Math.max(0, end - start + 1) }, (_value, index) => start + index);
}

function addIndexedToken(tokensByKey, key, tokenId) {
  let bucket = tokensByKey.get(key);
  if (!bucket) {
    bucket = new Set();
    tokensByKey.set(key, bucket);
  }
  bucket.add(tokenId);
}

function addIndexedOwnership(owners, tokensByOwner, tokenId, ownerInput) {
  const owner = getAddress(ownerInput).toLowerCase();
  if (owner === ZERO_ADDRESS) {
    throw new ApiError(502, 'nft_equipment_index_invalid', 'Ronin returned the zero address as an NFT owner.');
  }
  owners.set(tokenId, owner);
  addIndexedToken(tokensByOwner, owner, tokenId);
}

function applyOwnershipTransfer({ log, owners, tokensByOwner, label }) {
  const tokenId = tokenIdValue(log?.args?.tokenId, label);
  const previousOwner = owners.get(tokenId);
  if (previousOwner) tokensByOwner.get(previousOwner)?.delete(tokenId);
  const nextOwner = getAddress(log?.args?.to).toLowerCase();
  if (nextOwner === ZERO_ADDRESS) {
    owners.delete(tokenId);
    return tokenId;
  }
  owners.set(tokenId, nextOwner);
  let bucket = tokensByOwner.get(nextOwner);
  if (!bucket) {
    bucket = new Set();
    tokensByOwner.set(nextOwner, bucket);
  }
  bucket.add(tokenId);
  return tokenId;
}

function eventLoopTurn() {
  return new Promise((resolveTurn) => setImmediate(resolveTurn));
}

async function settleWithin(promise, timeoutMs) {
  if (timeoutMs === 0) return;
  await Promise.race([
    promise,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs))
  ]);
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
  return new ApiError(502, 'nft_chain_read_failed', `Unable to read ${label} from Ronin.`);
}
