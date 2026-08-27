import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseAbi,
  parseAbiItem
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError, assertApi } from './errors.js';
import { nftRpcUrlFromEnvironment } from './nft-rpc-url.js';

const ZERO_BYTES32 = `0x${'00'.repeat(32)}`;
const DEFAULT_OPERATOR_MINIMUM_BALANCE_WEI = 20_000_000_000_000_000n;
const DEFAULT_SETTLEMENT_RECONCILIATION_ATTEMPTS = 6;
const DEFAULT_SETTLEMENT_RECONCILIATION_DELAY_MS = 1_500;
const DEFAULT_SETTLEMENT_GAS_LIMIT = 1_200_000n;
const DEFAULT_SETTLEMENT_LOG_QUERY_BLOCK_SPAN = 90;

const ENDLESS_ABI = parseAbi([
  'function OPERATOR_ROLE() view returns (bytes32)',
  'function rewardSigner() view returns (address)',
  'function hasRole(bytes32 role,address account) view returns (bool)',
  'function paused() view returns (bool)',
  'function loadout() view returns (address)',
  'function crystalUnit() view returns (uint256)',
  'function playerNonces(address player) view returns (uint256)',
  'function processedRuns(bytes32 runId) view returns (bool)',
  'function versions(bytes32 versionId) view returns (bytes32 generatorHash,bytes32 configHash,uint128 conversionRate,uint128 maximumPayout,uint128 maximumDailyPayout,uint32 mineableCrystalUnits,uint32 maximumPhases,uint32 phaseXp,uint32 maximumRunXp,uint32 maximumWalletXpPerDay,uint32 maximumMinerXpPerDay,uint32 checkpointTimeout,bool failedRunsRetainXp,bool approved,bool retired)',
  'function activeRun(uint256 minerId) view returns ((bytes32 runId,bytes32 versionId,bytes32 loadoutHash,bytes32 checkpointDigest,address player,uint128 conversionRate,uint128 maximumPayout,uint128 maximumDailyPayout,uint40 startedAt,uint40 lastCheckpointAt,uint32 mineableCrystalUnits,uint32 maximumPhases,uint32 phaseXp,uint32 maximumRunXp,uint32 maximumWalletXpPerDay,uint32 maximumMinerXpPerDay,uint32 checkpointTimeout,uint32 completedPhases,uint32 minedCrystalUnits,uint16 carryCapacity,uint16 deathRetentionBps,bool failedRunsRetainXp,uint256 nonce))',
  'function beginRun((address player,uint256 minerId,bytes32 versionId,bytes32 loadoutHash,uint256 nonce,uint256 deadline) authorization,bytes playerSignature) returns (bytes32 runId)',
  'function checkpoint((address player,uint256 minerId,bytes32 runId,bytes32 versionId,bytes32 previousDigest,bytes32 checkpointDigest,uint32 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline) receipt,bytes rewardSignature)',
  'function settle((address player,uint256 minerId,bytes32 runId,bytes32 versionId,bytes32 checkpointDigest,uint8 outcome,uint32 completedPhases,uint32 minedCrystalUnits,uint256 nonce,uint256 deadline) result,bytes rewardSignature)',
  'error AuthorizationExpired()',
  'error InvalidSignature()',
  'error NotMinerOwner()',
  'error RunNotActive()',
  'error RunMismatch()',
  'error RunAlreadyProcessed()',
  'error InvalidRunResult()',
  'error UnsafeRoleOverlap()',
  'error MinerNotInRun(uint256 minerId)',
  'error AccessControlUnauthorizedAccount(address account,bytes32 neededRole)',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()'
]);
const LOADOUT_ABI = parseAbi(['function loadoutHash(uint256 minerId) view returns (bytes32)']);
const SETTLED_EVENT = parseAbiItem('event EndlessRunSettled(bytes32 indexed runId,address indexed player,uint256 indexed minerId,uint8 outcome,uint32 completedPhases,uint32 minedCrystalUnits,uint256 xpBanked,uint256 crystalsBanked,bytes32 checkpointDigest)');

export const ENDLESS_RUN_AUTHORIZATION_TYPES = Object.freeze({
  EndlessRunAuthorization: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'versionId', type: 'bytes32' },
    { name: 'loadoutHash', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});
const CHECKPOINT_TYPES = Object.freeze({
  EndlessCheckpoint: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'runId', type: 'bytes32' },
    { name: 'versionId', type: 'bytes32' },
    { name: 'previousDigest', type: 'bytes32' },
    { name: 'checkpointDigest', type: 'bytes32' },
    { name: 'completedPhases', type: 'uint32' },
    { name: 'minedCrystalUnits', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});
const RESULT_TYPES = Object.freeze({
  EndlessResult: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'runId', type: 'bytes32' },
    { name: 'versionId', type: 'bytes32' },
    { name: 'checkpointDigest', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'completedPhases', type: 'uint32' },
    { name: 'minedCrystalUnits', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});

