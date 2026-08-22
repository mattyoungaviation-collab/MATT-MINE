import { RETENTION_CONTROL_LINKS } from '../src/adminControlRegistry.js';

export { LINKED_ADMIN_CONTROL_GROUPS, linkedControlForExpansion, linkedControlForTuning } from '../src/adminControlRegistry.js';

export function applyTuningLinksToExpansion(state, lobby, patch, timestamp = Date.now()) {
  const link = RETENTION_CONTROL_LINKS.find((entry) => entry.lobby === lobby);
  if (!link || !Object.hasOwn(patch || {}, 'deathKeepFraction')) return [];
  const percent = rounded(Number(patch.deathKeepFraction) * 100);
  if (state.expansionConfig.settings[link.expansionKey] === percent) return [];
  state.expansionConfig.settings[link.expansionKey] = percent;
  touchExpansion(state.expansionConfig, timestamp);
  return [`${link.label} synchronized to ${percent}%`];
}

export function applyExpansionLinksToTuning(state, expansionConfig = state.expansionConfig) {
  const changes = [];
  for (const link of RETENTION_CONTROL_LINKS) {
    const fraction = rounded(Number(expansionConfig.settings[link.expansionKey]) / 100);
    const preset = state.gameTuning?.[link.lobby];
    if (!preset || nearlyEqual(preset.deathKeepFraction, fraction)) continue;
    preset.deathKeepFraction = fraction;
    changes.push(`${link.label} synchronized to ${fraction}`);
  }
  return changes;
}

export function reconcileLinkedAdminControls(state, _retiredEconomy, timestamp = Date.now()) {
  const mainChanges = applyExpansionLinksToTuning(state);
  if (mainChanges.length) state.expansionConfig.updatedAt = Math.max(Number(state.expansionConfig.updatedAt || 0), timestamp);
  return { mainChanges, economyChanges: [], shadowPatch: {} };
}

export function linkedAdminControlSnapshot(state) {
  const groups = RETENTION_CONTROL_LINKS.map((link) => {
    const percent = Number(state.expansionConfig?.settings?.[link.expansionKey] || 0);
    const fraction = Number(state.gameTuning?.[link.lobby]?.deathKeepFraction || 0);
    return {
      id: link.id,
      label: link.label,
      canonical: `${percent}%`,
      mirror: String(fraction),
      consistent: nearlyEqual(percent / 100, fraction)
    };
  });
  return { groups, consistent: groups.every((group) => group.consistent), synchronizedCount: groups.length, conflictCount: groups.filter((group) => !group.consistent).length };
}

function touchExpansion(config, timestamp) {
  config.revision = Number(config.revision || 0) + 1;
  config.updatedAt = timestamp;
  config.updatedBy = 'SERVER_ADMIN_LINK_SYNC';
}

function nearlyEqual(left, right) { return Math.abs(Number(left) - Number(right)) < 0.000001; }
function rounded(value) { return Number(Number(value).toFixed(4)); }
