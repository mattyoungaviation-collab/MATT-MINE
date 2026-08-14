import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  isAddressEqual,
  parseAbi
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError, assertApi } from './errors.js';
import { nftRpcUrlFromEnvironment } from './nft-rpc-url.js';

const SETTLEMENT_ABI = parseAbi([
  'function OPERATOR_ROLE() view returns (bytes32)',
  'function rewardSigner() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
  'function playerNonces(address player) view returns (uint256)',
  'function processedRuns(bytes32 runId) view returns (bool)',
  'function paused() view returns (bool)',
  'function mapVersions(bytes32 versionId) view returns (bytes32 mapId,bytes32 contentHash,uint128 conversionRate,uint128 maximumPayout,uint32 mineableCrystalUnits,uint32 runTimeout,bool approved,bool retired)',
  'function activeRun(uint256 minerId) view returns ((bytes32 runId,bytes32 mapVersion,bytes32 loadoutHash,address player,uint128 conversionRate,uint128 maximumPayout,uint40 startedAt,uint32 mineableCrystalUnits,uint32 runTimeout,uint16 carryCapacity,uint16 deathRetentionBps,uint256 nonce))',
  'function beginRun((address player,uint256 minerId,bytes32 mapVersion,bytes32 loadoutHash,uint256 nonce,uint256 deadline) authorization,bytes playerSignature) returns (bytes32 runId)',
  'function settleRun((address player,uint256 minerId,bytes32 runId,bytes32 mapVersion,bytes32 loadoutHash,uint8 outcome,uint8 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline) result,bytes rewardSignature)'
]);
const LOADOUT_ABI = parseAbi([
  'function loadoutHash(uint256 minerId) view returns (bytes32)'
]);

