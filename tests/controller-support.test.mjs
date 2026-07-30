import test from 'node:test';
import assert from 'node:assert/strict';

import { InputController } from '../src/game/input.js';

function installInputBrowser(pad) {
  globalThis.window = {
    addEventListener() {},
    dispatchEvent() {}
  };
  globalThis.document = {
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { getGamepads: () => [pad] }
  });
  const canvas = {
    dataset: {},
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1_280, height: 720 })
  };
  return new InputController(canvas);
}

function gamepad({ axes = [0, 0, 0, 0], buttons = [] } = {}) {
  return {
    connected: true,
    index: 0,
    axes,
    buttons: Array.from({ length: 18 }, (_, index) => ({
      pressed: Boolean(buttons[index]),
      value: buttons[index] ? 1 : 0
    }))
  };
}

test('controller aim follows the right stick and then retains the last pushed direction', async () => {
  const pad = gamepad({ axes: [0, -1, 1, 0] });
  const input = installInputBrowser(pad);
  assert.deepEqual(input.aimVector(), { x: 1, y: 0 });
  await Promise.resolve();
  pad.axes = [0, -1, 0, 0];
  assert.deepEqual(input.aimVector(), { x: 0, y: -1 });
  await Promise.resolve();
  pad.axes = [0, 0, 0, 0];
  assert.deepEqual(input.aimVector(), { x: 0, y: -1 });
});

test('D-pad direction controls movement and becomes the retained controller aim', () => {
  const pad = gamepad({ buttons: { 14: true, 12: true } });
  const input = installInputBrowser(pad);
  const movement = input.movement();
  assert.ok(movement.x < 0);
  assert.ok(movement.y < 0);
  const aim = input.aimVector();
  assert.ok(aim.x < 0);
  assert.ok(aim.y < 0);
});

test('new trigger and stick defaults avoid gameplay collisions with confirm and back', () => {
  const pad = gamepad({ buttons: { 7: true } });
  const input = installInputBrowser(pad);
  input.pollGamepad();
  assert.equal(input.attacking(), true);
  assert.equal(input.controllerHeld('confirm'), false);
  assert.equal(input.controllerHeld('dash'), false);
});
