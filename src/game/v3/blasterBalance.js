import { CONFIG } from '../config.js';
import { clamp } from '../utils.js';

export const blasterBalanceMethods = {
  fireBlaster() {
    const tuning = this.runContext?.tuning || {};
    const energyCost = tuning.blasterEnergyCost ?? CONFIG.blasterEnergyCost;
    if (this.player.blasterEnergy < energyCost) {
      if (this.player.emptyWeaponToast <= 0) {
        this.hooks.onToast?.('Crystal Blaster is recharging');
        this.player.emptyWeaponToast = .8;
      }
      return;
    }

    const cooldownMultiplier = tuning.blasterCooldownMultiplier ?? .48;
    this.player.attackTimer = Math.max(.08, this.player.attackCooldown * cooldownMultiplier);
    this.player.swingTimer = Math.max(this.player.swingTimer, .14);
    this.player.blasterEnergy -= energyCost;

    // Raw engine tests and unsnapshotted legacy runs retain the former two-beam
    // ceiling. Production run snapshots explicitly carry the editable setting,
    // whose normal Free, Pass, and Practice default is now three beams.
    const maximumBeams = Math.max(1, Math.floor(tuning.blasterBeams ?? 2));
    const count = clamp(Math.floor(this.player.blasterVolley || 1), 1, maximumBeams);
    const perProjectileMultiplier = count >= 3
      ? tuning.blasterVolleyThreeDamageMultiplier ?? .60
      : count === 2
        ? tuning.blasterVolleyTwoDamageMultiplier ?? .66
        : 1;
    const spread = tuning.blasterVolleySpread ?? CONFIG.blasterVolleySpread;
    const speed = tuning.blasterProjectileSpeed ?? 760;
    const baseDamage = this.player.blasterBaseDamage || this.player.damage;
    const damage = baseDamage * this.player.blasterDamageScale * perProjectileMultiplier;

    for (let index = 0; index < count; index += 1) {
      const offset = count === 1
        ? 0
        : (index - (count - 1) / 2) * spread;
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
        life: .82,
        travelled: 0,
        maxRange: tuning.blasterRange ?? CONFIG.blasterRange,
        damage,
        volleySize: count,
        volleyDamageMultiplier: perProjectileMultiplier,
        color: CONFIG.colors.crystal
      });
    }
    this.audio.play('blaster');
  }
};
