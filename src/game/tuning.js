import { CONFIG, ORE_TYPES } from './config.js';
import { bossTuningSchema, validateBossThresholds } from './bossTuning.js';
import { enemyDepthTuningSchema } from './enemyDepthTuning.js';

export const GAMEPLAY_LOBBIES = Object.freeze(['practice', 'free', 'paid', 'arena']);
export const MAX_TUNED_DEPTH = 5;

const number = (id, category, label, value, min, max, step = 1, description = '') =>
  Object.freeze({ id, category, label, type: 'number', default: value, min, max, step, description });
const toggle = (id, category, label, value, description = '') =>
  Object.freeze({ id, category, label, type: 'boolean', default: value, description });

const ROOM_SPAWN_FIELDS = Object.freeze([
  Object.freeze({ suffix: 'StartEnemies', label: 'Lift / extraction enemies', default: 0, max: 30 }),
  Object.freeze({ suffix: 'MiningEnemies', label: 'Enemies per mining room', default: 1, max: 30 }),
  Object.freeze({ suffix: 'CombatEnemies', label: 'Enemies per combat room', default: 4, max: 30 }),
  Object.freeze({ suffix: 'MixedEnemies', label: 'Enemies per mixed room', default: 3, max: 30 }),
  Object.freeze({ suffix: 'TreasureEnemies', label: 'Enemies in Prospector Cache', default: 1, max: 30 }),
  Object.freeze({ suffix: 'GuardianEnemies', label: 'Guardian-vault minions', default: 0, max: 30 }),
  Object.freeze({ suffix: 'GuardianBosses', label: 'Guardian bosses', default: 1, max: 5 })
]);

const depthSpawnSchema = Array.from({ length: MAX_TUNED_DEPTH }, (_, index) => index + 1)
  .flatMap((depth) => ROOM_SPAWN_FIELDS.map((field) => number(
    `depth${depth}${field.suffix}`,
    `Depth ${depth} room spawns`,
    field.label,
    field.default,
    0,
    field.max,
    1,
    field.suffix === 'GuardianBosses'
      ? `Number of Guardians that must be defeated before extraction unlocks on depth ${depth}.`
      : `${field.label} on depth ${depth}. This count applies to every room of that type.`
  )));

