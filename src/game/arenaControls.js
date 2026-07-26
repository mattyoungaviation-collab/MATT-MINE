import { clamp } from './utils.js';

export const ARENA_FIXED_STEP_MS = 20;
export const ARENA_WEAPONS = Object.freeze(['', 'pickaxe', 'dynamite', 'blaster']);

export function captureArenaControlState(input, game) {
  const movement = input?.movement?.() || { x: 0, y: 0 };
  const pointer = input?.pointer;
  let aim = null;
  if (pointer?.active && !input?.mobileAttack && game?.player) {
    const worldX = Number(pointer.x || 0) + Number(game.camera?.x || 0);
    const worldY = Number(pointer.y || 0) + Number(game.camera?.y || 0);
    aim = Math.atan2(worldY - game.player.y, worldX - game.player.x);
  }
  return normalizeArenaControlState({
    moveX: movement.x,
    moveY: movement.y,
    aim,
    attack: input?.attacking?.() === true,
    dash: input?.consumeDash?.() === true,
    weapon: input?.consumeWeaponSelection?.() || ''
  });
}

export function normalizeArenaControlState(input = {}) {
  let moveX = finite(input.moveX);
  let moveY = finite(input.moveY);
  const length = Math.hypot(moveX, moveY);
  if (length > 1) {
    moveX /= length;
    moveY /= length;
  }
  const rawAim = input.aim === null || input.aim === undefined ? null : finite(input.aim);
  const aim = rawAim === null
    ? null
    : quantize(clamp(normalizeAngle(rawAim), -Math.PI, Math.PI), 10_000);
  const weapon = ARENA_WEAPONS.includes(String(input.weapon || ''))
    ? String(input.weapon || '')
    : '';
  return {
    moveX: quantize(clamp(moveX, -1, 1), 1_000),
    moveY: quantize(clamp(moveY, -1, 1), 1_000),
    aim,
    attack: input.attack === true,
    dash: input.dash === true,
    weapon
  };
}

export function encodeArenaControlState(input) {
  const state = normalizeArenaControlState(input);
  return {
    moveX: Math.round(state.moveX * 1_000),
    moveY: Math.round(state.moveY * 1_000),
    aim: state.aim === null ? null : Math.round(state.aim * 10_000),
    attack: state.attack,
    dash: state.dash,
    weapon: state.weapon
  };
}

export function decodeArenaControlState(input = {}) {
  return normalizeArenaControlState({
    moveX: Number(input.moveX) / 1_000,
    moveY: Number(input.moveY) / 1_000,
    aim: input.aim === null ? null : Number(input.aim) / 10_000,
    attack: input.attack === true,
    dash: input.dash === true,
    weapon: input.weapon
  });
}

export class ArenaControlInput {
  constructor(state = {}) {
    this.state = normalizeArenaControlState(state);
    this.dashConsumed = false;
    this.weaponConsumed = false;
    this.pointer = { active: false, down: false, x: 0, y: 0 };
    this.mobileAttack = false;
  }

  movement() {
    return { x: this.state.moveX, y: this.state.moveY };
  }

  attacking() {
    return this.state.attack;
  }

  consumeDash() {
    if (this.dashConsumed) return false;
    this.dashConsumed = true;
    return this.state.dash;
  }

  consumeWeaponSelection() {
    if (this.weaponConsumed) return null;
    this.weaponConsumed = true;
    return this.state.weapon || null;
  }

  arenaAimAngle() {
    return this.state.aim;
  }
}

export function arenaControlStateEquals(left, right) {
  if (!left || !right) return false;
  return left.moveX === right.moveX &&
    left.moveY === right.moveY &&
    left.aim === right.aim &&
    left.attack === right.attack &&
    left.dash === right.dash &&
    left.weapon === right.weapon;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function quantize(value, scale) {
  return Math.round(value * scale) / scale;
}

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
