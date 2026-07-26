import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  ADMIN_ROLES,
  ECONOMY_STORAGE_KEY,
  LocalEconomyStore,
  RUN_MODES,
  consumeRun,
  defaultEconomyState,
  normalizeEconomyState,
  passIsActive,
  purchasePaidRun,
  purchasePass,
  recordRun,
  runAccess,
  setWalletBan,
  updateAdminSettings,
  utcDayKey,
  utcWeekKey,
  weeklyUserScore
} from '../src/game/economy.js';
import {
  PROFILE_STORAGE_KEY,
  defaultProfile,
  loadProfile
} from '../src/game/storage.js';
import { CONFIG, META_UPGRADES, metaUpgradeCost } from '../src/game/config.js';

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

function installBrowserStubs() {
  let animationFrames = 0;
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => {
    animationFrames += 1;
    return animationFrames;
  };
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => gradient;
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
  return {
    canvas,
    profile: defaultProfile(),
    animationFrameCount: () => animationFrames
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    value(key) {
      return values.get(key);
    }
  };
}

function oreTarget(game, overrides = {}) {
  return {
    id: game.entityId++,
    kind: 'stone',
    name: 'Stone',
    x: game.player.x + 70,
    y: game.player.y,
    radius: 20,
    hp: 200,
    maxHp: 200,
    nuggets: 10,
    xp: 1,
    color: '#888888',
    hitFlash: 0,
    rich: false,
    roomId: game.layout.startRoom.id,
    ...overrides
  };
}

function enemyTarget(game, overrides = {}) {
  return {
    id: game.entityId++,
    type: 'slime',
    isBoss: false,
    x: game.player.x + 110,
    y: game.player.y,
    vx: 0,
    vy: 0,
    knockbackX: 0,
    knockbackY: 0,
    radius: 18,
    hp: 200,
    maxHp: 200,
    speed: 0,
    damage: 1,
    xp: 1,
    color: '#e94f64',
    hitFlash: 0,
    contactTimer: 0,
    phase: 0,
    roomId: game.layout.startRoom.id,
    awake: true,
    hidden: false,
    facing: 0,
    ...overrides
  };
}

test('the frame boundary reports a runtime failure and keeps scheduling animation frames', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  let reported;
  const game = new MattMineGame(stubs.canvas, stubs.profile, {
    onFatalError(error) {
      reported = error;
    }
  });
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'FRAME-BOUNDARY' });
  game.update = () => {
    throw new ReferenceError('stress-test failure');
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => game.loop(performance.now() + 16));
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(game.state, 'runtime-error');
  assert.equal(reported.message, 'stress-test failure');
  assert.ok(stubs.animationFrameCount() >= 2);
  game.backToMenu();
  assert.equal(game.runtimeError, null);
  assert.equal(game.state, 'menu');
});

test('pickaxe, dynamite, and crystal blaster damage their intended targets', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'THREE-WEAPONS' });
  game.player.angle = 0;

  const pickaxeOre = oreTarget(game);
  game.ores = [pickaxeOre];
  game.enemies = [];
  game.swingPickaxe();
  assert.ok(pickaxeOre.hp < pickaxeOre.maxHp);

  const dynamiteOre = oreTarget(game, { x: game.player.x + 300 });
  game.ores = [dynamiteOre];
  game.unlockWeapon('dynamite', 1);
  game.throwDynamite();
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'dynamite'), true);
  game.updateProjectiles(0.7);
  assert.ok(dynamiteOre.hp < dynamiteOre.maxHp);
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'dynamite'), false);

  const blasterEnemy = enemyTarget(game);
  game.ores = [];
  game.enemies = [blasterEnemy];
  game.unlockWeapon('blaster');
  game.player.blasterEnergy = game.player.blasterEnergyMax;
  game.fireBlaster();
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'crystalBolt'), true);
  game.updateProjectiles(0.1);
  assert.ok(blasterEnemy.hp < blasterEnemy.maxHp);
  assert.equal(game.projectiles.some((projectile) => projectile.kind === 'crystalBolt'), false);
});

