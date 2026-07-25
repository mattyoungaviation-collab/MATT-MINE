import { renderFrameMethods } from './renderFrame.js';
import { renderWorldMethods } from './renderWorld.js';
import { renderProjectileMethods } from './renderProjectiles.js';

export const renderSceneMethods = {
  ...renderFrameMethods,
  ...renderWorldMethods,
  ...renderProjectileMethods
};
