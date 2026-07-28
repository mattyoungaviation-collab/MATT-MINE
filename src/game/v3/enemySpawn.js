import { CONFIG } from '../config.js';
import { randomPointInRoom, roomAt } from '../layout.js';
import { distance, random, randomInt, randomRange } from '../utils.js';
import { ENEMY_STATS, enemyArchetypeForRoll, roomRequiresLock } from '../combat.js';

const TAU = Math.PI * 2;

export const enemySpawnMethods = {
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

    const depthScale = 1 + (this.run.depth - 1) * 0.28;
    const arenaMode = this.runContext?.mode === 'arena';
    const roll = isBoss || forcedType ? 0 : random();
    let type = isBoss
      ? 'guardian'
      : forcedType || (arenaMode ? legacyArenaArchetype(roll, this.run.depth) : enemyArchetypeForRoll(roll, this.run.depth));
    const tuning = this.runContext?.tuning || {};
    const enabledTypes = [
      ['slime', tuning.spawnSlimes !== false],
      ['bat', tuning.spawnBats !== false],
      ['crawler', tuning.spawnCrawlers !== false],
      ['beetle', tuning.spawnBeetles !== false],
      ['exploder', tuning.spawnExploders !== false],
      ['spitter', tuning.spawnRanged !== false]
    ].filter(([, enabled]) => enabled).map(([id]) => id);
    if (!isBoss && !enabledTypes.includes(type)) type = enabledTypes[0] || 'slime';
    const configuredStats = ENEMY_STATS[type];
    const stats = arenaMode && isBoss
      ? { ...configuredStats, health: 620, speed: 56, damage: 24, xp: 160 }
      : configuredStats;
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
      radius: stats.radius * (isBoss ? 1 + (this.run.depth - 1) * 0.05 : 1),
      hp: stats.health * depthScale * (tuning.enemyHealthMultiplier || 1) * (tuning[`${type}HealthMultiplier`] || 1) * (isBoss ? tuning.bossHealthMultiplier || 1 : 1),
      maxHp: stats.health * depthScale * (tuning.enemyHealthMultiplier || 1) * (tuning[`${type}HealthMultiplier`] || 1) * (isBoss ? tuning.bossHealthMultiplier || 1 : 1),
      speed: stats.speed * (1 + (this.run.depth - 1) * 0.06) * (tuning.enemySpeedMultiplier || 1) * (isBoss ? tuning.bossSpeedMultiplier || 1 : 1),
      damage: stats.damage * depthScale * (tuning.enemyDamageMultiplier ?? 1) * (isBoss ? tuning.bossDamageMultiplier ?? 1 : 1),
      xp: Math.round(stats.xp * depthScale),
      color: stats.color,
      hitFlash: 0,
      contactTimer: 0,
      phase: randomRange(0, TAU),
      roomId: room.id,
      awake: !dormant,
      hidden: type === 'crawler' && dormant,
      facing: randomRange(0, TAU),
      aiTimer: randomRange(0.35, 1.2),
      attackTimer: randomRange(0.6, 1.4),
      summonTimer: 4.5,
      fuseTimer: 0,
      lastBossPhase: 1,
      guardianReinforcement: false
    };
    this.enemies.push(enemy);
    return enemy;
  },
  killEnemy(enemy) {
    const tuning = this.runContext?.tuning || {};
    this.enemies = this.enemies.filter((entry) => entry.id !== enemy.id);
    this.run.kills += 1;
    this.run.rawNuggets += enemy.isBoss
      ? Math.max(0, Math.round(tuning.bossPointValue || 0))
      : Math.max(0, Math.round(tuning.killPointValue || 0));
    this.hooks.onArenaEvent?.({
      type: enemy.isBoss ? 'guardian_defeated' : 'enemy_killed',
      tick: Math.round(this.run.elapsed * 1_000),
      targetId: enemy.id
    });
    this.gainXp(enemy.xp);
    const payout = enemy.isBoss ? 180 + this.run.depth * 45 : randomInt(2, 8);
    const count = enemy.isBoss ? 16 : 1;
    const baseValue = Math.floor(payout / count);
    const remainder = payout % count;
    for (let index = 0; index < count; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: 'nugget',
        x: enemy.x + randomRange(-enemy.radius, enemy.radius),
        y: enemy.y + randomRange(-enemy.radius, enemy.radius),
        radius: enemy.isBoss ? 9 : 7,
        value: baseValue + (index < remainder ? 1 : 0),
        color: CONFIG.colors.pickup,
        vx: randomRange(-110, 110),
        vy: randomRange(-110, 110)
      });
    }

    if (enemy.isBoss) {
      this.finishBossTelemetry?.(enemy);
      const vaultId = this.layout.guardianRoom.id;
      for (const minion of this.enemies.filter((entry) => entry.roomId === vaultId)) this.burst(minion.x, minion.y, minion.color, 8);
      this.enemies = this.enemies.filter((entry) => entry.roomId !== vaultId);
      this.run.bossKilled = true;
      this.audio.stopBoss();
      this.audio.play('guardianDown');
      this.unlockRoom(vaultId, false);
      this.hooks.onToast?.('Guardian defeated — return to the Lift Station');
      this.createPortal();
      return;
    }
    this.checkRoomClear(enemy.roomId);
  },
};

function legacyArenaArchetype(roll, depth) {
  if (depth >= 2 && roll >= 0.87) return 'exploder';
  if (roll >= 0.7) return 'beetle';
  if (roll >= 0.47) return 'crawler';
  if (roll >= 0.24) return 'bat';
  return 'slime';
}