test('every mode starts with the Pickaxe while Practice keeps the Blaster available', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const practice = new MattMineGame(stubs.canvas, stubs.profile);
  practice.startRun({ mode: RUN_MODES.PRACTICE, seed: 'STARTING-BLASTER' });
  assert.equal(practice.player.weapon, 'pickaxe');
  assert.equal(practice.player.unlockedWeapons.blaster, true);
  assert.ok(practice.layout.guardianRoom.width >= 520);
  assert.ok(practice.layout.guardianRoom.height >= 390);

  const arena = new MattMineGame(stubs.canvas, defaultProfile(), { headless: true, audio: {
    startMusic() {}, resume() {}, play() {}, stopBoss() {}, stopMusic() {}
  } });
  arena.startRun({ mode: 'arena', seed: 'ARENA-RULES' });
  assert.equal(arena.player.weapon, 'pickaxe');
  assert.equal(arena.player.unlockedWeapons.blaster, false);
  assert.equal(arena.layout.guardianRoom.width, CONFIG.roomWidth);
  assert.equal(arena.layout.guardianRoom.height, CONFIG.roomHeight);
});

test('Safe Start keeps nearby enemies away and passive until the miner moves out or the grace period ends', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'SAFE-START' });
  assert.equal(game.player.weapon, 'pickaxe');
  assert.equal(game.isSafeStartActive(), true);
  assert.equal(game.enemies.some((enemy) => enemy.roomId === game.layout.startRoom.id), false);

  const closeEnemy = enemyTarget(game, {
    x: game.player.x,
    y: game.player.y,
    speed: 100,
    damage: 15,
    aiTimer: 0,
    attackTimer: 0,
    summonTimer: 0
  });
  game.enemies = [closeEnemy];
  const startingHealth = game.player.health;
  game.updateEnemies(0.1);
  assert.equal(game.player.health, startingHealth);
  assert.equal(closeEnemy.vx, 0);
  assert.equal(closeEnemy.vy, 0);

  game.run.elapsed = game.run.safeStartUntil;
  game.updateEnemies(0.1);
  assert.ok(game.player.health < startingHealth);

  game.player.health = startingHealth;
  game.run.elapsed = 0;
  game.run.safeStartUntil = CONFIG.safeStartSeconds;
  closeEnemy.contactTimer = 0;
  game.player.invulnerable = 0;
  const nextRoom = game.layout.rooms.find((room) => room.id !== game.layout.startRoom.id);
  game.player.x = nextRoom.x;
  game.player.y = nextRoom.y;
  closeEnemy.x = nextRoom.x;
  closeEnemy.y = nextRoom.y;
  closeEnemy.roomId = nextRoom.id;
  game.updateEnemies(0.1);
  assert.ok(game.player.health < startingHealth);
});

test('the treasure cache offers Blaster tuning and volleys fire up to three bolts', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  let offered = [];
  const game = new MattMineGame(stubs.canvas, stubs.profile, {
    onLevelUp(options) {
      offered = options;
    }
  });
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'BLASTER-CACHE' });
  const cache = oreTarget(game, { kind: 'cache', hp: 1, maxHp: 1, xp: 0 });
  game.ores = [cache];
  game.damageTarget(cache, 10);
  assert.equal(game.state, 'levelup');
  assert.equal(offered.length, 3);
  assert.equal(offered.every((option) => option.id.startsWith('blaster')), true);

  game.chooseRunUpgrade(offered[0].id);
  game.player.blasterVolley = 3;
  game.player.angle = 0;
  game.projectiles = [];
  game.fireBlaster();
  assert.equal(game.projectiles.filter((projectile) => projectile.kind === 'crystalBolt').length, 3);
});

