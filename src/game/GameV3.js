import { MattMineGame as BaseMattMineGame } from './Game.js';
import { GameAudio } from './audio.js';
import { stateMethods } from './v3/state.js';
import { goldTrailMethods } from './v3/goldTrail.js';
import { pickupMethods } from './v3/pickups.js';
import { weaponsMethods } from './v3/weapons.js';
import { roomsMethods } from './v3/rooms.js';
import { enemiesMethods } from './v3/enemies.js';
import { balanceControlMethods } from './v3/balanceControls.js';
import { blasterBalanceMethods } from './v3/blasterBalance.js';
import { spawnTuningMethods } from './v3/spawnTuning.js';
import { enemyCapMethods } from './v3/enemyCap.js';
import { arenaCompatibilityMethods } from './v3/arenaCompatibility.js';
import { renderMethods } from './v3/render.js';
import { loadVisualAssets } from './v3/visualAssets.js';

export class MattMineGame extends BaseMattMineGame {
  constructor(canvas, profile, hooks = {}) {
    super(canvas, profile, hooks);
    this.audio = hooks.audio || new GameAudio();
    this.visualAssets = this.headless ? {} : loadVisualAssets();
  }
}

Object.assign(
  MattMineGame.prototype,
  stateMethods,
  goldTrailMethods,
  pickupMethods,
  weaponsMethods,
  roomsMethods,
  enemiesMethods,
  balanceControlMethods,
  blasterBalanceMethods,
  spawnTuningMethods,
  enemyCapMethods,
  arenaCompatibilityMethods,
  renderMethods
);
