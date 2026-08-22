import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function installBrowserStubs() {
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;

  const calls = { arc: 0, fill: 0, stroke: 0 };
  const gradient = { addColorStop() {} };
  const context = new Proxy({
    arc() { calls.arc += 1; },
    fill() { calls.fill += 1; },
    stroke() { calls.stroke += 1; },
    createRadialGradient() { return gradient; },
    createLinearGradient() { return gradient; }
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
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
  return { canvas, profile, context, calls };
}

function equipGoldTrail(game) {
  game.setCosmetics({ trail: 'gold_trail' });
  game.startRun();
  game.player.vx = 80;
  game.player.vy = 0;
  game.input.movement = () => ({ x: 1, y: 0 });
  game.input.consumeDash = () => false;
}

test('equipped Gold Trail creates connected ground glow and stationary sparkles', async () => {
  const { canvas, profile, context, calls } = installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  equipGoldTrail(game);

  const originalRandom = Math.random;
  Math.random = () => {
    throw new Error('Gold Trail visuals must not consume gameplay randomness.');
  };
  try {
    game.updatePlayerMovement(0.1);
  } finally {
    Math.random = originalRandom;
  }

  const groundParticles = game.particles.filter((particle) => particle.layer === 'ground');
  const glow = groundParticles.find((particle) => particle.kind === 'gold_trail_glow');
  const sparks = groundParticles.filter((particle) => particle.kind === 'gold_trail_spark');

  assert.ok(glow, 'a connected gold glow segment should be emitted');
  assert.ok(sparks.length >= 1, 'at least one gold sparkle should be emitted');
  assert.ok(Number.isFinite(glow.x1) && Number.isFinite(glow.y1));
  assert.ok(Number.isFinite(glow.x2) && Number.isFinite(glow.y2));
  assert.ok(glow.y2 > game.player.y, 'the trail should sit at the miner foot/ground plane');
  assert.ok(groundParticles.every((particle) => particle.vx === 0 && particle.vy === 0));
  assert.equal(glow.color, '#ffd95a', 'legacy cosmetic metadata should remain compatible');
  assert.equal(
    game.particles.some((particle) => particle.color === '#ffd95a' && particle.layer !== 'ground'),
    false,
    'the old round upward-moving puff should not be emitted'
  );

  const arcsBeforeGenericParticles = calls.arc;
  game.drawParticles(context);
  assert.equal(calls.arc, arcsBeforeGenericParticles,
    'ground trail particles should not be drawn in the airborne particle pass');
  game.drawGroundTrails(context);
  assert.ok(calls.stroke > 0, 'the ground trail should render luminous connected strokes');
  assert.ok(calls.fill > 0, 'the ground trail should render a soft ground glow');
});

test('Gold Trail emits only after actual player movement and resets across dashes', async () => {
  const { canvas, profile } = installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  equipGoldTrail(game);

  game.moveEntity = () => {};
  game.updatePlayerMovement(0.1);
  assert.equal(game.particles.some((particle) => particle.layer === 'ground'), false,
    'walking into a wall should not paint a stationary gold cloud');

  game.player.goldTrailX = 100;
  game.player.goldTrailY = 100;
  game.player.dashTimer = 0.2;
  game.updatePlayerMovement(0.01);
  assert.equal(Number.isFinite(game.player.goldTrailX), false,
    'dash movement should clear the normal ground-trail anchor');
  assert.equal(Number.isFinite(game.player.goldTrailY), false,
    'dash movement should not connect an airborne-looking segment afterward');
});

test('Gold Trail is rendered before the player sprite', async () => {
  const source = await readFile(new URL('../src/game/v3/renderFrame.js', import.meta.url), 'utf8');
  const trailIndex = source.indexOf('this.drawGroundTrails(ctx)');
  const playerIndex = source.indexOf('this.drawPlayer(ctx)');
  assert.ok(trailIndex >= 0);
  assert.ok(playerIndex >= 0);
  assert.ok(trailIndex < playerIndex, 'the glow must remain on the ground beneath the miner');
});
