import { randomBytes } from 'node:crypto';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const RANDOMNESS_ABI = parseAbi([
  'function nextRequestId() view returns (uint256)',
  'function oracle() view returns (address)',
  'function consumers(uint256 requestId) view returns (address)',
  'function fulfill(uint256 requestId, uint256 randomWord)'
]);

export class SaigonChestKeeper {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.chainId = positiveInteger(options.chainId || 202601, 'chainId');
    this.rpcUrl = requiredUrl(options.rpcUrl, 'rpcUrl');
    this.randomnessAddress = requiredAddress(options.randomnessAddress, 'randomnessAddress');
    this.chestAddress = requiredAddress(options.chestAddress, 'chestAddress');
    this.expectedOracle = requiredAddress(options.expectedOracle, 'expectedOracle');
    this.privateKey = requiredPrivateKey(options.privateKey);
    this.pollIntervalMs = Math.max(3_000, positiveInteger(options.pollIntervalMs || 5_000, 'pollIntervalMs'));
    this.logger = options.logger || console;
    this.timer = null;
    this.running = false;
    this.closed = false;
    this.scanCursor = 1n;
    this.pendingRequestIds = new Set();
    this.snapshot = {
      enabled: this.enabled,
      running: false,
      pending: 0,
      fulfilled: 0,
      lastRequestId: null,
      lastTransactionHash: null,
      lastError: null,
      checkedAt: null
    };

    const chain = defineChain({
      id: this.chainId,
      name: 'Saigon Testnet',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } }
    });
    this.account = privateKeyToAccount(this.privateKey);
    if (getAddress(this.account.address) !== this.expectedOracle) {
      throw new Error(`Saigon keeper key resolves to ${this.account.address}, expected ${this.expectedOracle}.`);
    }
    this.publicClient = options.publicClient || createPublicClient({ chain, transport: http(this.rpcUrl) });
    this.walletClient = options.walletClient || createWalletClient({
      account: this.account,
      chain,
      transport: http(this.rpcUrl)
    });
  }

  async init() {
    if (!this.enabled) return this;
    const [actualChainId, oracle] = await Promise.all([
      this.publicClient.getChainId(),
      this.publicClient.readContract({
        address: this.randomnessAddress,
        abi: RANDOMNESS_ABI,
        functionName: 'oracle'
      })
    ]);
    if (actualChainId !== this.chainId) throw new Error(`Saigon keeper RPC is on chain ${actualChainId}.`);
    if (getAddress(oracle) !== this.expectedOracle) {
      throw new Error(`Saigon randomness oracle is ${oracle}, expected ${this.expectedOracle}.`);
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref?.();
    return this;
  }

  status() {
    return structuredClone(this.snapshot);
  }

  async tick() {
    if (!this.enabled || this.running || this.closed) return this.status();
    this.running = true;
    this.snapshot.running = true;
    try {
      const nextRequestId = await this.publicClient.readContract({
        address: this.randomnessAddress,
        abi: RANDOMNESS_ABI,
        functionName: 'nextRequestId'
      });
      for (let requestId = this.scanCursor; requestId < nextRequestId; requestId += 1n) {
        const consumer = await this.publicClient.readContract({
          address: this.randomnessAddress,
          abi: RANDOMNESS_ABI,
          functionName: 'consumers',
          args: [requestId]
        });
        if (consumer !== ZERO_ADDRESS) {
          if (getAddress(consumer) !== this.chestAddress) {
            throw new Error(`Saigon randomness request ${requestId} belongs to unexpected consumer ${consumer}.`);
          }
          this.pendingRequestIds.add(requestId);
        }
      }
      this.scanCursor = nextRequestId;
      this.snapshot.pending = this.pendingRequestIds.size;
      for (const requestId of [...this.pendingRequestIds].sort((left, right) => left < right ? -1 : 1)) {
        const consumer = await this.publicClient.readContract({
          address: this.randomnessAddress,
          abi: RANDOMNESS_ABI,
          functionName: 'consumers',
          args: [requestId]
        });
        if (consumer === ZERO_ADDRESS) {
          this.pendingRequestIds.delete(requestId);
          continue;
        }
        if (getAddress(consumer) !== this.chestAddress) {
          throw new Error(`Saigon randomness request ${requestId} belongs to unexpected consumer ${consumer}.`);
        }
        await this.fulfill(requestId);
        this.pendingRequestIds.delete(requestId);
      }
      this.snapshot.pending = this.pendingRequestIds.size;
      this.snapshot.lastError = null;
    } catch (error) {
      this.snapshot.lastError = error instanceof Error ? error.message : String(error);
      this.logger.error?.('Saigon chest keeper failed.', { error: this.snapshot.lastError });
    } finally {
      this.snapshot.running = false;
      this.snapshot.checkedAt = new Date().toISOString();
      this.running = false;
    }
    return this.status();
  }

  async fulfill(requestId) {
    const randomWord = BigInt(`0x${randomBytes(32).toString('hex')}`);
    const hash = await this.walletClient.writeContract({
      address: this.randomnessAddress,
      abi: RANDOMNESS_ABI,
      functionName: 'fulfill',
      args: [requestId, randomWord]
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`Saigon chest request ${requestId} reverted.`);
    this.snapshot.fulfilled += 1;
    this.snapshot.lastRequestId = requestId.toString();
    this.snapshot.lastTransactionHash = hash;
    this.logger.info?.(`Saigon chest request ${requestId} fulfilled: ${hash}`);
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

export function createSaigonChestKeeperFromEnvironment(environment = process.env, options = {}) {
  const enabled = environment.MATT_MINE_NFT_SAIGON_KEEPER_ENABLED === 'true';
  if (!enabled) return null;
  const chainId = Number(environment.MATT_MINE_NFT_CHAIN_ID || 202601);
  const contractVersion = Number(environment.MATT_MINE_NFT_CONTRACT_VERSION || 1);
  if (chainId !== 202601 || contractVersion !== 1) return null;
  return new SaigonChestKeeper({
    enabled,
    chainId,
    rpcUrl: environment.MATT_MINE_NFT_RPC_URL || 'https://saigon-testnet.roninchain.com/rpc',
    randomnessAddress: environment.MATT_MINE_NFT_RANDOMNESS_ADDRESS,
    chestAddress: environment.MATT_MINE_NFT_CHEST_ADDRESS,
    expectedOracle: environment.MATT_MINE_NFT_SAIGON_KEEPER_ADDRESS,
    privateKey: environment.MATT_MINE_NFT_SAIGON_KEEPER_PRIVATE_KEY,
    pollIntervalMs: Number(environment.MATT_MINE_NFT_SAIGON_KEEPER_POLL_MS || 5_000),
    ...options
  });
}

function requiredAddress(value, label) {
  try {
    return getAddress(String(value || ''));
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
}

function requiredPrivateKey(value) {
  const privateKey = String(value || '');
  if (!/^0x[0-9a-f]{64}$/i.test(privateKey)) throw new Error('Saigon keeper private key is missing or invalid.');
  return privateKey;
}

function requiredUrl(value, label) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label} must use HTTP(S).`);
  return url.href;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer.`);
  return number;
}
