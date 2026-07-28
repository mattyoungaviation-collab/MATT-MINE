const ENEMY_TYPES = Object.freeze(['slime', 'bat', 'crawler', 'beetle', 'exploder', 'spitter']);
const TALENT_LIMIT = 20;

export function defaultBetaConfiguration() {
  return {
    depth: 1,
    roomId: 0,
    bossCount: 0,
    bossPhase: 1,
    level: 1,
    health: 100,
    maximumHealth: 100,
    invulnerable: false,
    weaponUnlocks: { pickaxe: true, dynamite: true, blaster: true },
    weaponDamage: 1,
    armor: 0,
    movementSpeed: 1,
    dashCooldown: 1,
    talents: {},
    enemyType: 'slime',
    enemyCount: 1,
    enemyAI: true,
    bossAI: true,
    damageNumbers: true,
    hitboxes: false,
    cooldownDebug: false,
    seedDisplay: false
  };
}

export function normalizeBetaConfiguration(input = {}) {
  const source = record(input);
  const defaults = defaultBetaConfiguration();
  const talents = record(source.talents);
  const normalizedTalents = {};
  for (const [id, raw] of Object.entries(talents).slice(0, 100)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) throw new Error(`Invalid talent: ${id}`);
    normalizedTalents[id] = integer(raw, 0, TALENT_LIMIT, 0);
  }
  const enemyType = String(source.enemyType || defaults.enemyType);
  if (!ENEMY_TYPES.includes(enemyType)) throw new Error('Unknown beta enemy type.');
  return {
    depth: integer(source.depth, 1, 100, defaults.depth),
    roomId: integer(source.roomId, 0, 100, defaults.roomId),
    bossCount: integer(source.bossCount, 0, 10, defaults.bossCount),
    bossPhase: integer(source.bossPhase, 1, 3, defaults.bossPhase),
    level: integer(source.level, 1, 100, defaults.level),
    health: finite(source.health, 0, 10_000, defaults.health),
    maximumHealth: finite(source.maximumHealth, 1, 10_000, defaults.maximumHealth),
    invulnerable: source.invulnerable === true,
    weaponUnlocks: {
      pickaxe: true,
      dynamite: source.weaponUnlocks?.dynamite !== false,
      blaster: source.weaponUnlocks?.blaster !== false
    },
    weaponDamage: finite(source.weaponDamage, 0, 100, defaults.weaponDamage),
    armor: finite(source.armor, 0, 1, defaults.armor),
    movementSpeed: finite(source.movementSpeed, .1, 10, defaults.movementSpeed),
    dashCooldown: finite(source.dashCooldown, 0, 20, defaults.dashCooldown),
    talents: normalizedTalents,
    enemyType,
    enemyCount: integer(source.enemyCount, 0, 100, defaults.enemyCount),
    enemyAI: source.enemyAI !== false,
    bossAI: source.bossAI !== false,
    damageNumbers: source.damageNumbers !== false,
    hitboxes: source.hitboxes === true,
    cooldownDebug: source.cooldownDebug === true,
    seedDisplay: source.seedDisplay === true
  };
}

export class BetaDeveloperTools {
  constructor(game, entitlement) {
    if (!entitlement?.allowed || !Array.isArray(entitlement.capabilities)) {
      throw new Error('beta_access_required');
    }
    this.game = game;
    this.entitlement = entitlement;
    this.configuration = defaultBetaConfiguration();
  }

  apply(input) {
    const config = normalizeBetaConfiguration(input);
    const game = this.game;
    if (!game?.player || !game?.run) throw new Error('beta_run_required');
    game.run.depth = config.depth;
    game.player.level = config.level;
    game.player.maxHealth = config.maximumHealth;
    game.player.health = Math.min(config.health, config.maximumHealth);
    game.player.invulnerable = config.invulnerable ? Number.POSITIVE_INFINITY : 0;
    game.player.unlockedWeapons = { ...config.weaponUnlocks };
    game.player.damage = config.weaponDamage;
    game.player.armor = config.armor;
    game.player.speed = config.movementSpeed;
    game.player.dashCooldownMax = config.dashCooldown;
    game.player.runUpgradeCounts = { ...config.talents };
    game.betaDebug = {
      enemyAI: config.enemyAI,
      bossAI: config.bossAI,
      damageNumbers: config.damageNumbers,
      hitboxes: config.hitboxes,
      cooldownDebug: config.cooldownDebug,
      seedDisplay: config.seedDisplay
    };
    this.configuration = config;
    return structuredClone(config);
  }

  restoreHealth() {
    this.game.player.health = this.game.player.maxHealth;
  }

  refillBlaster() {
    this.game.player.blasterEnergy = this.game.player.blasterEnergyMax;
  }

  clearMonsters() {
    this.game.enemies = [];
  }

  resetMonsters() {
    this.game.generateDepth();
  }

  spawnEnemies(type = this.configuration.enemyType, count = this.configuration.enemyCount) {
    if (!ENEMY_TYPES.includes(type)) throw new Error('unknown_beta_enemy');
    const room = this.game.layout.rooms.find((entry) => entry.id === this.configuration.roomId)
      || this.game.layout.startRoom;
    for (let index = 0; index < Math.min(100, count); index += 1) {
      const enemy = this.game.spawnEnemy(false, room, type);
      enemy.awake = true;
    }
  }

  spawnBosses(count = this.configuration.bossCount || 1) {
    const room = this.game.layout.guardianRoom;
    for (let index = 0; index < Math.min(10, count); index += 1) {
      const boss = this.game.spawnEnemy(true, room);
      boss.hp = boss.maxHp * ({ 1: 1, 2: .6, 3: .25 }[this.configuration.bossPhase]);
      boss.lastBossPhase = this.configuration.bossPhase;
    }
  }

  jumpToRoom(roomId) {
    const room = this.game.layout.rooms.find((entry) => entry.id === Number(roomId));
    if (!room) throw new Error('beta_room_missing');
    this.game.player.x = room.x;
    this.game.player.y = room.y;
    this.configuration.roomId = room.id;
  }

  restartRoom() {
    this.clearMonsters();
    this.spawnEnemies();
    this.restoreHealth();
  }

  restartDepth() {
    this.game.generateDepth();
  }

  exportJson() {
    return JSON.stringify(this.configuration, null, 2);
  }

  importJson(value) {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return this.apply(parsed);
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function integer(value, min, max, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}
