import { CONFIG, ORE_TYPES } from '../config.js';
import { bossPhaseForHealth, ENEMY_STATS, enemyArchetypeForRoll, roomRequiresLock } from '../combat.js';
import { createMineLayout, randomPointInRoom, roomAt } from '../layout.js';
import { distance, random, randomInt, randomRange, weightedChoice } from '../utils.js';
import { enemySpawnMethods } from './enemySpawn.js';
import { roomsMethods } from './rooms.js';
import { stateMethods } from './state.js';
import { resolveEnemyDepthStats, resolveEnemySpawnType } from '../enemyDepthTuning.js';

const TAU = Math.PI * 2;
const MAX_CONFIGURED_DEPTH = 5;

export const spawnTuningMethods = {
  generateDepth() {
    const tuning = this.runContext?.tuning || {};
    if (tuning.usePerDepthRoomSpawns === false) {
      const result = stateMethods.generateDepth.call(this);
      this.run.bossGoal = 1;
      this.run.bossKills = 0;
      return result;
    }

    const arenaMode = this.runContext?.mode === 'arena';
    this.layout = createMineLayout(tuning.roomsPerDepth || CONFIG.roomsPerDepth, tuning);
    if (!arenaMode && this.layout.guardianRoom) {
      this.layout.guardianRoom.width = Math.max(this.layout.guardianRoom.width, tuning.bossRoomWidth || 520);
      this.layout.guardianRoom.height = Math.max(this.layout.guardianRoom.height, tuning.bossRoomHeight || 390);
    }
    this.decor = this.makeDepthDecor();
    this.enemies = [];
    this.ores = [];
    this.pickups = [];
    this.portal = null;
    this.projectiles = [];
    this.roomStates = Object.fromEntries(this.layout.rooms.map((room) => [room.id, {
      triggered: false,
      locked: false,
      cleared: room.type === 'start' || room.type === 'mining' || room.type === 'treasure' || room.type === 'mixed'
    }]));
    this.activeLockedRoomId = null;
    this.run.crystals = 0;
    this.run.bossKilled = false;
    this.run.bossReady = false;
    this.run.bossSpawned = false;
    this.run.bossKills = 0;
    this.run.bossGoal = configuredSpawnCount(tuning, this.run.depth, 'GuardianBosses', 1);
    this.lastRoomId = this.layout.startRoom.id;
    this.player.x = this.layout.startRoom.x;
    this.player.y = this.layout.startRoom.y;
    this.player.vx = 0;
    this.player.vy = 0;
    this.player.health = Math.min(this.player.maxHealth, this.player.health + this.player.maxHealth * .3);
    this.run.safeStartUntil = this.run.elapsed +
      (arenaMode ? CONFIG.arenaSafeStartSeconds : (tuning.safeStartSeconds ?? CONFIG.safeStartSeconds));

    const luck = arenaMode ? 0 : this.profile.meta.luck || 0;
    const oreEntries = Object.entries(ORE_TYPES)
      .filter(([id]) => id !== 'cache')
      .map(([id, ore]) => ({ id, ...ore }));
    let guaranteedCrystals = this.crystalGoal() + 2;

    for (const room of this.layout.rooms) {
      const oreCount = Math.round(({
        start: 3,
        mining: 14,
        combat: 4,
        mixed: 8,
        treasure: 5,
        guardian: 5
      }[room.type] || 6) * (tuning.oreAmountMultiplier || 1));

      for (let index = 0; index < oreCount; index += 1) {
        const shouldGuarantee = guaranteedCrystals > 0 && ['mining', 'treasure'].includes(room.type);
        const type = shouldGuarantee ? { id: 'crystal', ...ORE_TYPES.crystal } : weightedChoice(oreEntries);
        if (shouldGuarantee) guaranteedCrystals -= 1;
        this.addOre(type, room, luck);
      }

      const enemyCount = configuredSpawnCount(
        tuning,
        this.run.depth,
        roomTypeSuffix(room.type),
        defaultRoomEnemyCount(room.type)
      );
      for (let index = 0; index < enemyCount; index += 1) this.spawnEnemy(false, room);
    }

    while (guaranteedCrystals > 0) {
      const room = this.layout.rooms.find((entry) => entry.type === 'mining') || this.layout.rooms[1];
      this.addOre({ id: 'crystal', ...ORE_TYPES.crystal }, room, luck);
      guaranteedCrystals -= 1;
    }

    if (this.layout.treasureRoom) {
      this.addOre({ id: 'cache', ...ORE_TYPES.cache }, this.layout.treasureRoom, luck, true);
    }
    this.updateObjective();
    this.updateHud();
  },

  spawnEnemy(isBoss = false, requestedRoom = null, forcedType = null) {
    let room = requestedRoom;
    if (isBoss) room = this.layout.guardianRoom;
    if (!room) {
      const currentRoom = roomAt(this.layout, this.player.x, this.player.y);
      const candidates = this.layout.rooms.filter((entry) => !['start', 'guardian'].includes(entry.type));
      room = currentRoom && !['start', 'guardian'].includes(currentRoom.type)
        ? currentRoom
        : candidates[randomInt(0, candidates.length - 1)];
    }

    let position = randomPointInRoom(room, isBoss ? 92 : 54);
    let attempts = 0;
    const minimumPlayerDistance = this.run.elapsed < this.run.safeStartUntil
      ? this.runContext?.tuning?.safeStartDistance ?? CONFIG.safeStartEnemyDistance
      : 170;
    while (distance(position, this.player) < minimumPlayerDistance && attempts < 20) {
      position = randomPointInRoom(room, isBoss ? 92 : 54);
      attempts += 1;
    }

    const tuning = this.runContext?.tuning || {};
    const arenaMode = this.runContext?.mode === 'arena';
    const roll = isBoss || forcedType ? 0 : random();
    const type = isBoss
      ? 'guardian'
      : forcedType || resolveEnemySpawnType({
        roll,
        depth: this.run.depth,
        tuning,
        legacySelector: arenaMode ? legacyArenaArchetype : enemyArchetypeForRoll
      });
    const configuredStats = ENEMY_STATS[type];
    const stats = arenaMode && isBoss
      ? { ...configuredStats, health: 620, speed: 56, damage: 24, xp: 160 }
      : configuredStats;
    const resolvedStats = resolveEnemyDepthStats({
      type,
      depth: this.run.depth,
      tuning,
      baseStats: stats,
      isBoss
    });
    const dormant = roomRequiresLock(room.type) && !isBoss;

    const enemy = {
      id: this.entityId++,
      type,
      isBoss,
      x: position.x,
      y: position.y,
      vx: 0,
      vy: 0,
      knockbackX: 0,
      knockbackY: 0,
      radius: stats.radius * (isBoss ? 1 + (this.run.depth - 1) * .05 : 1),
      hp: resolvedStats.health,
      maxHp: resolvedStats.health,
      speed: resolvedStats.speed,
      damage: resolvedStats.damage,
      xp: Math.round(resolvedStats.xp),
      color: stats.color,
      hitFlash: 0,
      contactTimer: 0,
      phase: randomRange(0, TAU),
      roomId: room.id,
      awake: !dormant,
      hidden: type === 'crawler' && dormant,
      facing: randomRange(0, TAU),
      aiTimer: randomRange(.35, 1.2),
      attackTimer: randomRange(.6, 1.4),
      summonTimer: 4.5,
      fuseTimer: 0,
      lastBossPhase: 1,
      guardianReinforcement: false
    };
    this.enemies.push(enemy);
    return enemy;
  },

  awakenGuardian(room) {
    if (this.runContext?.tuning?.usePerDepthRoomSpawns === false) {
      return roomsMethods.awakenGuardian.call(this, room);
    }
    if (
      room?.type !== 'guardian' ||
      !this.run.bossReady ||
      this.run.bossSpawned
    ) return null;

    this.run.bossSpawned = true;
    const count = Math.max(0, Math.floor(this.run.bossGoal || 0));
    if (count === 0) {
      this.run.bossKilled = true;
      this.unlockRoom(room.id, false);
      this.createPortal();
      this.hooks.onToast?.('Guardian encounter disabled — extraction unlocked');
      return null;
    }

    const guardians = [];
    for (let index = 0; index < count; index += 1) {
      const guardian = this.spawnEnemy(true, room);
      if (!guardian) continue;
      guardian.awake = true;
      guardian.hidden = false;
      guardians.push(guardian);
    }
    this.hooks.onToast?.(guardians.length === 1
      ? 'THE GUARDIAN AWAKENS'
      : `${guardians.length} GUARDIANS AWAKEN`);
    return guardians[0] || null;
  },

  killEnemy(enemy) {
    if (!enemy?.isBoss || this.runContext?.tuning?.usePerDepthRoomSpawns === false) {
      return enemySpawnMethods.killEnemy.call(this, enemy);
    }

    const tuning = this.runContext?.tuning || {};
    this.enemies = this.enemies.filter((entry) => entry.id !== enemy.id);
    this.run.kills += 1;
    this.run.bossKills = Math.max(0, Math.floor(this.run.bossKills || 0)) + 1;
    this.run.rawNuggets += Math.max(0, Math.round(tuning.bossPointValue || 0));
    this.hooks.onArenaEvent?.({
      type: 'guardian_defeated',
      tick: Math.round(this.run.elapsed * 1_000),
      targetId: enemy.id
    });
    this.gainXp(enemy.xp);

    const payout = 180 + this.run.depth * 45;
    const count = 16;
    const baseValue = Math.floor(payout / count);
    const remainder = payout % count;
    for (let index = 0; index < count; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: 'nugget',
        x: enemy.x + randomRange(-enemy.radius, enemy.radius),
        y: enemy.y + randomRange(-enemy.radius, enemy.radius),
        radius: 9,
        value: baseValue + (index < remainder ? 1 : 0),
        color: CONFIG.colors.pickup,
        vx: randomRange(-110, 110),
        vy: randomRange(-110, 110)
      });
    }

    const vaultId = this.layout.guardianRoom.id;
    const remainingBosses = this.enemies.filter((entry) => entry.isBoss && entry.roomId === vaultId);
    if (remainingBosses.length) {
      this.audio.play('guardianDown');
      this.addFloater(enemy.x, enemy.y - enemy.radius, `${remainingBosses.length} GUARDIAN${remainingBosses.length === 1 ? '' : 'S'} REMAIN`, '#f1b6ff');
      this.hooks.onToast?.(`${remainingBosses.length} Guardian${remainingBosses.length === 1 ? '' : 's'} remaining`);
      return;
    }

    for (const minion of this.enemies.filter((entry) => entry.roomId === vaultId)) {
      this.burst(minion.x, minion.y, minion.color, 8);
    }
    this.enemies = this.enemies.filter((entry) => entry.roomId !== vaultId);
    this.run.bossKilled = true;
    this.audio.stopBoss();
    this.audio.play('guardianDown');
    this.unlockRoom(vaultId, false);
    this.hooks.onToast?.('Guardian force defeated — return to the Lift Station');
    this.createPortal();
  },

  updateObjective() {
    if (this.runContext?.tuning?.usePerDepthRoomSpawns === false) {
      return stateMethods.updateObjective.call(this);
    }
    const goal = this.crystalGoal();
    let text;
    if (this.isSafeStartActive()) {
      text = 'SAFE START - Pickaxe ready - Move when you are ready';
    } else if (this.activeLockedRoomId) {
      const room = this.layout.rooms.find((entry) => entry.id === this.activeLockedRoomId);
      const remaining = this.enemies.filter((enemy) => enemy.roomId === this.activeLockedRoomId && enemy.awake).length;
      if (room?.type === 'guardian') {
        const guardians = this.enemies.filter((enemy) => enemy.roomId === room.id && enemy.isBoss);
        const guardian = guardians[0];
        const phase = guardian ? bossPhaseForHealth(guardian.hp, guardian.maxHp) : 3;
        text = guardians.length > 1
          ? `${guardians.length} Guardians remaining · lead phase ${phase}`
          : `Guardian phase ${phase} · ${remaining} threat${remaining === 1 ? '' : 's'} remaining`;
      } else text = `Room sealed · ${remaining} enem${remaining === 1 ? 'y' : 'ies'} remaining`;
    } else if (this.run.bossKilled) text = 'Return to the extraction lift';
    else if (this.run.bossSpawned) {
      const remaining = this.enemies.filter((enemy) => enemy.isBoss).length;
      text = `Defeat the Guardian force · ${remaining} remaining`;
    } else if (this.run.bossReady) text = 'Enter the Guardian Vault';
    else text = `MATT crystals: ${this.run.crystals} / ${goal}`;
    this.hooks.onObjective?.(text);
  }
};

function configuredSpawnCount(tuning, depth, suffix, fallback) {
  const normalizedDepth = Math.max(1, Math.min(MAX_CONFIGURED_DEPTH, Math.floor(Number(depth) || 1)));
  const value = Number(tuning[`depth${normalizedDepth}${suffix}`]);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function roomTypeSuffix(type) {
  return ({
    start: 'StartEnemies',
    mining: 'MiningEnemies',
    combat: 'CombatEnemies',
    mixed: 'MixedEnemies',
    treasure: 'TreasureEnemies',
    guardian: 'GuardianEnemies'
  })[type] || 'MixedEnemies';
}

function defaultRoomEnemyCount(type) {
  return ({
    start: 0,
    mining: 1,
    combat: 4,
    mixed: 3,
    treasure: 1,
    guardian: 0
  })[type] ?? 0;
}

function legacyArenaArchetype(roll, depth) {
  if (depth >= 2 && roll >= .87) return 'exploder';
  if (roll >= .7) return 'beetle';
  if (roll >= .47) return 'crawler';
  if (roll >= .24) return 'bat';
  return 'slime';
}