test('shield beetles recoil frontal pickaxe attacks, resist bolts and drones, and are weak to dynamite', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'BEETLE-BALANCE' });
  const beetle = enemyTarget(game, { type: 'beetle', hp: 500, maxHp: 500, facing: 0 });

  game.damageTarget(beetle, 100, false, Math.PI, 'pick');
  const pickDamage = 500 - beetle.hp;
  assert.ok(pickDamage <= 10);
  assert.ok(game.player.attackTimer >= 0.5);

  const beforeBolt = beetle.hp;
  game.damageTarget(beetle, 100, false, 0, 'blaster');
  const boltDamage = beforeBolt - beetle.hp;
  assert.ok(boltDamage <= 22);

  const beforeDrone = beetle.hp;
  game.damageTarget(beetle, 100, false, 0, 'drone');
  const droneDamage = beforeDrone - beetle.hp;
  assert.ok(droneDamage <= 22);

  const beforeExplosion = beetle.hp;
  game.damageTarget(beetle, 100, false, 0, 'explosion');
  assert.equal(Math.round(beforeExplosion - beetle.hp), 180);
});

test('ranged enemies fire at the player and run endings clear all camera shake', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'SPITTER-SHAKE' });
  const spitter = enemyTarget(game, {
    type: 'spitter',
    x: game.player.x + 250,
    attackTimer: 0,
    speed: 74,
    damage: 22,
    phase: 1
  });
  game.enemies = [spitter];
  game.projectiles = [];
  game.updateEnemyBehavior(spitter, 0.02);
  assert.equal(game.projectiles.filter((projectile) => projectile.owner === 'enemy').length, 3);

  game.camera.shake = 15;
  game.endRun(false);
  assert.equal(game.camera.shake, 0);
});

test('the stronger Guardian fires evasive spreads and summons fast relentless reinforcements', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'GUARDIAN-PRESSURE' });
  const guardian = game.spawnEnemy(true, game.layout.guardianRoom);
  guardian.hp = guardian.maxHp * 0.6;
  guardian.lastBossPhase = 2;
  guardian.attackTimer = 0;
  guardian.summonTimer = 0;
  game.enemies = [guardian];
  game.projectiles = [];

  game.updateGuardian(guardian, 0.02);

  const reinforcements = game.enemies.filter((enemy) => enemy.guardianReinforcement);
  assert.equal(guardian.maxHp, 820);
  assert.equal(game.projectiles.length, 5);
  assert.equal(reinforcements.length, 3);
  assert.equal(reinforcements.every((enemy) => enemy.awake && enemy.speed > 74), true);
  const projectileAngles = game.projectiles.map((projectile) => Math.atan2(projectile.vy, projectile.vx));
  assert.ok(Math.max(...projectileAngles) - Math.min(...projectileAngles) > 1);
});

test('Guardian slam aura cannot damage the player through mine walls', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'GUARDIAN-WALL-AURA' });
  const guardianRoom = { id: 1, x: 100, y: 100, width: 180, height: 180, type: 'guardian' };
  const playerRoom = { id: 2, x: 300, y: 100, width: 180, height: 180, type: 'combat' };
  game.layout = {
    rooms: [guardianRoom, playerRoom],
    corridors: [],
    startRoom: playerRoom,
    guardianRoom
  };
  const guardian = game.spawnEnemy(true, guardianRoom);
  guardian.x = 180;
  guardian.y = 100;
  game.player.x = 220;
  game.player.y = 100;
  game.player.invulnerability = 0;
  const healthBehindWall = game.player.health;

  game.guardianSlam(guardian, 235, 30);
  assert.equal(game.player.health, healthBehindWall);

  game.layout.rooms = [guardianRoom];
  game.player.x = 170;
  game.player.invulnerability = 0;
  game.guardianSlam(guardian, 235, 30);
  assert.ok(game.player.health < healthBehindWall);
});

