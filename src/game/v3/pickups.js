import { CONFIG } from '../config.js';
import { angleTo, distance } from '../utils.js';

export const pickupMethods = {
  updatePickups(dt) {
    for (const pickup of this.pickups) {
      pickup.vx *= 0.92;
      pickup.vy *= 0.92;
      pickup.x += pickup.vx * dt;
      pickup.y += pickup.vy * dt;

      const dist = distance(pickup, this.player);
      if (dist < this.player.magnetRange) {
        const angle = angleTo(pickup, this.player);
        const pull = 280 + (this.player.magnetRange - dist) * 5;
        pickup.x += Math.cos(angle) * pull * dt;
        pickup.y += Math.sin(angle) * pull * dt;
      }

      if (dist < pickup.radius + this.player.radius + 5) {
        this.run.rawNuggets += pickup.value;
        if (pickup.type === 'crystal') {
          this.run.crystals += 1;
          this.audio.play('crystal');
          this.addFloater(this.player.x, this.player.y - 52, 'MATT CRYSTAL', CONFIG.colors.crystal);
        }
        pickup.collected = true;
      }
    }

    this.pickups = this.pickups.filter((pickup) => !pickup.collected);

    const goal = this.crystalGoal();
    if (this.run.crystals >= goal && !this.run.bossReady) {
      this.run.bossReady = true;
      this.hooks.onToast?.(`${this.layout.guardianRoom.name} unlocked`);
    }

    this.updateObjective();
  }
};
