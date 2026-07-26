import { CONFIG } from '../config.js';
import { angleTo, clamp } from '../utils.js';
import { bossPhaseForHealth } from '../combat.js';

const TAU = Math.PI * 2;

export const guardianAIMethods = {
  updateGuardian(enemy, dt) {
    const phase = bossPhaseForHealth(enemy.hp, enemy.maxHp);
    if (phase !== enemy.lastBossPhase) {
      enemy.lastBossPhase = phase;
      enemy.attackTimer = 0.45;
      this.audio.play('bossPhase');
      this.camera.shake = 15;
      this.hooks.onToast?.(`GUARDIAN PHASE ${phase}`);
    }
    const prediction = phase === 1 ? 0.12 : phase === 2 ? 0.24 : CONFIG.guardianPredictionSeconds;
    const target = {
      x: clamp(
        this.player.x + this.player.vx * prediction,
        this.layout.guardianRoom.x - this.layout.guardianRoom.width / 2,
        this.layout.guardianRoom.x + this.layout.guardianRoom.width / 2
      ),
      y: clamp(
        this.player.y + this.player.vy * prediction,
        this.layout.guardianRoom.y - this.layout.guardianRoom.height / 2,
        this.layout.guardianRoom.y + this.layout.guardianRoom.height / 2
      )
    };
    const angle = angleTo(enemy, target);
    enemy.facing = angle;
    const speedScale = phase === 3 ? 1.6 : phase === 2 ? 1.05 : 0.82;
    enemy.vx += (Math.cos(angle) * enemy.speed * speedScale - enemy.vx) * Math.min(1, dt * (phase === 3 ? 7 : 4));
    enemy.vy += (Math.sin(angle) * enemy.speed * speedScale - enemy.vy) * Math.min(1, dt * (phase === 3 ? 7 : 4));

    if (phase === 1 && enemy.attackTimer <= 0) {
      enemy.attackTimer = 2.0;
      this.guardianSlam(enemy, 185, enemy.damage * 0.9);
    }
    if (phase === 2) {
      if (enemy.attackTimer <= 0) {
        enemy.attackTimer = 1.45;
        this.fireEnemyVolley(enemy, 5, 0.56, 330);
      }
      if (enemy.summonTimer <= 0) {
        enemy.summonTimer = 5.2;
        for (const type of ['bat', 'slime']) {
          this.spawnEnemy(false, this.layout.guardianRoom, type);
          this.enemies.at(-1).awake = true;
        }
        this.hooks.onToast?.('Guardian summoned reinforcements');
      }
    }
    if (phase === 3 && enemy.attackTimer <= 0) {
      enemy.attackTimer = 1.05;
      if (Math.floor(enemy.phase) % 2 === 0) this.fireEnemyVolley(enemy, 10, TAU, 390, true);
      else this.guardianSlam(enemy, 230, enemy.damage * 1.08);
    }
  }
};