test('the expanded nugget workshop keeps legacy ranks and scales into long-term costs', () => {
  const profile = defaultProfile();
  assert.deepEqual(Object.keys(profile.meta), META_UPGRADES.map((upgrade) => upgrade.id));
  assert.equal(META_UPGRADES.every((upgrade) => upgrade.max >= 15), true);
  const health = META_UPGRADES.find((upgrade) => upgrade.id === 'health');
  assert.equal(metaUpgradeCost(health, 0), 110);
  assert.ok(metaUpgradeCost(health, 10) > metaUpgradeCost(health, 5));
});

test('player, enemy, expired, and wall projectile paths resolve without throwing', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'PROJECTILE-PATHS' });
  const startingHealth = game.player.health;

  game.projectiles.push({
    id: game.entityId++,
    kind: 'enemyCrystal',
    owner: 'enemy',
    x: game.player.x,
    y: game.player.y,
    vx: 0,
    vy: 0,
    radius: 9,
    life: 1,
    damage: 5,
    color: '#d86cff'
  });
  assert.doesNotThrow(() => game.updateProjectiles(0.016));
  assert.ok(game.player.health < startingHealth);
  assert.equal(game.projectiles.length, 0);

  game.projectiles.push({
    id: game.entityId++,
    kind: 'crystalBolt',
    owner: 'player',
    x: -100,
    y: -100,
    vx: -10,
    vy: 0,
    radius: 7,
    life: 1,
    damage: 5,
    color: '#ffffff'
  });
  const expiredTarget = enemyTarget(game, { x: game.player.x, y: game.player.y });
  game.enemies = [expiredTarget];
  assert.doesNotThrow(() => game.updateProjectiles(0.016));
  assert.equal(game.projectiles.length, 0);
  assert.equal(expiredTarget.hp, expiredTarget.maxHp);

  game.projectiles.push({
    id: game.entityId++,
    kind: 'crystalBolt',
    owner: 'player',
    x: game.player.x,
    y: game.player.y,
    vx: 0,
    vy: 0,
    radius: 7,
    life: 0.001,
    damage: 5,
    color: '#ffffff'
  });
  assert.doesNotThrow(() => game.updateProjectiles(0.016));
  assert.equal(game.projectiles.length, 0);
});

test('fast player projectiles cannot tunnel through walls during a long frame', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'WALL-SWEEP' });
  const firstRoom = { id: 1, x: 100, y: 200, width: 200, height: 300, type: 'start' };
  const secondRoom = { id: 2, x: 500, y: 200, width: 200, height: 300, type: 'guardian' };
  game.layout = {
    rooms: [firstRoom, secondRoom],
    corridors: [],
    startRoom: firstRoom,
    guardianRoom: secondRoom
  };
  game.player.x = 100;
  game.player.y = 200;
  const target = enemyTarget(game, { x: 550, y: 200, roomId: 2 });
  game.enemies = [target];
  game.ores = [];
  game.projectiles = [{
    id: game.entityId++,
    kind: 'crystalBolt',
    owner: 'player',
    x: 150,
    y: 200,
    vx: 1_000,
    vy: 0,
    radius: 7,
    life: 1,
    travelled: 0,
    maxRange: 1_000,
    damage: 50,
    color: '#ffffff'
  }];

  game.updateProjectiles(0.4);

  assert.equal(game.projectiles.length, 0);
  assert.equal(target.hp, target.maxHp);
});

