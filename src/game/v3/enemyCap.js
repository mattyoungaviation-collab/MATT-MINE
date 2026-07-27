import { CONFIG } from '../config.js';
import { spawnTuningMethods } from './spawnTuning.js';

export const enemyCapMethods = {
  generateDepth() {
    const result = spawnTuningMethods.generateDepth.call(this);
    if (this.runContext?.tuning?.usePerDepthRoomSpawns !== false) {
      const maximum = Math.max(
        0,
        Math.floor(Number(this.runContext?.tuning?.enemyMaximum ?? CONFIG.maxEnemiesBase))
      );
      this.enemies = this.enemies.slice(0, maximum);
    }
    return result;
  }
};
