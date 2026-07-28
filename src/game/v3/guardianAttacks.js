import { CONFIG } from '../config.js';
import { segmentInLayout } from '../layout.js';
import { angleTo, distance } from '../utils.js';

const TAU = Math.PI * 2;

export const guardianAttackMethods = {
  guardianSlam(enemy, radius, damage, attackType = 'slam') {
    this.camera.shake = 15;
    this.audio.play('boom');
    this.tracers.push({ x1: enemy.x, y1: enemy.y, x2: enemy.x, y2: enemy.y, radius, color: '#d86cff', life: 0.42, maxLife: 0.42, ring: true });
    const playerIsExposed = segmentInLayout(
      this.layout,
      enemy.x,
      enemy.y,
      this.player.x,
      this.player.y,
      Math.min(6, this.player.radius * 0.2)
    );
    if (playerIsExposed && distance(enemy, this.player) < radius + this.player.radius) {
      this.damagePlayer(damage, angleTo(enemy, this.player), {
        bossId: enemy.id,
        bossAttack: attackType
      });
    }
  },
  fireEnemyVolley(enemy, count, spread, speed, radial = false, options = {}) {
    if (enemy.isBoss) {
      speed = this.runContext?.tuning?.bossProjectileSpeed || speed;
      if (!radial) spread = this.runContext?.tuning?.bossVolleySpread || spread;
    }
    const predictedPlayer = {
      x: this.player.x + this.player.vx * CONFIG.guardianPredictionSeconds,
      y: this.player.y + this.player.vy * CONFIG.guardianPredictionSeconds
    };
    const centerAngle = angleTo(enemy, predictedPlayer);
    for (let index = 0; index < count; index += 1) {
      const offset = radial
        ? (index / count) * TAU
        : count === 1 ? 0 : -spread / 2 + (index / (count - 1)) * spread;
      const angle = radial ? offset : centerAngle + offset;
      this.projectiles.push({
        id: this.entityId++,
        kind: 'enemyCrystal',
        owner: 'enemy',
        x: enemy.x + Math.cos(angle) * enemy.radius,
        y: enemy.y + Math.sin(angle) * enemy.radius,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: this.runContext?.mode === 'arena' ? 9 : enemy.isBoss ? 7 : 8,
        life: 2.2,
        travelled: 0,
        maxRange: options.maxRange || CONFIG.guardianProjectileRange,
        damage: options.damage ?? enemy.damage * 0.62,
        bossId: enemy.isBoss ? enemy.id : 0,
        bossAttack: options.attackType || (radial ? 'radial' : 'volley'),
        color: '#d86cff'
      });
    }
    this.audio.play('blaster');
  },
  enemyExplode(enemy) {
    const roomId = enemy.roomId;
    this.enemies = this.enemies.filter((entry) => entry.id !== enemy.id);
    this.explode(enemy.x, enemy.y, 138, enemy.damage * 0.9);
    if (distance(enemy, this.player) < 145 + this.player.radius) this.damagePlayer(enemy.damage, angleTo(enemy, this.player));
    this.checkRoomClear(roomId);
  }
};
