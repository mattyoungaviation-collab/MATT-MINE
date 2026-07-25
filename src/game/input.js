import { clamp } from './utils.js';

export class InputController {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.pointer = { x: 0, y: 0, down: false, active: false };
    this.mobileMove = { x: 0, y: 0 };
    this.mobileAttack = false;
    this.mobileDashQueued = false;
    this.joystickPointerId = null;
    this.bindKeyboard();
    this.bindPointer();
    this.bindMobile();
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
      this.mobileAttack = false;
      this.mobileDashQueued = false;
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

    const updateJoystick = (event) => {
      const touch = [...event.changedTouches].find((item) => item.identifier === this.joystickPointerId);
      if (!touch) return;
      const rect = joystick.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const dx = touch.clientX - centerX;
      const dy = touch.clientY - centerY;
      const length = Math.hypot(dx, dy) || 1;
      const max = rect.width * 0.32;
      const scale = Math.min(1, max / length);
      const px = dx * scale;
      const py = dy * scale;
      knob.style.transform = `translate(${px}px, ${py}px)`;
      this.mobileMove.x = clamp(dx / max, -1, 1);
      this.mobileMove.y = clamp(dy / max, -1, 1);
    };

    joystick.addEventListener('touchstart', (event) => {
      this.joystickPointerId = event.changedTouches[0].identifier;
      updateJoystick(event);
      event.preventDefault();
    }, { passive: false });
    joystick.addEventListener('touchmove', (event) => {
      updateJoystick(event);
      event.preventDefault();
    }, { passive: false });
    const endJoystick = (event) => {
      if (![...event.changedTouches].some((item) => item.identifier === this.joystickPointerId)) return;
      this.joystickPointerId = null;
      this.mobileMove.x = 0;
      this.mobileMove.y = 0;
      knob.style.transform = 'translate(0, 0)';
    };
    joystick.addEventListener('touchend', endJoystick);
    joystick.addEventListener('touchcancel', endJoystick);

    const setAttack = (value) => (event) => {
      this.mobileAttack = value;
      event.preventDefault();
    };
    attack.addEventListener('touchstart', setAttack(true), { passive: false });
    attack.addEventListener('touchend', setAttack(false), { passive: false });
    attack.addEventListener('touchcancel', setAttack(false), { passive: false });

    if (dash) {
      dash.addEventListener('touchstart', (event) => {
        this.mobileDashQueued = true;
        event.preventDefault();
      }, { passive: false });
    }
  }

  movement() {
    let x = 0;
    let y = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) y -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) y += 1;
    x += this.mobileMove.x;
    y += this.mobileMove.y;
    const length = Math.hypot(x, y);
    return length > 1 ? { x: x / length, y: y / length } : { x, y };
  }

  attacking() {
    return this.pointer.down || this.mobileAttack || this.keys.has('Space');
  }

  consumeDash() {
    const keyboardDash = this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight');
    this.pressed.delete('ShiftLeft');
    this.pressed.delete('ShiftRight');
    const result = keyboardDash || this.mobileDashQueued;
    this.mobileDashQueued = false;
    return result;
  }
}
