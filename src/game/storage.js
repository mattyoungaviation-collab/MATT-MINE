const KEY = 'matt-mine-profile-v1';

export function defaultProfile() {
  return {
    bankedNuggets: 0,
    bestDepth: 0,
    bestScore: 0,
    totalRuns: 0,
    meta: { health: 0, damage: 0, speed: 0, luck: 0 }
  };
}

export function loadProfile() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultProfile();
    const parsed = JSON.parse(raw);
    const base = defaultProfile();
    return {
      ...base,
      ...parsed,
      meta: { ...base.meta, ...(parsed.meta || {}) }
    };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile) {
  try {
    localStorage.setItem(KEY, JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function resetProfile() {
  const profile = defaultProfile();
  saveProfile(profile);
  return profile;
}
