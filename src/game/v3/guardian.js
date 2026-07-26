import { guardianAIMethods } from './guardianAI.js';
import { guardianAttackMethods } from './guardianAttacks.js';

export const guardianMethods = {
  ...guardianAIMethods,
  ...guardianAttackMethods
};
