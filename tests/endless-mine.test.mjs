import test from 'node:test';
import assert from 'node:assert/strict';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import { materializeCompetitionMap, validateCompetitionMap } from '../src/game/competitionStudio.js';
import { segmentInLayout } from '../src/game/layout.js';
import {
  calculateDangerRating,
  calculateMinerCapability,
  ENDLESS_CONSERVATIVE_ECONOMY_PRESET,
  defaultEndlessConfig,
  endlessDifficultyBudget,
  endlessPhasePointBudget,
  generateEndlessPhase,
  normalizeEndlessConfig,
  solveExactIntegerBudget,
  validateEndlessConfig,
  validateEndlessManifest
} from '../src/game/endlessMine.js';

const NOOP_AUDIO = {
  startMusic() {}, resume() {}, stopBoss() {}, stopMusic() {}, play() {}, startBoss() {}
};

test('Endless phase generation is deterministic, unique by run, and reconstructable', () => {
  const config = defaultEndlessConfig();
  const options = { runId: 'run-alpha', runSeed: 'server-seed', phase: 37, configVersion: 4, config };
  const first = generateEndlessPhase(options);
  const second = generateEndlessPhase(options);
  const otherRun = generateEndlessPhase({ ...options, runId: 'run-bravo' });
  const otherPhase = generateEndlessPhase({ ...options, phase: 38 });
  assert.deepEqual(first, second);
  assert.notEqual(first.fingerprint, otherRun.fingerprint);
  assert.notEqual(first.fingerprint, otherPhase.fingerprint);
  assert.equal(validateEndlessManifest(first, config).ok, true);
});

test('Endless map v1 remains replayable while corrected runs use map v2', () => {
  const legacyConfig = defaultEndlessConfig();
  legacyConfig.generatorVersion = 'endless-map-v1';
  const legacy = generateEndlessPhase({
    runId: 'legacy-run', runSeed: 'legacy-seed', phase: 12, configVersion: 2, config: legacyConfig
  });
  const repeated = generateEndlessPhase({
    runId: 'legacy-run', runSeed: 'legacy-seed', phase: 12, configVersion: 2, config: legacyConfig
  });
  assert.deepEqual(legacy, repeated);
  assert.equal(legacy.generatorVersion, 'endless-map-v1');
  assert.equal(validateEndlessManifest(legacy, legacyConfig).ok, true);

  const corrected = generateEndlessPhase({
    runId: 'corrected-run', runSeed: 'corrected-seed', phase: 12,
    configVersion: 3, config: defaultEndlessConfig()
  });
  assert.equal(corrected.generatorVersion, 'endless-map-v2');
  assert.equal(corrected.map.corridors.every((corridor) => {
    const a = corrected.map.rooms.find((room) => room.id === corridor.from);
    const b = corrected.map.rooms.find((room) => room.id === corridor.to);
    return a.x === b.x || a.y === b.y;
  }), true);
});

test('Endless manifests use the same validated map schema and renderer path as Pass Mine', () => {
  for (let phase = 1; phase <= 100; phase += 1) {
    const manifest = generateEndlessPhase({
      runId: `run-pass-style-${phase}`, runSeed: 'server-pass-style', phase,
      configVersion: 3, config: defaultEndlessConfig()
    });
    const validation = validateCompetitionMap(manifest.map);
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    const materialized = materializeCompetitionMap(manifest.map);
    assert.ok(materialized.startRoom);
    assert.ok(materialized.guardianRoom);
    assert.equal(materialized.objects.length, manifest.map.objects.length);
    assert.ok(materialized.guardianRoom.width >= 2.8 * 170);
    assert.ok(materialized.guardianRoom.height >= 2.6 * 155);

    const sourceRooms = new Map(manifest.map.rooms.map((room) => [room.id, room]));
    const runtimeRooms = new Map(materialized.rooms.map((room) => [room.sourceId, room]));
    for (const corridor of manifest.map.corridors) {
      const sourceA = sourceRooms.get(corridor.from);
      const sourceB = sourceRooms.get(corridor.to);
      assert.ok(sourceA.x === sourceB.x || sourceA.y === sourceB.y, `${corridor.id} is diagonal`);
      const a = runtimeRooms.get(corridor.from);
      const b = runtimeRooms.get(corridor.to);
      assert.equal(
        segmentInLayout(materialized, a.x, a.y, b.x, b.y, 18),
        true,
        `${corridor.id} is not continuously traversable`
      );
      assert.equal(materialized.corridors.filter((entry) => entry.sourceId === corridor.id).length, 1);
    }
  }
});

