import {
  CHARACTER_PRICE_CONTROL_LINKS,
  LINKED_ADMIN_CONTROL_GROUPS,
  RETENTION_CONTROL_LINKS
} from '../src/adminControlRegistry.js';

export {
  LINKED_ADMIN_CONTROL_GROUPS,
  linkedControlForCharacter,
  linkedControlForExpansion,
  linkedControlForTuning
} from '../src/adminControlRegistry.js';

const RETENTION_LINKS = RETENTION_CONTROL_LINKS;
const CHARACTER_PRICE_LINKS = CHARACTER_PRICE_CONTROL_LINKS;

export function applyTuningLinksToExpansion(state, lobby, patch, timestamp = Date.now()) {
  const link = RETENTION_LINKS.find((entry) => entry.lobby === lobby);
  if (!link || !Object.hasOwn(patch || {}, 'deathKeepFraction')) return [];
  const percent = rounded(Number(patch.deathKeepFraction) * 100);
  if (state.expansionConfig.settings[link.expansionKey] === percent) return [];
  state.expansionConfig.settings[link.expansionKey] = percent;
  touchExpansion(state.expansionConfig, timestamp);
  return [`${link.label} synchronized to ${percent}%`];
}

export function applyExpansionLinksToTuning(state, expansionConfig = state.expansionConfig) {
  const changes = [];
  for (const link of RETENTION_LINKS) {
    const fraction = rounded(Number(expansionConfig.settings[link.expansionKey]) / 100);
    const preset = state.gameTuning?.[link.lobby];
    if (!preset || nearlyEqual(preset.deathKeepFraction, fraction)) continue;
    preset.deathKeepFraction = fraction;
    changes.push(`${link.label} synchronized to ${fraction}`);
  }
  return changes;
}

export function applyEconomyLinksToExpansion(state, economyConfig, timestamp = Date.now()) {
  if (!economyConfig || !state.expansionConfig) return [];
  const changes = [];
  const advertisementEnabled = economyConfig.advertisementRewardsEnabled === true;
  if (state.expansionConfig.settings.advertisementRewardsEnabled !== advertisementEnabled) {
    state.expansionConfig.settings.advertisementRewardsEnabled = advertisementEnabled;
    changes.push(`Advertisement rewards synchronized to ${advertisementEnabled ? 'enabled' : 'disabled'}`);
  }
  for (const link of CHARACTER_PRICE_LINKS) {
    const character = state.expansionConfig.characters?.[link.characterId];
    if (!character) continue;
    const price = Number(economyConfig.characterUnlockPrices?.[link.economyKey] ?? character.nuggetPrice);
    if (!Number.isSafeInteger(price) || character.nuggetPrice === price) continue;
    character.nuggetPrice = price;
    changes.push(`${link.label} synchronized to ${price}`);
  }
  if (changes.length) touchExpansion(state.expansionConfig, timestamp);
  return changes;
}

export function economyShadowPatch(expansionConfig) {
  const characters = expansionConfig?.characters || {};
  return {
    advertisementRewardsEnabled: expansionConfig?.settings?.advertisementRewardsEnabled === true,
    characterUnlockPrices: Object.fromEntries(CHARACTER_PRICE_LINKS.map((link) => [
      link.economyKey,
      Number(characters[link.characterId]?.nuggetPrice || 0)
    ]))
  };
}

export function reconcileLinkedAdminControls(state, economyConfig, timestamp = Date.now()) {
  const mainChanges = applyExpansionLinksToTuning(state);
  const shadowPatch = economyShadowPatch(state.expansionConfig);
  const economyChanges = [];
  if (economyConfig) {
    if (economyConfig.advertisementRewardsEnabled !== shadowPatch.advertisementRewardsEnabled) {
      economyChanges.push('Advertisement rewards shadow synchronized');
    }
    for (const link of CHARACTER_PRICE_LINKS) {
      if (Number(economyConfig.characterUnlockPrices?.[link.economyKey] || 0) !== shadowPatch.characterUnlockPrices[link.economyKey]) {
        economyChanges.push(`${link.label} shadow synchronized`);
      }
    }
  }
  if (mainChanges.length) {
    state.expansionConfig.updatedAt = Math.max(Number(state.expansionConfig.updatedAt || 0), timestamp);
  }
  return { mainChanges, economyChanges, shadowPatch };
}

export function linkedAdminControlSnapshot(state, economyConfig) {
  const groups = [];
  for (const link of RETENTION_LINKS) {
    const percent = Number(state.expansionConfig?.settings?.[link.expansionKey] || 0);
    const fraction = Number(state.gameTuning?.[link.lobby]?.deathKeepFraction || 0);
    groups.push({
      id: link.id,
      label: link.label,
      canonical: `${percent}%`,
      mirror: String(fraction),
      consistent: nearlyEqual(percent / 100, fraction)
    });
  }
  const advertisementCanonical = state.expansionConfig?.settings?.advertisementRewardsEnabled === true;
  const advertisementMirror = economyConfig?.advertisementRewardsEnabled === true;
  groups.push({
    id: 'advertisement-rewards-enabled',
    label: 'Advertisement rewards enabled',
    canonical: String(advertisementCanonical),
    mirror: String(advertisementMirror),
    consistent: !economyConfig || advertisementCanonical === advertisementMirror
  });
  for (const link of CHARACTER_PRICE_LINKS) {
    const canonical = Number(state.expansionConfig?.characters?.[link.characterId]?.nuggetPrice || 0);
    const mirror = Number(economyConfig?.characterUnlockPrices?.[link.economyKey] || 0);
    groups.push({
      id: link.id,
      label: link.label,
      canonical: String(canonical),
      mirror: String(mirror),
      consistent: !economyConfig || canonical === mirror
    });
  }
  return {
    groups,
    consistent: groups.every((group) => group.consistent),
    synchronizedCount: groups.length,
    conflictCount: groups.filter((group) => !group.consistent).length
  };
}

function touchExpansion(config, timestamp) {
  config.revision = Number(config.revision || 0) + 1;
  config.updatedAt = timestamp;
  config.updatedBy = 'SERVER_ADMIN_LINK_SYNC';
}

function nearlyEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < 0.000001;
}

function rounded(value) {
  return Number(Number(value).toFixed(4));
}
