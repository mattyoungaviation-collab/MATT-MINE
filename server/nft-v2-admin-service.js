import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApiError } from './errors.js';
import { nftRpcUrlFromEnvironment } from './nft-rpc-url.js';

const CONFIG_ABI_LINES = [
  'function CONFIG_ROLE() view returns (bytes32)',
  'function hasRole(bytes32,address) view returns (bool)',
  'function paused() view returns (bool)'
];
const LOADOUT_ABI = parseAbi([
  ...CONFIG_ABI_LINES,
  'function repairPrice() view returns (uint256)',
  'function setRepairPrice(uint256 repairPrice)'
]);
const BANK_ABI = parseAbi([
  ...CONFIG_ABI_LINES,
  'function minimumWithdrawal() view returns (uint256)',
  'function walletDailyLimit() view returns (uint256)',
  'function globalDailyLimit() view returns (uint256)',
  'function setWithdrawalConfiguration(uint256 minimum,uint256 walletLimit,uint256 globalLimit)'
]);
const CHEST_ABI = parseAbi([
  ...CONFIG_ABI_LINES,
  'function chestPrice(uint8 slot) view returns (uint256)',
  'function setChestPrice(uint8 slot,uint256 price)'
]);
const SETTLEMENT_ABI = parseAbi([
  ...CONFIG_ABI_LINES,
  'function approveMapVersion(bytes32 mapId,bytes32 contentHash,uint32 mineableCrystalUnits,uint256 conversionRate,uint256 maximumPayout,uint32 runTimeout) returns (bytes32)',
  'function retireMapVersion(bytes32 versionId)',
  'function mapVersions(bytes32 versionId) view returns (bytes32 mapId,bytes32 contentHash,uint128 conversionRate,uint128 maximumPayout,uint32 mineableCrystalUnits,uint32 runTimeout,bool approved,bool retired)'
]);
const SLOT_NAMES = Object.freeze(['armor', 'pickaxe', 'blaster', 'dynamite', 'helmet', 'backpack']);

export class NftV2AdminService {
  constructor(options = {}) {
    this.enabled = options.enabled === true;
    this.chainId = positiveInteger(options.chainId || 2020, 'NFT Admin chain ID');
    this.rpcUrl = requiredUrl(options.rpcUrl, 'NFT Admin RPC URL');
    this.addresses = Object.freeze(Object.fromEntries(['loadout', 'bank', 'chest', 'settlement'].map((key) => [
      key,
      requiredAddress(options.addresses?.[key], `${key} address`)
    ])));
    this.operatorAddress = requiredAddress(options.operatorAddress, 'NFT Config Operator address');
    this.account = privateKeyToAccount(requiredPrivateKey(options.privateKey, 'NFT Config Operator private key'));
    if (getAddress(this.account.address) !== this.operatorAddress) throw new Error('NFT Config Operator key/address mismatch.');
    this.gameplayService = options.gameplayService;
    const chain = defineChain({
      id: this.chainId,
      name: this.chainId === 2020 ? 'Ronin Mainnet' : 'Saigon Testnet',
      nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
      rpcUrls: { default: { http: [this.rpcUrl] } }
    });
    this.publicClient = options.publicClient || createPublicClient({ chain, transport: http(this.rpcUrl) });
    this.walletClient = options.walletClient || createWalletClient({ account: this.account, chain, transport: http(this.rpcUrl) });
    this.queue = Promise.resolve();
  }

  async init() {
    for (const [name, address] of Object.entries(this.addresses)) {
      const abi = this.#abi(name);
      const role = await this.publicClient.readContract({ address, abi, functionName: 'CONFIG_ROLE' });
      const allowed = await this.publicClient.readContract({ address, abi, functionName: 'hasRole', args: [role, this.operatorAddress] });
      if (!allowed) throw new Error(`NFT Config Operator lacks CONFIG_ROLE on ${name}.`);
    }
    return this;
  }

  publicStatus() {
    return { enabled: this.enabled, chainId: this.chainId, operator: this.operatorAddress, contracts: this.addresses };
  }

