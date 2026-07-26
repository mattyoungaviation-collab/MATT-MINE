import { CONFIG, ORE_TYPES } from './config.js';

export const GAMEPLAY_LOBBIES = Object.freeze(['practice', 'free', 'paid', 'arena']);

const number = (id, category, label, value, min, max, step = 1, description = '') =>
  Object.freeze({ id, category, label, type: 'number', default: value, min, max, step, description });
const toggle = (id, category, label, value, description = '') =>
  Object.freeze({ id, category, label, type: 'boolean', default: value, description });

export const GAME_TUNING_SCHEMA = Object.freeze([
  number('playerMaxHealth', 'Player', 'Starting health', CONFIG.basePlayerHealth, 25, 1000),
  number('playerSpeed', 'Player', 'Movement speed', CONFIG.basePlayerSpeed, 80, 700),
  number('playerAcceleration', 'Player', 'Acceleration', CONFIG.playerAcceleration, 2, 40, .5),
  number('playerFriction', 'Player', 'Stopping control', CONFIG.playerFriction, 2, 40, .5),
  number('playerRadius', 'Player', 'Collision size', CONFIG.playerRadius, 10, 45),
  number('playerBaseDamage', 'Player', 'Base damage', CONFIG.baseDamage, 1, 250),
  number('playerCritChance', 'Player', 'Critical chance', CONFIG.baseCritChance, 0, .75, .01),
  number('playerMagnetRange', 'Player', 'Pickup range', CONFIG.baseMagnetRange, 20, 600),
  number('dashCooldown', 'Player', 'Dash cooldown', CONFIG.baseDashCooldown, .25, 12, .05),
  number('dashSpeed', 'Player', 'Dash speed', CONFIG.baseDashSpeed, 200, 1600, 10),
  number('dashDuration', 'Player', 'Dash duration', CONFIG.dashDuration, .05, .8, .01),
  number('safeStartSeconds', 'Player', 'Safe-start seconds', CONFIG.safeStartSeconds, 0, 30, .5),
  number('safeStartDistance', 'Player', 'Safe-start enemy distance', CONFIG.safeStartEnemyDistance, 0, 900, 10),

  number('pickaxeDamageMultiplier', 'Pickaxe', 'Damage multiplier', CONFIG.pickaxeDamageScale, .1, 10, .05),
  number('pickaxeRange', 'Pickaxe', 'Attack range', CONFIG.baseAttackRange, 40, 500, 5),
  number('pickaxeCooldown', 'Pickaxe', 'Swing cooldown', CONFIG.baseAttackCooldown, .05, 3, .01),
  number('blasterDamageMultiplier', 'Blaster', 'Damage multiplier', CONFIG.blasterDamageScale, .05, 8, .05),
  number('blasterRange', 'Blaster', 'Projectile range', CONFIG.blasterRange, 100, 1200, 10),
  number('blasterEnergy', 'Blaster', 'Battery capacity', CONFIG.blasterEnergyMax, 10, 1000, 5),
  number('blasterRecharge', 'Blaster', 'Recharge per second', CONFIG.blasterEnergyRegen, 1, 200, 1),
  number('blasterEnergyCost', 'Blaster', 'Energy per shot', CONFIG.blasterEnergyCost, 1, 100, 1),
  number('blasterBeams', 'Blaster', 'Maximum beams', 2, 1, 2),
  number('dynamiteDamage', 'Dynamite', 'Explosion damage', CONFIG.dynamiteDamage, 1, 500),
  number('dynamiteThrowRange', 'Dynamite', 'Throw range', CONFIG.dynamiteRange, 50, 800, 10),
  number('dynamiteBlastRadius', 'Dynamite', 'Blast radius', 170, 50, 500, 5),
  number('dynamiteStartAmmo', 'Dynamite', 'Starting ammo', CONFIG.dynamiteStartAmmo, 0, 50),

  number('enemyHealthMultiplier', 'Enemies', 'Global health multiplier', 1, .1, 10, .05),
  number('enemyDamageMultiplier', 'Enemies', 'Global damage multiplier', 1, 0, 10, .05),
  number('enemySpeedMultiplier', 'Enemies', 'Global speed multiplier', 1, .1, 5, .05),
  number('enemyMaximum', 'Enemies', 'Maximum active enemies', CONFIG.maxEnemiesBase, 0, 100),
  toggle('spawnSlimes', 'Creature types', 'Slimes', true),
  toggle('spawnBats', 'Creature types', 'Bats', true),
  toggle('spawnCrawlers', 'Creature types', 'Crawlers', true),
  toggle('spawnBeetles', 'Creature types', 'Crystal beetles', true),
  toggle('spawnExploders', 'Creature types', 'Exploders', true),
  toggle('spawnRanged', 'Creature types', 'Ranged creatures', true),
  number('slimeHealthMultiplier', 'Creature types', 'Slime health', 1, .1, 10, .05),
  number('batHealthMultiplier', 'Creature types', 'Bat health', 1, .1, 10, .05),
  number('crawlerHealthMultiplier', 'Creature types', 'Crawler health', 1, .1, 10, .05),
  number('beetleHealthMultiplier', 'Creature types', 'Beetle health', 1, .1, 10, .05),
  number('exploderHealthMultiplier', 'Creature types', 'Exploder health', 1, .1, 10, .05),

  number('bossHealthMultiplier', 'Boss', 'Health multiplier', 1, .1, 20, .05),
  number('bossDamageMultiplier', 'Boss', 'Damage multiplier', 1, 0, 10, .05),
  number('bossSpeedMultiplier', 'Boss', 'Speed multiplier', 1, .1, 5, .05),
  number('bossAwarenessRange', 'Boss', 'Awareness range', CONFIG.guardianAwarenessRange, 100, 1800, 10),
  number('bossRoomWidth', 'Boss', 'Room width', 720, 420, 1600, 10),
  number('bossRoomHeight', 'Boss', 'Room height', 520, 320, 1200, 10),
  number('bossProjectileSpeed', 'Boss', 'Projectile speed', 280, 50, 1200, 10),
  number('bossVolleySpread', 'Boss', 'Volley spread', .38, .05, 1.5, .01),
  number('bossReinforcementCount', 'Boss', 'Reinforcements per call', 3, 0, 20),
  number('bossReinforcementInterval', 'Boss', 'Reinforcement interval', 7, 1, 60, .5),

  number('roomWidth', 'Mine layout', 'Standard room width', CONFIG.roomWidth, 260, 900, 10),
  number('roomHeight', 'Mine layout', 'Standard room height', CONFIG.roomHeight, 200, 700, 10),
  number('corridorWidth', 'Mine layout', 'Corridor width', CONFIG.corridorWidth, 70, 300, 5),
  number('roomsPerDepth', 'Mine layout', 'Rooms per depth', CONFIG.roomsPerDepth, 4, 12),
  number('oreAmountMultiplier', 'Mine layout', 'Ore amount multiplier', 1, .1, 5, .05),
  number('treasureAmountMultiplier', 'Mine layout', 'Treasure amount multiplier', 1, 0, 5, .05),

  number('scoreMultiplier', 'Rewards and scoring', 'Leaderboard score multiplier', 1, 0, 10, .05),
  number('nuggetMultiplier', 'Rewards and scoring', 'Nugget value multiplier', 1, 0, 10, .05),
  number('xpMultiplier', 'Rewards and scoring', 'Run XP multiplier', 1, 0, 10, .05),
  number('passXpMultiplier', 'Rewards and scoring', 'Pass XP multiplier', 1, 0, 10, .05),
  number('killPointValue', 'Rewards and scoring', 'Bonus points per enemy', 0, 0, 10000),
  number('bossPointValue', 'Rewards and scoring', 'Bonus points for Guardian', 0, 0, 100000),
  number('depthScoreMultiplier', 'Rewards and scoring', 'Depth score multiplier', 1, 0, 10, .05),
  number('deathKeepFraction', 'Rewards and scoring', 'Loot kept on knockout', CONFIG.deathKeepFraction, 0, 1, .01),
  ...Object.entries(ORE_TYPES).flatMap(([id, ore]) => [
    number(`${id}HealthMultiplier`, 'Ore', `${ore.name} health`, 1, .1, 10, .05),
    number(`${id}ValueMultiplier`, 'Ore', `${ore.name} value`, 1, 0, 10, .05)
  ])
]);

