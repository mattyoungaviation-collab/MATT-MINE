import test from 'node:test';
import assert from 'node:assert/strict';

import { bossPhaseForHealth, enemyArchetypeForRoll, frontArmorMultiplier, roomRequiresLock } from '../src/game/combat.js';
import { drawEnemyBody, guardianAnimationFrame } from '../src/game/v3/renderEnemyBody.js';

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
  const profile = { bestDepth: 0, bestScore: 0, totalRuns: 0 };
  return { canvas, profile, context };
}

test('combat helpers resolve enemy roles, armor, boss phases, and locked rooms', () => {
  assert.equal(enemyArchetypeForRoll(0.1, 1), 'slime');
  assert.equal(enemyArchetypeForRoll(0.3, 1), 'bat');
  assert.equal(enemyArchetypeForRoll(0.55, 1), 'crawler');
  assert.equal(enemyArchetypeForRoll(0.75, 1), 'beetle');
  assert.equal(enemyArchetypeForRoll(0.85, 1), 'spitter');
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
  assert.equal(game.player.weapon, 'pickaxe');
});

test('an already-cleared combat room stays open when the player enters it', async () => {
  const { canvas, profile } = installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  game.startRun();
  const combatRoom = game.layout.rooms.find((room) => room.type === 'combat');
  const roomEnemies = game.enemies.filter((enemy) => enemy.roomId === combatRoom.id);
  assert.ok(roomEnemies.length > 0);

  for (const enemy of [...roomEnemies]) game.killEnemy(enemy);
  assert.equal(game.roomStates[combatRoom.id].locked, false);
  assert.equal(game.roomStates[combatRoom.id].cleared, false);

  game.player.x = combatRoom.x;
  game.player.y = combatRoom.y;
  game.updateCurrentRoom();

  assert.equal(game.roomStates[combatRoom.id].triggered, true);
  assert.equal(game.roomStates[combatRoom.id].cleared, true);
  assert.equal(game.roomStates[combatRoom.id].locked, false);
  assert.equal(game.activeLockedRoomId, null);
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

test('cinematic floor and Guardian assets render without breaking the combat frame', async () => {
  const { canvas, profile } = installBrowserStubs(true);
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  const readyImage = { complete: true, naturalWidth: 1254, naturalHeight: 1254 };
  game.visualAssets = { floor: readyImage, guardian: readyImage };
  game.startRun();
  game.run.bossSpawned = true;
  game.spawnEnemy(true, game.layout.guardianRoom);
  game.player.x = game.layout.guardianRoom.x;
  game.player.y = game.layout.guardianRoom.y;
  assert.doesNotThrow(() => game.render());
});

test('the Guardian animation uses all 30 sprite frames across idle, walk, and attacks', () => {
  const enemy = {
    phase: 0,
    vx: 0,
    vy: 0
  };
  const seen = new Set();
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 6; column += 1) {
      if (row === 0) {
        enemy.guardianAnimation = null;
        enemy.vx = 0;
        enemy.phase = column / 1.15;
      } else if (row === 1) {
        enemy.guardianAnimation = null;
        enemy.vx = 40;
        enemy.phase = column / 1.8;
      } else {
        enemy.vx = 0;
        enemy.phase = column;
        enemy.guardianAnimation = {
          attack: row === 2 ? 'slam' : row === 4 ? 'radial' : 'volley',
          startedAt: 0,
          endsAt: 6
        };
      }
      seen.add(guardianAnimationFrame(enemy).index);
    }
  }
  assert.deepEqual([...seen].sort((left, right) => left - right), Array.from({ length: 30 }, (_, index) => index));
});

test('animated Guardian rendering crops one cell from the 6 by 5 sprite sheet', () => {
  const { context } = installBrowserStubs(true);
  const draws = [];
  context.drawImage = (...args) => draws.push(args);
  const guardianAnimated = { complete: true, naturalWidth: 1_368, naturalHeight: 1_145 };
  drawEnemyBody(context, {
    isBoss: true,
    hidden: false,
    phase: 2,
    vx: 0,
    vy: 0,
    hp: 100,
    maxHp: 100,
    radius: 64,
    hitFlash: 0
  }, {
    guardianAnimated
  });
  const guardianDraw = draws.find((args) => args[0] === guardianAnimated);
  assert.ok(guardianDraw);
  assert.deepEqual({
    sourceWidth: guardianDraw[3],
    sourceHeight: guardianDraw[4]
  }, {
    sourceWidth: 228,
    sourceHeight: 229
  });
});

