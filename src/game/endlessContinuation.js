import { CONSUMABLE_ID_LIST, CONSUMABLE_IDS } from './consumables.js';

const PLAYER_NUMBER_FIELDS = Object.freeze([
  'maxHealth', 'health', 'maxShield', 'shield', 'speed', 'damage',
  'blasterBaseDamage', 'dynamiteBaseDamage', 'healAmount', 'minerLevel',
  'crystalCarryCapacity', 'crystalDeathRetentionBps', 'crystalsPerHour',
  'attackCooldown', 'attackTimer', 'attackRange', 'critChance', 'magnetRange',
  'armor', 'level', 'xp', 'nextXp', 'invulnerable', 'dashCooldown',
  'dashCooldownMax', 'dynamiteEvery', 'droneCount', 'droneTimer',
  'dynamiteAmmo', 'blasterEnergy', 'blasterEnergyMax', 'blasterEnergyRegen',
  'blasterDamageScale', 'blasterVolley', 'forceFieldRemaining'
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
    version: 2,
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
    run: {
      ...copyFiniteFields(run, RUN_NUMBER_FIELDS),
      consumables: normalizeEndlessConsumables(run.consumables)
    }
  };
}

export function applyEndlessContinuation(game, input) {
  const version = Number(input?.version);
  if (!game?.player || !game?.run || ![1, 2].includes(version)) return false;
  const snapshot = captureEndlessContinuation({ player: input.player, run: input.run });
  Object.assign(game.player, snapshot.player);
  const { consumables, ...runState } = snapshot.run;
  Object.assign(game.run, runState);
  if (version >= 2 && input?.run?.consumables && typeof input.run.consumables === 'object') {
    game.run.consumables = consumables;
  }
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

function normalizeEndlessConsumables(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const remainingSource = source.remaining && typeof source.remaining === 'object' && !Array.isArray(source.remaining)
    ? source.remaining
    : {};
  const remaining = Object.fromEntries(CONSUMABLE_ID_LIST.map((id) => [id, counter(remainingSource[id])]));
  return {
    remaining,
    heavyCrystalHaulerActive:
      source.heavyCrystalHaulerActive === true ||
      remaining[CONSUMABLE_IDS.HEAVY_CRYSTAL_HAULER] > 0,
    medicPacksUsed: counter(source.medicPacksUsed),
    forceFieldsUsed: counter(source.forceFieldsUsed)
  };
}

function counter(value) {
  return Math.max(0, Math.min(1_000_000, Math.floor(finite(value))));
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
