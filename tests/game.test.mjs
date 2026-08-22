import test from 'node:test';
import assert from 'node:assert/strict';
import { clamp, weightedChoice } from '../src/game/utils.js';
import { ORE_TYPES } from '../src/game/config.js';
import { createMineLayout, pointInLayout, randomPointInRoom, roomAt } from '../src/game/layout.js';

test('clamp keeps values inside the requested range', () => {
  assert.equal(clamp(-2, 0, 10), 0);
  assert.equal(clamp(12, 0, 10), 10);
  assert.equal(clamp(4, 0, 10), 4);
});

test('weightedChoice returns an entry from the supplied pool', () => {
  const entries = Object.entries(ORE_TYPES)
    .filter(([id]) => id !== 'cache')
    .map(([id, ore]) => ({ id, ...ore }));
  for (let index = 0; index < 100; index += 1) {
    assert.ok(entries.includes(weightedChoice(entries)));
  }
});

test('procedural mine always contains the required room types', () => {
  for (let index = 0; index < 100; index += 1) {
    const layout = createMineLayout();
    assert.equal(layout.rooms.length, 7);
    assert.ok(layout.startRoom);
    assert.ok(layout.guardianRoom);
    assert.ok(layout.treasureRoom);
    assert.notEqual(layout.startRoom.id, layout.guardianRoom.id);
    assert.equal(layout.corridors.length, layout.rooms.length - 1);
    assert.equal(new Set(layout.rooms.map((room) => `${room.cellX},${room.cellY}`)).size, layout.rooms.length);
  }
});

test('room points are walkable and resolve back to their room', () => {
  const layout = createMineLayout();
  for (const room of layout.rooms) {
    const point = randomPointInRoom(room, 60);
    assert.equal(pointInLayout(layout, point.x, point.y, 10), true);
    assert.equal(roomAt(layout, point.x, point.y)?.id, room.id);
  }
});

test('a generated run contains enough crystals and a treasure cache', async () => {
  globalThis.window = {
    addEventListener() {},
    devicePixelRatio: 1
  };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;

  const { MattMineGame } = await import('../src/game/Game.js');
  const context = { setTransform() {} };
  const canvas = {
    width: 1280,
    height: 720,
    style: {},
    dataset: {},
    getContext: () => context,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 })
  };
  const profile = { bestDepth: 0, bestScore: 0, totalRuns: 0 };
  const game = new MattMineGame(canvas, profile);
  game.startRun();

  assert.equal(game.layout.rooms.length, 7);
  assert.ok(game.ores.filter((ore) => ore.kind === 'crystal').length >= game.crystalGoal());
  assert.equal(game.ores.filter((ore) => ore.kind === 'cache').length, 1);
  assert.equal(pointInLayout(game.layout, game.player.x, game.player.y, game.player.radius * 0.68), true);
});

test('guardian and extraction flow records the run score', async () => {
  globalThis.window = {
    addEventListener() {},
    devicePixelRatio: 1
  };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;

  const { MattMineGame } = await import('../src/game/Game.js');
  const context = { setTransform() {} };
  const canvas = {
    width: 1280,
    height: 720,
    style: {},
    dataset: {},
    getContext: () => context,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 })
  };
  const profile = { bestDepth: 0, bestScore: 0, totalRuns: 0 };
  const game = new MattMineGame(canvas, profile);
  game.startRun();
  game.run.rawScore = 100;
  game.run.crystals = game.crystalGoal();
  game.updatePickups(0);

  const guardian = game.enemies.find((enemy) => enemy.isBoss);
  assert.ok(guardian);
  assert.equal(guardian.roomId, game.layout.guardianRoom.id);
  game.killEnemy(guardian);
  assert.ok(game.portal);
  assert.equal(game.portal.x, game.layout.startRoom.x);
  assert.equal(game.portal.y, game.layout.startRoom.y);

  game.player.x = game.portal.x;
  game.player.y = game.portal.y;
  game.updatePortal();
  assert.equal(game.state, 'depthchoice');
  assert.equal(game.projectedPayout(), 100);
  game.extract();
  assert.equal(game.state, 'ended');
  assert.equal(profile.bestScore, 100);
  assert.equal(profile.totalRuns, 1);
});

test('camera can center rooms placed at every authored map edge', async () => {
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;

  const { MattMineGame } = await import('../src/game/Game.js');
  const game = new MattMineGame({}, { bestDepth: 0, bestScore: 0, totalRuns: 0 }, { headless: true });
  game.layout = {
    rooms: [
      { x: 300, y: 280 },
      { x: 2100, y: 1320 }
    ]
  };

  const bounds = game.cameraBounds();
  assert.ok(bounds.minX < 0);
  assert.ok(bounds.minY < 0);
  assert.ok(bounds.maxX > 2400 - game.viewportWidth);
  assert.ok(bounds.maxY > 1600 - game.viewportHeight);

  game.player = { x: 2100, y: 280, vx: 0, vy: 0 };
  game.updateCamera(1);
  assert.ok(Math.abs((game.player.x - game.camera.x) - game.viewportWidth / 2) <= 72);
  assert.ok(Math.abs((game.player.y - game.camera.y) - game.viewportHeight / 2) <= 72);
});
