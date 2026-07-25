import { CONFIG, WEAPONS } from '../config.js';
import { angleTo, clamp, distance, randomRange } from '../utils.js';
import { frontArmorMultiplier, bossPhaseForHealth, normalizeAngle } from '../combat.js';

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
      this.player.weapon = id;
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
    this.player.swingTimer = 0.16;
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
    const critical = Math.random() < this.player.critChance;
    const damage = this.player.damage * (critical ? 2 : 1);
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
    this.player.dynamiteAmmo -= 1;
    const speed = 430;
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
      damage: this.player.damage * 1.8,
      explosionRadius: 155,
      color: '#ffb342'
    });
    this.audio.play('throw');
  },
  fireBlaster() {
    if (this.player.blasterEnergy < CONFIG.blasterEnergyCost) {
      if (this.player.emptyWeaponToast <= 0) {
        this.hooks.onToast?.('Crystal Blaster is recharging');
        this.player.emptyWeaponToast = 0.8;
      }
      return;
    }
    this.player.attackTimer = Math.max(0.13, this.player.attackCooldown * 0.48);
    this.player.blasterEnergy -= CONFIG.blasterEnergyCost;
    const speed = 760;
    this.projectiles.push({
      id: this.entityId++,
      kind: 'crystalBolt',
      owner: 'player',
      x: this.player.x + Math.cos(this.player.angle) * 34,
      y: this.player.y + Math.sin(this.player.angle) * 34,
      vx: Math.cos(this.player.angle) * speed,
      vy: Math.sin(this.player.angle) * speed,
      radius: 7,
      life: 0.82,
      damage: this.player.damage * 0.56,
      color: CONFIG.colors.crystal
    });
    this.audio.play('blaster');
  },
  updateProjectiles(dt) {
    for (const projectile of this.projectiles) {
      projectile.life -= dt;
      projectile.x += projectile.vx * dt;
      projectile.y += projectile.vy * dt;
      if (projectile.kind === 'dynamite') {
        projectile.vx *= Math.max(0, 1 - dt * 2.8);
        projectile.vy *= Math.max(0, 1 - dt * 2.8);
        if (projectile.life <= 0) {
          this.explode(projectile.x, projectile.y, projectile.explosionRadius, projectile.damage);
          projectile.dead = true;
        }
        continue;
      }
      if (!pointInLayout(this.layout, projectile.x, projectile.y, 4)) {
        projectile.dead = true;
        continue;
      }
      if (projectile.owner === 'player') {
        const target = [...this.enemies, ...this.ores].find((entry) => distance(projectile, entry) <= projectile.radius + entry.radius);
        if (target) {
          this.damageTarget(target, projectile.damage, false, Math.atan2(projectile.vy, projectile.vx), 'blaster');
          projectile.dead = true;
        }
      } else if (distance(projectile, this.player) <= projectile.radius + this.player.radius) {
        this.damagePlayer(projectile.damage, Math.atan2(projectile.vy, projectile.vx));
        projectile.dead = true;
      }
    }
    this.projectiles = this.projectiles.filter((projectile) => !projectile.dead && projectile.life > 0);
  },
  damageTarget(target, damage, critical = false, impactAngle = 0, source = 'pick') {
    if (!target || target.hp <= 0) return;
    let resolvedDamage = damage;
    let blocked = false;
    if (!('kind' in target)) {
      target.awake = true;
      target.hidden = false;
      if (target.type === 'beetle' && !['explosion', 'drone'].includes(source)) {
        const armor = frontArmorMultiplier(target.facing, impactAngle);
        blocked = armor < 1;
        resolvedDamage *= armor;
      }
      if (target.isBoss && bossPhaseForHealth(target.hp, target.maxHp) === 3) resolvedDamage *= 1.22;
    }

    target.hp -= resolvedDamage;
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
    this.camera.shake = Math.max(this.camera.shake, 12);
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
    this.gainXp(ore.xp);
    const drops = Math.max(1, Math.ceil(ore.nuggets / (ore.kind === 'cache' ? 9 : 6)));
    const baseDropValue = Math.floor(ore.nuggets / drops);
    const remainder = ore.nuggets % drops;
    for (let index = 0; index < drops; index += 1) {
      this.pickups.push({
        id: this.entityId++,
        type: ore.kind === 'crystal' && index === 0 ? 'crystal' : 'nugget',
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
      this.unlockWeapon('blaster');
      this.player.blasterEnergy = this.player.blasterEnergyMax;
      this.hooks.onToast?.('Crystal Blaster recovered from the cache');
    }
    else if (ore.rich) this.addFloater(ore.x, ore.y - 36, 'RICH VEIN', '#ffe88c');
  }
};
