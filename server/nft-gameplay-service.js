import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToHex
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError, assertApi } from './errors.js';

const SETTLEMENT_ABI = parseAbi([
  'function RUN_MANAGER_ROLE() view returns (bytes32)',
  'function gameSigner() view returns (address)',
  'function hasRole(bytes32 role, address account) view returns (bool)',
  'function nonces(address player) view returns (uint256)',
  'function processedRuns(bytes32 runId) view returns (bool)',
  'function paused() view returns (bool)',
  'function beginRun(uint256 minerId)',
  'function cancelRun(uint256 minerId)',
  'function settleRun((address player,uint256 minerId,bytes32 runId,uint8 outcome,uint8 completedPhases,uint256 xpDelta,uint8 newLevel,uint256 crystalsCarried,uint256 crystalsBanked,uint256 nonce,uint256 deadline) receipt, bytes signature)',
  'function xpForCompletedPhases(uint8 completedPhases) pure returns (uint256)'
]);

const RUN_RECEIPT_TYPES = Object.freeze({
  RunReceipt: [
    { name: 'player', type: 'address' },
    { name: 'minerId', type: 'uint256' },
    { name: 'runId', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'completedPhases', type: 'uint8' },
    { name: 'xpDelta', type: 'uint256' },
    { name: 'newLevel', type: 'uint8' },
    { name: 'crystalsCarried', type: 'uint256' },
    { name: 'crystalsBanked', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
});

export class NftGameplayService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.chainId = positiveInteger(options.chainId || 202601, 'NFT gameplay chain ID');
    this.rpcUrl = requiredUrl(options.rpcUrl, 'NFT gameplay RPC URL');
    this.settlementAddress = requiredAddress(options.settlementAddress, 'NFT Settlement address');
    this.operatorAddress = requiredAddress(options.operatorAddress, 'NFT Game Operator address');
    this.signerAddress = requiredAddress(options.signerAddress, 'NFT Run Signer address');
    this.operatorPrivateKey = requiredPrivateKey(options.operatorPrivateKey, 'NFT Game Operator private key');
    this.signerPrivateKey = requiredPrivateKey(options.signerPrivateKey, 'NFT Run Signer private key');
    this.metadataService = options.metadataService;
    this.baseCrystalCarryLimit = positiveInteger(options.baseCrystalCarryLimit || 10, 'base crystal carry limit');
    assertApi(this.metadataService, 500, 'nft_gameplay_metadata_missing', 'NFT gameplay requires the metadata chain reader.');
    const chain = defineChain({
      id: this.chainId,
      name: 'Saigon Testnet',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } }
    });
    this.operatorAccount = privateKeyToAccount(this.operatorPrivateKey);
    this.signerAccount = privateKeyToAccount(this.signerPrivateKey);
    if (getAddress(this.operatorAccount.address) !== this.operatorAddress) {
      throw new Error(`NFT Game Operator key resolves to ${this.operatorAccount.address}, expected ${this.operatorAddress}.`);
    }
    if (getAddress(this.signerAccount.address) !== this.signerAddress) {
      throw new Error(`NFT Run Signer key resolves to ${this.signerAccount.address}, expected ${this.signerAddress}.`);
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
    const runManagerRole = await this.publicClient.readContract({
      address: this.settlementAddress,
      abi: SETTLEMENT_ABI,
      functionName: 'RUN_MANAGER_ROLE'
    });
    const [chainId, paused, signer, operatorAuthorized] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({ address: this.settlementAddress, abi: SETTLEMENT_ABI, functionName: 'paused' }),
      this.publicClient.readContract({ address: this.settlementAddress, abi: SETTLEMENT_ABI, functionName: 'gameSigner' }),
      this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'hasRole',
        args: [runManagerRole, this.operatorAddress]
      })
    ]);
    if (chainId !== this.chainId) throw new Error(`NFT gameplay RPC is on chain ${chainId}.`);
    if (paused) throw new Error('NFT Settlement contract is paused.');
    if (getAddress(signer) !== this.signerAddress) throw new Error(`NFT Settlement signer is ${signer}.`);
    if (!operatorAuthorized) throw new Error('NFT Game Operator lacks RUN_MANAGER_ROLE.');
    return this;
  }

  publicStatus() {
    return {
      enabled: this.enabled,
      chainId: this.chainId,
      settlement: this.settlementAddress
    };
  }

  async playerMiner(address, requestedMinerId = 0) {
    const player = getAddress(address);
    if (requestedMinerId) {
      const profile = await this.metadataService.minerProfile(requestedMinerId);
      if (getAddress(profile.owner) !== player) {
        throw new ApiError(403, 'nft_miner_owner_mismatch', `Miner #${requestedMinerId} is not owned by this wallet.`);
      }
      return profile;
    }
    for (let minerId = 1; minerId <= 1_000; minerId += 1) {
      try {
        const profile = await this.metadataService.minerProfile(minerId);
        if (getAddress(profile.owner) === player) return profile;
      } catch (error) {
        if (missingToken(error)) break;
        throw error;
      }
    }
    return null;
  }

  async beginRun({ address, serverRunId, minerId = 0 }) {
    return this.#serialize(async () => {
      const profile = await this.playerMiner(address, minerId);
      if (!profile) return null;
      assertApi(!profile.gameplay.runLocked, 409, 'nft_miner_in_run', `Miner #${profile.minerId} is already locked in a run.`);
      const hash = await this.operatorClient.writeContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'beginRun',
        args: [BigInt(profile.minerId)]
      });
      await this.#confirmed(hash, 'NFT run start');
      return {
        minerId: profile.minerId,
        profile,
        crystalCarryLimit: this.baseCrystalCarryLimit * profile.gameplay.crystalCarryMultiplier,
        runId: contractRunId(serverRunId),
        beginTransactionHash: hash
      };
    });
  }

  async settleRun({ address, serverRunId, minerId, result, currentLevel, completedPhases }) {
    return this.#serialize(async () => {
      const player = getAddress(address);
      const onChainRunId = contractRunId(serverRunId);
      const profile = await this.playerMiner(player, minerId);
      const alreadyProcessed = await this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'processedRuns',
        args: [onChainRunId]
      });
      if (alreadyProcessed) {
        return this.#settlementResult({
          profile,
          minerId,
          result,
          completedPhases,
          transactionHash: null,
          alreadySettled: true
        });
      }
      assertApi(profile?.gameplay.runLocked, 409, 'nft_run_not_locked', `Miner #${minerId} is not locked for settlement.`);
      const phaseMask = normalizedPhaseMask(completedPhases);
      const carried = BigInt(Math.max(0, Math.floor(Number(result.crystalsCarried || 0))));
      const extraction = result.extracted === true;
      const xpDelta = extraction
        ? await this.publicClient.readContract({
            address: this.settlementAddress,
            abi: SETTLEMENT_ABI,
            functionName: 'xpForCompletedPhases',
            args: [phaseMask]
          })
        : 0n;
      const banked = extraction ? carried : profile.equipped.backpack ? carried / 2n : 0n;
      const nonce = await this.publicClient.readContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'nonces',
        args: [player]
      });
      const receipt = {
        player,
        minerId: BigInt(minerId),
        runId: onChainRunId,
        outcome: extraction ? 0 : 1,
        completedPhases: phaseMask,
        xpDelta,
        newLevel: extraction
          ? levelForXp(Number(profile.progression.bankedXp) + Number(xpDelta), currentLevel)
          : currentLevel,
        crystalsCarried: carried,
        crystalsBanked: banked,
        nonce,
        deadline: BigInt(Math.floor(Date.now() / 1_000) + 15 * 60)
      };
      const signature = await this.signerAccount.signTypedData({
        domain: {
          name: 'MATT Mine Run Settlement',
          version: '1',
          chainId: this.chainId,
          verifyingContract: this.settlementAddress
        },
        types: RUN_RECEIPT_TYPES,
        primaryType: 'RunReceipt',
        message: receipt
      });
      const hash = await this.operatorClient.writeContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'settleRun',
        args: [receipt, signature]
      });
      await this.#confirmed(hash, 'NFT run settlement');
      return {
        minerId,
        outcome: extraction ? 'extraction' : 'death',
        completedPhases: Number(phaseMask),
        crystalsCarried: Number(carried),
        crystalsBanked: Number(banked),
        xpBanked: Number(xpDelta),
        newLevel: Number(receipt.newLevel),
        transactionHash: hash,
        profile: await this.metadataService.minerProfile(minerId)
      };
    });
  }

  #settlementResult({ profile, minerId, result, completedPhases, transactionHash, alreadySettled }) {
    const carried = Math.max(0, Math.floor(Number(result.crystalsCarried || 0)));
    const extraction = result.extracted === true;
    const phaseMask = normalizedPhaseMask(completedPhases);
    const xpBanked = extraction ? xpForPhaseMask(Number(phaseMask)) : 0;
    return {
      minerId,
      outcome: extraction ? 'extraction' : 'death',
      completedPhases: Number(phaseMask),
      crystalsCarried: carried,
      crystalsBanked: extraction ? carried : profile.equipped.backpack ? Math.floor(carried / 2) : 0,
      xpBanked,
      newLevel: profile.progression.level,
      transactionHash,
      alreadySettled,
      profile
    };
  }

  async cancelRun({ address, minerId }) {
    return this.#serialize(async () => {
      const profile = await this.playerMiner(address, minerId);
      if (!profile?.gameplay.runLocked) return { cancelled: false, minerId };
      const hash = await this.operatorClient.writeContract({
        address: this.settlementAddress,
        abi: SETTLEMENT_ABI,
        functionName: 'cancelRun',
        args: [BigInt(minerId)]
      });
      await this.#confirmed(hash, 'NFT run cancellation');
      return { cancelled: true, minerId, transactionHash: hash };
    });
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
  return new NftGameplayService({
    enabled,
    chainId: Number(environment.MATT_MINE_NFT_CHAIN_ID || 202601),
    rpcUrl: environment.MATT_MINE_NFT_RPC_URL || 'https://saigon-testnet.roninchain.com/rpc',
    settlementAddress: environment.MATT_MINE_NFT_SETTLEMENT_ADDRESS,
    operatorAddress: environment.MATT_MINE_NFT_GAME_OPERATOR_ADDRESS,
    signerAddress: environment.MATT_MINE_NFT_GAME_SIGNER_ADDRESS,
    operatorPrivateKey: environment.MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY,
    signerPrivateKey: environment.MATT_MINE_NFT_GAME_SIGNER_PRIVATE_KEY,
    baseCrystalCarryLimit: Number(environment.MATT_MINE_NFT_CRYSTAL_CARRY_LIMIT || 10),
    metadataService,
    ...options
  });
}