export class EndlessSettlementService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.chainId = positiveInteger(options.chainId || 2020, 'Endless settlement chain ID');
    this.rpcUrl = requiredUrl(options.rpcUrl, 'Endless settlement RPC URL');
    this.settlementAddress = requiredAddress(options.settlementAddress, 'Endless Settlement address');
    this.loadoutAddress = requiredAddress(options.loadoutAddress, 'NFT Loadout address');
    this.operatorAddress = requiredAddress(options.operatorAddress, 'NFT Game Operator address');
    this.signerAddress = requiredAddress(options.signerAddress, 'NFT Reward Signer address');
    this.operatorAccount = privateKeyToAccount(requiredPrivateKey(options.operatorPrivateKey, 'NFT Game Operator private key'));
    this.signerAccount = privateKeyToAccount(requiredPrivateKey(options.signerPrivateKey, 'NFT Reward Signer private key'));
    this.versionIds = normalizeVersionIds(options.versionIds);
    this.deploymentBlock = nonnegativeBigInt(options.deploymentBlock || 0, 'Endless deployment block');
    this.operatorMinimumBalanceWei = nonnegativeBigInt(
      options.operatorMinimumBalanceWei ?? DEFAULT_OPERATOR_MINIMUM_BALANCE_WEI,
      'Endless operator minimum RON balance'
    );
    this.settlementReconciliationAttempts = boundedPositiveInteger(
      options.settlementReconciliationAttempts ?? DEFAULT_SETTLEMENT_RECONCILIATION_ATTEMPTS,
      'Endless settlement reconciliation attempts',
      20
    );
    this.settlementReconciliationDelayMs = boundedNonnegativeInteger(
      options.settlementReconciliationDelayMs ?? DEFAULT_SETTLEMENT_RECONCILIATION_DELAY_MS,
      'Endless settlement reconciliation delay',
      10_000
    );
    this.settlementGasLimit = positiveBigInt(
      options.settlementGasLimit ?? DEFAULT_SETTLEMENT_GAS_LIMIT,
      'Endless settlement gas limit'
    );
    this.settlementLogQueryBlockSpan = boundedPositiveInteger(
      options.settlementLogQueryBlockSpan ?? DEFAULT_SETTLEMENT_LOG_QUERY_BLOCK_SPAN,
      'Endless settlement log query block span',
      100
    );
    this.wait = options.wait || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    if (!isAddressEqual(this.operatorAccount.address, this.operatorAddress)) {
      throw new Error(`Endless operator key resolves to ${this.operatorAccount.address}, expected ${this.operatorAddress}.`);
    }
    if (!isAddressEqual(this.signerAccount.address, this.signerAddress)) {
      throw new Error(`Endless signer key resolves to ${this.signerAccount.address}, expected ${this.signerAddress}.`);
    }
    if (isAddressEqual(this.operatorAddress, this.signerAddress)) {
      throw new Error('Endless Game Operator and Reward Signer must be separate wallets.');
    }
    const chain = defineChain({
      id: this.chainId,
      name: this.chainId === 2020 ? 'Ronin Mainnet' : 'Saigon Testnet',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } }
    });
    this.publicClient = options.publicClient || createPublicClient({ chain, transport: http(this.rpcUrl) });
    this.operatorClient = options.operatorClient || createWalletClient({
      account: this.operatorAccount,
      chain,
      transport: http(this.rpcUrl)
    });
    this.queue = Promise.resolve();
  }

  async init() {
    if (!this.enabled) return this;
    const operatorRole = await this.publicClient.readContract({
      address: this.settlementAddress,
      abi: ENDLESS_ABI,
      functionName: 'OPERATOR_ROLE'
    });
    const [chainId, paused, signer, settlementLoadout, crystalUnit, operatorAuthorized] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'paused' }),
      this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'rewardSigner' }),
      this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'loadout' }),
      this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'crystalUnit' }),
      this.publicClient.readContract({
        address: this.settlementAddress,
        abi: ENDLESS_ABI,
        functionName: 'hasRole',
        args: [operatorRole, this.operatorAddress]
      })
    ]);
    if (Number(chainId) !== this.chainId) throw new Error(`Endless RPC is on chain ${chainId}.`);
    if (paused) throw new Error('Endless Settlement contract is paused.');
    if (!isAddressEqual(signer, this.signerAddress)) throw new Error(`Endless Reward Signer is ${signer}.`);
    if (!isAddressEqual(settlementLoadout, this.loadoutAddress)) throw new Error(`Endless Loadout is ${settlementLoadout}.`);
    if (BigInt(crystalUnit) !== 10n ** 18n) throw new Error('Endless CRYSTALS must use 18 decimals.');
    if (!operatorAuthorized) throw new Error('Endless Game Operator lacks OPERATOR_ROLE.');
    // Version routes are allowed to be staged before their approval
    // transaction lands. Existing approved routes must remain usable while a
    // new Admin economy is being prepared.
    await Promise.all(Object.values(this.versionIds).map((versionId) => this.#version(versionId)));
    return this;
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      chainId: this.chainId,
      settlement: this.settlementAddress,
      loadout: this.loadoutAddress,
      versionIds: { ...this.versionIds }
    };
  }

  async health() {
    const startedAt = Date.now();
    try {
      const operatorRole = await this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'OPERATOR_ROLE' });
      const [chainId, paused, signer, settlementLoadout, crystalUnit, operatorAuthorized, operatorBalance] = await Promise.all([
        this.publicClient.getChainId(),
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'paused' }),
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'rewardSigner' }),
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'loadout' }),
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'crystalUnit' }),
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'hasRole', args: [operatorRole, this.operatorAddress] }),
        this.publicClient.getBalance({ address: this.operatorAddress })
      ]);
      const versions = Object.fromEntries(await Promise.all(Object.entries(this.versionIds).map(async ([name, id]) => [name, await this.#version(id)])));
      const versionsReady = Object.values(versions).some((value) => value.approved && !value.retired);
      const signerMatches = isAddressEqual(signer, this.signerAddress);
      const loadoutMatches = isAddressEqual(settlementLoadout, this.loadoutAddress);
      const crystalUnitMatches = BigInt(crystalUnit) === 10n ** 18n;
      const funded = BigInt(operatorBalance) >= this.operatorMinimumBalanceWei;
      return {
        ok: Number(chainId) === this.chainId && !paused && signerMatches && loadoutMatches && crystalUnitMatches && operatorAuthorized && funded && versionsReady,
        latencyMs: Date.now() - startedAt,
        chainId: Number(chainId),
        paused: paused === true,
        signerMatches,
        loadoutMatches,
        crystalUnitMatches,
        operatorAuthorized: operatorAuthorized === true,
        operatorFunded: funded,
        versions
      };
    } catch {
      return { ok: false, latencyMs: Date.now() - startedAt, error: 'Endless settlement chain health could not be verified.' };
    }
  }

  async prepareRunAuthorization({ address, minerId, economyVersion, economyConfig }) {
    const player = getAddress(address);
    const [nonce, loadoutHash, route] = await Promise.all([
      this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'playerNonces', args: [player] }),
      this.publicClient.readContract({ address: this.loadoutAddress, abi: LOADOUT_ABI, functionName: 'loadoutHash', args: [BigInt(minerId)] }),
      this.#resolveVersionRoute(economyVersion, economyConfig)
    ]);
    const versionId = route.versionId;
    const authorization = {
      player,
      minerId: BigInt(minerId),
      versionId,
      loadoutHash,
      nonce: BigInt(nonce),
      deadline: BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
    };
    return {
      contractVersion: 2,
      mode: 'endless',
      economyVersion: route.economyVersion,
      requestedEconomyVersion: String(economyVersion || ''),
      authorization: jsonSafe(authorization),
      typedData: {
        domain: this.#domain(),
        types: ENDLESS_RUN_AUTHORIZATION_TYPES,
        primaryType: 'EndlessRunAuthorization',
        message: jsonSafe(authorization)
      }
    };
  }

  async beginRun({ address, minerId, economyVersion, economyConfig, authorization, playerSignature }) {
    return this.#serialize(async () => {
      const player = getAddress(address);
      const supplied = normalizeAuthorization(authorization);
      const route = await this.#resolveVersionRoute(economyVersion, economyConfig);
      const expectedVersion = route.versionId;
      assertApi(isAddressEqual(supplied.player, player), 422, 'endless_authorization_player', 'Endless approval belongs to another wallet.');
      assertApi(supplied.minerId === BigInt(minerId), 422, 'endless_authorization_miner', 'Endless approval belongs to another Miner.');
      assertApi(supplied.versionId === expectedVersion, 422, 'endless_authorization_version', 'Endless approval belongs to another economy version.');
      assertApi(/^0x[0-9a-f]{130}$/i.test(String(playerSignature || '')), 422, 'endless_authorization_signature', 'Approve the Endless Miner lock in Ronin Wallet.');
      const [nonce, loadoutHash] = await Promise.all([
        this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'playerNonces', args: [player] }),
        this.publicClient.readContract({ address: this.loadoutAddress, abi: LOADOUT_ABI, functionName: 'loadoutHash', args: [BigInt(minerId)] })
      ]);
      assertApi(supplied.nonce === BigInt(nonce), 409, 'endless_authorization_stale', 'The Endless approval is stale. Approve it again.');
      assertApi(supplied.loadoutHash === loadoutHash, 409, 'endless_loadout_changed', 'The Miner loadout changed. Approve the run again.');
      assertApi(supplied.deadline >= BigInt(Math.floor(Date.now() / 1_000)), 422, 'endless_authorization_expired', 'The Endless approval expired. Approve it again.');
      let transactionHash = '';
      try {
        transactionHash = await this.operatorClient.writeContract({
          address: this.settlementAddress,
          abi: ENDLESS_ABI,
          functionName: 'beginRun',
          args: [supplied, playerSignature]
        });
        await this.#confirmed(transactionHash, 'Endless run start');
      } catch (error) {
        const recovered = await this.#activeRun(minerId).catch(() => null);
        if (!recovered || !matchesAuthorization(recovered, supplied)) throw error;
      }
      const active = await this.#activeRun(minerId);
      assertApi(matchesAuthorization(active, supplied), 502, 'endless_chain_start_missing', 'The confirmed Endless Miner lock was not found on-chain.');
      return { transactionHash, recovered: !transactionHash, chainRun: publicChainRun(active) };
    });
  }

  async assertEconomyConfig({ economyVersion, economyConfig }) {
    const route = await this.#resolveVersionRoute(economyVersion, economyConfig);
    return { economyVersion: route.economyVersion, versionId: route.versionId };
  }

  async checkpoint({ address, minerId, chainRun, completedPhases, minedCrystalUnits, rollingDigest }) {
    return this.#serialize(async () => {
      const active = await this.#activeRun(minerId);
      assertChainRun(active, chainRun, address);
      const checkpointDigest = digestBytes32(rollingDigest);
      const targetPhase = boundedUint32(completedPhases, 'completed phases');
      const targetUnits = boundedUint32(minedCrystalUnits, 'mined Crystal units');
      const activePhase = Number(active.completedPhases);
      if (activePhase === targetPhase) {
        // Ronin may confirm a checkpoint before the surrounding database
        // transaction is saved. The next request then legitimately repeats the
        // same phase, sometimes with different volatile server metadata in its
        // locally rebuilt digest. The signed on-chain checkpoint is the
        // authoritative result for that phase, so return it for server resync
        // instead of permanently trapping the Miner behind a sequence error.
        const resynced = active.checkpointDigest !== checkpointDigest || Number(active.minedCrystalUnits) !== targetUnits;
        return { recovered: true, resynced, transactionHash: '', chainRun: publicChainRun(active) };
      }
      assertApi(activePhase + 1 === targetPhase, 409, 'endless_chain_checkpoint_sequence', 'The on-chain Endless checkpoint cannot be advanced safely from the current phase.', {
        chainPhase: activePhase,
        requestedPhase: targetPhase,
        expectedPhase: activePhase + 1
      });
      const receipt = {
        player: getAddress(address),
        minerId: BigInt(minerId),
        runId: active.runId,
        versionId: active.versionId,
        previousDigest: active.checkpointDigest,
        checkpointDigest,
        completedPhases: targetPhase,
        minedCrystalUnits: targetUnits,
        nonce: BigInt(active.nonce),
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
      };
      const rewardSignature = await this.signerAccount.signTypedData({ domain: this.#domain(), types: CHECKPOINT_TYPES, primaryType: 'EndlessCheckpoint', message: receipt });
      const transactionHash = await this.operatorClient.writeContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'checkpoint', args: [receipt, rewardSignature] });
      await this.#confirmed(transactionHash, 'Endless checkpoint');
      const updated = await this.#activeRun(minerId);
      assertApi(Number(updated.completedPhases) === targetPhase && updated.checkpointDigest === checkpointDigest, 502, 'endless_chain_checkpoint_missing', 'The confirmed Endless checkpoint was not found on-chain.');
      return { recovered: false, transactionHash, chainRun: publicChainRun(updated) };
    });
  }

  async settle({
    address,
    minerId,
    chainRun,
    completedPhases,
    minedCrystalUnits,
    rollingDigest,
    outcome = 'extraction',
    fromTransactionHash = ''
  }) {
    return this.#serialize(async () => {
      const active = await this.#activeRun(minerId);
      if (active.runId === ZERO_BYTES32) {
        const recovered = await this.#settledEvent(chainRun?.runId, { fromTransactionHash });
        assertApi(recovered, 409, 'endless_chain_run_missing', 'The Endless Miner has no active or previously settled chain run.');
        return this.#settlementReceipt(recovered, '', true);
      }
      assertChainRun(active, chainRun, address);
      const result = {
        player: getAddress(address),
        minerId: BigInt(minerId),
        runId: active.runId,
        versionId: active.versionId,
        checkpointDigest: digestBytes32(rollingDigest),
        outcome: outcome === 'extraction' ? 0 : 1,
        completedPhases: boundedUint32(completedPhases, 'completed phases'),
        minedCrystalUnits: boundedUint32(minedCrystalUnits, 'mined Crystal units'),
        nonce: BigInt(active.nonce),
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
      };
      return this.#submitSettlement(active, result, 'Endless settlement', { fromTransactionHash });
    });
  }

  async activeRun(minerId) {
    const active = await this.#activeRun(minerId);
    return active.runId === ZERO_BYTES32 ? null : publicChainRun(active);
  }

  async cancelRun({ address, minerId }) {
    return this.#serialize(async () => {
      const active = await this.#activeRun(minerId);
      if (active.runId === ZERO_BYTES32) return { cancelled: false, minerId };
      assertApi(
        isAddressEqual(active.player, getAddress(address)),
        409,
        'endless_chain_player_mismatch',
        'The active Endless chain run belongs to another wallet.'
      );
      const result = {
        player: active.player,
        minerId: BigInt(minerId),
        runId: active.runId,
        versionId: active.versionId,
        checkpointDigest: active.checkpointDigest,
        outcome: 1,
        completedPhases: boundedUint32(active.completedPhases, 'completed phases'),
        minedCrystalUnits: boundedUint32(active.minedCrystalUnits, 'mined Crystal units'),
        nonce: BigInt(active.nonce),
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
      };
      const settlement = await this.#submitSettlement(active, result, 'Endless run cancellation', {
        allowProcessedRecovery: true,
        minerId
      });
      return {
        cancelled: true,
        minerId,
        transactionHash: settlement.transactionHash,
        settlement
      };
    });
  }

  async cancelUnstarted({ minerId, chainRun }) {
    return this.#serialize(async () => {
      const active = await this.#activeRun(minerId);
      if (active.runId === ZERO_BYTES32) return { recovered: true, transactionHash: '' };
      assertApi(active.runId === bytes32(chainRun?.runId, 'Endless chain run ID'), 409, 'endless_chain_run_mismatch', 'Another Endless chain run is active.');
      assertApi(Number(active.completedPhases) === 0 && active.checkpointDigest === ZERO_BYTES32, 409, 'endless_chain_run_progressed', 'A progressed Endless run cannot use start cancellation.');
      const result = {
        player: active.player,
        minerId: BigInt(minerId),
        runId: active.runId,
        versionId: active.versionId,
        checkpointDigest: ZERO_BYTES32,
        outcome: 1,
        completedPhases: 0,
        minedCrystalUnits: 0,
        nonce: BigInt(active.nonce),
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 10 * 60)
      };
      let transactionHash = '';
      try {
        const rewardSignature = await this.signerAccount.signTypedData({ domain: this.#domain(), types: RESULT_TYPES, primaryType: 'EndlessResult', message: result });
        transactionHash = await this.operatorClient.writeContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'settle', args: [result, rewardSignature] });
        await this.#confirmed(transactionHash, 'Endless start cancellation');
        return { recovered: false, transactionHash };
      } catch (error) {
        const recovered = await this.#reconcileSettlement(active, transactionHash, {
          allowProcessedRecovery: true,
          minerId
        });
        if (recovered) return { recovered: true, transactionHash: recovered.transactionHash };
        if (error instanceof ApiError) throw error;
        const reason = endlessContractErrorName(error);
        throw new ApiError(
          502,
          'endless_chain_settlement_failed',
          `Endless start cancellation was not confirmed on Ronin${reason ? ` (${reason})` : ''}. The locked run remains saved and can be retried.`,
          { reason: reason || 'UNAVAILABLE', retryable: true, transactionHash }
        );
      }
    });
  }

  async #version(versionId) {
    const raw = await this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'versions', args: [versionId] });
    return normalizeStruct(raw, ['generatorHash', 'configHash', 'conversionRate', 'maximumPayout', 'maximumDailyPayout', 'mineableCrystalUnits', 'maximumPhases', 'phaseXp', 'maximumRunXp', 'maximumWalletXpPerDay', 'maximumMinerXpPerDay', 'checkpointTimeout', 'failedRunsRetainXp', 'approved', 'retired']);
  }

  async #activeRun(minerId) {
    const raw = await this.publicClient.readContract({ address: this.settlementAddress, abi: ENDLESS_ABI, functionName: 'activeRun', args: [BigInt(minerId)] });
    return normalizeStruct(raw, ['runId', 'versionId', 'loadoutHash', 'checkpointDigest', 'player', 'conversionRate', 'maximumPayout', 'maximumDailyPayout', 'startedAt', 'lastCheckpointAt', 'mineableCrystalUnits', 'maximumPhases', 'phaseXp', 'maximumRunXp', 'maximumWalletXpPerDay', 'maximumMinerXpPerDay', 'checkpointTimeout', 'completedPhases', 'minedCrystalUnits', 'carryCapacity', 'deathRetentionBps', 'failedRunsRetainXp', 'nonce']);
  }

  #settledEventFromReceipt(receipt, runId) {
    if (!receipt || !runId) return null;
    const targetRunId = bytes32(runId, 'Endless chain run ID');
    for (const log of receipt.logs || []) {
      if (String(log.address || '').toLowerCase() !== this.settlementAddress.toLowerCase()) continue;
      if (String(log.args?.runId || '').toLowerCase() === targetRunId) return log;
      try {
        const decoded = decodeEventLog({ abi: [SETTLED_EVENT], data: log.data, topics: log.topics });
        if (decoded.eventName === 'EndlessRunSettled' && String(decoded.args?.runId || '').toLowerCase() === targetRunId) {
          return { ...log, eventName: decoded.eventName, args: decoded.args };
        }
      } catch {}
    }
    return null;
  }

  async #settledEvent(runId, options = {}) {
    if (!runId) return null;
    const targetRunId = bytes32(runId, 'Endless chain run ID');
    let fromBlock = options.fromBlock == null ? null : BigInt(options.fromBlock);
    for (const transactionHash of [options.transactionHash, options.fromTransactionHash]) {
      if (!/^0x[0-9a-f]{64}$/i.test(String(transactionHash || ''))) continue;
      try {
        const receipt = await this.publicClient.getTransactionReceipt({ hash: transactionHash });
        const event = this.#settledEventFromReceipt(receipt, targetRunId);
        if (event) return event;
        if (fromBlock == null && receipt.blockNumber != null) fromBlock = BigInt(receipt.blockNumber);
      } catch {}
    }
    if (fromBlock == null) {
      try {
        const logs = await this.publicClient.getLogs({
          address: this.settlementAddress,
          event: SETTLED_EVENT,
          args: { runId: targetRunId },
          fromBlock: this.deploymentBlock,
          toBlock: 'latest'
        });
        return logs.at(-1) || null;
      } catch {}
      fromBlock = this.deploymentBlock;
    }
    const latestBlock = await this.publicClient.getBlockNumber();
    if (fromBlock > latestBlock) return null;
    const span = BigInt(this.settlementLogQueryBlockSpan);
    let toBlock = latestBlock;
    while (toBlock >= fromBlock) {
      const candidate = toBlock >= span - 1n ? toBlock - span + 1n : 0n;
      const windowFrom = candidate > fromBlock ? candidate : fromBlock;
      const logs = await this.publicClient.getLogs({
        address: this.settlementAddress,
        event: SETTLED_EVENT,
        args: { runId: targetRunId },
        fromBlock: windowFrom,
        toBlock
      });
      if (logs.length) return logs.at(-1);
      if (windowFrom === fromBlock) break;
      toBlock = windowFrom - 1n;
    }
    return null;
  }

  async #processedRun(runId) {
    return this.publicClient.readContract({
      address: this.settlementAddress,
      abi: ENDLESS_ABI,
      functionName: 'processedRuns',
      args: [bytes32(runId, 'Endless chain run ID')]
    });
  }

  async #reconcileSettlement(active, transactionHash, options = {}) {
    for (let attempt = 0; attempt < this.settlementReconciliationAttempts; attempt += 1) {
      const event = await this.#settledEvent(active.runId, {
        transactionHash,
        fromTransactionHash: options.fromTransactionHash
      }).catch(() => null);
      if (event) return this.#settlementReceipt(event, transactionHash, true);
      if (attempt + 1 < this.settlementReconciliationAttempts) {
        await this.wait(this.settlementReconciliationDelayMs);
      }
    }
    if (options.allowProcessedRecovery === true && Number(options.minerId) > 0) {
      const [processed, current] = await Promise.all([
        this.#processedRun(active.runId).catch(() => false),
        this.#activeRun(options.minerId).catch(() => null)
      ]);
      if (processed === true && current?.runId === ZERO_BYTES32) {
        return {
          settled: true,
          recovered: true,
          eventPending: true,
          transactionHash: transactionHash || '',
          crystalsBankedRaw: '',
          crystalsBanked: null,
          minerXpBanked: null,
          completedPhases: Number(active.completedPhases || 0),
          minedCrystalUnits: Number(active.minedCrystalUnits || 0)
        };
      }
    }
    return null;
  }

  async #submitSettlement(active, result, label, options = {}) {
    let transactionHash = '';
    let stage = 'signing';
    let simulationBypassed = false;
    try {
      const rewardSignature = await this.signerAccount.signTypedData({ domain: this.#domain(), types: RESULT_TYPES, primaryType: 'EndlessResult', message: result });
      const request = {
        address: this.settlementAddress,
        abi: ENDLESS_ABI,
        functionName: 'settle',
        args: [result, rewardSignature],
        gas: this.settlementGasLimit
      };
      stage = 'simulating';
      try {
        await this.publicClient.simulateContract({ ...request, account: this.operatorAddress });
      } catch (error) {
        // A decoded contract rejection is authoritative and must not be sent.
        // An undecoded RPC/preflight outage is not: the signed contract call is
        // still fully validated on-chain, and the explicit gas limit avoids a
        // second eth_estimateGas dependency before broadcast.
        if (endlessContractErrorName(error)) throw error;
        simulationBypassed = true;
        console.warn(JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warn',
          event: 'endless_settlement_simulation_bypassed',
          runId: active.runId,
          minerId: Number(result.minerId)
        }));
      }
      stage = 'broadcasting';
      transactionHash = await this.operatorClient.writeContract(request);
      stage = 'confirming';
      const confirmed = await this.#confirmed(transactionHash, label);
      stage = 'reading-event';
      const event = this.#settledEventFromReceipt(confirmed, active.runId)
        || await this.#settledEvent(active.runId, {
          transactionHash,
          fromTransactionHash: options.fromTransactionHash,
          fromBlock: confirmed.blockNumber
        });
      assertApi(event, 502, 'endless_chain_settlement_event_missing', 'The confirmed Endless settlement event was not found.');
      return this.#settlementReceipt(event, transactionHash, false);
    } catch (error) {
      const couldHaveBroadcast = transactionHash || ['broadcasting', 'confirming', 'reading-event'].includes(stage);
      const recovered = couldHaveBroadcast
        ? await this.#reconcileSettlement(active, transactionHash, options)
        : await this.#settledEvent(active.runId, {
          fromTransactionHash: options.fromTransactionHash
        }).catch(() => null);
      if (recovered) {
        return recovered.settled === true
          ? recovered
          : this.#settlementReceipt(recovered, transactionHash, true);
      }
      if (error instanceof ApiError) throw error;
      const reason = endlessContractErrorName(error);
      throw new ApiError(
        502,
        'endless_chain_settlement_failed',
        `${label} was not confirmed on Ronin${reason ? ` (${reason})` : ''}. The locked run remains saved and can be retried.`,
        { reason: reason || 'UNAVAILABLE', retryable: true, transactionHash, stage, simulationBypassed }
      );
    }
  }

  #settlementReceipt(event, transactionHash, recovered) {
    const args = event.args || event;
    return {
      settled: true,
      recovered,
      transactionHash: transactionHash || event.transactionHash || '',
      crystalsBankedRaw: BigInt(args.crystalsBanked || 0).toString(),
      crystalsBanked: Number(formatUnits(BigInt(args.crystalsBanked || 0), 18)),
      minerXpBanked: Number(args.xpBanked || 0),
      completedPhases: Number(args.completedPhases || 0),
      minedCrystalUnits: Number(args.minedCrystalUnits || 0)
    };
  }

  async #resolveVersionRoute(economyVersion, economyConfig) {
    const requestedName = String(economyVersion || '').trim();
    const entries = Object.entries(this.versionIds);
    const preferredIndex = entries.findIndex(([name]) => name === requestedName);
    if (preferredIndex > 0) entries.unshift(entries.splice(preferredIndex, 1)[0]);
    const routes = await Promise.all(entries.map(async ([name, versionId]) => ({
      economyVersion: name,
      versionId,
      version: await this.#version(versionId)
    })));
    const exact = routes.find((route) => (
      route.version.approved && !route.version.retired && economyVersionMatches(route.version, economyConfig)
    ));
    if (exact) return exact;
    if (!this.versionIds[requestedName]) {
      throw new ApiError(503, 'endless_version_unmapped', 'This Endless economy has no approved on-chain route yet. The Miner was not locked.');
    }
    const requested = routes.find((route) => route.economyVersion === requestedName);
    assertApi(requested?.version?.approved && !requested.version.retired, 503, 'endless_version_unavailable', 'The configured Endless economy version is not active on-chain. The Miner was not locked.');
    assertEconomyVersion(requested.version, economyConfig);
    return requested;
  }

  #domain() {
    return { name: 'MATT Mine V2 Endless Settlement', version: '1', chainId: this.chainId, verifyingContract: this.settlementAddress };
  }

  async #confirmed(hash, label) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted.`);
    return receipt;
  }

  #serialize(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function createEndlessSettlementServiceFromEnvironment(environment = process.env, options = {}) {
  if (environment.MATT_MINE_ENDLESS_SETTLEMENT_ENABLED !== 'true') return null;
  return new EndlessSettlementService({
    enabled: true,
    chainId: Number(environment.MATT_MINE_NFT_CHAIN_ID || 2020),
    rpcUrl: nftRpcUrlFromEnvironment(environment),
    settlementAddress: environment.MATT_MINE_ENDLESS_SETTLEMENT_ADDRESS,
    loadoutAddress: environment.MATT_MINE_NFT_LOADOUT_ADDRESS,
    operatorAddress: environment.MATT_MINE_NFT_GAME_OPERATOR_ADDRESS,
    signerAddress: environment.MATT_MINE_NFT_REWARD_SIGNER_ADDRESS,
    operatorPrivateKey: environment.MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY,
    signerPrivateKey: environment.MATT_MINE_NFT_REWARD_SIGNER_PRIVATE_KEY || environment.MATT_MINE_NFT_GAME_SIGNER_PRIVATE_KEY,
    versionIds: parseVersionIds(environment.MATT_MINE_ENDLESS_VERSION_IDS_JSON),
    deploymentBlock: environment.MATT_MINE_ENDLESS_DEPLOYMENT_BLOCK || 0,
    operatorMinimumBalanceWei: environment.MATT_MINE_NFT_OPERATOR_MINIMUM_BALANCE_WEI || DEFAULT_OPERATOR_MINIMUM_BALANCE_WEI,
    settlementReconciliationAttempts: environment.MATT_MINE_ENDLESS_RECONCILIATION_ATTEMPTS || DEFAULT_SETTLEMENT_RECONCILIATION_ATTEMPTS,
    settlementReconciliationDelayMs: environment.MATT_MINE_ENDLESS_RECONCILIATION_DELAY_MS || DEFAULT_SETTLEMENT_RECONCILIATION_DELAY_MS,
    settlementGasLimit: environment.MATT_MINE_ENDLESS_SETTLEMENT_GAS_LIMIT || DEFAULT_SETTLEMENT_GAS_LIMIT,
    settlementLogQueryBlockSpan: environment.MATT_MINE_ENDLESS_LOG_QUERY_BLOCK_SPAN || DEFAULT_SETTLEMENT_LOG_QUERY_BLOCK_SPAN,
    ...options
  });
}