test('mining drones only damage enemies with a clear path through the mine', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'DRONE-WALLS' });
  const firstRoom = { id: 1, x: 100, y: 200, width: 200, height: 300, type: 'start' };
  const secondRoom = { id: 2, x: 430, y: 200, width: 200, height: 300, type: 'combat' };
  game.layout = {
    rooms: [firstRoom, secondRoom],
    corridors: [],
    startRoom: firstRoom,
    guardianRoom: secondRoom
  };
  game.player.x = 100;
  game.player.y = 200;
  game.player.droneCount = 1;
  game.player.droneTimer = 0;
  game.run.elapsed = 0;
  const target = enemyTarget(game, { x: 430, y: 200, roomId: 2, hp: 200, maxHp: 200 });
  game.enemies = [target];
  game.tracers = [];

  game.updateDrone();
  assert.equal(target.hp, 200);
  assert.equal(game.tracers.length, 0);
  assert.equal(game.player.droneTimer, 0);

  game.layout.corridors.push({
    x: 265,
    y: 200,
    width: 330,
    height: 90,
    orientation: 'horizontal'
  });
  game.updateDrone();
  assert.ok(target.hp < 200);
  assert.equal(game.tracers.length, 1);
  assert.ok(game.player.droneTimer > 0);
});

test('Crystal Blaster bolts expire at their configured maximum range', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'BLASTER-RANGE' });
  const room = { id: 1, x: 700, y: 300, width: 1_400, height: 600, type: 'start' };
  game.layout = {
    rooms: [room],
    corridors: [],
    startRoom: room,
    guardianRoom: room
  };
  game.player.x = 100;
  game.player.y = 300;
  game.player.angle = 0;
  const target = enemyTarget(game, { x: 680, y: 300 });
  game.enemies = [target];
  game.ores = [];
  game.unlockWeapon('blaster');
  game.player.blasterEnergy = game.player.blasterEnergyMax;
  game.fireBlaster();
  const startX = game.projectiles[0].x;
  let furthestX = startX;
  for (let frame = 0; frame < 30 && game.projectiles.length; frame += 1) {
    game.updateProjectiles(0.05);
    furthestX = Math.max(furthestX, game.projectiles[0]?.x || furthestX);
  }

  assert.equal(game.projectiles.length, 0);
  assert.ok(furthestX <= startX + CONFIG.blasterRange + 8);
  assert.equal(target.hp, target.maxHp);
});

test('the Guardian acquires the player across rooms and stays contained in its vault', async () => {
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const stubs = installBrowserStubs();
  const game = new MattMineGame(stubs.canvas, stubs.profile);
  game.startRun({ mode: RUN_MODES.PRACTICE, seed: 'GUARDIAN-AWARENESS' });
  const firstRoom = { id: 1, x: 100, y: 200, width: 300, height: 300, type: 'start' };
  const guardianRoom = { id: 2, x: 700, y: 200, width: 300, height: 300, type: 'guardian' };
  game.layout = {
    rooms: [firstRoom, guardianRoom],
    corridors: [],
    startRoom: firstRoom,
    guardianRoom
  };
  game.roomStates = {
    1: { locked: false, cleared: true },
    2: { locked: false, cleared: false }
  };
  game.player.x = 100;
  game.player.y = 200;
  game.player.vx = 120;
  const guardian = enemyTarget(game, {
    type: 'guardian',
    isBoss: true,
    x: 700,
    y: 200,
    roomId: 2,
    radius: 56,
    hp: 620,
    maxHp: 620,
    speed: 56,
    awake: true,
    engaged: false,
    aiTimer: 1,
    attackTimer: 1,
    summonTimer: 4,
    lastBossPhase: 1
  });
  game.enemies = [guardian];
  game.layout.startRoom = { id: 99, x: -500, y: -500, width: 100, height: 100, type: 'start' };

  game.updateEnemies(0.1);

  assert.equal(guardian.engaged, true);
  assert.ok(guardian.vx < 0);
  assert.ok(guardian.x >= guardianRoom.x - guardianRoom.width / 2 + guardian.radius * 0.68);
});

test('production leaderboard copy never offers a test MATT claim', async () => {
  const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /CLAIM TEST MATT|Test claim recorded|test publisher/i);
  assert.match(source, /CONNECT WALLET TO CLAIM/);
  assert.match(source, /CLAIM MATT/);
});