export const NFT_V2_RUN_AUTHORIZATION_TYPES = Object.freeze({
  RunAuthorization: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'mapVersion', type: 'bytes32' },
    { name: 'loadoutHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});
const RUN_RESULT_TYPES = Object.freeze({
  RunResult: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'runId', type: 'bytes32' },
    { name: 'mapVersion', type: 'bytes32' },
    { name: 'loadoutHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'completedPhases', type: 'uint8' },
    { name: 'minedCrystalUnits', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});

export class NftGameplayService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.chainId = positiveInteger(options.chainId || 2020, 'NFT gameplay chain ID');
    this.rpcUrl = requiredUrl(options.rpcUrl, 'NFT gameplay RPC URL');
    this.settlementAddress = requiredAddress(options.settlementAddress, 'NFT Settlement address');
    this.loadoutAddress = requiredAddress(options.loadoutAddress, 'NFT Loadout address');
    this.operatorAddress = requiredAddress(options.operatorAddress, 'NFT Game Operator address');
    this.signerAddress = requiredAddress(options.signerAddress, 'NFT Reward Signer address');
    this.operatorPrivateKey = requiredPrivateKey(options.operatorPrivateKey, 'NFT Game Operator private key');
    this.signerPrivateKey = requiredPrivateKey(options.signerPrivateKey, 'NFT Reward Signer private key');
    this.metadataService = options.metadataService;
    this.mapVersions = normalizeMapVersions(options.mapVersions);
    assertApi(this.metadataService, 500, 'nft_gameplay_metadata_missing', 'NFT gameplay requires the V2 metadata chain reader.');
    const chain = defineChain({
      id: this.chainId,
      name: this.chainId === 2020 ? 'Ronin Mainnet' : 'Saigon Testnet',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } }
    });
    this.operatorAccount = privateKeyToAccount(this.operatorPrivateKey);
    this.signerAccount = privateKeyToAccount(this.signerPrivateKey);
    if (!isAddressEqual(this.operatorAccount.address, this.operatorAddress)) {
      throw new Error(`NFT Game Operator key resolves to ${this.operatorAccount.address}, expected ${this.operatorAddress}.`);
    }
    if (!isAddressEqual(this.signerAccount.address, this.signerAddress)) {
      throw new Error(`NFT Reward Signer key resolves to ${this.signerAccount.address}, expected ${this.signerAddress}.`);
    }
    if (isAddressEqual(this.operatorAddress, this.signerAddress)) {
      throw new Error('NFT Game Operator and Reward Signer must be separate wallets.');
    }
    this.publicClient = options.publicClient || createPublicClient({ chain, transport: http(this.rpcUrl) });
    this.operatorClient = options.operatorClient || createWalletClient({
      account: this.operatorAccount,
      chain,
      transport: http(this.rpcUrl)
    });
    this.runQueue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) return this;
    const operatorRole = await this.publicClient.readContract({
      address: this.settlementAddress,
      abi: SETTLEMENT_ABI,
      functionName: 'OPERATOR_ROLE'
    });
    const [chainId, paused, signer, operatorAuthorized] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({ address: this.settlementAddress, abi: SETTLEMENT_ABI, functionName: 'paused' }),
      this.publicClient.readContract({ address: this.settlementAddress, abi: SETTLEMENT_ABI, functionName: 'rewardSigner' }),
      this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'hasRole',
        args: [operatorRole, this.operatorAddress]
      })
    ]);
    if (chainId !== this.chainId) throw new Error(`NFT gameplay RPC is on chain ${chainId}.`);
    if (paused) throw new Error('NFT V2 Settlement contract is paused.');
    if (!isAddressEqual(signer, this.signerAddress)) throw new Error(`NFT Settlement Reward Signer is ${signer}.`);
    if (!operatorAuthorized) throw new Error('NFT Game Operator lacks OPERATOR_ROLE.');
    for (const [mode, versionId] of Object.entries(this.mapVersions)) {
      const state = await this.#mapState(versionId);
      if (!state.approved || state.retired) throw new Error(`${mode} map version ${versionId} is not active on-chain.`);
    }
    return this;
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      contractVersion: 2,
      chainId: this.chainId,
      settlement: this.settlementAddress,
      loadout: this.loadoutAddress,
      mapVersions: { ...this.mapVersions }
    };
  }

  setMapVersion(mode, versionId) {
    this.mapVersions[normalizedMode(mode)] = bytes32(versionId, `${mode} map version`);
    return this.mapVersions[normalizedMode(mode)];
  }

  clearMapVersion(mode, versionId = '') {
    const key = normalizedMode(mode);
    if (!versionId || this.mapVersions[key] === String(versionId).toLowerCase()) delete this.mapVersions[key];
  }

  async playerMiner(address, requestedMinerId = 0) {
    const player = getAddress(address);
    if (requestedMinerId) {
      const profile = await this.metadataService.minerProfile(requestedMinerId);
      if (!isAddressEqual(profile.owner, player)) {
        throw new ApiError(403, 'nft_miner_owner_mismatch', `Miner #${requestedMinerId} is not owned by this wallet.`);
      }
      return profile;
    }
    return this.metadataService.playerMiner(player);
  }

  async prepareRunAuthorization({ address, minerId, mode }) {
    const player = getAddress(address);
    const profile = await this.playerMiner(player, minerId);
    assertApi(profile, 403, 'miner_nft_required', 'A Miner NFT owned by this wallet is required.');
    assertApi(!profile.gameplay.runLocked, 409, 'nft_miner_in_run', `Miner #${profile.minerId} is already locked in a run.`);
    const mapVersion = this.#mapVersion(mode);
    const [nonce, loadoutHash, mapState] = await Promise.all([
      this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'playerNonces',
        args: [player]
      }),
      this.publicClient.readContract({
        address: this.loadoutAddress,
        abi: LOADOUT_ABI,
        functionName: 'loadoutHash',
        args: [BigInt(profile.minerId)]
      }),
      this.#mapState(mapVersion)
    ]);
    assertApi(mapState.approved && !mapState.retired, 503, 'nft_map_unavailable', 'The selected mine version is not approved on-chain.');
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + 10 * 60);
    const authorization = {
      player,
      minerId: BigInt(profile.minerId),
      mapVersion,
      loadoutHash,
      nonce,
      deadline
    };
    return {
      contractVersion: 2,
      mode: normalizedMode(mode),
      authorization: jsonSafe(authorization),
      typedData: {
        domain: this.#domain(),
        types: NFT_V2_RUN_AUTHORIZATION_TYPES,
        primaryType: 'RunAuthorization',
        message: jsonSafe(authorization)
      }
    };
  }

  async beginRun({ address, minerId, mode, authorization, playerSignature }) {
    return this.#serialize(async () => {
      let broadcastAttempted = false;
      try {
        const player = getAddress(address);
        const profile = await this.playerMiner(player, minerId);
        const expectedMapVersion = this.#mapVersion(mode);
        const supplied = normalizeAuthorization(authorization);
        assertApi(isAddressEqual(supplied.player, player), 422, 'nft_run_authorization_player', 'Run authorization belongs to another wallet.');
        assertApi(supplied.minerId === BigInt(profile.minerId), 422, 'nft_run_authorization_miner', 'Run authorization is for another Miner.');
        assertApi(supplied.mapVersion === expectedMapVersion, 422, 'nft_run_authorization_map', 'Run authorization is for another mine version.');
        assertApi(/^0x[0-9a-f]{130}$/i.test(String(playerSignature || '')), 422, 'nft_run_signature_invalid', 'Approve the Miner run in Ronin Wallet.');
        const [nonce, loadoutHash] = await Promise.all([
          this.publicClient.readContract({ address: this.settlementAddress, abi: SETTLEMENT_ABI, functionName: 'playerNonces', args: [player] }),
          this.publicClient.readContract({ address: this.loadoutAddress, abi: LOADOUT_ABI, functionName: 'loadoutHash', args: [BigInt(profile.minerId)] })
        ]);
        assertApi(supplied.nonce === nonce, 409, 'nft_run_authorization_stale', 'The run approval is stale. Approve it again.');
        assertApi(supplied.loadoutHash === loadoutHash, 409, 'nft_run_loadout_changed', 'The Miner loadout changed. Approve the run again.');
        assertApi(supplied.deadline >= BigInt(Math.floor(Date.now() / 1_000)), 422, 'nft_run_authorization_expired', 'The run approval expired. Approve it again.');
        broadcastAttempted = true;
        let hash = null;
        try {
          hash = await this.operatorClient.writeContract({
            address: this.settlementAddress,
            abi: SETTLEMENT_ABI,
            functionName: 'beginRun',
            args: [supplied, playerSignature]
          });
          await this.#confirmed(hash, 'NFT V2 run start');
        } catch (transactionError) {
          let active;
          try {
            active = await this.#activeRun(profile.minerId);
          } catch (inspectionError) {
            const uncertain = new ApiError(
              503,
              'nft_run_start_uncertain',
              'The chain response is unavailable. This mine attempt remains reserved until its Miner lock can be confirmed.'
            );
            uncertain.cause = inspectionError;
            throw uncertain;
          }
          if (!matchesAuthorizedRun(active, supplied)) {
            if (active.runId === zeroBytes32()) transactionError.nftRunDefinitelyNotStarted = true;
            throw transactionError;
          }
          return this.#startedRunResult(profile, active, hash, true);
        }
        const active = await this.#activeRun(profile.minerId);
        assertApi(active.runId !== zeroBytes32(), 502, 'nft_run_start_missing', 'The confirmed Miner run was not found on-chain.');
        return this.#startedRunResult(profile, active, hash, false);
      } catch (error) {
        if (!broadcastAttempted && error && typeof error === 'object') {
          error.nftRunDefinitelyNotStarted = true;
        }
        throw error;
      }
    });
  }

  async #startedRunResult(profile, active, hash, recovered) {
    return {
      version: 2,
      contractVersion: 2,
      minerId: profile.minerId,
      profile: await this.metadataService.minerProfile(profile.minerId),
      crystalCarryLimit: Number(active.carryCapacity),
      runId: active.runId,
      mapVersion: active.mapVersion,
      loadoutHash: active.loadoutHash,
      beginTransactionHash: hash,
      ...(recovered ? { recovered: true } : {})
    };
  }

  async settleRun({ address, minerId, runId = '', result, completedPhases }) {
    return this.#serialize(async () => {
      const player = getAddress(address);
      const active = await this.#activeRun(minerId);
      const expectedRunId = runId ? bytes32(runId, 'run ID') : '';
      if (active.runId === zeroBytes32()) {
        if (expectedRunId) {
          const alreadyProcessed = await this.publicClient.readContract({
            address: this.settlementAddress,
            abi: SETTLEMENT_ABI,
            functionName: 'processedRuns',
            args: [expectedRunId]
          });
          if (alreadyProcessed) return this.#alreadySettled(player, minerId, result);
        }
        throw new ApiError(409, 'nft_run_not_locked', `Miner #${minerId} has no active on-chain run.`);
      }
      assertApi(!expectedRunId || active.runId === expectedRunId, 409, 'nft_run_id_mismatch', 'The active on-chain run does not match this server run.');
      const alreadyProcessed = await this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'processedRuns',
        args: [active.runId]
      });
      if (alreadyProcessed) return this.#alreadySettled(player, minerId, result);
      const extraction = result.extracted === true;
      const phaseCount = normalizedPhaseCount(completedPhases);
      const minedCrystalUnits = Math.min(4_294_967_295, Math.max(0, Math.floor(Number(result.crystalsCarried || 0))));
      const receipt = {
        player,
        minerId: BigInt(minerId),
        runId: active.runId,
        mapVersion: active.mapVersion,
        loadoutHash: active.loadoutHash,
        outcome: extraction ? 0 : 1,
        completedPhases: phaseCount,
        minedCrystalUnits,
        nonce: active.nonce,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 15 * 60)
      };
      const signature = await this.signerAccount.signTypedData({
        domain: this.#domain(),
        types: RUN_RESULT_TYPES,
        primaryType: 'RunResult',
        message: receipt
      });
      const hash = await this.operatorClient.writeContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'settleRun',
        args: [receipt, signature]
      });
      await this.#confirmed(hash, 'NFT V2 run settlement');
      const carried = Math.min(BigInt(minedCrystalUnits), active.carryCapacity);
      const converted = minBigInt(carried * active.conversionRate, active.maximumPayout, 100_000n * 10n ** 18n);
      const crystalsBanked = extraction ? converted : converted * active.deathRetentionBps / 10_000n;
      const profile = await this.metadataService.minerProfile(minerId);
      return {
        version: 2,
        minerId,
        outcome: extraction ? 'extraction' : 'death',
        completedPhases: phaseCount,
        minedCrystalUnits,
        crystalsBankedRaw: crystalsBanked.toString(),
        // The server mirror is display-only. The contract's Crystal Bank is authoritative.
        crystalsBanked: Number(crystalsBanked / 10n ** 18n),
        xpBanked: extraction ? [0, 10, 25, 45, 70, 100][phaseCount] : 0,
        newLevel: profile.progression.level,
        transactionHash: hash,
        profile
      };
    });
  }

  async cancelRun({ address, minerId, runId = '' }) {
    const active = await this.#activeRun(minerId);
    if (active.runId === zeroBytes32()) return { cancelled: false, minerId };
    // Abandonment is an on-chain death: no XP or Crystals are fabricated, and
    // the contract applies the approved Armor/Backpack death consequences.
    const settlement = await this.settleRun({
      address,
      minerId,
      runId,
      result: { extracted: false, crystalsCarried: 0 },
      completedPhases: 0
    });
    return { cancelled: true, minerId, transactionHash: settlement.transactionHash, settlement };
  }

  async #alreadySettled(player, minerId, result) {
    const profile = await this.playerMiner(player, minerId);
    return {
      version: 2,
      minerId,
      outcome: result.extracted === true ? 'extraction' : 'death',
      transactionHash: null,
      alreadySettled: true,
      profile
    };
  }

  async #activeRun(minerId) {
    const value = await this.publicClient.readContract({
      address: this.settlementAddress,
      abi: SETTLEMENT_ABI,
      functionName: 'activeRun',
      args: [BigInt(minerId)]
    });
    return normalizeStruct(value, [
      'runId', 'mapVersion', 'loadoutHash', 'player', 'conversionRate', 'maximumPayout',
      'startedAt', 'mineableCrystalUnits', 'runTimeout', 'carryCapacity',
      'deathRetentionBps', 'nonce'
    ]);
  }

  async #mapState(versionId) {
    const value = await this.publicClient.readContract({
      address: this.settlementAddress,
      abi: SETTLEMENT_ABI,
      functionName: 'mapVersions',
      args: [versionId]
    });
    return normalizeStruct(value, [
      'mapId', 'contentHash', 'conversionRate', 'maximumPayout',
      'mineableCrystalUnits', 'runTimeout', 'approved', 'retired'
    ]);
  }

  #mapVersion(mode) {
    const version = this.mapVersions[normalizedMode(mode)];
    if (!version) throw new ApiError(422, 'nft_map_mode_invalid', 'This mine has no approved NFT V2 map version.');
    return version;
  }

  #domain() {
    return {
      name: 'MATT Mine V2 Run Settlement',
      version: '2',
      chainId: this.chainId,
      verifyingContract: this.settlementAddress
    };
  }

  async #confirmed(hash, label) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
    return receipt;
  }

  #serialize(operation) {
    const next = this.runQueue.then(operation, operation);
    this.runQueue = next.catch(() => undefined);
    return next;
  }
}

