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
      const awarenessRange = enemy.behavior?.awarenessRange ?? (enemy.isBoss
        ? this.runContext?.tuning?.bossAwarenessRange || CONFIG.guardianAwarenessRange
        : 440);
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
        enemy.contactTimer = enemy.behavior?.contactCooldown ?? (enemy.isBoss ? 0.8 : 1.05);
        this.damagePlayer(enemy.damage, angleTo(enemy, this.player), enemy.isBoss
          ? { bossId: enemy.id, bossAttack: 'contact' }
          : {});
      }
    }
  },
  updateEnemyBehavior(enemy, dt) {
    const dist = distance(enemy, this.player);
    const angle = angleTo(enemy, this.player);
    const behavior = enemy.behavior || {};
    if (enemy.type === 'beetle' && this.runContext?.mode !== 'arena') {
      const turn = normalizeAngle(angle - enemy.facing);
      const maxTurn = dt * (behavior.beetleTurnRate ?? 1.25);
      enemy.facing += Math.max(-maxTurn, Math.min(maxTurn, turn));
    } else enemy.facing = angle;

    if (enemy.type === 'crawler' && enemy.hidden) {
      enemy.vx = 0;
      enemy.vy = 0;
      if (dist < (behavior.crawlerRevealRange ?? 155)) {
        enemy.hidden = false;
        enemy.aiTimer = 0;
        this.burst(enemy.x, enemy.y, '#d94b9d', 12);
      }
      return;
    }

    if (enemy.type === 'exploder') {
      if (enemy.fuseTimer > 0) {
        enemy.fuseTimer -= dt;
        const damping = Math.pow(behavior.exploderFuseDamping ?? .84, dt * 60);
        enemy.vx *= damping;
        enemy.vy *= damping;
        enemy.hitFlash = Math.floor(enemy.fuseTimer * 12) % 2 ? 0.08 : 0;
        if (enemy.fuseTimer <= 0) this.enemyExplode(enemy);
        return;
      }
      if (dist < (behavior.exploderTriggerRange ?? 92)) {
        enemy.fuseTimer = behavior.exploderFuseSeconds ?? .82;
        this.addFloater(enemy.x, enemy.y - 30, 'FUSE!', '#ffcf73');
        return;
      }
    }

    if (enemy.type === 'spitter') {
      const preferredRange = behavior.spitterPreferredRange ?? 285;
      const direction = dist < preferredRange - (behavior.spitterInnerTolerance ?? 35)
        ? -1
        : dist > preferredRange + (behavior.spitterOuterTolerance ?? 45) ? 1 : 0;
      const strafeAngle = angle + Math.PI / 2 * (Math.sin(enemy.phase * (behavior.spitterStrafeWaveSpeed ?? .72)) >= 0 ? 1 : -1);
      const strafeSpeed = behavior.spitterStrafeSpeed ?? .72;
      const targetVx = Math.cos(angle) * enemy.speed * direction + Math.cos(strafeAngle) * enemy.speed * strafeSpeed;
      const targetVy = Math.sin(angle) * enemy.speed * direction + Math.sin(strafeAngle) * enemy.speed * strafeSpeed;
      const steering = behavior.steering ?? 4;
      enemy.vx += (targetVx - enemy.vx) * Math.min(1, dt * steering);
      enemy.vy += (targetVy - enemy.vy) * Math.min(1, dt * steering);
      if (enemy.attackTimer <= 0 && dist < (behavior.spitterAttackRange ?? 440)) {
        const cooldownMin = behavior.spitterCooldownMin ?? 1.15;
        const cooldownMax = Math.max(cooldownMin, behavior.spitterCooldownMax ?? 1.35);
        enemy.attackTimer = randomRange(cooldownMin, cooldownMax);
        this.fireEnemyVolley(
          enemy,
          Math.round(behavior.spitterProjectileCount ?? 3),
          behavior.spitterProjectileSpread ?? .46,
          behavior.spitterProjectileSpeed ?? 300,
          false,
          {
            damage: enemy.damage * (behavior.spitterProjectileDamage ?? .62),
            maxRange: behavior.spitterProjectileRange ?? CONFIG.guardianProjectileRange,
            radius: behavior.spitterProjectileRadius > 0
              ? behavior.spitterProjectileRadius
              : this.runContext?.mode === 'arena' ? 9 : 8,
            life: behavior.spitterProjectileLifetime ?? 2.2
          }
        );
      }
      return;
    }

    let speedScale = 1;
    let steering = behavior.steering ?? 6;
    let targetAngle = angle;
    if (enemy.type === 'slime') {
      if (enemy.aiTimer <= 0) {
        const minimum = behavior.slimeBurstCooldownMin ?? 1.2;
        enemy.aiTimer = randomRange(minimum, Math.max(minimum, behavior.slimeBurstCooldownMax ?? 1.8));
        speedScale = behavior.slimeBurstSpeed ?? 2.35;
        steering = behavior.slimeBurstSteering ?? 13;
      } else speedScale = behavior.slimeCruiseSpeed ?? .72;
    } else if (enemy.type === 'bat') {
      targetAngle += Math.sin(enemy.phase * (behavior.batWeaveSpeed ?? 1.45)) * (behavior.batWeaveAmount ?? .72);
      speedScale = enemy.aiTimer <= 0 ? behavior.batBurstSpeed ?? 1.8 : behavior.batCruiseSpeed ?? 1.05;
      if (enemy.aiTimer <= 0) {
        const minimum = behavior.batBurstCooldownMin ?? .7;
        enemy.aiTimer = randomRange(minimum, Math.max(minimum, behavior.batBurstCooldownMax ?? 1.3));
      }
    } else if (enemy.type === 'crawler') {
      speedScale = enemy.aiTimer <= 0 ? behavior.crawlerBurstSpeed ?? 1.75 : behavior.crawlerCruiseSpeed ?? .82;
      if (enemy.aiTimer <= 0) {
        const minimum = behavior.crawlerBurstCooldownMin ?? 1;
        enemy.aiTimer = randomRange(minimum, Math.max(minimum, behavior.crawlerBurstCooldownMax ?? 1.6));
      }
    } else if (enemy.type === 'beetle') {
      speedScale = behavior.beetleSpeedScale ?? .82;
    } else if (enemy.type === 'exploder') {
      speedScale = behavior.exploderChaseSpeed ?? 1.12;
    }

    const targetVx = Math.cos(targetAngle) * enemy.speed * speedScale;
    const targetVy = Math.sin(targetAngle) * enemy.speed * speedScale;
    enemy.vx += (targetVx - enemy.vx) * Math.min(1, dt * steering);
    enemy.vy += (targetVy - enemy.vy) * Math.min(1, dt * steering);
  },
};
