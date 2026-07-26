import { defaultProfile, normalizeProfile } from '../src/game/storage.js';
import {
  COSMETIC_SLOTS,
  PASS_CHEST_ID,
  PASS_COSMETICS,
  defaultPassInventory
} from '../src/game/passRewards.js';
import { SERVER_STATE_VERSION } from './constants.js';

export function defaultServerState() {
  return {
    version: SERVER_STATE_VERSION,
    wallets: {},
    challenges: {},
    sessions: {},
    runs: {},
    passPurchases: {},
    paidEntitlements: {},
    operations: defaultOperations(),
    audit: []
  };
}

export function defaultWalletState(address, timestamp = Date.now()) {
  return {
    address,
    profile: defaultProfile(),
    passProgress: defaultPassProgress(),
    passInventory: defaultPassInventory(),
    suspended: false,
    daily: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function normalizeServerState(input = {}) {
  const source = isRecord(input) ? input : {};
  return {
    version: SERVER_STATE_VERSION,
    wallets: normalizeWallets(source.wallets),
    challenges: normalizeRecords(source.challenges, 2_000),
    sessions: normalizeRecords(source.sessions, 10_000),
    runs: normalizeRecords(source.runs, 25_000),
    passPurchases: normalizePassPurchases(source.passPurchases),
    paidEntitlements: normalizePaidEntitlements(source.paidEntitlements),
    operations: normalizeOperations(source.operations),
    audit: Array.isArray(source.audit)
      ? source.audit.filter(isRecord).slice(-2_000).map((entry) => ({ ...entry }))
      : []
  };
}

export function defaultOperations() {
  return {
    maintenanceMode: false,
    freeRankedPaused: false,
    passRankedPaused: false,
    purchasesPaused: false,
    claimsPaused: false,
    announcement: '',
    updatedAt: 0,
    updatedBy: ''
  };
}

function normalizeOperations(input) {
  const source = isRecord(input) ? input : {};
  return {
    maintenanceMode: source.maintenanceMode === true,
    freeRankedPaused: source.freeRankedPaused === true,
    passRankedPaused: source.passRankedPaused === true,
    purchasesPaused: source.purchasesPaused === true,
    claimsPaused: source.claimsPaused === true,
    announcement: typeof source.announcement === 'string'
      ? source.announcement.trim().slice(0, 280)
      : '',
    updatedAt: safeTimestamp(source.updatedAt),
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 80) : ''
  };
}

function normalizePaidEntitlements(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) =>
      isRecord(value) &&
      /^0x[a-fA-F0-9]{64}$/.test(value.transactionHash || '') &&
      isHexAddress(value.address) &&
      Number.isSafeInteger(value.logIndex) &&
      value.logIndex >= 0
    )
    .slice(-25_000)
    .map(([key, value]) => [String(key).slice(0, 200).toLowerCase(), {
      key: String(value.key || key).slice(0, 200).toLowerCase(),
      transactionHash: value.transactionHash.toLowerCase(),
      logIndex: value.logIndex,
      blockNumber: safeUnsignedString(value.blockNumber),
      address: value.address.toLowerCase(),
      entitlementId: safeUnsignedString(value.entitlementId),
      ronPaid: safeUnsignedString(value.ronPaid),
      mattBought: safeUnsignedString(value.mattBought),
      currentPoolMatt: safeUnsignedString(value.currentPoolMatt),
      futureRewardsMatt: safeUnsignedString(value.futureRewardsMatt),
      reserveMatt: safeUnsignedString(value.reserveMatt),
      confirmedAt: safeTimestamp(value.confirmedAt),
      consumedAt: safeTimestamp(value.consumedAt),
      usedRunId: typeof value.usedRunId === 'string' ? value.usedRunId.slice(0, 120) : ''
    }]));
}

