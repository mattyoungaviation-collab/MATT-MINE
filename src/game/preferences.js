import '../practiceClaimFlow.js';
import '../nuggetShop.js';

export const GAMEPLAY_PREFERENCES_KEY = 'matt-mine-gameplay-preferences-v1';

export function loadGameplayPreferences(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(GAMEPLAY_PREFERENCES_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    return {
      screenShake: typeof saved?.screenShake === 'boolean' ? saved.screenShake : true
    };
  } catch {
    return { screenShake: true };
  }
}

export function saveGameplayPreferences(preferences, storage = globalThis.localStorage) {
  const normalized = {
    screenShake: preferences?.screenShake !== false
  };
  try {
    storage?.setItem(GAMEPLAY_PREFERENCES_KEY, JSON.stringify(normalized));
  } catch {
    // Preferences are optional; gameplay must continue if storage is blocked.
  }
  return normalized;
}
