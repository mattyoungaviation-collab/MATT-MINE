import { enemySpawnMethods } from './enemySpawn.js';
import { enemyBehaviorMethods } from './enemyBehavior.js';
import { guardianMethods } from './guardian.js';

export const enemiesMethods = {
  ...enemySpawnMethods,
  ...enemyBehaviorMethods,
  ...guardianMethods
};