test('MATT Dyno swaps weapon sheets and uses front and back walking rows', async () => {
  const { canvas, profile, context } = installBrowserStubs(true);
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const game = new MattMineGame(canvas, profile);
  const draws = [];
  context.drawImage = (...args) => draws.push(args);
  const image = (id, height = 482) => ({
    id,
    complete: true,
    naturalWidth: 724,
    naturalHeight: height
  });
  game.visualAssets = {
    mattDyno: image('pickaxe-side', 241),
    mattDynoBlaster: image('blaster-side', 241),
    mattDynoDynamite: image('dynamite-side', 241),
    mattDynoPickaxeVertical: image('pickaxe-vertical'),
    mattDynoBlasterVertical: image('blaster-vertical'),
    mattDynoDynamiteVertical: image('dynamite-vertical')
  };
  game.startRun();

  game.player.weapon = 'blaster';
  game.player.angle = Math.PI / 2;
  game.player.actionAngle = game.player.angle;
  game.player.swingTimer = 0.1;
  game.drawPlayer(context);
  assert.equal(draws.at(-1)[0].id, 'blaster-vertical');
  assert.equal(draws.at(-1)[1], 602);
  assert.equal(draws.at(-1)[2], 0);
  assert.equal(draws.at(-1)[3], 120);
  assert.equal(draws.at(-1)[6], -102);
  assert.equal(draws.at(-1)[7], 108);
  assert.equal(draws.at(-1)[8], 134);

  game.player.weapon = 'dynamite';
  game.player.swingTimer = 0;
  game.player.angle = 0;
  game.player.vx = 0;
  game.player.vy = -80;
  game.player.visualAngle = -Math.PI / 2;
  game.drawPlayer(context);
  assert.equal(draws.at(-1)[0].id, 'dynamite-vertical');
  assert.equal(draws.at(-1)[2], 241);
  assert.equal(draws.at(-1)[6], -97);
  assert.equal(draws.at(-1)[8], 134);
  assert.equal(Number.isInteger(draws.at(-1)[1]), true);

  game.player.weapon = 'pickaxe';
  game.player.vx = 80;
  game.player.vy = 0;
  game.player.angle = 0;
  game.player.visualAngle = 0;
  game.drawPlayer(context);
  assert.equal(draws.at(-1)[0].id, 'pickaxe-side');
  assert.equal(draws.at(-1)[6], -127);
  assert.equal(draws.at(-1)[8], 180);
});

test('Ronke, Axie, and Orc use their own walk, Pickaxe, Blaster, and Dynamite rows', async () => {
  const { canvas, profile, context } = installBrowserStubs(true);
  const { MattMineGame } = await import('../src/game/GameV3.js');
  const image = (id) => ({
    id,
    complete: true,
    naturalWidth: 1024,
    naturalHeight: 1536
  });
  const characters = [
    ['ronke', 'ronkeCharacter'],
    ['axie', 'axieCharacter'],
    ['orc', 'orcCharacter']
  ];

  for (const [characterId, asset] of characters) {
    const game = new MattMineGame(canvas, profile);
    const draws = [];
    context.drawImage = (...args) => draws.push(args);
    game.visualAssets = { [asset]: image(characterId) };
    game.runContext = { mode: 'practice', characterId, tuning: {}, character: {} };
    game.startRun();

    game.player.vx = 70;
    game.drawPlayer(context);
    assert.equal(draws.at(-1)[0].id, characterId);
    assert.equal(draws.at(-1)[2], 0);

    for (const [weapon, expectedRow] of [
      ['pickaxe', 330],
      ['blaster', 620],
      ['dynamite', 900]
    ]) {
      game.player.weapon = weapon;
      game.player.swingTimer = weapon === 'dynamite' ? 0.12 : weapon === 'blaster' ? 0.07 : 0.08;
      game.drawPlayer(context);
      assert.equal(draws.at(-1)[0].id, characterId);
      assert.equal(draws.at(-1)[2], expectedRow);
    }

    game.player.health = 0;
    game.player.swingTimer = 0;
    game.drawPlayer(context);
    assert.equal(draws.at(-1)[1], 744);
    assert.equal(draws.at(-1)[2], 1196);
  }
});
