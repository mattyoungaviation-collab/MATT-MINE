import { renderSceneMethods } from './renderScene.js';
import { renderEnemyMethods } from './renderEnemies.js';
import { renderPlayerMethods } from './renderPlayer.js';

export const renderMethods = {
  ...renderSceneMethods,
  ...renderEnemyMethods,
  ...renderPlayerMethods
};
