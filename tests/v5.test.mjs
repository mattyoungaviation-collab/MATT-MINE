import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.deepEqual(recovered.meta, { health: 10, damage: 0, speed: 0, luck: 7 });
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