test('profile saves recover invalid JSON and sanitize unsafe numeric fields', () => {
  const invalidJson = memoryStorage({ [PROFILE_STORAGE_KEY]: '{not-json' });
  assert.deepEqual(loadProfile(invalidJson), defaultProfile());
  assert.deepEqual(JSON.parse(invalidJson.value(PROFILE_STORAGE_KEY)), defaultProfile());

  const invalidSchema = memoryStorage({
    [PROFILE_STORAGE_KEY]: JSON.stringify({
      bankedNuggets: 'infinite',
      bestDepth: -4,
      bestScore: null,
      totalRuns: 2.9,
      meta: { health: 999, damage: -1, speed: 'fast', luck: 7.8 }
    })
  });
  const recovered = loadProfile(invalidSchema);
  assert.equal(recovered.bankedNuggets, 0);
  assert.equal(recovered.bestDepth, 0);
  assert.equal(recovered.totalRuns, 2);
  assert.deepEqual(recovered.meta, {
    health: 25,
    damage: 0,
    speed: 0,
    luck: 7,
    magnet: 0,
    armor: 0,
    dash: 0,
    blaster: 0
  });
  assert.deepEqual(JSON.parse(invalidSchema.value(PROFILE_STORAGE_KEY)), recovered);
});

test('economy saves recover invalid JSON and discard corrupt nested records', () => {
  const invalidJson = memoryStorage({ [ECONOMY_STORAGE_KEY]: '{not-json' });
  const recoveredStore = new LocalEconomyStore(invalidJson);
  assert.deepEqual(recoveredStore.state, defaultEconomyState());
  assert.deepEqual(JSON.parse(invalidJson.value(ECONOMY_STORAGE_KEY)), defaultEconomyState());

  const normalized = normalizeEconomyState({
    walletId: 123,
    player: { paidRunCredits: -9, passXp: 'lots', banned: 'false' },
    settings: {
      passPriceRon: -1,
      paidSplitCurrentPercent: 99,
      paidSplitFuturePercent: 99,
      paidSplitReservePercent: 99,
      rankedPaused: 'true'
    },
    daily: {
      bad: { freeRunUsed: true },
      '2026-07-25': { freeRunUsed: 'yes', paidRunsPurchased: 999, paidRunsUsed: -3 }
    },
    runs: [null, 'broken', { mode: RUN_MODES.FREE, score: 'huge' }],
    publishedRewards: 'broken',
    audit: [null, { action: 99 }]
  });
  assert.equal(normalized.walletId, 'TEST-WALLET-01');
  assert.equal(normalized.player.paidRunCredits, 0);
  assert.equal(normalized.player.banned, false);
  assert.equal(normalized.settings.passPriceRon, 95);
  assert.equal(normalized.settings.rankedPaused, false);
  assert.equal(normalized.settings.paidSplitCurrentPercent, 70);
  assert.deepEqual(normalized.daily['2026-07-25'], {
    freeRunUsed: false,
    paidRunsPurchased: 0,
    paidRunsUsed: 0
  });
  assert.equal(normalized.runs.length, 1);
  assert.equal(normalized.runs[0].score, 0);
  assert.deepEqual(normalized.publishedRewards, []);
  assert.equal(normalized.audit.length, 1);
});

