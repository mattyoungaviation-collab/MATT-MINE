export const PER_DEPTH_ENEMY_TYPES = Object.freeze([
  Object.freeze({ id: 'slime', label: 'Slime', spawnable: true }),
  Object.freeze({ id: 'bat', label: 'Bat', spawnable: true }),
  Object.freeze({ id: 'crawler', label: 'Crawler', spawnable: true }),
  Object.freeze({ id: 'beetle', label: 'Crystal beetle', spawnable: true }),
  Object.freeze({ id: 'exploder', label: 'Exploder', spawnable: true }),
  Object.freeze({ id: 'spitter', label: 'Ranged creature', spawnable: true }),
  Object.freeze({ id: 'guardian', label: 'Guardian', spawnable: false })
]);

const TYPE_BY_ID = new Map(PER_DEPTH_ENEMY_TYPES.map((entry) => [entry.id, entry]));
const STAT_SUFFIXES = Object.freeze({
  health: 'Health',
  damage: 'Damage',
  speed: 'Speed',
  xp: 'Xp'
});

export function enemyDepthTuningSchema(number, toggle, maximumDepth = 5) {
  return Array.from({ length: maximumDepth }, (_, index) => index + 1)
    .flatMap((depth) => PER_DEPTH_ENEMY_TYPES.flatMap((type) => {
      const category = `Depth ${depth} enemy tuning`;
      const prefix = enemyDepthPrefix(depth, type.id);
      const fields = [
        number(
          `${prefix}Health`,
          category,
          `${type.label} exact health`,
          0,
          0,
          type.id === 'guardian' ? 1_000_000 : 100_000,
          1,
          `Final health at depth ${depth}. Set to 0 to use the normal base, lobby, creature, and depth multipliers.`
        ),
        number(
          `${prefix}Damage`,
          category,
          `${type.label} exact contact damage`,
          0,
          0,
          100_000,
          1,
          `Final contact damage at depth ${depth}. Set to 0 to use calculated damage. Guardian special attacks remain independently tunable by phase.`
        ),
        number(
          `${prefix}Speed`,
          category,
          `${type.label} exact movement speed`,
          0,
          0,
          5_000,
          1,
          `Final movement speed at depth ${depth}. Set to 0 to use calculated speed.`
        ),
        number(
          `${prefix}Xp`,
          category,
          `${type.label} exact XP`,
          0,
          0,
          1_000_000,
          1,
          `Final XP awarded for defeating this enemy at depth ${depth}. Set to 0 to use calculated XP.`
        )
      ];
      if (!type.spawnable) return fields;
      return [
        toggle(
          `${prefix}Enabled`,
          category,
          `${type.label} enabled`,
          true,
          `Allows ${type.label.toLowerCase()} spawns at depth ${depth}. Global creature switches still take priority.`
        ),
        number(
          `${prefix}SpawnWeight`,
          category,
          `${type.label} spawn weight`,
          0,
          0,
          1_000,
          1,
          `Relative random-spawn weight at depth ${depth}. When every enabled creature has weight 0, the legacy spawn distribution is preserved.`
        ),
        ...fields
      ];
    }));
}

export function resolveEnemySpawnType({
  roll,
  depth,
  tuning = {},
  legacySelector
}) {
  const normalizedRoll = Math.max(0, Math.min(.999999, Number(roll) || 0));
  const candidates = PER_DEPTH_ENEMY_TYPES
    .filter((entry) => entry.spawnable)
    .filter((entry) => isEnemySpawnEnabled(entry.id, depth, tuning));
  if (!candidates.length) return null;

  const weighted = candidates
    .map((entry) => ({
      id: entry.id,
      weight: Math.max(0, Number(tuning[`${enemyDepthPrefix(depth, entry.id)}SpawnWeight`]) || 0)
    }))
    .filter((entry) => entry.weight > 0);
  if (weighted.length) {
    const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
    let target = normalizedRoll * total;
    for (const entry of weighted) {
      target -= entry.weight;
      if (target < 0) return entry.id;
    }
    return weighted.at(-1).id;
  }

  const legacy = typeof legacySelector === 'function'
    ? legacySelector(normalizedRoll, depth)
    : candidates[0].id;
  return candidates.some((entry) => entry.id === legacy) ? legacy : candidates[0].id;
}

export function isEnemySpawnEnabled(type, depth, tuning = {}) {
  const definition = TYPE_BY_ID.get(type);
  if (!definition?.spawnable) return false;
  return globallyEnabled(type, tuning) && depthEnabled(type, depth, tuning);
}

export function resolveEnemyDepthStats({
  type,
  depth,
  tuning = {},
  baseStats,
  isBoss = false
}) {
  const level = Math.max(1, Math.floor(Number(depth) || 1));
  const healthDepthScale = 1 + (level - 1) * (tuning.enemyDepthHealthScale ?? .28);
  const speedDepthScale = 1 + (level - 1) * (tuning.enemyDepthSpeedScale ?? .06);
  const calculated = {
    health: baseStats.health * healthDepthScale *
      (tuning.enemyHealthMultiplier || 1) *
      (tuning[`${type}HealthMultiplier`] || 1) *
      (isBoss ? tuning.bossHealthMultiplier || 1 : 1),
    damage: baseStats.damage * healthDepthScale *
      (tuning.enemyDamageMultiplier ?? 1) *
      (isBoss ? tuning.bossDamageMultiplier ?? 1 : 1),
    speed: baseStats.speed * speedDepthScale *
      (tuning.enemySpeedMultiplier || 1) *
      (isBoss ? tuning.bossSpeedMultiplier || 1 : 1),
    xp: baseStats.xp * healthDepthScale
  };
  const definition = TYPE_BY_ID.get(type);
  if (!definition || level > 5) return calculated;
  const prefix = enemyDepthPrefix(level, type);
  return Object.fromEntries(Object.entries(calculated).map(([stat, value]) => {
    const override = Number(tuning[`${prefix}${STAT_SUFFIXES[stat]}`]);
    return [stat, Number.isFinite(override) && override > 0 ? override : value];
  }));
}

export function enemyDepthPrefix(depth, type) {
  const level = Math.max(1, Math.min(5, Math.floor(Number(depth) || 1)));
  return `depth${level}${type.charAt(0).toUpperCase()}${type.slice(1)}`;
}

function depthEnabled(type, depth, tuning) {
  if (Number(depth) > 5) return true;
  return tuning[`${enemyDepthPrefix(depth, type)}Enabled`] !== false;
}

function globallyEnabled(type, tuning) {
  return ({
    slime: tuning.spawnSlimes !== false,
    bat: tuning.spawnBats !== false,
    crawler: tuning.spawnCrawlers !== false,
    beetle: tuning.spawnBeetles !== false,
    exploder: tuning.spawnExploders !== false,
    spitter: tuning.spawnRanged !== false
  })[type] !== false;
}
