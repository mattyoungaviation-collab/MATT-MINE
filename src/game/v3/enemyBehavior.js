import { CONFIG } from '../config.js';
import { roomAt } from '../layout.js';
import { angleTo, distance, randomRange } from '../utils.js';
import { normalizeAngle } from '../combat.js';

export const enemyBehaviorMethods = {
  updateEnemies(dt) {
    const playerRoom = roomAt(this.layout, this.player.x, this.player.y);
    const safeStartActive = this.isSafeStartActive();
    for (const enemy of [...this.enemies]) {
      enemy.hitFlash -= dt;
      enemy.contactTimer -= dt;
      enemy.aiTimer -= dt;
      enemy.attackTimer -= dt;
      enemy.summonTimer -= dt;
      enemy.phase += dt * 3;
      if (!enemy.awake) continue;
      if (safeStartActive) {
        enemy.vx *= Math.max(0, 1 - dt * 10);
        enemy.vy *= Math.max(0, 1 - dt * 10);
        continue;
      }

      const enemyRoom = roomAt(this.layout, enemy.x, enemy.y);
      const awarenessRange = enemy.isBoss
        ? this.runContext?.tuning?.bossAwarenessRange || CONFIG.guardianAwarenessRange
        : 440;
      const active = enemy.isBoss
        ? enemy.engaged === true ||
          distance(enemy, this.player) < awarenessRange ||
          (playerRoom && enemyRoom && playerRoom.id === enemyRoom.id)
        : distance(enemy, this.player) < awarenessRange ||
          (playerRoom && enemyRoom && playerRoom.id === enemyRoom.id);
      if (!active) {
        enemy.vx *= Math.max(0, 1 - dt * 7);
        enemy.vy *= Math.max(0, 1 - dt * 7);
        continue;
      }

      if (enemy.isBoss) {
        enemy.engaged = true;
        this.updateGuardian(enemy, dt);
      }
      else this.updateEnemyBehavior(enemy, dt);
      if (!this.enemies.includes(enemy)) continue;

      enemy.knockbackX *= Math.max(0, 1 - dt * 8);
      enemy.knockbackY *= Math.max(0, 1 - dt * 8);
      this.moveEntity(enemy, (enemy.vx + enemy.knockbackX) * dt, (enemy.vy + enemy.knockbackY) * dt);

      if (enemy.type !== 'exploder' && distance(enemy, this.player) < enemy.radius + this.player.radius && enemy.contactTimer <= 0) {
        enemy.contactTimer = enemy.isBoss ? 0.8 : 1.05;
        this.damagePlayer(enemy.damage, angleTo(enemy, this.player), enemy.isBoss
          ? { bossId: enemy.id, bossAttack: 'contact' }
          : {});
      }
    }
  },
  updateEnemyBehavior(enemy, dt) {
    const dist = distance(enemy, this.player);
    const angle = angleTo(enemy, this.player);
    if (enemy.type === 'beetle' && this.runContext?.mode !== 'arena') {
      const turn = normalizeAngle(angle - enemy.facing);
      const maxTurn = dt * 1.25;
      enemy.facing += Math.max(-maxTurn, Math.min(maxTurn, turn));
    } else enemy.facing = angle;

    if (enemy.type === 'crawler' && enemy.hidden) {
      enemy.vx = 0;
      enemy.vy = 0;
      if (dist < 155) {
        enemy.hidden = false;
        enemy.aiTimer = 0;
        this.burst(enemy.x, enemy.y, '#d94b9d', 12);
      }
      return;
    }

    if (enemy.type === 'exploder') {
      if (enemy.fuseTimer > 0) {
        enemy.fuseTimer -= dt;
        enemy.vx *= 0.84;
        enemy.vy *= 0.84;
        enemy.hitFlash = Math.floor(enemy.fuseTimer * 12) % 2 ? 0.08 : 0;
        if (enemy.fuseTimer <= 0) this.enemyExplode(enemy);
        return;
      }
      if (dist < 92) {
        enemy.fuseTimer = 0.82;
        this.addFloater(enemy.x, enemy.y - 30, 'FUSE!', '#ffcf73');
        return;
      }
    }

    if (enemy.type === 'spitter') {
      const preferredRange = 285;
      const direction = dist < preferredRange - 35 ? -1 : dist > preferredRange + 45 ? 1 : 0;
      const strafeAngle = angle + Math.PI / 2 * (Math.sin(enemy.phase * 0.72) >= 0 ? 1 : -1);
      const targetVx = Math.cos(angle) * enemy.speed * direction + Math.cos(strafeAngle) * enemy.speed * 0.72;
      const targetVy = Math.sin(angle) * enemy.speed * direction + Math.sin(strafeAngle) * enemy.speed * 0.72;
      enemy.vx += (targetVx - enemy.vx) * Math.min(1, dt * 4);
      enemy.vy += (targetVy - enemy.vy) * Math.min(1, dt * 4);
      if (enemy.attackTimer <= 0 && dist < 440) {
        enemy.attackTimer = randomRange(1.15, 1.35);
        this.fireEnemyVolley(enemy, 3, 0.46, 300);
      }
      return;
    }

    let speedScale = 1;
    let steering = 6;
    let targetAngle = angle;
    if (enemy.type === 'slime') {
      if (enemy.aiTimer <= 0) {
        enemy.aiTimer = randomRange(1.2, 1.8);
        speedScale = 2.35;
        steering = 13;
      } else speedScale = 0.72;
    } else if (enemy.type === 'bat') {
      targetAngle += Math.sin(enemy.phase * 1.45) * 0.72;
      speedScale = enemy.aiTimer <= 0 ? 1.8 : 1.05;
      if (enemy.aiTimer <= 0) enemy.aiTimer = randomRange(0.7, 1.3);
    } else if (enemy.type === 'crawler') {
      speedScale = enemy.aiTimer <= 0 ? 1.75 : 0.82;
      if (enemy.aiTimer <= 0) enemy.aiTimer = randomRange(1.0, 1.6);
    } else if (enemy.type === 'beetle') {
      speedScale = 0.82;
      steering = 4;
    } else if (enemy.type === 'exploder') {
      speedScale = 1.12;
    }

    const targetVx = Math.cos(targetAngle) * enemy.speed * speedScale;
    const targetVy = Math.sin(targetAngle) * enemy.speed * speedScale;
    enemy.vx += (targetVx - enemy.vx) * Math.min(1, dt * steering);
    enemy.vy += (targetVy - enemy.vy) * Math.min(1, dt * steering);
  },
};
