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
  xp: 'Xp',
  radius: 'Radius'
});

const ALL_STANDARD_TYPES = Object.freeze(PER_DEPTH_ENEMY_TYPES.filter((entry) => entry.spawnable).map((entry) => entry.id));
const ALL_TYPES = Object.freeze(PER_DEPTH_ENEMY_TYPES.map((entry) => entry.id));

const behavior = (suffix, label, types, defaults, min, max, step, description) => Object.freeze({
  suffix, label, types: Object.freeze(types), defaults: Object.freeze(defaults), min, max, step, description
});

// These definitions are shared by Game Balance, Competition Studio, and the
// runtime AI. Keeping one registry prevents an Admin control from becoming a
// cosmetic field that the game never reads.
export const ENEMY_BEHAVIOR_TUNING_FIELDS = Object.freeze([
  behavior('AwarenessRange', 'Awareness range', ALL_TYPES, { default: 440, guardian: 760 }, 20, 2400, 10, 'Distance at which this creature notices and pursues the miner.'),
  behavior('ContactCooldown', 'Contact-hit cooldown', ALL_TYPES, { default: 1.05, guardian: .8 }, .05, 10, .05, 'Seconds before touching the miner can deal damage again.'),
  behavior('Steering', 'Steering response', ALL_STANDARD_TYPES, { default: 6, beetle: 4, spitter: 4 }, .1, 30, .1, 'How quickly movement turns toward its target velocity.'),
  behavior('SlimeBurstCooldownMin', 'Burst cooldown minimum', ['slime'], { default: 1.2 }, .05, 20, .05, 'Shortest time between Slime lunges.'),
  behavior('SlimeBurstCooldownMax', 'Burst cooldown maximum', ['slime'], { default: 1.8 }, .05, 20, .05, 'Longest time between Slime lunges.'),
  behavior('SlimeBurstSpeed', 'Burst speed multiplier', ['slime'], { default: 2.35 }, 0, 10, .05, 'Movement-speed multiplier during a Slime lunge.'),
  behavior('SlimeBurstSteering', 'Burst steering response', ['slime'], { default: 13 }, .1, 30, .1, 'How sharply the Slime turns during its lunge.'),
  behavior('SlimeCruiseSpeed', 'Cruise speed multiplier', ['slime'], { default: .72 }, 0, 10, .05, 'Movement-speed multiplier between Slime lunges.'),
  behavior('BatWeaveAmount', 'Weave amount', ['bat'], { default: .72 }, 0, 3.14, .01, 'Side-to-side flight angle in radians.'),
  behavior('BatWeaveSpeed', 'Weave speed', ['bat'], { default: 1.45 }, 0, 10, .05, 'How quickly the Bat oscillates while flying.'),
  behavior('BatBurstCooldownMin', 'Burst cooldown minimum', ['bat'], { default: .7 }, .05, 20, .05, 'Shortest time between Bat speed bursts.'),
  behavior('BatBurstCooldownMax', 'Burst cooldown maximum', ['bat'], { default: 1.3 }, .05, 20, .05, 'Longest time between Bat speed bursts.'),
  behavior('BatBurstSpeed', 'Burst speed multiplier', ['bat'], { default: 1.8 }, 0, 10, .05, 'Movement-speed multiplier during a Bat burst.'),
  behavior('BatCruiseSpeed', 'Cruise speed multiplier', ['bat'], { default: 1.05 }, 0, 10, .05, 'Normal Bat movement-speed multiplier.'),
  behavior('CrawlerRevealRange', 'Ambush reveal range', ['crawler'], { default: 155 }, 0, 1200, 5, 'Distance at which a hidden Crawler springs its ambush.'),
  behavior('CrawlerBurstCooldownMin', 'Burst cooldown minimum', ['crawler'], { default: 1 }, .05, 20, .05, 'Shortest time between Crawler rushes.'),
  behavior('CrawlerBurstCooldownMax', 'Burst cooldown maximum', ['crawler'], { default: 1.6 }, .05, 20, .05, 'Longest time between Crawler rushes.'),
  behavior('CrawlerBurstSpeed', 'Burst speed multiplier', ['crawler'], { default: 1.75 }, 0, 10, .05, 'Movement-speed multiplier during a Crawler rush.'),
  behavior('CrawlerCruiseSpeed', 'Cruise speed multiplier', ['crawler'], { default: .82 }, 0, 10, .05, 'Normal Crawler movement-speed multiplier.'),
  behavior('BeetleTurnRate', 'Maximum turn rate', ['beetle'], { default: 1.25 }, 0, 20, .05, 'Maximum Beetle facing change in radians per second.'),
  behavior('BeetleSpeedScale', 'Movement-speed multiplier', ['beetle'], { default: .82 }, 0, 10, .05, 'Beetle chase-speed multiplier.'),
  behavior('ExploderTriggerRange', 'Fuse trigger range', ['exploder'], { default: 92 }, 0, 1200, 5, 'Distance that starts the Exploder fuse.'),
  behavior('ExploderFuseSeconds', 'Fuse seconds', ['exploder'], { default: .82 }, .05, 20, .01, 'Delay between fuse ignition and explosion.'),
  behavior('ExploderFuseDamping', 'Fuse movement damping', ['exploder'], { default: .84 }, 0, 1, .01, 'Velocity retained per 60 Hz frame while the fuse burns.'),
  behavior('ExploderChaseSpeed', 'Chase-speed multiplier', ['exploder'], { default: 1.12 }, 0, 10, .05, 'Exploder movement-speed multiplier before ignition.'),
  behavior('ExploderBlastRadius', 'Blast radius', ['exploder'], { default: 138 }, 0, 1000, 5, 'Radius of the world explosion.'),
  behavior('ExploderPlayerRadius', 'Player damage radius', ['exploder'], { default: 145 }, 0, 1000, 5, 'Radius in which the explosion directly damages the miner.'),
  behavior('ExploderBlastDamage', 'Blast damage multiplier', ['exploder'], { default: .9 }, 0, 10, .05, 'Multiplier applied to base damage for the world explosion.'),
  behavior('ExploderPlayerDamage', 'Player damage multiplier', ['exploder'], { default: 1 }, 0, 10, .05, 'Multiplier applied to base damage when the blast reaches the miner.'),
  behavior('SpitterPreferredRange', 'Preferred range', ['spitter'], { default: 285 }, 0, 1500, 5, 'Range the Spitter tries to maintain.'),
  behavior('SpitterInnerTolerance', 'Retreat tolerance', ['spitter'], { default: 35 }, 0, 1000, 5, 'How far inside preferred range before retreating.'),
  behavior('SpitterOuterTolerance', 'Advance tolerance', ['spitter'], { default: 45 }, 0, 1000, 5, 'How far outside preferred range before advancing.'),
  behavior('SpitterStrafeSpeed', 'Strafe-speed multiplier', ['spitter'], { default: .72 }, 0, 10, .05, 'Sideways movement-speed multiplier.'),
  behavior('SpitterStrafeWaveSpeed', 'Strafe switch speed', ['spitter'], { default: .72 }, 0, 10, .05, 'How quickly the Spitter changes strafe direction.'),
  behavior('SpitterAttackRange', 'Attack range', ['spitter'], { default: 440 }, 0, 2400, 10, 'Maximum range for starting a volley.'),
  behavior('SpitterCooldownMin', 'Volley cooldown minimum', ['spitter'], { default: 1.15 }, .05, 30, .05, 'Shortest delay between volleys.'),
  behavior('SpitterCooldownMax', 'Volley cooldown maximum', ['spitter'], { default: 1.35 }, .05, 30, .05, 'Longest delay between volleys.'),
  behavior('SpitterProjectileCount', 'Projectiles per volley', ['spitter'], { default: 3 }, 0, 30, 1, 'Number of projectiles in each volley.'),
  behavior('SpitterProjectileSpread', 'Projectile spread', ['spitter'], { default: .46 }, 0, 6.2832, .01, 'Total volley spread in radians.'),
  behavior('SpitterProjectileSpeed', 'Projectile speed', ['spitter'], { default: 300 }, 0, 2400, 10, 'Projectile travel speed.'),
  behavior('SpitterProjectileDamage', 'Projectile damage multiplier', ['spitter'], { default: .62 }, 0, 10, .01, 'Multiplier applied to base damage for each projectile.'),
  behavior('SpitterProjectileRange', 'Projectile range', ['spitter'], { default: 560 }, 0, 3000, 10, 'Maximum projectile travel distance.'),
  behavior('SpitterProjectileRadius', 'Projectile collision radius', ['spitter'], { default: 0 }, 0, 80, 1, 'Projectile collision size. Set to 0 for the mode default (9 in Arena, 8 elsewhere).'),
  behavior('SpitterProjectileLifetime', 'Projectile lifetime', ['spitter'], { default: 2.2 }, .05, 20, .05, 'Maximum projectile lifetime in seconds.')
]);

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
        ),
        number(
          `${prefix}Radius`,
          category,
          `${type.label} exact collision radius`,
          0,
          0,
          500,
          1,
          `Final collision radius at depth ${depth}. Set to 0 to use the creature's normal radius.`
        )
      ];
      const behaviorFields = ENEMY_BEHAVIOR_TUNING_FIELDS
        .filter((definition) => definition.types.includes(type.id))
        .map((definition) => number(
          `${prefix}${definition.suffix}`,
          category,
          `${type.label} ${definition.label.toLowerCase()}`,
          behaviorDefault(definition, type.id),
          definition.min,
          definition.max,
          definition.step,
          `${definition.description} Applies only to ${type.label} at depth ${depth}.`
        ));
      if (!type.spawnable) return [...fields, ...behaviorFields];
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
        ...fields,
        ...behaviorFields
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
    xp: baseStats.xp * healthDepthScale,
    radius: baseStats.radius * (isBoss ? 1 + (level - 1) * .05 : 1)
  };
  const definition = TYPE_BY_ID.get(type);
  if (!definition || level > 5) return calculated;
  const prefix = enemyDepthPrefix(level, type);
  return Object.fromEntries(Object.entries(calculated).map(([stat, value]) => {
    const override = Number(tuning[`${prefix}${STAT_SUFFIXES[stat]}`]);
    return [stat, Number.isFinite(override) && override > 0 ? override : value];
  }));
}

export function resolveEnemyDepthBehavior({ type, depth, tuning = {} }) {
  const prefix = enemyDepthPrefix(depth, type);
  return Object.fromEntries(ENEMY_BEHAVIOR_TUNING_FIELDS
    .filter((definition) => definition.types.includes(type))
    .map((definition) => {
      const configured = Number(tuning[`${prefix}${definition.suffix}`]);
      return [
        lowerFirst(definition.suffix),
        Number.isFinite(configured)
          ? Math.min(definition.max, Math.max(definition.min, configured))
          : behaviorDefault(definition, type)
      ];
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

function behaviorDefault(definition, type) {
  return Number(definition.defaults[type] ?? definition.defaults.default ?? 0);
}

function lowerFirst(value) {
  return value.charAt(0).toLowerCase() + value.slice(1);
}
