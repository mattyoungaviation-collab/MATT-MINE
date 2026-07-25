import { defaultProfile, normalizeProfile } from '../src/game/storage.js';
import { SERVER_STATE_VERSION } from './constants.js';

export function defaultServerState() {
  return {
    version: SERVER_STATE_VERSION,
    wallets: {},
    challenges: {},
    sessions: {},
    runs: {},
    audit: []
  };
}

export function defaultWalletState(address, timestamp = Date.now()) {
  return {
    address,
    profile: defaultProfile(),
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
    audit: Array.isArray(source.audit)
      ? source.audit.filter(isRecord).slice(-2_000).map((entry) => ({ ...entry }))
      : []
  };
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
        suspended: wallet.suspended === true,
        daily: normalizeDaily(wallet.daily),
        createdAt: safeTimestamp(wallet.createdAt),
        updatedAt: safeTimestamp(wallet.updatedAt)
      }];
    }));
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

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
