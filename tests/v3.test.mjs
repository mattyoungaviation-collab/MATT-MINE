import test from 'node:test';
import assert from 'node:assert/strict';

import { bossPhaseForHealth, enemyArchetypeForRoll, frontArmorMultiplier, roomRequiresLock } from '../src/game/combat.js';

function installBrowserStubs(rendering = false) {
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 0;

  const gradient = { addColorStop() {} };
  const context = rendering
    ? new Proxy({}, {
      get(target, property) {
        if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => gradient;
        if (property in target) return target[property];
        return () => {};
      },
      set(target, property, value) { target[property] = value; return true; }
    })
    : { setTransform() {} };

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

test('combat helpers resolve enemy roles, armor, boss phases, and locked rooms', () => {
  assert.equal(enemyArchetypeForRoll(0.1, 1), 'slime');
  assert.equal(enemyArchetypeForRoll(0.3, 1), 'bat');
  assert.equal(enemyArchetypeForRoll(0.55, 1), 'crawler');
  assert.equal(enemyArchetypeForRoll(0.75, 1), 'beetle');
  assert.equal(enemyArchetypeForRoll(0.95, 2), 'exploder');
  assert.equal(bossPhaseForHealth(90, 100), 1);
  assert.equal(bossPhaseForHealth(60, 100), 2);
  assert.equal(bossPhaseForHealth(20, 100), 3);
  assert.ok(frontArmorMultiplier(0, Math.PI) < 0.3);
  assert.equal(frontArmorMultiplier(0, 0), 1);
  assert.equal(roomRequiresLock('combat'), true);
  assert.equal(roomRequiresLock('guardian'), true);
  assert.equal(roomRequiresLock('mining'), false);
});

test('clearing a sealed combat room unlocks dynamite and reopens the room', async () => {
  const { canvas, profile } = installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  game.startRun();
  const combatRoom = game.layout.rooms.find((room) => room.type === 'combat');
  game.player.x = combatRoom.x;
  game.player.y = combatRoom.y;
  game.updateCurrentRoom();
  assert.equal(game.roomStates[combatRoom.id].locked, true);
  assert.equal(game.activeLockedRoomId, combatRoom.id);
  const roomEnemies = game.enemies.filter((enemy) => enemy.roomId === combatRoom.id);
  assert.ok(roomEnemies.length > 0);
  assert.ok(roomEnemies.every((enemy) => enemy.awake));
  for (const enemy of [...roomEnemies]) game.killEnemy(enemy);
  assert.equal(game.roomStates[combatRoom.id].cleared, true);
  assert.equal(game.activeLockedRoomId, null);
  assert.equal(game.player.unlockedWeapons.dynamite, true);
  assert.ok(game.player.dynamiteAmmo >= 3);
});

test('v0.3 combat render and weapon loop run without throwing', async () => {
  const { canvas, profile } = installBrowserStubs(true);
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  game.startRun();
  assert.doesNotThrow(() => game.render());
  game.unlockWeapon('dynamite', 2);
  game.switchWeapon('dynamite');
  game.throwDynamite();
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'dynamite'), true);
  game.updateProjectiles(0.7);
  game.unlockWeapon('blaster');
  game.switchWeapon('blaster');
  game.fireBlaster();
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'crystalBolt'), true);
  assert.doesNotThrow(() => game.render());
});

test('equipped Pass cosmetics render on the miner and emit the gold movement trail', async () => {
  const { canvas, profile } = installBrowserStubs(true);
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  game.setCosmetics({
    trail: 'gold_trail',
    weapon: 'molten_pickaxe',
    skin: 'crystal_skin',
    aura: 'guardian_aura'
  });
  game.startRun();
  game.player.vx = 80;
  game.player.vy = 0;
  game.player.trailTimer = 0;
  game.input.movement = () => ({ x: 1, y: 0 });
  game.input.consumeDash = () => false;
  game.updatePlayerMovement(0.1);
  assert.equal(game.particles.some((particle) => particle.color === '#ffd95a'), true);
  assert.doesNotThrow(() => game.render());
  assert.deepEqual(game.cosmetics, {
    trail: 'gold_trail',
    weapon: 'molten_pickaxe',
    skin: 'crystal_skin',
    aura: 'guardian_aura'
  });
});
