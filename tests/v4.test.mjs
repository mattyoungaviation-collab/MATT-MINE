import test from 'node:test';
import assert from 'node:assert/strict';

function browserStubs() {
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (property in target) return target[property];
      return () => {};
    },
    set(target, property, value) { target[property] = value; return true; }
  });
  const canvas = {
    width: 1280,
    height: 720,
    style: {},
    dataset: {},
    getContext: () => context,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 })
  };
  const profile = {
    bankedNuggets: 0,
    bestDepth: 0,
    bestScore: 0,
    totalRuns: 0,
    meta: { health: 0, damage: 0, speed: 0, luck: 0 }
  };
  return { canvas, profile };
}

function mineSnapshot(game) {
  return {
    rooms: game.layout.rooms.map(({ cellX, cellY, type }) => ({ cellX, cellY, type })),
    ores: game.ores.slice(0, 20).map(({ kind, x, y, rich }) => ({ kind, x, y, rich })),
    enemies: game.enemies.slice(0, 20).map(({ type, x, y, roomId }) => ({ type, x, y, roomId }))
  };
}

test('v0.4 ranked runs generate the same mine from the same daily seed', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const firstStubs = browserStubs();
  const first = new MattMineGame(firstStubs.canvas, firstStubs.profile);
  first.startRun({ mode: 'free', seed: 'MATT-MINE-2026-07-25-FREE', day: '2026-07-25', week: '2026-07-20', rewardWeight: 1 });
  const secondStubs = browserStubs();
  const second = new MattMineGame(secondStubs.canvas, secondStubs.profile);
  second.startRun({ mode: 'free', seed: 'MATT-MINE-2026-07-25-FREE', day: '2026-07-25', week: '2026-07-20', rewardWeight: 1 });
  assert.deepEqual(mineSnapshot(first), mineSnapshot(second));
});

test('v0.4 run results carry leaderboard and reward metadata', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const { canvas, profile } = browserStubs();
  let result;
  const game = new MattMineGame(canvas, profile, { onRunEnd(value) { result = value; } });
  game.startRun({ mode: 'paid', seed: 'PAID-SEED', day: '2026-07-25', week: '2026-07-20', rewardWeight: 2 });
  game.run.rawNuggets = 100;
  game.endRun(true);
  assert.equal(result.mode, 'paid');
  assert.equal(result.seed, 'PAID-SEED');
  assert.equal(result.day, '2026-07-25');
  assert.equal(result.week, '2026-07-20');
  assert.equal(result.rewardWeight, 2);
});
