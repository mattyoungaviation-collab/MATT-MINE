import { MattMineGame as V3MattMineGame } from './GameV3.js';
import {
  ARENA_FIXED_STEP_MS,
  ArenaControlInput,
  captureArenaControlState,
  encodeArenaControlState,
  normalizeArenaControlState
} from './arenaControls.js';
import { seededRandom, withRandomSource } from './utils.js';

/**
 * v0.4 adds deterministic ranked-run seeds and economy metadata while
 * preserving the v0.3 combat engine. Entitlements are consumed outside the
 * game by the economy adapter before startRun is called.
 */
export class MattMineGame extends V3MattMineGame {
  startRun(context = {}) {
    this.runContext = {
      mode: context.mode || 'practice',
      seed: context.seed || `MATT-PRACTICE-${Date.now()}`,
      day: context.day || '',
      week: context.week || '',
      rewardWeight: Number(context.rewardWeight || 0)
    };
    this.arenaAccumulator = 0;
    this.arenaFinishRecorded = false;
    this.arenaRandom = this.runContext.mode === 'arena'
      ? seededRandom(`${this.runContext.seed}:MATT-ARENA-RUNTIME-V2`)
      : null;
    super.startRun();
  }

  generateDepth() {
    const seed = `${this.runContext?.seed || 'MATT-RANDOM'}:DEPTH:${this.run?.depth || 1}`;
    const source = this.runContext?.mode === 'arena'
      ? this.arenaRandom
      : seededRandom(seed);
    return withRandomSource(source, () => super.generateDepth());
  }

  update(dt) {
    if (this.runContext?.mode !== 'arena') return super.update(dt);
    this.arenaAccumulator += Math.max(0, Math.min(Number(dt) || 0, 0.25));
    const stepSeconds = ARENA_FIXED_STEP_MS / 1_000;
    while (this.arenaAccumulator + Number.EPSILON >= stepSeconds && this.state === 'playing') {
      const control = captureArenaControlState(this.input, this);
      this.applyArenaControlStep(control, true);
      this.arenaAccumulator -= stepSeconds;
    }
  }

  applyArenaControlStep(control, record = false) {
    if (this.runContext?.mode !== 'arena' || this.state !== 'playing') return false;
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
    if (this.runContext?.mode === 'arena') {
      const angle = this.input?.arenaAimAngle?.(this);
      if (Number.isFinite(angle)) {
        this.player.angle = angle;
        return;
      }
    }
    return super.updateAim();
  }

  updateHud() {
    const original = this.hooks.onHud;
    this.hooks.onHud = (stats) => original?.({
      ...stats,
      runMode: this.runContext?.mode || 'practice',
      rewardWeight: this.runContext?.rewardWeight || 0
    });
    try {
      return super.updateHud();
    } finally {
      this.hooks.onHud = original;
    }
  }

  chooseRunUpgrade(id) {
    if (
      this.runContext?.mode === 'arena' &&
      this.state === 'levelup' &&
      this.pendingUpgradeIds?.includes(id)
    ) {
      this.recordArenaCommand('upgrade', id);
    }
    return super.chooseRunUpgrade(id);
  }

  descend() {
    if (this.runContext?.mode === 'arena' && this.state === 'depthchoice') {
      if ((this.run?.depth || 0) >= 5) return this.extract();
      this.recordArenaCommand('descend');
    }
    return super.descend();
  }

  extract() {
    if (this.runContext?.mode === 'arena' && this.state === 'depthchoice') {
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

  endRun(extracted) {
    if (this.runContext?.mode === 'arena' && !this.arenaFinishRecorded) {
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
      rewardWeight: this.runContext?.rewardWeight || 0
    });
    try {
      return super.endRun(extracted);
    } finally {
      this.hooks.onRunEnd = original;
    }
  }
}
