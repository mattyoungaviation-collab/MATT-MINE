const PLAYER_NUMBER_FIELDS = Object.freeze([
  'maxHealth', 'health', 'maxShield', 'shield', 'speed', 'damage',
  'blasterBaseDamage', 'dynamiteBaseDamage', 'healAmount', 'minerLevel',
  'crystalCarryCapacity', 'crystalDeathRetentionBps', 'crystalsPerHour',
  'attackCooldown', 'attackTimer', 'attackRange', 'critChance', 'magnetRange',
  'armor', 'level', 'xp', 'nextXp', 'invulnerable', 'dashCooldown',
  'dashCooldownMax', 'dynamiteEvery', 'droneCount', 'droneTimer',
  'dynamiteAmmo', 'blasterEnergy', 'blasterEnergyMax', 'blasterEnergyRegen',
  'blasterDamageScale', 'blasterVolley'
]);

const RUN_NUMBER_FIELDS = Object.freeze([
  'rawScore', 'displayedScore', 'kills', 'oreBroken', 'crystalsCollected',
  'runLevelUps', 'attackCounter'
]);

const WEAPONS = new Set(['pickaxe', 'dynamite', 'blaster']);

// Complete mutable state that survives an Endless descent. Position, map
// entities, and phase timers are excluded because the immutable manifest and
// phase seed recreate those on the browser and authoritative server replay.
export function captureEndlessContinuation(game = {}) {
  const player = game.player || {};
  const run = game.run || {};
  return {
    version: 1,
    player: {
      ...copyFiniteFields(player, PLAYER_NUMBER_FIELDS),
      weapon: WEAPONS.has(player.weapon) ? player.weapon : 'pickaxe',
      unlockedWeapons: {
        pickaxe: true,
        dynamite: player.unlockedWeapons?.dynamite === true,
        blaster: player.unlockedWeapons?.blaster === true
      },
      runUpgradeCounts: normalizeUpgradeCounts(player.runUpgradeCounts)
    },
    run: copyFiniteFields(run, RUN_NUMBER_FIELDS)
  };
}

export function applyEndlessContinuation(game, input) {
  if (!game?.player || !game?.run || Number(input?.version) !== 1) return false;
  const snapshot = captureEndlessContinuation({ player: input.player, run: input.run });
  Object.assign(game.player, snapshot.player);
  Object.assign(game.run, snapshot.run);
  return true;
}

function copyFiniteFields(source, fields) {
  return Object.fromEntries(fields.map((field) => [field, finite(source?.[field])]));
}

function normalizeUpgradeCounts(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key, value]) => /^[a-z]{3,20}$/.test(key) && Number.isSafeInteger(Number(value)))
      .slice(0, 100)
      .map(([key, value]) => [key, Math.max(0, Math.min(1_000, Number(value)))])
  );
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
