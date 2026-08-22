export const PROFILE_STORAGE_KEY = 'matt-mine-profile-v1';

export function defaultProfile() {
  return {
    bestDepth: 0,
    bestScore: 0,
    totalRuns: 0
  };
}

export function normalizeProfile(input = {}) {
  const source = isRecord(input) ? input : {};
  const base = defaultProfile();
  return {
    bestDepth: safeInteger(source.bestDepth, base.bestDepth),
    bestScore: safeInteger(source.bestScore, base.bestScore),
    totalRuns: safeInteger(source.totalRuns, base.totalRuns)
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