const schemaById = new Map(GAME_TUNING_SCHEMA.map((entry) => [entry.id, entry]));

export function defaultGameTuning() {
  const preset = Object.fromEntries(GAME_TUNING_SCHEMA.map((entry) => [entry.id, entry.default]));
  return Object.fromEntries(GAMEPLAY_LOBBIES.map((lobby) => [lobby, { ...preset }]));
}

export function normalizeGameTuning(input = {}) {
  const defaults = defaultGameTuning();
  for (const lobby of GAMEPLAY_LOBBIES) {
    const source = input && typeof input[lobby] === 'object' ? input[lobby] : {};
    defaults[lobby] = normalizeTuningPreset(source);
  }
  return defaults;
}

export function normalizeTuningPatch(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A tuning patch is required.');
  const patch = {};
  for (const [id, raw] of Object.entries(input)) {
    const definition = schemaById.get(id);
    if (!definition) throw new Error(`Unknown game setting: ${id}`);
    patch[id] = normalizeValue(definition, raw);
  }
  return patch;
}

export function normalizeTuningPreset(input = {}) {
  const result = {};
  for (const definition of GAME_TUNING_SCHEMA) {
    result[definition.id] = normalizeValue(definition, input[definition.id] ?? definition.default);
  }
  return result;
}

function normalizeValue(definition, raw) {
  if (definition.type === 'boolean') return raw === true;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${definition.label} must be a number.`);
  const clamped = Math.min(definition.max, Math.max(definition.min, value));
  return definition.step >= 1 ? Math.round(clamped) : Number(clamped.toFixed(4));
}