  async snapshot() {
    const [repairPrice, withdrawal, prices, paused] = await Promise.all([
      this.#read('loadout', 'repairPrice'),
      Promise.all(['minimumWithdrawal', 'walletDailyLimit', 'globalDailyLimit'].map((functionName) => this.#read('bank', functionName))),
      Promise.all(SLOT_NAMES.map((_slot, index) => this.#read('chest', 'chestPrice', [index]))),
      Promise.all(Object.keys(this.addresses).map(async (name) => [name, await this.#read(name, 'paused')]))
    ]);
    return {
      repairPriceRaw: repairPrice.toString(),
      withdrawal: {
        minimumRaw: withdrawal[0].toString(),
        walletDailyRaw: withdrawal[1].toString(),
        globalDailyRaw: withdrawal[2].toString()
      },
      chestPrices: Object.fromEntries(SLOT_NAMES.map((slot, index) => [slot, prices[index].toString()])),
      paused: Object.fromEntries(paused),
      activeMapVersions: { ...(this.gameplayService?.mapVersions || {}) }
    };
  }

  async setEconomy(input = {}) {
    return this.#serialize(async () => {
      const planned = [];
      const transactions = [];
      if (input.repairPriceRaw !== undefined) {
        planned.push(['loadout', 'setRepairPrice', [boundedUint128(input.repairPriceRaw, 'repair price')]]);
      }
      if (input.withdrawal) {
        const minimum = positiveUint(input.withdrawal.minimumRaw, 'minimum withdrawal');
        const wallet = positiveUint(input.withdrawal.walletDailyRaw, 'wallet daily limit');
        const global = positiveUint(input.withdrawal.globalDailyRaw, 'global daily limit');
        if (minimum < 10n ** 18n || minimum > wallet || global < wallet || wallet > 1_000_000n * 10n ** 18n || global > 100_000_000n * 10n ** 18n) {
          throw new ApiError(422, 'nft_withdrawal_limits_invalid', 'Withdrawal limits exceed the contract ceilings.');
        }
        planned.push(['bank', 'setWithdrawalConfiguration', [minimum, wallet, global]]);
      }
      for (const [slot, raw] of Object.entries(input.chestPrices || {})) {
        const index = SLOT_NAMES.indexOf(slot);
        if (index < 0) throw new ApiError(422, 'nft_chest_slot_invalid', `Unknown equipment slot ${slot}.`);
        planned.push(['chest', 'setChestPrice', [index, boundedUint128(raw, `${slot} chest price`)]]);
      }
      if (!planned.length) {
        throw new ApiError(422, 'nft_economy_patch_empty', 'Change at least one NFT V2 economy control.');
      }
      for (const [name, functionName, args] of planned) transactions.push(await this.#write(name, functionName, args));
      return { transactions, protocol: await this.snapshot() };
    });
  }

  async approveMap(input = {}) {
    return this.#serialize(async () => {
      const mode = ['arena', 'paid'].includes(String(input.mode || '').toLowerCase()) ? String(input.mode).toLowerCase() : '';
      if (!mode) throw new ApiError(422, 'nft_map_mode_invalid', 'Choose arena or paid.');
      const args = [
        requiredBytes32(input.mapId, 'map ID'),
        requiredBytes32(input.contentHash, 'content hash'),
        positiveNumber(input.mineableCrystalUnits, 'mineable Crystal units', 1_000_000),
        positiveUint(input.conversionRateRaw, 'conversion rate'),
        positiveUint(input.maximumPayoutRaw, 'maximum payout'),
        positiveNumber(input.runTimeoutSeconds, 'run timeout', 86_400)
      ];
      if (args[5] < 300) throw new ApiError(422, 'nft_map_timeout_invalid', 'Run timeout must be at least five minutes.');
      const tokenUnit = 10n ** 18n;
      if (args[3] > 100_000n * tokenUnit || args[4] > 100_000n * tokenUnit) {
        throw new ApiError(422, 'nft_map_economy_invalid', 'Map conversion and payout exceed the contract ceiling.');
      }
      const hash = await this.#write('settlement', 'approveMapVersion', args);
      const versionId = mapVersionId(args);
      this.gameplayService?.setMapVersion?.(mode, versionId);
      return { mode, versionId, transactionHash: hash, protocol: await this.snapshot() };
    });
  }

  async retireMap(input = {}) {
    return this.#serialize(async () => {
      const versionId = requiredBytes32(input.versionId, 'map version');
      const hash = await this.#write('settlement', 'retireMapVersion', [versionId]);
      const retiredModes = Object.entries(this.gameplayService?.mapVersions || {})
        .filter(([, activeVersion]) => activeVersion === versionId)
        .map(([mode]) => mode);
      for (const mode of retiredModes) this.gameplayService?.clearMapVersion?.(mode, versionId);
      return { versionId, retiredModes, transactionHash: hash, protocol: await this.snapshot() };
    });
  }

  #abi(name) { return { loadout: LOADOUT_ABI, bank: BANK_ABI, chest: CHEST_ABI, settlement: SETTLEMENT_ABI }[name]; }
  async #read(name, functionName, args = []) {
    return this.publicClient.readContract({ address: this.addresses[name], abi: this.#abi(name), functionName, args });
  }
  async #write(name, functionName, args) {
    const hash = await this.walletClient.writeContract({ address: this.addresses[name], abi: this.#abi(name), functionName, args });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`NFT ${functionName} reverted.`);
    return hash;
  }
  #serialize(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export function createNftV2AdminServiceFromEnvironment(gameplayService, environment = process.env, options = {}) {
  if (environment.MATT_MINE_NFT_ADMIN_CONTROLS_ENABLED !== 'true') return null;
  return new NftV2AdminService({
    enabled: true,
    chainId: Number(environment.MATT_MINE_NFT_CHAIN_ID || 2020),
    rpcUrl: nftRpcUrlFromEnvironment(environment),
    addresses: {
      loadout: environment.MATT_MINE_NFT_LOADOUT_ADDRESS,
      bank: environment.MATT_MINE_NFT_CRYSTAL_BANK_ADDRESS,
      chest: environment.MATT_MINE_NFT_CHEST_ADDRESS,
      settlement: environment.MATT_MINE_NFT_SETTLEMENT_ADDRESS
    },
    operatorAddress: environment.MATT_MINE_NFT_CONFIG_OPERATOR_ADDRESS,
    privateKey: environment.MATT_MINE_NFT_CONFIG_OPERATOR_PRIVATE_KEY
      || environment.MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY,
    gameplayService,
    ...options
  });
}

function mapVersionId(args) {
  return keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32,bytes32,uint32,uint256,uint256,uint32'),
    args
  ));
}
function requiredAddress(value, label) { try { return getAddress(String(value || '')); } catch { throw new Error(`${label} is invalid.`); } }
function requiredUrl(value, label) { const url = new URL(String(value || '')); if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`); return url.href; }
function requiredPrivateKey(value, label) { const key = String(value || ''); if (!/^0x[0-9a-f]{64}$/i.test(key)) throw new Error(`${label} is invalid.`); return key; }
function requiredBytes32(value, label) { const result = String(value || '').toLowerCase(); if (!/^0x[0-9a-f]{64}$/.test(result) || /^0x0{64}$/.test(result)) throw new ApiError(422, 'nft_bytes32_invalid', `${label} is invalid.`); return result; }
function positiveUint(value, label) { let result; try { result = BigInt(value); } catch { throw new ApiError(422, 'nft_uint_invalid', `${label} is invalid.`); } if (result <= 0n) throw new ApiError(422, 'nft_uint_invalid', `${label} must be greater than zero.`); return result; }
function boundedUint128(value, label) { const result = positiveUint(value, label); if (result > (1n << 128n) - 1n) throw new ApiError(422, 'nft_uint_invalid', `${label} exceeds the contract ceiling.`); return result; }
function positiveInteger(value, label) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be positive.`); return result; }
function positiveNumber(value, label, maximum) { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new ApiError(422, 'nft_number_invalid', `${label} is outside 1-${maximum}.`); return result; }
