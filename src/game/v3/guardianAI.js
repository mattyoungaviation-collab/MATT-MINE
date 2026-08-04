import { CONFIG } from '../config.js';
import { angleTo, clamp } from '../utils.js';
import { bossPhaseForHealth } from '../combat.js';
import {
  bossPhaseConfig,
  bossPhaseForTuning,
  selectBossAttack
} from '../bossTuning.js';

const TAU = Math.PI * 2;

export const guardianAIMethods = {
  updateGuardian(enemy, dt) {
    const competitionSnapshot = this.runContext?.competitionSnapshot || this.runContext?.tuning?._competitionSnapshot;
    if (this.runContext?.mode === 'arena' && competitionSnapshot?.guardianAiMode !== 'advanced') {
      this.updateLegacyArenaGuardian(enemy, dt);
      return;
    }
    const tuning = this.runContext?.tuning || {};
    const phase = bossPhaseForTuning(enemy.hp, enemy.maxHp, tuning);
    const phaseConfig = bossPhaseConfig(tuning, phase);
    this.beginBossTelemetry?.(enemy, phase);
    if (phase !== enemy.lastBossPhase) {
      this.transitionBossTelemetry?.(enemy, phase);
      enemy.lastBossPhase = phase;
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
    enemy.vx += (Math.cos(angle) * enemy.speed * phaseConfig.movementSpeed - enemy.vx) * Math.min(1, dt * phaseConfig.chasePressure);
    enemy.vy += (Math.sin(angle) * enemy.speed * phaseConfig.movementSpeed - enemy.vy) * Math.min(1, dt * phaseConfig.chasePressure);

    const activeSummons = this.enemies.filter((entry) =>
      entry.guardianReinforcement &&
      entry.guardianOwnerId === enemy.id
    ).length;
    const attack = selectBossAttack(enemy, tuning, phase, this.run.elapsed, activeSummons);
    if (attack) {
      setGuardianAnimation(enemy, attack.id, attack.windup + attack.duration);
      this.executeGuardianAttack(enemy, phase, phaseConfig, attack, activeSummons);
    }
  },
  executeGuardianAttack(enemy, phase, phaseConfig, attack, activeSummons) {
    const damage = enemy.damage * phaseConfig.damageMultiplier * attack.damage;
    this.recordBossAttack?.(enemy, phase, attack.id);
    if (attack.id === 'slam') {
      this.guardianSlam(enemy, attack.range, damage, attack.id);
      return;
    }
    if (attack.id === 'volley' || attack.id === 'radial') {
      this.fireEnemyVolley(
        enemy,
        attack.projectileCount,
        attack.spread,
        attack.projectileSpeed,
        attack.id === 'radial',
        {
          damage,
          maxRange: attack.range,
          attackType: attack.id
        }
      );
      return;
    }
    if (attack.id !== 'summon') return;
    const count = Math.max(0, Math.min(
      attack.projectileCount,
      phaseConfig.maxSummons - activeSummons
    ));
    const types = phase >= 3 ? ['bat', 'spitter'] : ['bat', 'slime', 'spitter'];
    for (let index = 0; index < count; index += 1) {
      const reinforcement = this.spawnEnemy(false, this.layout.guardianRoom, types[index % types.length]);
      reinforcement.awake = true;
      reinforcement.guardianReinforcement = true;
      reinforcement.guardianOwnerId = enemy.id;
      reinforcement.speed *= phase >= 3 ? 1.42 : 1.35;
    }
    if (count > 0) this.hooks.onToast?.('Guardian summoned reinforcements');
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
      setGuardianAnimation(enemy, 'slam', 0.9);
      this.guardianSlam(enemy, 185, enemy.damage * 0.9);
    }
    if (phase === 2) {
      if (enemy.attackTimer <= 0) {
        enemy.attackTimer = 1.45;
        setGuardianAnimation(enemy, 'volley', 0.9);
        this.fireEnemyVolley(enemy, 5, 0.56, 330);
      }
      if (enemy.summonTimer <= 0) {
        enemy.summonTimer = 5.2;
        setGuardianAnimation(enemy, 'summon', 1.1);
        for (const type of ['bat', 'slime']) {
          const reinforcement = this.spawnEnemy(false, this.layout.guardianRoom, type);
          reinforcement.awake = true;
        }
        this.hooks.onToast?.('Guardian summoned reinforcements');
      }
    }
    if (phase === 3 && enemy.attackTimer <= 0) {
      enemy.attackTimer = 1.05;
      if (Math.floor(enemy.phase) % 2 === 0) {
        setGuardianAnimation(enemy, 'radial', 0.85);
        this.fireEnemyVolley(enemy, 10, TAU, 390, true);
      } else {
        setGuardianAnimation(enemy, 'slam', 0.85);
        this.guardianSlam(enemy, 230, enemy.damage * 1.08);
      }
    }
  }
};

function setGuardianAnimation(enemy, attack, durationSeconds) {
  const duration = Math.max(0.5, Number(durationSeconds) || 0);
  enemy.guardianAnimation = {
    attack,
    startedAt: enemy.phase,
    endsAt: enemy.phase + duration * 3
  };
}