export const GAME_TUNING_SCHEMA = Object.freeze([
  toggle('ignorePermanentUpgrades', 'Beta testing', 'Ignore permanent upgrades', false, 'New runs use a clean new-player profile without deleting the wallet’s saved upgrades.'),
  toggle('disableRunUpgrades', 'Beta testing', 'Disable all in-run upgrades', false, 'Level-ups continue, but no upgrade selection screen appears and no temporary talents are applied.'),
  toggle('disableBlasterUpgrades', 'Beta testing', 'Disable Prospector Cache Blaster upgrades', false, 'The cache still refills the Blaster, but it does not offer Battery, Charger, Core, or Volley talents.'),
  toggle('usePerDepthRoomSpawns', 'Beta testing', 'Use editable per-depth room spawns', true, 'Uses the room-by-room spawn plan below. Saving applies this choice to the next new run; runs already in progress keep their pinned plan.'),

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

  number('permanentHealthPerRank', 'Permanent upgrade scaling', 'Health per permanent rank', 8, 0, 100, 1),
  number('permanentDamagePerRank', 'Permanent upgrade scaling', 'Damage per permanent rank', .05, 0, .5, .005),
  number('permanentSpeedPerRank', 'Permanent upgrade scaling', 'Speed per permanent rank', .02, 0, .25, .005),
  number('permanentLuckPerRank', 'Permanent upgrade scaling', 'Rich-ore chance per permanent rank', .01, 0, .1, .0025),
  number('permanentMagnetPerRank', 'Permanent upgrade scaling', 'Pickup range per permanent rank', 6, 0, 50, 1),
  number('permanentArmorPerRank', 'Permanent upgrade scaling', 'Armor per permanent rank', .008, 0, .05, .001, 'Damage reduction added by each permanent Reinforced Plates rank.'),
  number('permanentDashPerRank', 'Permanent upgrade scaling', 'Dash recharge per permanent rank', .02, 0, .2, .005),
  number('permanentBlasterDamagePerRank', 'Permanent upgrade scaling', 'Blaster damage per permanent rank', .03, 0, .25, .005),

  number('runPowerPerLevel', 'Run upgrade scaling', 'Heavy Pick damage per level', .25, 0, 2, .01),
  number('runSpeedPerLevel', 'Run upgrade scaling', 'Fast Boots speed per level', .12, 0, 1, .01),
  number('runHealthPerLevel', 'Run upgrade scaling', 'Reinforced Vest health per level', 25, 0, 250, 1),
  number('runHastePerLevel', 'Run upgrade scaling', 'Quick Hands cooldown reduction', .15, 0, .75, .01),
  number('runRangePerLevel', 'Run upgrade scaling', 'Long Handle range per level', .2, 0, 1, .01),
  number('runCritPerLevel', 'Run upgrade scaling', 'Lucky Strike crit chance per level', .08, 0, .5, .01),
  number('runMagnetPerLevel', 'Run upgrade scaling', 'Ore Magnet range per level', 45, 0, 300, 5),
  number('armorUpgradePerLevel', 'Run upgrade scaling', 'Rock Armor reduction per level', .08, 0, .4, .01, 'Damage reduction added by each Rock Armor selection.'),
  number('armorMaximum', 'Run upgrade scaling', 'Maximum total armor', .45, 0, .9, .01, 'Hard cap across permanent and in-run armor.'),
  number('runDashRechargePerLevel', 'Run upgrade scaling', 'Blast Boots recharge reduction', .25, 0, .75, .01),
  number('runFortunePerLevel', 'Run upgrade scaling', 'Prospector Luck value per level', .15, 0, 2, .01),

  number('pickaxeDamageMultiplier', 'Pickaxe', 'Damage multiplier', CONFIG.pickaxeDamageScale, .1, 10, .05),
  number('pickaxeRange', 'Pickaxe', 'Attack range', CONFIG.baseAttackRange, 40, 500, 5),
  number('pickaxeCooldown', 'Pickaxe', 'Swing cooldown', CONFIG.baseAttackCooldown, .05, 3, .01),

  number('blasterDamageMultiplier', 'Blaster', 'Base damage multiplier', CONFIG.blasterDamageScale, .05, 8, .01, 'Base damage before permanent Blaster Tuning, Focused Core, and volley splitting.'),
  number('blasterFocusedCoreBonus', 'Blaster', 'Focused Core damage per level', .10, 0, 1, .01, 'Recommended balance is 10% per level, reduced from the original 25%.'),
  number('blasterVolleyTwoDamageMultiplier', 'Blaster', 'Two-beam damage per projectile', .66, .05, 1.5, .01, 'Each projectile deals this share of the single-shot damage when firing two beams.'),
  number('blasterVolleyThreeDamageMultiplier', 'Blaster', 'Three-beam damage per projectile', .60, .05, 1.5, .01, 'Each projectile deals this share of the single-shot damage when firing three beams.'),
  number('blasterRange', 'Blaster', 'Projectile range', CONFIG.blasterRange, 100, 1200, 10),
  number('blasterProjectileSpeed', 'Blaster', 'Projectile speed', 760, 100, 1800, 10),
  number('blasterCooldownMultiplier', 'Blaster', 'Fire cooldown multiplier', .48, .1, 2, .01),
  number('blasterEnergy', 'Blaster', 'Battery capacity', CONFIG.blasterEnergyMax, 10, 1000, 5),
  number('blasterRecharge', 'Blaster', 'Recharge per second', CONFIG.blasterEnergyRegen, 1, 200, 1),
  number('blasterEnergyCost', 'Blaster', 'Energy per shot', CONFIG.blasterEnergyCost, 1, 100, 1),
  number('blasterCapacityPerLevel', 'Blaster', 'Battery upgrade per level', 30, 0, 250, 5),
  number('blasterRechargePerLevel', 'Blaster', 'Flux Charger bonus per level', .35, 0, 2, .01),
  number('blasterBeams', 'Blaster', 'Maximum beams', 3, 1, 3),
  number('blasterVolleySpread', 'Blaster', 'Volley spread', CONFIG.blasterVolleySpread, 0, 1.2, .01),

  number('dynamiteDamage', 'Dynamite', 'Explosion damage', CONFIG.dynamiteDamage, 1, 500),
  number('dynamiteThrowRange', 'Dynamite', 'Throw range', CONFIG.dynamiteRange, 50, 800, 10),
  number('dynamiteBlastRadius', 'Dynamite', 'Blast radius', 170, 50, 500, 5),
  number('dynamiteStartAmmo', 'Dynamite', 'Starting ammo', CONFIG.dynamiteStartAmmo, 0, 50),

  number('enemyHealthMultiplier', 'Enemies', 'Global health multiplier', 1, .1, 10, .05),
  number('enemyDamageMultiplier', 'Enemies', 'Global damage multiplier', 1, 0, 10, .05),
  number('enemySpeedMultiplier', 'Enemies', 'Global speed multiplier', 1, .1, 5, .05),
  number('enemyDepthHealthScale', 'Enemies', 'Health added per depth', .28, 0, 2, .01),
  number('enemyDepthSpeedScale', 'Enemies', 'Speed added per depth', .06, 0, .5, .01),
  number('enemyMaximum', 'Enemies', 'Maximum active reinforcements', CONFIG.maxEnemiesBase, 0, 100, 1, 'Safety cap used by reinforcement systems. The explicit room plan below is spawned exactly.'),
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
  number('spitterHealthMultiplier', 'Creature types', 'Ranged creature health', 1, .1, 10, .05),

  ...depthSpawnSchema,
  ...enemyDepthTuningSchema(number, toggle, MAX_TUNED_DEPTH),

  number('bossHealthMultiplier', 'Boss', 'Health multiplier', 2.25, .1, 20, .05, 'Default targets a readable roughly 30-second final encounter for a normally upgraded miner.'),
  number('bossDamageMultiplier', 'Boss', 'Damage multiplier', 1, 0, 10, .05),
  number('bossSpeedMultiplier', 'Boss', 'Speed multiplier', 1, .1, 5, .05),
  number('bossAwarenessRange', 'Boss', 'Awareness range', CONFIG.guardianAwarenessRange, 100, 1800, 10),
  number('bossRoomWidth', 'Boss', 'Room width', 720, 420, 1600, 10),
  number('bossRoomHeight', 'Boss', 'Room height', 520, 320, 1200, 10),
  number('bossProjectileSpeed', 'Boss', 'Projectile speed', 280, 50, 1200, 10),
  number('bossVolleySpread', 'Boss', 'Volley spread', .38, .05, 1.5, .01),
  number('bossReinforcementCount', 'Boss', 'Reinforcements per call', 3, 0, 20),
  number('bossReinforcementInterval', 'Boss', 'Reinforcement interval', 7, 1, 60, .5),
  ...bossTuningSchema(number, toggle),

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
  return Object.fromEntries(GAMEPLAY_LOBBIES.map((lobby) => [lobby, defaultTuningPreset(lobby)]));
}

export function normalizeGameTuning(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(GAMEPLAY_LOBBIES.map((lobby) => [
    lobby,
    normalizeTuningPreset(source[lobby], lobby)
  ]));
}

export function normalizeTuningPatch(input = {}, current = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('A tuning patch is required.');
  const patch = {};
  for (const [id, raw] of Object.entries(input)) {
    const definition = schemaById.get(id);
    if (!definition) throw new Error(`Unknown game setting: ${id}`);
    patch[id] = normalizeValue(definition, raw);
  }
  validateBossThresholds({ ...current, ...patch });
  return patch;
}

export function normalizeTuningPreset(input = {}, lobby = 'practice') {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaults = defaultTuningPreset(lobby);
  const result = {};
  for (const definition of GAME_TUNING_SCHEMA) {
    result[definition.id] = normalizeValue(definition, source[definition.id] ?? defaults[definition.id]);
  }
  return validateBossThresholds(result);
}

export function defaultTuningPreset(lobby = 'practice') {
  const preset = Object.fromEntries(GAME_TUNING_SCHEMA.map((entry) => [entry.id, entry.default]));
  if (lobby === 'arena') {
    Object.assign(preset, {
      usePerDepthRoomSpawns: false,
      bossHealthMultiplier: 1,
      blasterDamageMultiplier: .56,
      blasterFocusedCoreBonus: .25,
      blasterBeams: 2,
      blasterVolleyTwoDamageMultiplier: 1,
      blasterVolleyThreeDamageMultiplier: 1,
      armorUpgradePerLevel: .12,
      armorMaximum: .6,
      permanentArmorPerRank: .01
    });
  }
  return preset;
}

function normalizeValue(definition, raw) {
  if (definition.type === 'boolean') return raw === true;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${definition.label} must be a number.`);
  const clamped = Math.min(definition.max, Math.max(definition.min, value));
  return definition.step >= 1 ? Math.round(clamped) : Number(clamped.toFixed(4));
}
