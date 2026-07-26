import { angleTo, distance } from '../utils.js';

const TAU = Math.PI * 2;

export const guardianAttackMethods = {
  guardianSlam(enemy, radius, damage) {
    this.camera.shake = 15;
    this.audio.play('boom');
    this.tracers.push({ x1: enemy.x, y1: enemy.y, x2: enemy.x, y2: enemy.y, radius, color: '#d86cff', life: 0.42, maxLife: 0.42, ring: true });
    if (distance(enemy, this.player) < radius + this.player.radius) this.damagePlayer(damage, angleTo(enemy, this.player));
  },
  fireEnemyVolley(enemy, count, spread, speed, radial = false) {
    const centerAngle = angleTo(enemy, this.player);
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
        radius: 9,
        life: 2.2,
        damage: enemy.damage * 0.62,
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