test('free and pass scoring stay separate, use daily bests, and score knockouts at secured loot', () => {
  let state = defaultEconomyState();
  const add = (mode, offset, projected, extracted = true, banked = projected) => {
    const timestamp = NOW + offset * 86_400_000;
    const result = recordRun(state, {
      mode,
      projected,
      banked,
      extracted,
      day: utcDayKey(timestamp),
      week: utcWeekKey(timestamp),
      rewardWeight: 999
    }, timestamp);
    assert.equal(result.ok, true);
    state = result.state;
    return result.entry;
  };

  add(RUN_MODES.FREE, 0, 100);
  const freeKnockout = add(RUN_MODES.FREE, 1, 500, false, 175);
  add(RUN_MODES.PAID, 0, 300);
  add(RUN_MODES.PAID, 0, 450);
  add(RUN_MODES.PAID, 1, 400, false, 140);
  add(RUN_MODES.PRACTICE, 0, 99_999);

  assert.equal(freeKnockout.score, 175);
  assert.equal(freeKnockout.rewardWeight, 1);
  assert.equal(weeklyUserScore(state, RUN_MODES.FREE, NOW), 275);
  assert.equal(weeklyUserScore(state, RUN_MODES.PAID, NOW), 590);
  assert.equal(weeklyUserScore(state, RUN_MODES.PRACTICE, NOW), 0);
});

test('competition suspension blocks ranked access, purchases, and score submission but not practice', () => {
  const pass = purchasePass(defaultEconomyState(), NOW);
  assert.equal(pass.ok, true);
  assert.equal(passIsActive(pass.state, NOW), true);
  const banned = setWalletBan(pass.state, true, ADMIN_ROLES.MODERATOR, NOW + 1);
  assert.equal(banned.ok, true);
  assert.equal(runAccess(banned.state, RUN_MODES.FREE, NOW + 2).allowed, false);
  assert.equal(runAccess(banned.state, RUN_MODES.PAID, NOW + 2).allowed, false);
  assert.equal(runAccess(banned.state, RUN_MODES.PRACTICE, NOW + 2).allowed, true);
  assert.equal(purchasePass(banned.state, NOW + 2).ok, false);
  assert.equal(purchasePaidRun(banned.state, NOW + 2).ok, false);
  assert.equal(consumeRun(banned.state, RUN_MODES.FREE, NOW + 2).ok, false);
  assert.equal(recordRun(banned.state, {
    mode: RUN_MODES.FREE,
    projected: 100,
    banked: 100,
    extracted: true,
    day: utcDayKey(NOW),
    week: utcWeekKey(NOW)
  }, NOW + 2).ok, false);
  assert.equal(recordRun(banned.state, {
    mode: RUN_MODES.PRACTICE,
    projected: 100,
    extracted: true
  }, NOW + 2).ok, true);
  assert.equal(setWalletBan(banned.state, false, ADMIN_ROLES.GAME, NOW + 3).ok, false);
  const restored = setWalletBan(banned.state, false, ADMIN_ROLES.MODERATOR, NOW + 3);
  assert.equal(restored.ok, true);
  assert.equal(runAccess(restored.state, RUN_MODES.FREE, NOW + 4).allowed, true);
});

test('admin settings reject unknown, malformed, and cross-role changes', () => {
  const state = defaultEconomyState();
  assert.equal(updateAdminSettings(state, { hiddenOverride: true }, ADMIN_ROLES.GAME, NOW).ok, false);
  assert.equal(updateAdminSettings(state, { rankedPaused: 'yes' }, ADMIN_ROLES.PAUSER, NOW).ok, false);
  assert.equal(updateAdminSettings(state, { passPriceRon: Number.NaN }, ADMIN_ROLES.PRICE, NOW).ok, false);
  assert.equal(updateAdminSettings(state, { maxPaidRunsPerDay: 20 }, ADMIN_ROLES.PRICE, NOW).ok, false);
  assert.equal(updateAdminSettings(state, { maxPaidRunsPerDay: 2.5 }, ADMIN_ROLES.GAME, NOW).ok, false);
  assert.equal(updateAdminSettings(state, { freeWeeklyPoolMatt: 10.5 }, ADMIN_ROLES.TREASURY, NOW).ok, false);
  const updated = updateAdminSettings(state, { maxPaidRunsPerDay: 20 }, ADMIN_ROLES.GAME, NOW);
  assert.equal(updated.ok, true);
  assert.equal(updated.state.settings.maxPaidRunsPerDay, 20);
});