function contractRunId(serverRunId) {
  return keccak256(stringToHex(`MATT-MINE-SERVER-RUN-V1|${String(serverRunId || '')}`));
}

function normalizedPhaseMask(value) {
  const mask = Number(value);
  if (!Number.isSafeInteger(mask) || mask < 0 || mask > 0x1f) {
    throw new ApiError(422, 'nft_phase_mask_invalid', 'The completed phase mask is invalid.');
  }
  return mask;
}

function levelForXp(totalXp, currentLevel) {
  const safeXp = Math.max(0, Math.floor(Number(totalXp) || 0));
  // 1,500 XP per level puts level 100 at 148,500 XP. At the maximum
  // 80 XP/full run and the planned 20 runs/day, that is about 93 days.
  const calculated = Math.min(100, 1 + Math.floor(safeXp / 1_500));
  return Math.max(Number(currentLevel) || 1, calculated);
}

function xpForPhaseMask(mask) {
  return [10, 12, 15, 18, 25].reduce((xp, amount, index) =>
    xp + ((mask & (1 << index)) ? amount : 0), 0);
}

function missingToken(error) {
  if (error?.status === 404 || error?.code === 'nft_not_found') return true;
  const message = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  return /nonexistent|not found|invalid token|erc721/.test(message);
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
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error(`${label} must use HTTP(S).`);
  return url.href;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}