function normalizeAuthorization(value = {}) {
  try {
    return {
      player: getAddress(value.player),
      minerId: BigInt(value.minerId),
      versionId: bytes32(value.versionId, 'Endless version ID'),
      loadoutHash: bytes32(value.loadoutHash, 'loadout hash'),
      nonce: BigInt(value.nonce),
      deadline: BigInt(value.deadline)
    };
  } catch {
    throw new ApiError(422, 'endless_authorization_invalid', 'The Endless run authorization is invalid.');
  }
}

function assertChainRun(active, expected, address) {
  assertApi(active.runId !== ZERO_BYTES32, 409, 'endless_chain_run_missing', 'The Miner has no active Endless chain run.');
  assertApi(active.runId === bytes32(expected?.runId, 'Endless chain run ID'), 409, 'endless_chain_run_mismatch', 'Another Endless chain run is active.');
  assertApi(active.versionId === bytes32(expected?.versionId, 'Endless version ID'), 409, 'endless_chain_version_mismatch', 'The Endless chain version changed unexpectedly.');
  assertApi(isAddressEqual(active.player, getAddress(address)), 409, 'endless_chain_player_mismatch', 'The Endless chain run belongs to another wallet.');
}

function matchesAuthorization(active, authorization) {
  return active.runId !== ZERO_BYTES32 && active.versionId === authorization.versionId && active.loadoutHash === authorization.loadoutHash && isAddressEqual(active.player, authorization.player) && BigInt(active.nonce) === authorization.nonce;
}

