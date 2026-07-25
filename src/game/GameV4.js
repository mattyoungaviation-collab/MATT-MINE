import { MattMineGame as V3MattMineGame } from './GameV3.js';
import { seededRandom } from './utils.js';

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
    super.startRun();
  }

  generateDepth() {
    const seed = `${this.runContext?.seed || 'MATT-RANDOM'}:DEPTH:${this.run?.depth || 1}`;
    const previousRandom = Math.random;
    Math.random = seededRandom(seed);
    try {
      return super.generateDepth();
    } finally {
      Math.random = previousRandom;
    }
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

  endRun(extracted) {
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
