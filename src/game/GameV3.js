import { MattMineGame as BaseMattMineGame } from './Game.js';
import { GameAudio } from './audio.js';
import { stateMethods } from './v3/state.js';
import { weaponsMethods } from './v3/weapons.js';
import { roomsMethods } from './v3/rooms.js';
import { enemiesMethods } from './v3/enemies.js';
import { renderMethods } from './v3/render.js';

export class MattMineGame extends BaseMattMineGame {
  constructor(canvas, profile, hooks = {}) {
    super(canvas, profile, hooks);
    this.audio = new GameAudio();
  }
}

Object.assign(
  MattMineGame.prototype,
  stateMethods,
  weaponsMethods,
  roomsMethods,
  enemiesMethods,
  renderMethods
);
