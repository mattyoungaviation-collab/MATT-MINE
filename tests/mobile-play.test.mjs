import test from 'node:test';
import assert from 'node:assert/strict';

import { InputController } from '../src/game/input.js';
import {
  canvasRenderSize,
  enterMobileGameplayFullscreen,
  exitMobileGameplayFullscreen,
  mobileLandscapeRequired,
  touchInputDetected,
  viewportDimensions
} from '../src/game/mobile.js';

class FakeTarget {
  constructor({ rect, dataset = {}, locked = false } = {}) {
    this.listeners = new Map();
    this.rect = rect || { left: 0, top: 0, width: 100, height: 100 };
    this.dataset = dataset;
    this.style = {};
    this.classList = { contains: (name) => name === 'locked' && locked };
    this.captured = new Set();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, properties = {}) {
    const event = {
      type,
      pointerId: 1,
      clientX: 0,
      clientY: 0,
      preventDefault() {},
      ...properties
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  setPointerCapture(pointerId) {
    this.captured.add(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.captured.delete(pointerId);
  }
}

function installMobileInputBrowser() {
  const windowTarget = new FakeTarget();
  windowTarget.dispatchEvent = () => {};
  globalThis.window = windowTarget;
  const joystick = new FakeTarget();
  const knob = new FakeTarget();
  const attack = new FakeTarget();
  const dash = new FakeTarget();
  const pickaxe = new FakeTarget({ dataset: { weapon: 'pickaxe' } });
  const lockedDynamite = new FakeTarget({
    dataset: { weapon: 'dynamite' },
    locked: true
  });
  const targets = {
    '#joystick': joystick,
    '#joystick-knob': knob,
    '#attack-button': attack,
    '#dash-button': dash
  };
  globalThis.document = {
    querySelector(selector) {
      return targets[selector] || null;
    },
    querySelectorAll(selector) {
      return selector === '.weapon-button' ? [pickaxe, lockedDynamite] : [];
    }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => [] }
  });
  const canvas = new FakeTarget({
    rect: { left: 0, top: 0, width: 1_280, height: 720 },
    dataset: {}
  });
  return {
    input: new InputController(canvas),
    joystick,
    knob,
    attack,
    dash,
    pickaxe,
    lockedDynamite
  };
}

test('touch input detection supports both Ronin mobile signals', () => {
  assert.equal(touchInputDetected({ navigator: { maxTouchPoints: 1 } }), true);
  assert.equal(touchInputDetected({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(touchInputDetected({ navigator: { maxTouchPoints: 0 } }), false);
});

test('phone portrait requires landscape before a run starts', () => {
  const portrait = { visualViewport: { width: 390, height: 844 } };
  const landscape = { visualViewport: { width: 844, height: 390 } };
  assert.deepEqual(viewportDimensions(portrait), { width: 390, height: 844 });
  assert.equal(mobileLandscapeRequired(portrait, true), true);
  assert.equal(mobileLandscapeRequired(landscape, true), false);
  assert.equal(mobileLandscapeRequired(portrait, false), false);
});

test('mobile canvas buffer follows visible size and caps pixel density', () => {
  assert.deepEqual(canvasRenderSize({
    cssWidth: 694,
    cssHeight: 390,
    logicalWidth: 1_280,
    logicalHeight: 720,
    devicePixelRatio: 3,
    touchInput: true
  }), {
    pixelWidth: 868,
    pixelHeight: 488,
    scaleX: 868 / 1_280,
    scaleY: 488 / 720
  });
  assert.deepEqual(canvasRenderSize({
    cssWidth: 1_280,
    cssHeight: 720,
    logicalWidth: 1_280,
    logicalHeight: 720,
    devicePixelRatio: 2,
    touchInput: false
  }), {
    pixelWidth: 1_920,
    pixelHeight: 1_080,
    scaleX: 1.5,
    scaleY: 1.5
  });
});

test('mobile gameplay requests native fullscreen and keeps an iOS viewport fallback', async () => {
  const classes = new Set();
  const calls = [];
  const element = {
    requestFullscreen(options) {
      calls.push(options);
      runtime.document.fullscreenElement = element;
      return Promise.resolve();
    }
  };
  const runtime = {
    document: {
      documentElement: {
        classList: {
          add: (name) => classes.add(name),
          remove: (name) => classes.delete(name)
        }
      },
      fullscreenElement: null,
      exitFullscreen() {
        this.fullscreenElement = null;
        return Promise.resolve();
      }
    },
    screen: { orientation: { lock: async () => undefined } },
    scrollTo(x, y) { calls.push([x, y]); }
  };

  assert.equal(await enterMobileGameplayFullscreen(element, runtime), true);
  assert.equal(classes.has('mobile-gameplay-fullscreen'), true);
  assert.deepEqual(calls, [[0, 1], { navigationUI: 'hide' }]);
  assert.equal(await exitMobileGameplayFullscreen(runtime), true);
  assert.equal(classes.has('mobile-gameplay-fullscreen'), false);
});

test('pointer controls move, attack, dash, and select only unlocked weapons', () => {
  const controls = installMobileInputBrowser();
  controls.joystick.dispatch('pointerdown', { pointerId: 11, clientX: 100, clientY: 50 });
  assert.deepEqual(controls.input.movement(), { x: 1, y: 0 });
  assert.equal(controls.joystick.captured.has(11), true);

  controls.joystick.dispatch('pointerup', { pointerId: 11 });
  assert.deepEqual(controls.input.movement(), { x: 0, y: 0 });
  assert.equal(controls.knob.style.transform, 'translate(0, 0)');

  controls.attack.dispatch('pointerdown', { pointerId: 12 });
  assert.equal(controls.input.attacking(), true);
  controls.attack.dispatch('pointercancel', { pointerId: 12 });
  assert.equal(controls.input.attacking(), false);

  controls.dash.dispatch('pointerdown', { pointerId: 13 });
  assert.equal(controls.input.consumeDash(), true);
  assert.equal(controls.input.consumeDash(), false);

  controls.lockedDynamite.dispatch('pointerdown', { pointerId: 14 });
  assert.equal(controls.input.consumeWeaponSelection(), null);
  controls.pickaxe.dispatch('pointerdown', { pointerId: 15 });
  assert.equal(controls.input.consumeWeaponSelection(), 'pickaxe');
  assert.equal(controls.input.consumeWeaponSelection(), null);
});
