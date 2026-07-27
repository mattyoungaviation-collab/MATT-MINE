import { renderSceneMethods } from './renderScene.js';
import { renderEnemyMethods } from './renderEnemies.js';
import { renderPlayerMethods } from './renderPlayer.js';
import { renderGoldTrailMethods } from './renderGoldTrail.js';

export const renderMethods = {
  ...renderSceneMethods,
  ...renderEnemyMethods,
  ...renderPlayerMethods,
  ...renderGoldTrailMethods
};