function publicChainRun(active) {
  return {
    runId: String(active.runId),
    versionId: String(active.versionId),
    loadoutHash: String(active.loadoutHash),
    checkpointDigest: String(active.checkpointDigest),
    player: String(active.player),
    startedAt: Number(active.startedAt),
    lastCheckpointAt: Number(active.lastCheckpointAt),
    checkpointTimeout: Number(active.checkpointTimeout),
    nonce: BigInt(active.nonce).toString(),
    completedPhases: Number(active.completedPhases),
    minedCrystalUnits: Number(active.minedCrystalUnits)
  };
}

function normalizeVersionIds(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = Object.fromEntries(Object.entries(source).map(([name, id]) => [String(name).trim(), bytes32(id, `${name} Endless version ID`)]));
  if (!Object.keys(result).length) throw new Error('At least one Endless economy version ID is required.');
  return result;
}

function parseVersionIds(value) {
  try { return JSON.parse(String(value || '{}')); } catch { throw new Error('MATT_MINE_ENDLESS_VERSION_IDS_JSON must be valid JSON.'); }
}

function normalizeStruct(value, names) {
  return Object.fromEntries(names.map((name, index) => [name, value?.[name] ?? value?.[index]]));
}

function endlessContractErrorName(error) {
  const pending = [error];
  const visited = new Set();
  while (pending.length) {
    const current = pending.shift();
    if (!current || (typeof current !== 'object' && typeof current !== 'function') || visited.has(current)) continue;
    visited.add(current);
    const direct = String(current?.data?.errorName || '').trim();
    if (/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(direct)) return direct;
    for (const value of [current.shortMessage, current.details, current.message]) {
      const message = String(value || '');
      const custom = message.match(/custom error\s+["']?([A-Za-z][A-Za-z0-9_]{0,79})/i);
      if (custom) return custom[1];
      const reverted = message.match(/reverted with\s+["']?([A-Za-z][A-Za-z0-9_]{0,79})/i);
      if (reverted) return reverted[1];
      const named = message.match(/\berror\s+["']?([A-Za-z][A-Za-z0-9_]{0,79})/i);
      if (named) return named[1];
    }
    if (current.cause) pending.push(current.cause);
    if (current.data && typeof current.data === 'object') pending.push(current.data);
  }
  return '';
}

function digestBytes32(value) {
  const text = String(value || '');
  return bytes32(text.startsWith('0x') ? text : `0x${text}`, 'Endless checkpoint digest');
}

function bytes32(value, label) {
  const text = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(text)) throw new Error(`${label} must be bytes32.`);
  return text;
}

function boundedUint32(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > 4_294_967_295) throw new ApiError(422, 'endless_chain_value_invalid', `${label} is invalid.`);
  return number;
}

function assertEconomyVersion(version, config = {}) {
  assertApi(
    economyVersionMatches(version, config),
    503,
    'endless_economy_route_mismatch',
    'This Admin economy needs its matching Ronin version approved before play can start. The Miner was not locked.'
  );
}

function economyVersionMatches(version, config = {}) {
  let expected;
  try {
    expected = {
      conversionRate: rationalTokenWei(config.crystalConversionNumerator, config.crystalConversionDenominator),
      maximumPayout: rationalTokenWei(config.maximumPayoutNumerator, config.maximumPayoutDenominator),
      maximumDailyPayout: rationalTokenWei(config.maximumDailyPayoutNumerator, config.maximumDailyPayoutDenominator),
      mineableCrystalUnits: BigInt(config.mineableCrystalUnits),
      maximumPhases: BigInt(config.maximumPhases),
      phaseXp: BigInt(config.phaseXp),
      maximumRunXp: BigInt(config.maximumRunXp),
      maximumWalletXpPerDay: BigInt(config.maximumWalletXpPerDay),
      maximumMinerXpPerDay: BigInt(config.maximumMinerXpPerDay),
      checkpointTimeout: BigInt(config.checkpointTimeoutSeconds),
      failedRunsRetainXp: config.failedRunsRetainXp === true
    };
  } catch {
    return false;
  }
  return Object.entries(expected).every(([key, value]) => (
    typeof value === 'boolean' ? version[key] === value : BigInt(version[key]) === value
  ));
}

function rationalTokenWei(numerator, denominator) {
  const top = BigInt(numerator);
  const bottom = BigInt(denominator);
  if (top <= 0n || bottom <= 0n || top * 10n ** 18n % bottom !== 0n) throw new Error('Inexact token value.');
  return top * 10n ** 18n / bottom;
}

function requiredAddress(value, label) {
  try { return getAddress(value); } catch { throw new Error(`${label} is invalid.`); }
}

function requiredPrivateKey(value, label) {
  const text = String(value || '');
  if (!/^0x[0-9a-f]{64}$/i.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function requiredUrl(value, label) {
  try { return new URL(String(value || '')).toString(); } catch { throw new Error(`${label} is invalid.`); }
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid.`);
  return number;
}

function boundedPositiveInteger(value, label, maximum) {
  const number = positiveInteger(value, label);
  if (number > maximum) throw new Error(`${label} cannot exceed ${maximum}.`);
  return number;
}

function boundedNonnegativeInteger(value, label, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > maximum) throw new Error(`${label} is invalid.`);
  return number;
}

function nonnegativeBigInt(value, label) {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error();
    return result;
  } catch { throw new Error(`${label} is invalid.`); }
}

function positiveBigInt(value, label) {
  const result = nonnegativeBigInt(value, label);
  if (result === 0n) throw new Error(`${label} is invalid.`);
  return result;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item));
}
