import { MattMineGame as V3MattMineGame } from './GameV3.js';
import {
  ARENA_FIXED_STEP_MS,
  ArenaControlInput,
  captureArenaControlState,
  encodeArenaControlState,
  normalizeArenaControlState
} from './arenaControls.js';
import { seededRandom, withRandomSource } from './utils.js';
import { endlessScale } from './expansionConfig.js';

const DETERMINISTIC_SERVER_MODES = new Set(['arena', 'free', 'paid', 'weekly', 'endless']);

/**
 * v0.4 adds deterministic ranked-run seeds and economy metadata while
 * preserving the v0.3 combat engine. Entitlements are consumed outside the
 * game by the economy adapter before startRun is called.
 */
export class MattMineGame extends V3MattMineGame {
  startRun(context = {}) {
    const competitionSnapshot = context.competitionSnapshot && typeof context.competitionSnapshot === 'object'
      ? structuredClone(context.competitionSnapshot)
      : context.tuning?._competitionSnapshot && typeof context.tuning._competitionSnapshot === 'object'
        ? structuredClone(context.tuning._competitionSnapshot)
        : null;
    const startingDepth = context.mode === 'practice' && competitionSnapshot?.status === 'test'
      ? Math.max(1, Math.min(5, Math.floor(Number(context.startingDepth) || 1)))
      : 1;
    this.runContext = {
      mode: context.mode || 'practice',
      seed: context.seed || `MATT-PRACTICE-${Date.now()}`,
      day: context.day || '',
      week: context.week || '',
      rewardWeight: Number(context.rewardWeight || 0),
      characterId: context.characterId || 'matt',
      character: context.character && typeof context.character === 'object' ? { ...context.character } : {},
      weeklyStage: context.weeklyStage && typeof context.weeklyStage === 'object' ? { ...context.weeklyStage } : null,
      endlessSnapshot: context.endlessSnapshot && typeof context.endlessSnapshot === 'object' ? { ...context.endlessSnapshot } : null,
      competitionSnapshot,
      startingDepth,
      roundDurationMs: context.mode === 'arena'
        ? normalizeRoundDuration(context.roundDurationMs)
        : 0,
      allowPaidRevive: context.allowPaidRevive === true,
      reviveLimitPerRun: context.allowPaidRevive === true
        ? Math.max(
            1,
            Math.min(
              3,
              Math.floor(Number(
                context.reviveLimitPerRun ?? context.tuning?._paidRevive?.limitPerRun ?? 1
              ) || 1)
            )
          )
        : 0,
      reviveInvulnerabilitySeconds: Math.max(0, Number(context.reviveInvulnerabilitySeconds || 3)),
      tuning: context.tuning && typeof context.tuning === 'object' ? { ...context.tuning } : {}
    };
    this.baseRunTuning = structuredClone(this.runContext.tuning);
    this.arenaAccumulator = 0;
    this.arenaFinishRecorded = false;
    this.paidReviveCount = 0;
    this.arenaRandom = DETERMINISTIC_SERVER_MODES.has(this.runContext.mode)
      ? seededRandom(
          this.runContext.mode === 'arena'
            ? `${this.runContext.seed}:MATT-ARENA-RUNTIME-V2`
            : `${this.runContext.seed}:MATT-SERVER-RUNTIME-V3`
        )
      : null;
    super.startRun();
  }

