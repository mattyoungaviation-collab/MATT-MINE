import { CONFIG } from '../config.js';
import { spawnTuningMethods } from './spawnTuning.js';

export const enemyCapMethods = {
  generateDepth() {
    const result = spawnTuningMethods.generateDepth.call(this);
    const tuning = this.runContext?.tuning || {};
    const authoredCompetitionMap = Boolean(
      this.runContext?.competitionSnapshot || tuning._competitionSnapshot
    );
    if (!authoredCompetitionMap && tuning.usePerDepthRoomSpawns !== false) {
      const maximum = Math.max(
        0,
        Math.floor(Number(tuning.enemyMaximum ?? CONFIG.maxEnemiesBase))
      );
      this.enemies = this.enemies.slice(0, maximum);
    }
    return result;
  }
};
