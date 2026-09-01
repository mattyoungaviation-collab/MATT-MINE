import { CONFIG } from '../config.js';
import { angleTo, distance } from '../utils.js';
import { nftCarryCapacity, nftHealAmount } from '../nftTraits.js';

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
        let crystalAccepted = true;
        if (pickup.type === 'crystal') {
          const carryLimit = nftCarryCapacity(this.runContext);
          const multiplier = this.run.consumables?.heavyCrystalHaulerActive ? 5 : 1;
          if (Number(this.run.crystalsCollected || 0) + multiplier > carryLimit) {
            this.addFloater(this.player.x, this.player.y - 52, 'CRYSTAL PACK FULL', '#ffcf73');
            crystalAccepted = false;
          }
        }
        if (pickup.type === 'health') {
          const amount = nftHealAmount(this.runContext, Math.max(1, pickup.value || 30));
          this.player.health = Math.min(this.player.maxHealth, this.player.health + amount);
          this.addFloater(this.player.x, this.player.y - 52, `+${Math.round(amount)} HEALTH`, '#ff8193');
          this.audio.play('crystal');
        } else if (pickup.type === 'upgrade') {
          this.gainXp(Math.max(this.player.nextXp, 1));
          this.addFloater(this.player.x, this.player.y - 52, 'UPGRADE', '#68e6ff');
          this.audio.play('crystal');
        } else {
          this.run.rawScore += pickup.value;
        }
        if (pickup.type === 'crystal' && crystalAccepted) {
          const multiplier = this.run.consumables?.heavyCrystalHaulerActive ? 5 : 1;
          this.run.crystals += multiplier;
          this.run.crystalsCollected = Math.max(0, Number(this.run.crystalsCollected || 0)) + multiplier;
          this.hooks.onArenaEvent?.({
            type: 'crystal_collected',
            tick: Math.round(this.run.elapsed * 1_000),
            targetId: pickup.sourceObjectId || '',
            totalCarried: this.run.crystalsCollected
          });
          this.audio.play('crystal');
          this.addFloater(this.player.x, this.player.y - 52, multiplier > 1 ? 'MATT CRYSTAL ×5' : 'MATT CRYSTAL', CONFIG.colors.crystal);
        }
        pickup.collected = true;
      }
    }

    this.pickups = this.pickups.filter((pickup) => !pickup.collected);

    const goal = this.crystalGoal();
    if (this.runContext?.mode !== 'endless' && this.run.crystals >= goal && !this.run.bossReady) {
      this.run.bossReady = true;
      this.hooks.onToast?.(`${this.layout.guardianRoom.name} unlocked`);
    }

    this.updateObjective();
  }
};
