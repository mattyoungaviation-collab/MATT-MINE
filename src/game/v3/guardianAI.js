import { CONFIG } from '../config.js';
import { angleTo, clamp } from '../utils.js';
import { bossPhaseForHealth } from '../combat.js';

const TAU = Math.PI * 2;

export const guardianAIMethods = {
  updateGuardian(enemy, dt) {
    if (this.runContext?.mode === 'arena') {
      this.updateLegacyArenaGuardian(enemy, dt);
      return;
    }
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
    const speedScale = phase === 3 ? 1.78 : phase === 2 ? 1.2 : 0.9;
    enemy.vx += (Math.cos(angle) * enemy.speed * speedScale - enemy.vx) * Math.min(1, dt * (phase === 3 ? 7 : 4));
    enemy.vy += (Math.sin(angle) * enemy.speed * speedScale - enemy.vy) * Math.min(1, dt * (phase === 3 ? 7 : 4));

    if (phase === 1 && enemy.attackTimer <= 0) {
      enemy.attackTimer = 1.72;
      if (Math.floor(enemy.phase) % 2 === 0) this.guardianSlam(enemy, 195, enemy.damage * 0.9);
      else this.fireEnemyVolley(enemy, 3, 0.9, 315);
    }
    if (phase === 2) {
      if (enemy.attackTimer <= 0) {
        enemy.attackTimer = 1.22;
        this.fireEnemyVolley(enemy, 5, 1.28, 345);
      }
      if (enemy.summonTimer <= 0) {
        enemy.summonTimer = this.runContext?.tuning?.bossReinforcementInterval || 3.65;
        const types = ['bat', 'slime', 'spitter'];
        const count = Math.round(this.runContext?.tuning?.bossReinforcementCount ?? 3);
        for (let index = 0; index < count; index += 1) {
          const type = types[index % types.length];
          const reinforcement = this.spawnEnemy(false, this.layout.guardianRoom, type);
          reinforcement.awake = true;
          reinforcement.guardianReinforcement = true;
          reinforcement.speed *= 1.35;
        }
        this.hooks.onToast?.('Guardian summoned reinforcements');
      }
    }
    if (phase === 3) {
      if (enemy.attackTimer <= 0) {
        enemy.attackTimer = 0.9;
        const pattern = Math.floor(enemy.phase) % 3;
        if (pattern === 0) this.fireEnemyVolley(enemy, 12, TAU, 405, true);
        else if (pattern === 1) this.fireEnemyVolley(enemy, 7, 1.8, 390);
        else this.guardianSlam(enemy, 235, enemy.damage * 1.08);
      }
      const activeReinforcements = this.enemies.filter((entry) => entry.guardianReinforcement).length;
      if (enemy.summonTimer <= 0 && activeReinforcements < 5) {
        enemy.summonTimer = this.runContext?.tuning?.bossReinforcementInterval || 2.8;
        const types = ['bat', 'spitter'];
        const count = Math.round(this.runContext?.tuning?.bossReinforcementCount ?? 2);
        for (let index = 0; index < count; index += 1) {
          const type = types[index % types.length];
          const reinforcement = this.spawnEnemy(false, this.layout.guardianRoom, type);
          reinforcement.awake = true;
          reinforcement.guardianReinforcement = true;
          reinforcement.speed *= 1.42;
        }
      }
    }
  },
  updateLegacyArenaGuardian(enemy, dt) {
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
      enemy.attackTimer = 2;
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
          const reinforcement = this.spawnEnemy(false, this.layout.guardianRoom, type);
          reinforcement.awake = true;
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