test('the exact point solver and every sampled phase have no score drift', () => {
  assert.deepEqual(solveExactIntegerBudget(11, [1, 1, 1]), [4, 4, 3]);
  const config = defaultEndlessConfig();
  for (let phase = 1; phase <= 1_000; phase += 1) {
    const manifest = generateEndlessPhase({
      runId: `run-${phase % 31}`,
      runSeed: `seed-${phase % 17}`,
      phase,
      configVersion: 9,
      config
    });
    const validation = validateEndlessManifest(manifest, config);
    assert.equal(validation.ok, true, `phase ${phase}: ${validation.errors.join(' ')}`);
    assert.equal(validation.collectibleMaximum, endlessPhasePointBudget(phase, config));
    assert.equal(manifest.pointLedger.total, manifest.pointBudget);
  }
  const deep = generateEndlessPhase({
    runId: 'run-deep-load',
    runSeed: 'server-deep-seed',
    phase: 10_000,
    configVersion: 9,
    config
  });
  assert.equal(validateEndlessManifest(deep, config).ok, true);
  assert.equal(deep.pointLedger.total, deep.pointBudget);
});

test('difficulty is separate from points and danger compares trusted Miner capability', () => {
  const config = defaultEndlessConfig();
  const capability = calculateMinerCapability({
    traits: { level: 20, health: 150, damage: 18, armor: 4, speed: 1.2, luck: 3, crystalCarryCapacity: 25 },
    equipment: { helmet: { power: 9 }, armor: { power: 14 } }
  });
  assert.ok(capability.rating > 0);
  assert.ok(endlessDifficultyBudget(100, config) > endlessDifficultyBudget(1, config));
  assert.equal(endlessPhasePointBudget(1, config), endlessPhasePointBudget(5, config));
  assert.match(calculateDangerRating(endlessDifficultyBudget(100, config), capability).tier, /LOW|GUARDED|HIGH|SEVERE|EXTREME/);
});

test('Endless Guardian balance is lower at phase one and independently Admin-adjustable', () => {
  const reducedConfig = defaultEndlessConfig();
  const baselineConfig = defaultEndlessConfig();
  baselineConfig.difficulty.guardianHealthScale = 1;
  baselineConfig.difficulty.guardianDamageScale = 1;

  const reducedManifest = generateEndlessPhase({
    runId: 'guardian-balance', runSeed: 'guardian-balance-seed', phase: 1,
    configVersion: 4, config: reducedConfig
  });
  const baselineManifest = generateEndlessPhase({
    runId: 'guardian-balance', runSeed: 'guardian-balance-seed', phase: 1,
    configVersion: 4, config: baselineConfig
  });
  assert.deepEqual(reducedManifest.difficulty.guardianStatScale, { health: 0.6, damage: 0.75 });
  assert.deepEqual(baselineManifest.difficulty.guardianStatScale, { health: 1, damage: 1 });

  const start = (config, manifest) => {
    const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
    game.startRun({
      mode: 'endless', runId: 'guardian-balance', seed: 'guardian-balance-seed',
      endlessRunId: 'guardian-balance', endlessConfigVersion: 4,
      endlessSnapshot: { config }, endlessManifest: manifest,
      nftRun: { profile: { traits: { level: 1, crystalCarryCapacity: 50 } } },
      tuning: {}
    });
    return game;
  };
  const reduced = start(reducedConfig, reducedManifest);
  const baseline = start(baselineConfig, baselineManifest);
  assert.deepEqual(
    reduced.enemies.filter((enemy) => !enemy.isBoss).map((enemy) => [enemy.type, enemy.maxHp, enemy.damage]),
    baseline.enemies.filter((enemy) => !enemy.isBoss).map((enemy) => [enemy.type, enemy.maxHp, enemy.damage])
  );

  reduced.run.bossReady = true;
  baseline.run.bossReady = true;
  const reducedGuardian = reduced.awakenGuardian(reduced.layout.guardianRoom);
  const baselineGuardian = baseline.awakenGuardian(baseline.layout.guardianRoom);
  assert.equal(reducedGuardian.maxHp, 492);
  assert.equal(reducedGuardian.damage, 18.75);
  assert.equal(reducedGuardian.maxHp, baselineGuardian.maxHp * 0.6);
  assert.equal(reducedGuardian.damage, baselineGuardian.damage * 0.75);
});