export function createNftGameplayServiceFromEnvironment(metadataService, environment = process.env, options = {}) {
  const enabled = environment.MATT_MINE_NFT_GAMEPLAY_ENABLED === 'true';
  if (!enabled) return null;
  if (String(environment.MATT_MINE_NFT_CONTRACT_VERSION || '2') !== '2') {
    throw new Error('Only the NFT V2 gameplay contracts may be enabled for new deployments.');
  }
  return new NftGameplayService({
    enabled,
    chainId: Number(environment.MATT_MINE_NFT_CHAIN_ID || 2020),
    rpcUrl: nftRpcUrlFromEnvironment(environment),
    settlementAddress: environment.MATT_MINE_NFT_SETTLEMENT_ADDRESS,
    loadoutAddress: environment.MATT_MINE_NFT_LOADOUT_ADDRESS,
    operatorAddress: environment.MATT_MINE_NFT_GAME_OPERATOR_ADDRESS,
    signerAddress: environment.MATT_MINE_NFT_REWARD_SIGNER_ADDRESS,
    operatorPrivateKey: environment.MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY,
    signerPrivateKey: environment.MATT_MINE_NFT_REWARD_SIGNER_PRIVATE_KEY,
    mapVersions: parseMapVersions(environment.MATT_MINE_NFT_MAP_VERSIONS_JSON),
    metadataService,
    ...options
  });
}

