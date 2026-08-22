import { CONFIG } from './config.js';

const V2_TRAIT_KEYS = Object.freeze([
  'armorShield',
  'pickaxeAttack',
  'blasterAttack',
  'dynamiteAttack',
  'healAmount',
  'carryCapacity',
  'deathRetentionBps'
]);

export function nftGameplayTraits(input = {}) {
  const nftRun = input?.nftRun && typeof input.nftRun === 'object'
    ? input.nftRun
    : input && typeof input === 'object'
      ? input
      : {};
  const profile = firstRecord(
    nftRun.profile,
    input?.tuning?.nftMinerProfile,
    input?.tuning?._nftRun?.profile
  );
  const gameplay = profile.gameplay && typeof profile.gameplay === 'object'
    ? profile.gameplay
    : {};
  const source = {
    ...record(gameplay),
    ...record(profile.traits),
    ...record(profile.effectiveTraits),
    ...record(gameplay.traits),
    ...record(gameplay.effectiveTraits),
    ...record(nftRun.traits)
  };
  const version = String(
    nftRun.contractVersion ?? nftRun.version ?? profile.contractVersion ?? profile.version ?? ''
  ).toLowerCase();
  const isV2 = version === '2' || version === 'v2' || version === 'nft-v2' ||
    V2_TRAIT_KEYS.some((key) => Object.hasOwn(source, key));
  if (!isV2) return null;

  const progression = profile.progression && typeof profile.progression === 'object'
    ? profile.progression
    : {};
  return Object.freeze({
    version: 2,
    maximumHealth: integer(source.maximumHealth ?? source.baseHealth, 1, Number.MAX_SAFE_INTEGER, 1),
    armorShield: integer(source.armorShield, 0),
    pickaxeAttack: integer(source.pickaxeAttack, 1, Number.MAX_SAFE_INTEGER, 1),
    blasterAttack: integer(source.blasterAttack, 1, Number.MAX_SAFE_INTEGER, 1),
    dynamiteAttack: integer(source.dynamiteAttack, 1, Number.MAX_SAFE_INTEGER, 1),
    healAmount: integer(source.healAmount ?? source.heal, 1, Number.MAX_SAFE_INTEGER, 1),
    carryCapacity: integer(source.carryCapacity ?? source.baseCarryCapacity, 0),
    deathRetentionBps: integer(source.deathRetentionBps, 0, 10_000),
    level: integer(source.level ?? progression.level, 1, 100, 1),
    crystalsPerHour: integer(source.crystalsPerHour, 0, 50)
  });
}

export function nftCarryCapacity(runContext = {}) {
  const traits = nftGameplayTraits(runContext);
  if (traits) return traits.carryCapacity;
  const configured = Number(runContext?.tuning?.nftCrystalCarryLimit);
  return Number.isSafeInteger(configured) && configured >= 0
    ? configured
    : Number.MAX_SAFE_INTEGER;
}

export function nftHealAmount(runContext = {}, fallback = 0) {
  return nftGameplayTraits(runContext)?.healAmount ?? Math.max(0, Number(fallback) || 0);
}

// A compact, non-secret proof of the exact trait and Admin values consumed by
// the shared browser/server engine. Replay responses expose this snapshot so
// parity tests can detect a control that was accepted by Admin but ignored by
// deterministic replay.
export function gameplayRuntimeSnapshot(game = {}) {
  const runContext = game.runContext || {};
  const tuning = runContext.tuning || {};
  const player = game.player || {};
  const traits = nftGameplayTraits(runContext);
  const pickaxeBase = finite(player.damage, traits?.pickaxeAttack || 0);
  const blasterBase = Number(player.blasterBaseDamage) > 0
    ? finite(player.blasterBaseDamage, pickaxeBase)
    : pickaxeBase;
  const dynamiteBase = Number(player.dynamiteBaseDamage) > 0
    ? finite(player.dynamiteBaseDamage, CONFIG.dynamiteDamage)
    : finite(tuning.dynamiteDamage, CONFIG.dynamiteDamage);
  return {
    version: 1,
    minerTraitsActive: Boolean(traits),
    minerLevel: integer(player.minerLevel, traits?.level || 0, 100),
    maximumHealth: finite(player.maxHealth, traits?.maximumHealth || CONFIG.basePlayerHealth),
    shieldArmor: finite(player.maxShield, traits?.armorShield || 0),
    currentShield: finite(player.shield, traits?.armorShield || 0),
    healAmount: finite(player.healAmount, traits?.healAmount || 0),
    carryCapacity: integer(player.crystalCarryCapacity, traits?.carryCapacity || 0),
    deathRetentionBps: integer(player.crystalDeathRetentionBps, traits?.deathRetentionBps || 0, 10_000),
    crystalsPerHour: integer(player.crystalsPerHour, traits?.crystalsPerHour || 0, 50),
    attacks: {
      pickaxeBase,
      pickaxeEffective: pickaxeBase * finite(tuning.pickaxeDamageMultiplier, CONFIG.pickaxeDamageScale),
      blasterBase,
      blasterEffective: blasterBase * finite(player.blasterDamageScale, tuning.blasterDamageMultiplier ?? CONFIG.blasterDamageScale),
      dynamiteBase,
      dynamiteEffective: dynamiteBase * finite(tuning.dynamiteDamageMultiplier, 1)
    },
    adminModifiers: {
      playerSpeed: finite(tuning.playerSpeed, CONFIG.basePlayerSpeed),
      scoreMultiplier: finite(tuning.scoreMultiplier, 1),
      minedOreValueMultiplier: finite(tuning.oreScoreMultiplier, 1),
      inRunXpMultiplier: finite(tuning.xpMultiplier, 1),
      passXpMultiplier: finite(tuning.passXpMultiplier, 1),
      depthScoreMultiplier: finite(tuning.depthScoreMultiplier, 1),
      killPointValue: finite(tuning.killPointValue, 0),
      bossPointValue: finite(tuning.bossPointValue, 0),
      runUpgradesEnabled: tuning.disableRunUpgrades !== true,
      rockArmorAvailable: !traits && tuning.disableRunUpgrades !== true
    }
  };
}

function firstRecord(...values) {
  return values.find((value) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  ) || {};
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integer(value, fallback, maximum = Number.MAX_SAFE_INTEGER, minimum = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : Number(fallback) || 0;
}
