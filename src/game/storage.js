import { META_UPGRADES } from './config.js';

export const PROFILE_STORAGE_KEY = 'matt-mine-profile-v1';

const META_LIMITS = Object.fromEntries(META_UPGRADES.map((upgrade) => [upgrade.id, upgrade.max]));

export function defaultProfile() {
  return {
    bankedNuggets: 0,
    bestDepth: 0,
    bestScore: 0,
    totalRuns: 0,
    meta: Object.fromEntries(META_UPGRADES.map((upgrade) => [upgrade.id, 0]))
  };
}

export function normalizeProfile(input = {}) {
  const source = isRecord(input) ? input : {};
  const meta = isRecord(source.meta) ? source.meta : {};
  const base = defaultProfile();
  return {
    bankedNuggets: safeInteger(source.bankedNuggets, base.bankedNuggets),
    bestDepth: safeInteger(source.bestDepth, base.bestDepth),
    bestScore: safeInteger(source.bestScore, base.bestScore),
    totalRuns: safeInteger(source.totalRuns, base.totalRuns),
    meta: Object.fromEntries(META_UPGRADES.map(({ id }) => [
      id,
      safeInteger(meta[id], base.meta[id], META_LIMITS[id] ?? 100)
    ]))
  };
}

export function loadProfile(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(PROFILE_STORAGE_KEY);
    if (!raw) return defaultProfile();
    const normalized = normalizeProfile(JSON.parse(raw));
    persistProfile(storage, normalized);
    return normalized;
  } catch {
    const recovered = defaultProfile();
    persistProfile(storage, recovered);
    return recovered;
  }
}

export function saveProfile(profile, storage = globalThis.localStorage) {
  return persistProfile(storage, normalizeProfile(profile));
}

export function resetProfile(storage = globalThis.localStorage) {
  const profile = defaultProfile();
  persistProfile(storage, profile);
  return profile;
}

function persistProfile(storage, profile) {
  try {
    storage?.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.min(max, Math.floor(number));
}