function normalizeAuthorization(value = {}) {
  try {
    return {
      player: getAddress(value.player),
      minerId: BigInt(value.minerId),
      mapVersion: bytes32(value.mapVersion, 'map version'),
      loadoutHash: bytes32(value.loadoutHash, 'loadout hash'),
      nonce: BigInt(value.nonce),
      deadline: BigInt(value.deadline)
    };
  } catch {
    throw new ApiError(422, 'nft_run_authorization_invalid', 'The Miner run authorization is invalid.');
  }
}

function normalizeMapVersions(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [mode, version] of Object.entries(source)) result[normalizedMode(mode)] = bytes32(version, `${mode} map version`);
  if (!result.arena || !result.paid) throw new Error('NFT V2 map versions must configure both arena and paid.');
  return result;
}

function parseMapVersions(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    throw new Error('MATT_MINE_NFT_MAP_VERSIONS_JSON must be valid JSON.');
  }
}

function normalizedMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'pass') return 'paid';
  if (mode === 'matt-arena') return 'arena';
  return mode;
}

function normalizedPhaseCount(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 5) {
    throw new ApiError(422, 'nft_phase_count_invalid', 'The completed phase count is invalid.');
  }
  return number;
}

function matchesAuthorizedRun(active, authorization) {
  return active.runId !== zeroBytes32() &&
    isAddressEqual(active.player, authorization.player) &&
    active.mapVersion === authorization.mapVersion &&
    active.loadoutHash === authorization.loadoutHash &&
    BigInt(active.nonce) === authorization.nonce;
}

function normalizeStruct(value, names) {
  return Object.fromEntries(names.map((name, index) => [name, value[name] ?? value[index]]));
}

function minBigInt(...values) {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}

function zeroBytes32() {
  return `0x${'0'.repeat(64)}`;
}

function bytes32(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized) || normalized === zeroBytes32()) throw new Error(`${label} must be a nonzero bytes32.`);
  return normalized;
}

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || ''));
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
}

function requiredPrivateKey(value, label) {
  const privateKey = String(value || '');
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error(`${label} is missing or invalid.`);
  return privateKey;
}

function requiredUrl(value, label) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  return url.href;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}