test('activation validation fails closed instead of guessing an economy', () => {
  const draft = defaultEndlessConfig();
  const inactive = validateEndlessConfig(draft, { forActivation: true });
  assert.equal(inactive.ok, false);
  assert.match(inactive.errors.join(' '), /economy version/i);
  const configured = normalizeEndlessConfig({
    ...draft,
    rewards: {
      ...draft.rewards,
      economyVersion: 'ronin-endless-v1',
      crystalConversionNumerator: 1,
      crystalConversionDenominator: 1,
      mineableCrystalUnits: 3_750,
      maximumPayoutNumerator: 10,
      maximumPayoutDenominator: 1,
      maximumDailyPayoutNumerator: 500,
      maximumDailyPayoutDenominator: 1,
      maximumPhases: 1_000_000,
      phaseXp: 10,
      maximumRunXp: 500,
      maximumWalletXpPerDay: 2_500,
      maximumMinerXpPerDay: 2_500,
      checkpointTimeoutSeconds: 86_400,
      failedRunsRetainXp: false
    }
  });
  assert.deepEqual(validateEndlessConfig(configured, { forActivation: true }).errors, []);
  const unsafeDaily = structuredClone(configured);
  unsafeDaily.rewards.maximumDailyPayoutNumerator = 9;
  assert.match(validateEndlessConfig(unsafeDaily, { forActivation: true }).errors.join(' '), /daily.*lower/i);
  assert.match(validateEndlessConfig({
    ...configured,
    entry: { paidEnabled: true, mattPrice: 10_000_001 }
  }).errors.join(' '), /between 0 and 10000000/i);
  assert.match(validateEndlessConfig({
    ...configured,
    entry: { ...configured.entry, resetUtcHour: 24 }
  }).errors.join(' '), /reset UTC hour.*between 0 and 23/i);
});

test('entry limits normalize as explicit adjustable Admin rules', () => {
  const config = normalizeEndlessConfig({
    ...defaultEndlessConfig(),
    entry: {
      paidEnabled: false,
      mattPrice: 0,
      entriesPerWallet: 5,
      entriesPerMiner: 2,
      resetPeriodHours: 168,
      resetUtcHour: 17,
      cooldownSeconds: 3_600,
      maximumActiveRunsPerWallet: 3,
      minimumMinerLevel: 9,
      abandonedRunsConsumeEntry: false
    }
  });
  assert.deepEqual(config.entry, {
    paidEnabled: false,
    mattPrice: 0,
    entriesPerWallet: 5,
    entriesPerMiner: 2,
    resetPeriodHours: 168,
    resetUtcHour: 17,
    cooldownSeconds: 3_600,
    maximumActiveRunsPerWallet: 3,
    minimumMinerLevel: 9,
    abandonedRunsConsumeEntry: false
  });
});

test('Endless v2 Guardian and corridor geometry stays exactly Admin-adjustable', () => {
  const config = defaultEndlessConfig();
  config.generation.guardianRoomWidth = 3.5;
  config.generation.guardianRoomHeight = 3;
  config.generation.corridorWidthMinimum = 1.25;
  config.generation.corridorWidthMaximum = 1.25;
  const manifest = generateEndlessPhase({
    runId: 'geometry-adjustment', runSeed: 'geometry-seed', phase: 1, configVersion: 4, config
  });
  const guardian = manifest.map.rooms.find((room) => room.type === 'guardian');
  assert.equal(guardian.width, 3.5);
  assert.equal(guardian.height, 3);
  assert.equal(manifest.map.corridors.every((corridor) => corridor.width === 1.25), true);
  assert.equal(validateEndlessManifest(manifest, config).ok, true);

  const invalid = structuredClone(config);
  invalid.generation.corridorWidthMinimum = 1.5;
  invalid.generation.corridorWidthMaximum = 1;
  assert.match(validateEndlessConfig(invalid).errors.join(' '), /Maximum corridor width/i);
});