  generateDepth() {
    if (this.runContext?.mode === 'endless' && this.runContext.endlessSnapshot) {
      const depth = this.run?.depth || 1;
      const snapshot = this.runContext.endlessSnapshot;
      const scale = endlessScale(depth, {
        endlessHealthGrowth: snapshot.healthGrowth,
        endlessDamageGrowth: snapshot.damageGrowth,
        endlessSpeedGrowth: snapshot.speedGrowth,
        endlessMultiplierGrowth: snapshot.multiplierGrowth,
        endlessMaximumScale: snapshot.maximumScale
      });
      const rules = {
        ...scale,
        bossCount: depth % snapshot.bossFrequency === 0
          ? Math.min(10, snapshot.bossCount + Math.floor(depth / 10))
          : 0,
        roomCount: Math.min(30, snapshot.roomCount + Math.floor((depth - 1) / 3))
      };
      const tuning = structuredClone(this.baseRunTuning || this.runContext.tuning || {});
      tuning.roomsPerDepth = rules.roomCount;
      tuning.enemyHealthMultiplier = (tuning.enemyHealthMultiplier || 1) * rules.health;
      tuning.enemyDamageMultiplier = (tuning.enemyDamageMultiplier || 1) * rules.damage;
      tuning.enemySpeedMultiplier = (tuning.enemySpeedMultiplier || 1) * rules.speed;
      for (let depth = 1; depth <= 5; depth += 1) {
        tuning[`depth${depth}GuardianBosses`] = rules.bossCount;
      }
      this.runContext.tuning = tuning;
      this.run.endlessRules = rules;
    }
    const seed = `${this.runContext?.seed || 'MATT-RANDOM'}:DEPTH:${this.run?.depth || 1}`;
    const source = DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)
      ? this.arenaRandom
      : seededRandom(seed);
    return withRandomSource(source, () => super.generateDepth());
  }

  update(dt) {
    if (!DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)) return super.update(dt);
    if (this.state !== 'playing' || this.pendingUpgradeIds?.length) {
      // Ranked replays advance only while the mine is actively playing.
      // Banking browser-frame time behind an upgrade, depth choice, pause, or
      // revive screen causes a large catch-up burst and desynchronizes the
      // signed client transcript from the server replay.
      this.arenaAccumulator = 0;
      return;
    }
    this.arenaAccumulator += Math.max(0, Math.min(Number(dt) || 0, 0.25));
    const stepSeconds = ARENA_FIXED_STEP_MS / 1_000;
    while (this.arenaAccumulator + Number.EPSILON >= stepSeconds) {
      const control = captureArenaControlState(this.input, this);
      this.applyArenaControlStep(control, true);
      this.arenaAccumulator -= stepSeconds;
      if (this.state !== 'playing') {
        this.arenaAccumulator = 0;
        break;
      }
    }
  }

  applyArenaControlStep(control, record = false) {
    if (!DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) || this.state !== 'playing') return false;
    const normalized = normalizeArenaControlState(control);
    const tick = Math.round((this.run?.elapsed || 0) * 1_000);
    if (record) {
      this.hooks.onArenaInput?.({
        type: 'input',
        tick,
        ...encodeArenaControlState(normalized)
      });
    }
    const originalInput = this.input;
    this.input = new ArenaControlInput(normalized);
    try {
      withRandomSource(this.arenaRandom, () => super.update(ARENA_FIXED_STEP_MS / 1_000));
    } finally {
      this.input = originalInput;
    }
    if (
      record &&
      this.runContext?.mode === 'arena' &&
      this.runContext.roundDurationMs > 0 &&
      Math.round((this.run?.elapsed || 0) * 1_000) >= this.runContext.roundDurationMs &&
      !['ended', 'menu'].includes(this.state)
    ) {
      this.endArenaTimeLimit();
    }
    return true;
  }

  advanceArenaToTick(targetTick, control) {
    if (!Number.isSafeInteger(targetTick) || targetTick < 0 || targetTick % ARENA_FIXED_STEP_MS !== 0) {
      return false;
    }
    while (
      Math.round((this.run?.elapsed || 0) * 1_000) < targetTick &&
      this.state === 'playing'
    ) {
      this.applyArenaControlStep(control, false);
    }
    return Math.round((this.run?.elapsed || 0) * 1_000) === targetTick;
  }

  updateAim() {
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode)) {
      const angle = this.input?.arenaAimAngle?.(this);
      if (Number.isFinite(angle)) {
        this.player.angle = angle;
        return;
      }
    }
    const controllerAim = this.input?.aimVector?.();
    if (controllerAim && Math.hypot(controllerAim.x, controllerAim.y) > .05) {
      this.player.angle = Math.atan2(controllerAim.y, controllerAim.x);
      return;
    }
    return super.updateAim();
  }

  updateHud() {
    const original = this.hooks.onHud;
    const roundDurationMs = this.runContext?.mode === 'arena'
      ? this.runContext.roundDurationMs || 0
      : 0;
    const roundElapsedMs = Math.round((this.run?.elapsed || 0) * 1_000);
    this.hooks.onHud = (stats) => original?.({
      ...stats,
      runMode: this.runContext?.mode || 'practice',
      rewardWeight: this.runContext?.rewardWeight || 0,
      roundDurationMs,
      roundRemainingMs: Math.max(0, roundDurationMs - roundElapsedMs)
    });
    try {
      return super.updateHud();
    } finally {
      this.hooks.onHud = original;
    }
  }

  chooseRunUpgrade(id) {
    const deterministic = DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode);
    if (
      deterministic &&
      this.state === 'levelup' &&
      this.pendingUpgradeIds?.includes(id)
    ) {
      this.recordArenaCommand('upgrade', id);
    }
    return deterministic
      ? withRandomSource(this.arenaRandom, () => super.chooseRunUpgrade(id))
      : super.chooseRunUpgrade(id);
  }

  descend() {
    if (
      DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) &&
      this.runContext?.mode !== 'endless' &&
      this.state === 'depthchoice'
    ) {
      const publishedDepths = this.runContext?.competitionSnapshot?.depths?.length;
      const maximumDepth = Number.isSafeInteger(publishedDepths)
        ? Math.max(1, Math.min(5, publishedDepths))
        : 5;
      if ((this.run?.depth || 0) >= maximumDepth) return this.extract();
      this.recordArenaCommand('descend');
    }
    if (this.runContext?.mode === 'endless' && this.state === 'depthchoice') {
      this.recordArenaCommand('descend');
      this.run.depth += 1;
      this.state = 'playing';
      this.generateDepth();
      this.hooks.onDepthStarted?.(this.run.depth);
      this.hooks.onToast?.(`Endless Depth ${this.run.depth}: x${this.depthMultiplier().toFixed(2)}`);
      return;
    }
    return super.descend();
  }

  depthMultiplier(depth = this.run?.depth || 1) {
    if (this.runContext?.mode === 'endless') {
      const growth = Number(this.runContext.endlessSnapshot?.multiplierGrowth || .25);
      return 1 + Math.max(0, depth - 1) * growth;
    }
    return super.depthMultiplier(depth);
  }

  extract() {
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) && this.state === 'depthchoice') {
      this.recordArenaCommand('extract');
    }
    return super.extract();
  }

  recordArenaCommand(command, value = '') {
    this.hooks.onArenaInput?.({
      type: 'command',
      tick: Math.round((this.run?.elapsed || 0) * 1_000),
      command,
      ...(value ? { value } : {})
    });
  }

  endArenaTimeLimit(options = {}) {
    const roundDurationMs = normalizeRoundDuration(
      options.roundDurationMs ?? this.runContext?.roundDurationMs
    );
    const elapsedMs = Math.round((this.run?.elapsed || 0) * 1_000);
    if (
      this.runContext?.mode !== 'arena' ||
      !this.run ||
      !roundDurationMs ||
      elapsedMs !== roundDurationMs ||
      ['ended', 'menu'].includes(this.state)
    ) {
      return false;
    }
    if (options.record !== false) this.recordArenaCommand('time_limit');
    this.run.timeLimitReached = true;
    this.endRun(true);
    return this.state === 'ended';
  }

  applyPaidRevive(options = {}) {
    if (
      this.state !== 'awaitingrevive' ||
      !this.player ||
      this.paidReviveCount >= this.runContext.reviveLimitPerRun
    ) return false;
    if (options.record !== false) this.recordArenaCommand('revive');
    this.paidReviveCount += 1;
    this.player.health = this.player.maxHealth;
    this.player.invulnerable = this.runContext.reviveInvulnerabilitySeconds;
    this.player.vx = 0;
    this.player.vy = 0;
    const safeRoom = this.layout?.startRoom;
    if (safeRoom) {
      this.player.x = safeRoom.x;
      this.player.y = safeRoom.y;
    }
    this.state = 'playing';
    this.audio.startMusic?.();
    this.hooks.onPaidReviveApplied?.({
      health: this.player.health,
      maximumHealth: this.player.maxHealth,
      invulnerabilitySeconds: this.runContext.reviveInvulnerabilitySeconds
    });
    return true;
  }

  declinePaidRevive(options = {}) {
    if (this.state !== 'awaitingrevive') return false;
    if (options.record !== false) this.recordArenaCommand('decline');
    this.runContext.allowPaidRevive = false;
    return this.endRun(false);
  }

  endRun(extracted) {
    if (
      extracted === false &&
      this.runContext?.allowPaidRevive &&
      this.paidReviveCount < this.runContext.reviveLimitPerRun &&
      this.state !== 'awaitingrevive'
    ) {
      this.player.health = 0;
      this.state = 'awaitingrevive';
      this.camera.shake = 0;
      this.audio.stopBoss?.();
      this.audio.stopMusic?.();
      this.recordArenaCommand('death');
      this.hooks.onPaidReviveOffered?.({
        projected: this.projectedPayout(),
        depth: this.run.depth,
        kills: this.run.kills,
        oreBroken: this.run.oreBroken,
        elapsed: this.run.elapsed,
        maximumHealth: this.player.maxHealth
      });
      return;
    }
    if (DETERMINISTIC_SERVER_MODES.has(this.runContext?.mode) && !this.arenaFinishRecorded) {
      this.arenaFinishRecorded = true;
      this.hooks.onArenaInput?.({
        type: 'finish',
        tick: Math.round((this.run?.elapsed || 0) * 1_000)
      });
    }
    const original = this.hooks.onRunEnd;
    this.hooks.onRunEnd = (result) => original?.({
      ...result,
      mode: this.runContext?.mode || 'practice',
      seed: this.runContext?.seed || '',
      day: this.runContext?.day || '',
      week: this.runContext?.week || '',
      rewardWeight: this.runContext?.rewardWeight || 0,
      timeLimitReached: this.run?.timeLimitReached === true
    });
    try {
      return super.endRun(extracted);
    } finally {
      this.hooks.onRunEnd = original;
    }
  }
}

function normalizeRoundDuration(value) {
  const duration = Number(value);
  return Number.isSafeInteger(duration) &&
    duration > 0 &&
    duration % ARENA_FIXED_STEP_MS === 0
    ? duration
    : 0;
}
