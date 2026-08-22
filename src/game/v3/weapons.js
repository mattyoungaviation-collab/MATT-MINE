import { CONFIG, WEAPONS } from '../config.js';
import { pointInLayout } from '../layout.js';
import { angleTo, clamp, distance, random, randomRange } from '../utils.js';
import { frontArmorMultiplier, bossPhaseForHealth, normalizeAngle } from '../combat.js';
import { nftMinerActionDuration } from './nftMinerAnimation.js';

export const weaponsMethods = {
  switchWeapon(id) {
    if (!WEAPONS[id]) return;
    if (!this.player.unlockedWeapons[id]) {
      if (this.player.emptyWeaponToast <= 0) {
        this.hooks.onToast?.(`${WEAPONS[id].name} has not been found yet`);
        this.player.emptyWeaponToast = 1.2;
      }
      return;
    }
    this.player.weapon = id;
    this.audio.play('weapon');
    this.hooks.onToast?.(`${WEAPONS[id].name} equipped`);
  },
  unlockWeapon(id, ammo = 0) {
    if (!WEAPONS[id]) return;
    const firstUnlock = !this.player.unlockedWeapons[id];
    this.player.unlockedWeapons[id] = true;
    if (id === 'dynamite') this.player.dynamiteAmmo += ammo;
    if (firstUnlock) {
      if (id !== 'dynamite') this.player.weapon = id;
      this.audio.play('weapon');
      this.hooks.onToast?.(`${WEAPONS[id].name} found — press ${id === 'dynamite' ? '2' : '3'} to equip`);
    }
  },
  attack() {
    if (this.player.weapon === 'dynamite') {
      this.throwDynamite();
      return;
    }
    if (this.player.weapon === 'blaster') {
      this.fireBlaster();
      return;
    }
    this.swingPickaxe();
  },
  swingPickaxe() {
    this.player.attackTimer = this.player.attackCooldown;
    this.player.swingTimer = nftMinerActionDuration('pickaxe');
    this.audio.play('swing');
    const candidates = [...this.enemies, ...this.ores]
      .map((target) => ({
        target,
        dist: distance(this.player, target),
        angleDiff: Math.abs(normalizeAngle(angleTo(this.player, target) - this.player.angle))
      }))
      .filter((entry) => entry.dist <= this.player.attackRange + entry.target.radius && entry.angleDiff < 0.88)
      .sort((a, b) => a.dist - b.dist);

    this.spawnSwingParticles();
    if (!candidates.length) return;

    const { target } = candidates[0];
    const critical = random() < this.player.critChance;
    const damage = this.player.damage * (this.runContext?.tuning?.pickaxeDamageMultiplier || CONFIG.pickaxeDamageScale) * (critical ? 2 : 1);
    this.damageTarget(target, damage, critical, angleTo(this.player, target));
    this.run.attackCounter += 1;

    if (this.player.dynamiteEvery > 0 && this.run.attackCounter % this.player.dynamiteEvery === 0) {
      this.explode(target.x, target.y, 125, this.player.damage * 0.72);
    }
  },
  throwDynamite() {
    if (this.player.dynamiteAmmo <= 0) {
      if (this.player.emptyWeaponToast <= 0) {
        this.hooks.onToast?.('No dynamite — clear combat rooms to restock');
        this.player.emptyWeaponToast = 1.1;
      }
      this.player.weapon = 'pickaxe';
      return;
    }
    this.player.attackTimer = 0.62;
    this.player.swingTimer = nftMinerActionDuration('dynamite');
    this.player.dynamiteAmmo -= 1;
    const speed = 430;
    const tuning = this.runContext?.tuning || {};
    const baseDamage = this.player.dynamiteBaseDamage || tuning.dynamiteDamage || CONFIG.dynamiteDamage;
    this.projectiles.push({
      id: this.entityId++,
      kind: 'dynamite',
      owner: 'player',
      x: this.player.x + Math.cos(this.player.angle) * 32,
      y: this.player.y + Math.sin(this.player.angle) * 32,
      vx: Math.cos(this.player.angle) * speed,
      vy: Math.sin(this.player.angle) * speed,
      radius: 10,
      life: 0.68,
      travelled: 0,
      maxRange: tuning.dynamiteThrowRange || CONFIG.dynamiteRange,
      damage: baseDamage * (tuning.dynamiteDamageMultiplier ?? 1),
      explosionRadius: tuning.dynamiteBlastRadius || 155,
      color: '#ffb342'
    });
    this.audio.play('throw');
  },
  fireBlaster() {
    const energyCost = this.runContext?.tuning?.blasterEnergyCost || CONFIG.blasterEnergyCost;
    if (this.player.blasterEnergy < energyCost) {
      if (this.player.emptyWeaponToast <= 0) {
        this.hooks.onToast?.('Crystal Blaster is recharging');
        this.player.emptyWeaponToast = 0.8;
      }
      return;
    }
    this.player.attackTimer = Math.max(0.13, this.player.attackCooldown * 0.48);
    this.player.swingTimer = nftMinerActionDuration('blaster');
    this.player.blasterEnergy -= energyCost;
    const speed = 760;
    const count = clamp(this.player.blasterVolley || 1, 1, this.runContext?.tuning?.blasterBeams || 2);
    for (let index = 0; index < count; index += 1) {
      const offset = count === 1
        ? 0
        : (index - (count - 1) / 2) * CONFIG.blasterVolleySpread;
      const angle = this.player.angle + offset;
      this.projectiles.push({
        id: this.entityId++,
        kind: 'crystalBolt',
        owner: 'player',
        x: this.player.x + Math.cos(angle) * 34,
        y: this.player.y + Math.sin(angle) * 34,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        radius: 7,
        life: 0.82,
        travelled: 0,
        maxRange: this.runContext?.tuning?.blasterRange || CONFIG.blasterRange,
        damage: this.player.damage * this.player.blasterDamageScale,
        color: CONFIG.colors.crystal
      });
    }
    this.audio.play('blaster');
  },
  updateProjectiles(dt) {
    for (const projectile of this.projectiles) {
      const previousLife = projectile.life;
      projectile.life -= dt;
      if (projectile.life <= 0 && projectile.kind !== 'dynamite') {
        projectile.dead = true;
        continue;
      }

      const movementTime = projectile.kind === 'dynamite'
        ? Math.min(dt, Math.max(0, previousLife))
        : dt;
      const distanceToMove = Math.hypot(projectile.vx, projectile.vy) * movementTime;
      const steps = Math.max(1, Math.ceil(distanceToMove / Math.max(4, projectile.radius * 0.75)));
      const stepTime = movementTime / steps;
      let hitWall = false;

      for (let step = 0; step < steps && !projectile.dead; step += 1) {
        const stepX = projectile.vx * stepTime;
        const stepY = projectile.vy * stepTime;
        const nextX = projectile.x + stepX;
        const nextY = projectile.y + stepY;
        const padding = Math.max(3, projectile.radius * 0.72);
        if (!pointInLayout(this.layout, nextX, nextY, padding)) {
          hitWall = true;
          break;
        }
        projectile.x = nextX;
        projectile.y = nextY;
        projectile.travelled = (projectile.travelled || 0) + Math.hypot(stepX, stepY);
        if (Number.isFinite(projectile.maxRange) && projectile.travelled >= projectile.maxRange) {
          projectile.dead = true;
          break;
        }
        if (projectile.kind !== 'dynamite') this.resolveProjectileHit(projectile);
      }

      if (projectile.kind === 'dynamite') {
        projectile.vx *= Math.max(0, 1 - dt * 2.8);
        projectile.vy *= Math.max(0, 1 - dt * 2.8);
        if (projectile.life <= 0 || hitWall || projectile.dead) {
          this.explode(projectile.x, projectile.y, projectile.explosionRadius, projectile.damage);
          projectile.dead = true;
        }
        continue;
      }
      if (hitWall) {
        projectile.dead = true;
      }
    }
    this.projectiles = this.projectiles.filter((projectile) => !projectile.dead && projectile.life > 0);
  },
  resolveProjectileHit(projectile) {
    if (projectile.owner === 'player') {
      const target = [...this.enemies, ...this.ores]
        .find((entry) => distance(projectile, entry) <= projectile.radius + entry.radius);
      if (!target) return;
      this.damageTarget(target, projectile.damage, false, Math.atan2(projectile.vy, projectile.vx), 'blaster');
      projectile.dead = true;
      return;
    }
    if (distance(projectile, this.player) <= projectile.radius + this.player.radius) {
      this.damagePlayer(projectile.damage, Math.atan2(projectile.vy, projectile.vx), {
        bossId: projectile.bossId,
        bossAttack: projectile.bossAttack
      });
      projectile.dead = true;
    }
  },
  damageTarget(target, damage, critical = false, impactAngle = 0, source = 'pick') {
    if (!target || target.hp <= 0) return;
    let resolvedDamage = damage;
    let blocked = false;
    if (!('kind' in target)) {
      target.awake = true;
      target.hidden = false;
      if (target.type === 'beetle') {
        if (this.runContext?.mode === 'arena') {
          if (!['explosion', 'drone'].includes(source)) {
            const armor = frontArmorMultiplier(target.facing, impactAngle);
            blocked = armor < 1;
            resolvedDamage *= armor < 1 ? 0.22 : 1;
          }
        } else if (source === 'explosion') resolvedDamage *= 1.8;
        else {
          const armor = frontArmorMultiplier(target.facing, impactAngle);
          blocked = armor < 1;
          resolvedDamage *= armor;
          if (['blaster', 'drone'].includes(source)) resolvedDamage *= 0.22;
          if (blocked && source === 'pick') {
            this.player.attackTimer = Math.max(this.player.attackTimer, 0.5);
            this.player.swingTimer = 0;
            this.player.vx -= Math.cos(impactAngle) * 180;
            this.player.vy -= Math.sin(impactAngle) * 180;
            this.audio.play('shield');
            this.addFloater(this.player.x, this.player.y - 32, 'RECOIL', '#9df0bd');
          }
        }
      }
      if (target.isBoss && bossPhaseForHealth(target.hp, target.maxHp) === 3) resolvedDamage *= 1.22;
    }

    target.hp -= resolvedDamage;
    if (target.isBoss && this.run?.bossTelemetry) {
      this.run.bossTelemetry.damageDealt += Math.max(0, resolvedDamage);
    }
    target.hitFlash = 0.1;
    this.camera.shake = Math.max(this.camera.shake, critical ? 8 : source === 'explosion' ? 11 : 3);
    this.addFloater(
      target.x,
      target.y - target.radius,
      blocked ? `BLOCK ${Math.max(1, Math.round(resolvedDamage))}` : `${critical ? 'CRIT ' : ''}${Math.round(resolvedDamage)}`,
      blocked ? '#8ee0a9' : source === 'drone' ? '#8be9ff' : critical ? '#fff09a' : '#ffffff'
    );
    this.burst(target.x, target.y, target.color, critical ? 12 : source === 'explosion' ? 10 : 6);
    this.audio.play('kind' in target ? 'rock' : 'hit');

    if (!('kind' in target)) {
      const knockback = target.isBoss ? 55 : source === 'explosion' ? 280 : blocked ? 70 : 180;
      target.knockbackX += Math.cos(impactAngle) * knockback;
      target.knockbackY += Math.sin(impactAngle) * knockback;
    }

    if (target.hp <= 0) {
      if ('kind' in target) this.breakOre(target);
      else this.killEnemy(target);
    }
  },
  explode(x, y, radius, damage) {
    this.camera.shake = Math.max(this.camera.shake, 9);
    this.audio.play('boom');
    this.burst(x, y, '#ffb342', 28);
    this.addFloater(x, y - 30, 'BOOM', '#ffcf73');
    for (const target of [...this.enemies, ...this.ores]) {
      const dist = Math.hypot(target.x - x, target.y - y);
      if (dist > radius + target.radius) continue;
      const falloff = clamp(1 - dist / (radius + target.radius), 0.35, 1);
      const impact = Math.atan2(target.y - y, target.x - x);
      this.damageTarget(target, damage * falloff, false, impact, 'explosion');
    }
    this.tracers.push({ x1: x, y1: y, x2: x, y2: y, radius, color: '#ffb342', life: 0.22, maxLife: 0.22, ring: true });
  },
  breakOre(ore) {
    this.ores = this.ores.filter((entry) => entry.id !== ore.id);
    this.run.oreBroken += 1;
    this.hooks.onArenaEvent?.({
      type: 'ore_broken',
      tick: Math.round(this.run.elapsed * 1_000),
      targetId: ore.id
    });
    this.gainXp(ore.xp);
    const drops = Math.max(1, Math.ceil(ore.scoreValue / (ore.kind === 'cache' ? 9 : 6)));
    const baseDropValue = Math.floor(ore.scoreValue / drops);
    const remainder = ore.scoreValue % drops;
    for (let index = 0; index < drops; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: ore.kind === 'crystal' && index === 0 ? 'crystal' : 'score',
        x: ore.x + randomRange(-18, 18),
        y: ore.y + randomRange(-18, 18),
        radius: ore.kind === 'crystal' && index === 0 ? 11 : ore.kind === 'cache' ? 9 : 7,
        value: baseDropValue + (index < remainder ? 1 : 0),
        color: ore.kind === 'crystal' && index === 0 ? CONFIG.colors.crystal : ore.kind === 'cache' ? CONFIG.colors.treasure : CONFIG.colors.pickup,
        vx: randomRange(-90, 90),
        vy: randomRange(-90, 90)
      });
    }
    if (ore.kind === 'cache') {
      this.player.blasterEnergy = this.player.blasterEnergyMax;
      if (ore.grantsWeapon === 'dynamite') {
        this.unlockWeapon('dynamite', 3);
        this.hooks.onToast?.('Pocket Dynamite recovered from the cache');
      } else if (ore.grantsWeapon === 'blaster') {
        this.unlockWeapon('blaster');
        this.hooks.onToast?.('Crystal Blaster recovered from the cache');
      } else if (this.runContext?.mode === 'arena') {
        this.unlockWeapon('blaster');
        this.hooks.onToast?.('Crystal Blaster recovered from the cache');
      } else this.offerBlasterUpgrade();
    }
    else if (ore.rich) this.addFloater(ore.x, ore.y - 36, 'RICH VEIN', '#ffe88c');
  }
};
