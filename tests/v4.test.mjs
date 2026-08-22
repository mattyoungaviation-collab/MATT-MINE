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
  const profile = { bestDepth: 0, bestScore: 0, totalRuns: 0 };
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
  game.run.rawScore = 100;
  game.endRun(true);
  assert.equal(result.mode, 'paid');
  assert.equal(result.seed, 'PAID-SEED');
  assert.equal(result.day, '2026-07-25');
  assert.equal(result.week, '2026-07-20');
  assert.equal(result.rewardWeight, 2);
});

test('ranked simulation clocks discard time while a choice screen is open', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const { canvas, profile } = browserStubs();
  const game = new MattMineGame(canvas, profile);
  game.startRun({ mode: 'arena', seed: 'ARENA-PAUSED-CLOCK' });
  const elapsedBeforeChoice = game.run.elapsed;

  game.state = 'levelup';
  for (let frame = 0; frame < 20; frame += 1) game.update(0.25);

  assert.equal(game.run.elapsed, elapsedBeforeChoice);
  assert.equal(game.arenaAccumulator, 0);

  game.state = 'playing';
  game.update(0.02);

  assert.ok(Math.abs(game.run.elapsed - elapsedBeforeChoice - 0.02) < 0.000_001);
  assert.equal(game.arenaAccumulator, 0);
});

test('Arena reaches its authoritative clock limit, extracts, and emits a terminal transcript', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const { canvas, profile } = browserStubs();
  const events = [];
  const hudUpdates = [];
  let result;
  const game = new MattMineGame(canvas, profile, {
    onArenaInput(event) { events.push(event); },
    onHud(stats) { hudUpdates.push(stats); },
    onRunEnd(value) { result = value; }
  });

  game.startRun({
    mode: 'arena',
    seed: 'ARENA-TIME-LIMIT',
    roundDurationMs: 40
  });
  game.run.rawScore = 123;
  game.update(0.04);

  assert.equal(game.state, 'ended');
  assert.equal(result.extracted, true);
  assert.equal(result.timeLimitReached, true);
  assert.equal(result.elapsed, 0.04);
  assert.equal(result.banked, result.projected);
  assert.deepEqual(events.slice(-2), [
    { type: 'command', tick: 40, command: 'time_limit' },
    { type: 'finish', tick: 40 }
  ]);
  assert.equal(hudUpdates.at(-1).roundDurationMs, 40);
  assert.equal(hudUpdates.at(-1).roundRemainingMs, 0);
});
