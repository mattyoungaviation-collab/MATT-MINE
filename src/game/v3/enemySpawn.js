import { CONFIG } from '../config.js';
import { randomPointInRoom, roomAt } from '../layout.js';
import { distance, randomInt, randomRange } from '../utils.js';
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
    while (distance(position, this.player) < 170 && attempts < 20) {
      position = randomPointInRoom(room, isBoss ? 92 : 54);
      attempts += 1;
    }

    const depthScale = 1 + (this.run.depth - 1) * 0.28;
    const type = isBoss ? 'guardian' : forcedType || enemyArchetypeForRoll(Math.random(), this.run.depth);
    const stats = ENEMY_STATS[type];
    const dormant = roomRequiresLock(room.type) && !isBoss;

    this.enemies.push({
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
      hp: stats.health * depthScale,
      maxHp: stats.health * depthScale,
      speed: stats.speed * (1 + (this.run.depth - 1) * 0.06),
      damage: stats.damage * depthScale,
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
      lastBossPhase: 1
    });
  },
  killEnemy(enemy) {
    this.enemies = this.enemies.filter((entry) => entry.id !== enemy.id);
    this.run.kills += 1;
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