function normalizePassPurchases(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) =>
      isRecord(value) &&
      /^0x[a-fA-F0-9]{64}$/.test(value.transactionHash || '') &&
      isHexAddress(value.address) &&
      Number.isSafeInteger(value.logIndex) &&
      value.logIndex >= 0
    )
    .slice(-20_000)
    .map(([key, value]) => [String(key).slice(0, 200).toLowerCase(), {
      key: String(value.key || key).slice(0, 200).toLowerCase(),
      transactionHash: value.transactionHash.toLowerCase(),
      logIndex: value.logIndex,
      blockNumber: safeUnsignedString(value.blockNumber),
      address: value.address.toLowerCase(),
      priceRon: safeUnsignedString(value.priceRon),
      expiresAt: safeTimestamp(value.expiresAt),
      confirmedAt: safeTimestamp(value.confirmedAt)
    }]));
}

function normalizeWallets(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([address, wallet]) => isRecord(wallet) && isHexAddress(address))
    .slice(-20_000)
    .map(([address, wallet]) => {
      const normalizedAddress = address.toLowerCase();
      return [normalizedAddress, {
        address: normalizedAddress,
        profile: normalizeProfile(wallet.profile),
        passProgress: normalizePassProgress(wallet.passProgress),
        passInventory: normalizePassInventory(wallet.passInventory),
        suspended: wallet.suspended === true,
        daily: normalizeDaily(wallet.daily),
        createdAt: safeTimestamp(wallet.createdAt),
        updatedAt: safeTimestamp(wallet.updatedAt)
      }];
    }));
}

function defaultPassProgress() {
  return {
    xp: 0,
    updatedAt: 0
  };
}

function normalizePassProgress(input) {
  const source = isRecord(input) ? input : {};
  return {
    xp: safeBoundedInteger(source.xp, 1_000_000_000),
    updatedAt: safeTimestamp(source.updatedAt)
  };
}

function normalizePassInventory(input) {
  const source = isRecord(input) ? input : {};
  const defaults = defaultPassInventory();
  const cosmetics = Array.isArray(source.cosmetics)
    ? [...new Set(source.cosmetics.filter((id) => typeof id === 'string' && PASS_COSMETICS[id]))]
    : [];
  const equippedSource = isRecord(source.equipped) ? source.equipped : {};
  const equipped = Object.fromEntries(COSMETIC_SLOTS.map((slot) => {
    const cosmeticId = typeof equippedSource[slot] === 'string' ? equippedSource[slot] : '';
    const cosmetic = PASS_COSMETICS[cosmeticId];
    return [slot, cosmetic && cosmetic.slot === slot && cosmetics.includes(cosmeticId) ? cosmeticId : ''];
  }));
  const claimedLevels = Array.isArray(source.claimedLevels)
    ? [...new Set(source.claimedLevels
      .filter((level) => Number.isSafeInteger(level) && level >= 1 && level <= 8))]
      .sort((left, right) => left - right)
    : [];
  const chestSource = isRecord(source.chests?.[PASS_CHEST_ID])
    ? source.chests[PASS_CHEST_ID]
    : defaults.chests[PASS_CHEST_ID];
  return {
    claimedLevels,
    cosmetics,
    equipped,
    chests: {
      [PASS_CHEST_ID]: {
        available: safeBoundedInteger(chestSource.available, 100),
        opened: safeBoundedInteger(chestSource.opened, 100),
        lastOpenedAt: safeTimestamp(chestSource.lastOpenedAt)
      }
    }
  };
}

function normalizeDaily(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && isRecord(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-45)
    .map(([key, value]) => [key, {
      freeRunUsed: value.freeRunUsed === true,
      freeRunId: typeof value.freeRunId === 'string' ? value.freeRunId.slice(0, 120) : ''
    }]));
}

function normalizeRecords(input, limit) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) => isRecord(value))
    .slice(-limit)
    .map(([key, value]) => [String(key).slice(0, 200), { ...value }]));
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeBoundedInteger(value, max) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function safeUnsignedString(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : '0';
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
