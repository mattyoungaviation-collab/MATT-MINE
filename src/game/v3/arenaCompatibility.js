import { defaultTuningPreset } from '../tuning.js';
import { balanceControlMethods } from './balanceControls.js';

export const arenaCompatibilityMethods = {
  startRun() {
    if (this.runContext?.mode !== 'arena') {
      return balanceControlMethods.startRun.call(this);
    }
    const originalTuning = this.runContext.tuning || {};
    this.runContext.tuning = {
      ...defaultTuningPreset('arena'),
      ...originalTuning,
      ignorePermanentUpgrades: true,
      usePerDepthRoomSpawns: originalTuning.usePerDepthRoomSpawns === true
    };
    try {
      return balanceControlMethods.startRun.call(this);
    } finally {
      this.runContext.tuning = originalTuning;
    }
  }
};
