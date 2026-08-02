import { clamp } from './utils.js';
import { defaultKeybindings, normalizeKeybindings } from './keybindings.js';
import { defaultControllerProfile, normalizeControllerProfile } from './expansionConfig.js';

export class InputController {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.pointer = { x: 0, y: 0, down: false, active: false, updatedAt: 0 };
    this.mobileMove = { x: 0, y: 0 };
    this.mobileAttack = false;
    this.mobileDashQueued = false;
    this.mobileWeaponQueued = null;
    this.joystickPointerId = null;
    this.mobileAttackPointerId = null;
    this.mobileKnob = null;
    this.keybindings = defaultKeybindings();
    this.controllerProfile = defaultControllerProfile();
    this.gamepad = {
      connected: false,
      index: 0,
      previous: [],
      current: [],
      movement: { x: 0, y: 0 },
      aim: { x: 0, y: 0 },
      lastDirection: { x: 1, y: 0 },
      updatedAt: 0
    };
    this.gamepadPolledThisTask = false;
    this.bindKeyboard();
    this.bindPointer();
    this.bindMobile();
    this.bindGamepad();
  }

  bindGamepad() {
    window.addEventListener('gamepadconnected', (event) => {
      if (this.gamepad.connected && event.gamepad.index !== this.controllerProfile.activeIndex) return;
      this.gamepad.connected = true;
      this.gamepad.index = event.gamepad.index;
      window.dispatchEvent(new CustomEvent('mattmine:controller', {
        detail: { connected: true, index: event.gamepad.index }
      }));
    });
    window.addEventListener('gamepaddisconnected', (event) => {
      if (event.gamepad.index !== this.gamepad.index) return;
      this.gamepad.connected = false;
      this.gamepad.current = [];
      this.gamepad.previous = [];
      window.dispatchEvent(new CustomEvent('mattmine:controller', {
        detail: { connected: false, index: event.gamepad.index, pauseRequested: true }
      }));
    });
  }

  pollGamepad() {
    if (this.gamepadPolledThisTask) return;
    this.gamepadPolledThisTask = true;
    queueMicrotask(() => {
      this.gamepadPolledThisTask = false;
    });
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
    const pads = navigator.getGamepads();
    const preferred = pads?.[this.controllerProfile.activeIndex];
    const pad = preferred?.connected ? preferred : [...(pads || [])].find((entry) => entry?.connected);
    if (!pad) {
      this.gamepad.connected = false;
      return;
    }
    this.gamepad.connected = true;
    this.gamepad.index = pad.index;
    this.gamepad.previous = this.gamepad.current;
    this.gamepad.current = pad.buttons.map((button) => button.pressed || button.value >= .55);
    const stickMovement = deadZoneVector(pad.axes[0] || 0, pad.axes[1] || 0, this.controllerProfile.deadZone);
    const dpadMovement = {
      x: (this.gamepad.current[15] ? 1 : 0) - (this.gamepad.current[14] ? 1 : 0),
      y: (this.gamepad.current[13] ? 1 : 0) - (this.gamepad.current[12] ? 1 : 0)
    };
    this.gamepad.movement = Math.hypot(dpadMovement.x, dpadMovement.y) > 0
      ? normalizeVector(dpadMovement.x, dpadMovement.y)
      : stickMovement;
    const aim = deadZoneVector(pad.axes[2] || 0, pad.axes[3] || 0, this.controllerProfile.deadZone);
    this.gamepad.aim = {
      x: aim.x * this.controllerProfile.aimSensitivity,
      y: aim.y * this.controllerProfile.aimSensitivity
    };
    const explicitAim = Math.hypot(this.gamepad.aim.x, this.gamepad.aim.y) > .05;
    const explicitMove = Math.hypot(this.gamepad.movement.x, this.gamepad.movement.y) > .05;
    if (explicitAim) this.gamepad.lastDirection = normalizeVector(this.gamepad.aim.x, this.gamepad.aim.y);
    else if (explicitMove) this.gamepad.lastDirection = normalizeVector(this.gamepad.movement.x, this.gamepad.movement.y);
    if (explicitAim || explicitMove || this.gamepad.current.some(Boolean)) this.gamepad.updatedAt = inputTimestamp();
  }

  controllerHeld(action) {
    return this.gamepad.current[this.controllerProfile.mapping[action]] === true;
  }

  consumeController(action) {
    const button = this.controllerProfile.mapping[action];
    return this.gamepad.current[button] === true && this.gamepad.previous[button] !== true;
  }

  bindKeyboard() {
    window.addEventListener('keydown', (event) => {
      if (!this.keys.has(event.code)) this.pressed.add(event.code);
      this.keys.add(event.code);
      if (['Space', 'ShiftLeft', 'ShiftRight', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) {
        event.preventDefault();
      }
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pressed.clear();
      this.pointer.down = false;
      this.resetMobileInput();
    });
  }

  bindPointer() {
    const updatePointer = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const logicalWidth = Number(this.canvas.dataset.logicalWidth || 1280);
      const logicalHeight = Number(this.canvas.dataset.logicalHeight || 720);
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * logicalWidth;
      this.pointer.y = ((event.clientY - rect.top) / rect.height) * logicalHeight;
      this.pointer.active = true;
      this.pointer.updatedAt = inputTimestamp();
    };
    this.canvas.addEventListener('pointermove', updatePointer);
    this.canvas.addEventListener('pointerdown', (event) => {
      updatePointer(event);
      this.pointer.down = true;
    });
    window.addEventListener('pointerup', () => (this.pointer.down = false));
    this.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  bindMobile() {
    const joystick = document.querySelector('#joystick');
    const knob = document.querySelector('#joystick-knob');
    const attack = document.querySelector('#attack-button');
    const dash = document.querySelector('#dash-button');
    if (!joystick || !knob || !attack) return;
    this.mobileKnob = knob;

    const updateJoystick = (event) => {
      if (event.pointerId !== this.joystickPointerId) return;
      const rect = joystick.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = event.clientX - centerX;
      const dy = event.clientY - centerY;
      const length = Math.hypot(dx, dy) || 1;
      const max = rect.width * 0.32;
      const scale = Math.min(1, max / length);
      const px = dx * scale;
      const py = dy * scale;
      knob.style.transform = `translate(${px}px, ${py}px)`;
      this.mobileMove.x = clamp(dx / max, -1, 1);
      this.mobileMove.y = clamp(dy / max, -1, 1);
    };

    joystick.addEventListener('pointerdown', (event) => {
      if (this.joystickPointerId !== null) return;
      this.joystickPointerId = event.pointerId;
      joystick.setPointerCapture?.(event.pointerId);
      updateJoystick(event);
      event.preventDefault();
    });
    joystick.addEventListener('pointermove', (event) => {
      updateJoystick(event);
      event.preventDefault();
    });
    const endJoystick = (event) => {
      if (event.pointerId !== this.joystickPointerId) return;
      if (event.type !== 'lostpointercapture') {
        joystick.releasePointerCapture?.(event.pointerId);
      }
      this.joystickPointerId = null;
      this.mobileMove.x = 0;
      this.mobileMove.y = 0;
      knob.style.transform = 'translate(0, 0)';
    };
    joystick.addEventListener('pointerup', endJoystick);
    joystick.addEventListener('pointercancel', endJoystick);
    joystick.addEventListener('lostpointercapture', endJoystick);

    attack.addEventListener('pointerdown', (event) => {
      if (this.mobileAttackPointerId !== null) return;
      this.mobileAttackPointerId = event.pointerId;
      attack.setPointerCapture?.(event.pointerId);
      this.mobileAttack = true;
      event.preventDefault();
    });
    const endAttack = (event) => {
      if (event.pointerId !== this.mobileAttackPointerId) return;
      if (event.type !== 'lostpointercapture') {
        attack.releasePointerCapture?.(event.pointerId);
      }
      this.mobileAttackPointerId = null;
      this.mobileAttack = false;
      event.preventDefault();
    };
    attack.addEventListener('pointerup', endAttack);
    attack.addEventListener('pointercancel', endAttack);
    attack.addEventListener('lostpointercapture', endAttack);

    for (const button of document.querySelectorAll('.weapon-button')) {
      button.addEventListener('pointerdown', (event) => {
        if (button.classList.contains('locked')) return;
        this.mobileWeaponQueued = button.dataset.weapon || null;
        event.preventDefault();
      });
    }

    if (dash) {
      dash.addEventListener('pointerdown', (event) => {
        this.mobileDashQueued = true;
        event.preventDefault();
      });
    }
  }

  movement() {
    this.pollGamepad();
    let x = 0;
    let y = 0;
    if (this.keys.has(this.keybindings.moveLeft)) x -= 1;
    if (this.keys.has(this.keybindings.moveRight)) x += 1;
    if (this.keys.has(this.keybindings.moveUp)) y -= 1;
    if (this.keys.has(this.keybindings.moveDown)) y += 1;
    x += this.mobileMove.x;
    y += this.mobileMove.y;
    x += this.gamepad.movement.x;
    y += this.gamepad.movement.y;
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  attacking() {
    return this.pointer.down || this.mobileAttack || this.keys.has(this.keybindings.attack) || this.controllerHeld('attack');
  }

  reset() {
    this.keys.clear();
    this.pressed.clear();
    this.pointer.down = false;
    this.resetMobileInput();
    this.gamepad.previous = [];
    this.gamepad.current = [];
  }

  resetMobileInput() {
    this.mobileMove.x = 0;
    this.mobileMove.y = 0;
    this.mobileAttack = false;
    this.mobileDashQueued = false;
    this.mobileWeaponQueued = null;
    this.joystickPointerId = null;
    this.mobileAttackPointerId = null;
    if (this.mobileKnob?.style) this.mobileKnob.style.transform = 'translate(0, 0)';
  }

  consumeWeaponSelection() {
    this.pollGamepad();
    let selected = this.mobileWeaponQueued;
    this.mobileWeaponQueued = null;
    const bindings = [
      [this.keybindings.pickaxe, 'pickaxe'],
      [this.keybindings.dynamite, 'dynamite'],
      [this.keybindings.blaster, 'blaster']
    ];
    for (const [code, weapon] of bindings) {
      if (!this.pressed.has(code)) continue;
      selected = weapon;
      this.pressed.delete(code);
    }
    if (this.consumeController('pickaxe')) selected = 'pickaxe';
    else if (this.consumeController('dynamite')) selected = 'dynamite';
    else if (this.consumeController('blaster')) selected = 'blaster';
    return selected;
  }

  consumeDash() {
    this.pollGamepad();
    const keyboardDash = this.pressed.has(this.keybindings.dash);
    this.pressed.delete(this.keybindings.dash);
    const result = keyboardDash || this.mobileDashQueued || this.consumeController('dash');
    this.mobileDashQueued = false;
    return result;
  }

  setKeybindings(bindings) {
    this.keybindings = normalizeKeybindings(bindings);
    return { ...this.keybindings };
  }

  setControllerProfile(profile) {
    this.controllerProfile = normalizeControllerProfile(profile);
    return structuredClone(this.controllerProfile);
  }

  aimVector() {
    this.pollGamepad();
    if (!this.gamepad.connected || this.gamepad.updatedAt < this.pointer.updatedAt) return { x: 0, y: 0 };
    if (Math.hypot(this.gamepad.aim.x, this.gamepad.aim.y) > .05) return { ...this.gamepad.aim };
    return { ...this.gamepad.lastDirection };
  }
}

export function deadZoneVector(x, y, deadZone = .18) {
  const length = Math.hypot(x, y);
  if (length <= deadZone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (length - deadZone) / Math.max(.001, 1 - deadZone));
  return { x: (x / length) * scaled, y: (y / length) * scaled };
}

function normalizeVector(x, y) {
  const length = Math.hypot(x, y) || 1;
  return { x: x / length, y: y / length };
}

function inputTimestamp() {
  return globalThis.performance?.now?.() ?? Date.now();
}
