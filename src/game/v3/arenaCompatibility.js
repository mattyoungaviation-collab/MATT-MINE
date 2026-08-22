import { defaultTuningPreset } from '../tuning.js';
import { balanceControlMethods } from './balanceControls.js';

export const arenaCompatibilityMethods = {
  startRun() {
    if (this.runContext?.mode !== 'arena') {
      return balanceControlMethods.startRun.call(this);
    }
    const suppliedTuning = this.runContext.tuning || {};
    this.runContext.tuning = {
      ...defaultTuningPreset('arena'),
      ...suppliedTuning,
      usePerDepthRoomSpawns: suppliedTuning.usePerDepthRoomSpawns === true
    };
    return balanceControlMethods.startRun.call(this);
  }
};