test('authoritative replay limits are explicit adjustable Admin rules with permanent bounds', () => {
  const draft = defaultEndlessConfig();
  draft.integrity = {
    ...draft.integrity,
    maximumInputEventsPerPhase: 123_456,
    inputClockToleranceSeconds: 17,
    maximumPhaseSeconds: 7_200
  };
  const config = normalizeEndlessConfig(draft);
  assert.equal(config.integrity.maximumInputEventsPerPhase, 123_456);
  assert.equal(config.integrity.inputClockToleranceSeconds, 17);
  assert.equal(config.integrity.maximumPhaseSeconds, 7_200);
  const invalid = structuredClone(draft);
  invalid.integrity.maximumInputEventsPerPhase = 1_000_001;
  invalid.integrity.inputClockToleranceSeconds = 61;
  assert.match(
    validateEndlessConfig(invalid).errors.join(' '),
    /Maximum input events.*between 100 and 1000000.*Input clock tolerance.*between 1 and 60/i
  );
});

test('the conservative economy preset is exact, bounded, and remains Admin-adjustable', () => {
  const draft = defaultEndlessConfig();
  draft.rewards = { ...draft.rewards, ...ENDLESS_CONSERVATIVE_ECONOMY_PRESET };
  const validation = validateEndlessConfig(draft, { forActivation: true });
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.config.rewards.crystalConversionNumerator, 1);
  assert.equal(validation.config.rewards.crystalConversionDenominator, 400);
  assert.equal(validation.config.rewards.maximumPayoutNumerator, 10);
  assert.equal(validation.config.rewards.maximumDailyPayoutNumerator, 500);
});

test('map validator rejects unreachable rooms, point drift, and a forged boss gate', () => {
  const config = defaultEndlessConfig();
  const manifest = generateEndlessPhase({ runId: 'run-a', runSeed: 'seed-a', phase: 1, configVersion: 1, config });
  const unreachable = structuredClone(manifest);
  unreachable.fingerprint = '';
  unreachable.map.corridors = [];
  assert.match(validateEndlessManifest(unreachable, config).errors.join(' '), /reachable/i);

  const diagonal = structuredClone(manifest);
  diagonal.fingerprint = '';
  const linkedRoom = diagonal.map.rooms.find((room) => room.id === diagonal.map.corridors[0].to);
  linkedRoom.y += 0.01;
  assert.match(validateEndlessManifest(diagonal, config).errors.join(' '), /shared X or Y doorway axis/i);

  const drift = structuredClone(manifest);
  drift.fingerprint = '';
  drift.map.objects.find((object) => object.points > 0).points += 1;
  assert.match(validateEndlessManifest(drift, config).errors.join(' '), /does not equal phase budget/i);

  const forged = structuredClone(manifest);
  forged.fingerprint = '';
  forged.gate.requiredEnemyIds.pop();
  assert.match(validateEndlessManifest(forged, config).errors.join(' '), /required enemy/i);
});

test('runtime uses manifest IDs and crystals never unlock the Endless Guardian', () => {
  const config = defaultEndlessConfig();
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({
    mode: 'endless',
    runId: 'run-runtime',
    seed: 'runtime-seed',
    endlessRunId: 'run-runtime',
    endlessConfigVersion: 1,
    endlessSnapshot: { config },
    nftRun: { profile: { traits: { level: 1, crystalCarryCapacity: 50 } } },
    tuning: {}
  });
  assert.ok(game.run.endlessRequiredRemaining > 0);
  game.run.crystals = 9_999;
  game.updatePickups(0);
  assert.equal(game.run.bossReady, false);

  const required = game.enemies.filter((enemy) => enemy.requiredForBoss);
  assert.equal(required.length, game.run.endlessManifest.gate.requiredCount);
  for (const enemy of required) game.killEnemy(enemy);
  assert.equal(game.run.endlessRequiredRemaining, 0);
  assert.equal(game.run.bossReady, true);
});
