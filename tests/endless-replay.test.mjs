import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CompetitiveReplayService,
  endlessPhaseOutcomeEvents,
  latestEndlessDecisionEvents
} from '../server/competitive-replay-service.js';
import { MemoryCompetitiveReplayStore } from '../server/competitive-replay-store.js';
import {
  applyReplayCommand,
  replayArenaTranscript,
  ARENA_TRANSCRIPT_VERSION
} from '../server/arena-engine.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { generateEndlessPhase, normalizeEndlessConfig, defaultEndlessConfig } from '../src/game/endlessMine.js';
import { gameplayRuntimeSnapshot } from '../src/game/nftTraits.js';
import { defaultProfile } from '../src/game/storage.js';
import { captureEndlessContinuation } from '../src/game/endlessContinuation.js';
import { pointInLayout } from '../src/game/layout.js';
import { verifyEndlessPhaseEvents } from '../server/endless-engine.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const RUN_TOKEN = 'ab'.repeat(24);
const NOOP_AUDIO = Object.freeze({
  startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {}
});

function endlessRun() {
  const config = normalizeEndlessConfig(defaultEndlessConfig());
  const minerProfile = {
    progression: { level: 6, bankedXp: 1_250 },
    gameplay: { crystalCarryCapacity: 12 },
    traits: { level: 6, health: 150, damage: 20, armor: 4, speed: 1, luck: 1, crystalCarryCapacity: 12 },
    equipped: {}
  };
  const run = {
    id: 'run_1234567890abcdef12345678',
    address: ADDRESS,
    mode: 'endless',
    status: 'active',
    runSeed: 'MATT-ENDLESS-AUTHORITATIVE-REPLAY',
    currentPhase: 1,
    phaseAttempt: 1,
    configVersion: 1,
    config,
    minerId: 7,
    minerProfile,
    phaseStartedAt: 1_000_000,
    startedAt: 1_000_000,
    expiresAt: 20_000_000
  };
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: run.currentPhase,
    configVersion: run.configVersion,
    config,
    minerProfile
  });
  return run;
}

test('Endless replay accepts the authenticated upgrade even when its random offer differs', () => {
  const run = endlessRun();
  const game = createHeadlessEndlessGame(run, run.manifest);
  game.state = 'levelup';
  game.pendingUpgradeIds = ['speed'];

  applyReplayCommand(game, { command: 'upgrade', value: 'power' }, { mode: 'endless' });

  assert.equal(game.player.runUpgradeCounts.power, 1);
  assert.equal(game.state, 'playing');
  assert.deepEqual(game.pendingUpgradeIds, []);
});

test('Endless retries keep only the latest extract or descend decision', () => {
  const events = latestEndlessDecisionEvents([
    { seq: 1, tick: 0, type: 'input', moveX: 0, moveY: 0, aim: null, attack: false, dash: false, weapon: '' },
    { seq: 2, tick: 20, type: 'command', command: 'descend' },
    { seq: 3, tick: 20, type: 'command', command: 'extract' }
  ]);

  assert.deepEqual(events.map((event) => event.seq), [1, 2]);
  assert.equal(events.at(-1).command, 'extract');
  assert.equal(events.some((event) => event.command === 'descend'), false);
});

test('Endless settlement ignores replay-only knockout and other non-scoring events', () => {
  const events = endlessPhaseOutcomeEvents([
    { type: 'damage_taken', tick: 100, amount: 10 },
    { type: 'knockout', tick: 120 },
    { type: 'future_visual_event', tick: 120 },
    { type: 'phase_completed', tick: 120 }
  ]);

  assert.deepEqual(events.map((event) => event.type), ['damage_taken', 'phase_completed']);
});

test('a replay-only knockout at phase five cannot block the signed descend choice', () => {
  const run = endlessRun();
  run.currentPhase = 5;
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: run.currentPhase,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  const outcomeEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: NOOP_AUDIO,
    onArenaEvent(event) { outcomeEvents.push(structuredClone(event)); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: run.currentPhase,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  game.player.health = 0;
  game.endRun(false);

  applyReplayCommand(game, { command: 'descend', tick: 0 }, {
    mode: 'endless',
    maxDepth: 6
  });

  const settlementEvents = endlessPhaseOutcomeEvents(outcomeEvents);
  assert.equal(game.state, 'playing');
  assert.equal(game.run.depth, 6);
  assert.equal(game.player.health, game.player.maxHealth);
  assert.equal(settlementEvents.some((event) => event.type === 'knockout'), false);
  const phase = verifyEndlessPhaseEvents(run, settlementEvents, 1_010_000);
  assert.equal(phase.bossKills, 1);
});

test('Endless verification accepts the latest signed decision after an earlier one failed', async () => {
  const run = endlessRun();
  run.minerProfile = {
    progression: { level: 50, bankedXp: 90_000 },
    gameplay: {
      maximumHealth: 10_000, armorShield: 2_000, pickaxeAttack: 1_500,
      blasterAttack: 1_500, dynamiteAttack: 2_000, healAmount: 500,
      carryCapacity: 100, deathRetentionBps: 8_000, level: 50
    },
    traits: { level: 50, health: 10_000, damage: 1_500, armor: 2_000, speed: 1, luck: 1, crystalCarryCapacity: 100 },
    equipped: {}
  };
  run.manifest = generateEndlessPhase({
    runId: run.id, runSeed: run.runSeed, phase: 1,
    configVersion: run.configVersion, config: run.config, minerProfile: run.minerProfile
  });
  const inputEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true, audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  driveEndlessPhaseWithControls(game);
  const decisionTick = Math.round(game.run.elapsed * 1_000);
  inputEvents.push({ type: 'command', tick: decisionTick, command: 'descend' });
  inputEvents.push({ type: 'command', tick: decisionTick, command: 'extract' });

  const service = await new CompetitiveReplayService({
    store: new MemoryCompetitiveReplayStore(),
    secret: 'endless-latest-decision-replay-test-secret',
    now: () => 1_100_000,
    resolveRun: async () => run
  }).init();
  let checkpoint = await service.registerEndlessPhase(run, RUN_TOKEN);
  const sequenced = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  for (let offset = 0; offset < sequenced.length; offset += 256) {
    checkpoint = await service.appendEndlessPhase(ADDRESS, {
      runId: run.id, runToken: RUN_TOKEN, phase: 1,
      previousCheckpoint: checkpoint,
      events: sequenced.slice(offset, offset + 256)
    });
  }

  const verified = await service.verifyEndlessPhase({ run, checkpoint, action: 'bank' });
  assert.equal(verified.evidence.state, 'ended');
  assert.equal(verified.outcomeEvents.at(-1)?.type, 'extract');
});

test('an active legacy Endless replay can verify extraction after Medic Pack and Force Field activations', async () => {
  const run = endlessRun();
  run.minerProfile = {
    progression: { level: 50, bankedXp: 90_000 },
    gameplay: {
      maximumHealth: 10_000, armorShield: 0, pickaxeAttack: 1_500,
      blasterAttack: 1_500, dynamiteAttack: 2_000, healAmount: 500,
      carryCapacity: 100, deathRetentionBps: 8_000, level: 50
    },
    traits: { level: 50, health: 10_000, damage: 1_500, armor: 0, speed: 1, luck: 1, crystalCarryCapacity: 100 },
    equipped: {}
  };
  run.consumables = {
    loadout: { 'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 0 },
    definitions: {},
    reservedAt: 1_000_000
  };
  run.manifest = generateEndlessPhase({
    runId: run.id, runSeed: run.runSeed, phase: 1,
    configVersion: run.configVersion, config: run.config, minerProfile: run.minerProfile
  });

  const inputEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true, audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile },
    tuning: { _consumables: structuredClone(run.consumables) }
  });
  const damageTarget = game.enemies.find((enemy) => !enemy.isBoss);
  assert.ok(damageTarget, 'The phase needs a natural enemy for the Medic Pack replay check.');
  let damageWaypoint = null;
  for (let step = 0; step < 4_000 && game.player.health >= game.player.maxHealth; step += 1) {
    if (step % 20 === 0 || !damageWaypoint) damageWaypoint = nextPathWaypoint(game, damageTarget);
    const destination = damageWaypoint || damageTarget;
    const dx = destination.x - game.player.x;
    const dy = destination.y - game.player.y;
    const distance = Math.hypot(dx, dy) || 1;
    game.applyArenaControlStep({
      moveX: dx / distance,
      moveY: dy / distance,
      aim: Math.atan2(dy, dx),
      attack: false,
      dash: false,
      weapon: 'pickaxe'
    }, true);
  }
  assert.ok(game.player.health < game.player.maxHealth);
  const damagedHealth = game.player.health;
  assert.equal(game.useConsumable('medic-pack'), true);
  assert.equal(game.player.health, Math.min(game.player.maxHealth, damagedHealth + 25));
  assert.equal(game.useConsumable('mythical-force-field'), true);
  driveEndlessPhaseWithControls(game);
  inputEvents.push({ type: 'command', tick: Math.round(game.run.elapsed * 1_000), command: 'extract' });

  const store = new MemoryCompetitiveReplayStore();
  const service = await new CompetitiveReplayService({
    store,
    secret: 'endless-consumable-recovery-test-secret',
    now: () => 1_100_000,
    resolveRun: async () => run
  }).init();
  let checkpoint = await service.registerEndlessPhase(run, RUN_TOKEN);

  // Reproduce a replay record created before Consumables were included in the
  // immutable phase snapshot. Active production runs must remain recoverable.
  const replayRecord = [...store.runs.values()][0];
  replayRecord.runSnapshot.challenge.tuning = {};
  delete replayRecord.runSnapshot.consumables;
  replayRecord.replaySchemaVersion = 'matt-endless-phase-input-v1';

  const sequenced = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  for (let offset = 0; offset < sequenced.length; offset += 256) {
    checkpoint = await service.appendEndlessPhase(ADDRESS, {
      runId: run.id, runToken: RUN_TOKEN, phase: 1,
      previousCheckpoint: checkpoint,
      events: sequenced.slice(offset, offset + 256)
    });
  }

  const verified = await service.verifyEndlessPhase({ run, checkpoint, action: 'bank' });
  assert.equal(verified.evidence.state, 'ended');
  assert.equal(verified.outcomeEvents.at(-1)?.type, 'extract');
});

test('legitimate Endless controls reproduce the exact browser runtime and outcome events', () => {
  const run = endlessRun();
  const inputEvents = [];
  const browserOutcomes = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); },
    onArenaEvent(event) { browserOutcomes.push(structuredClone(event)); }
  });
  game.startRun({
    mode: 'endless',
    seed: run.runSeed,
    currentPhase: run.currentPhase,
    endlessRunId: run.id,
    endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config },
    endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });

  const control = { moveX: 1, moveY: 0, aim: 0, attack: true, dash: false, weapon: 'pickaxe' };
  for (let step = 0; step < 100 && game.state === 'playing'; step += 1) {
    game.applyArenaControlStep(control, true);
  }
  const elapsedTick = Math.round((game.run?.elapsed || 0) * 1_000);
  inputEvents.push({
    type: 'input', tick: elapsedTick, moveX: 0, moveY: 0, aim: null,
    attack: false, dash: false, weapon: ''
  });
  const sequenced = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  const replayed = replayArenaTranscript({
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed: run.runSeed,
    tickMs: 20,
    maxTicks: run.config.integrity.maximumPhaseSeconds * 1_000,
    maxEvents: 1_000_000,
    maxDepth: run.currentPhase + 1,
    verificationMode: 'deterministic-input-replay',
    tuning: {}
  }, sequenced, {
    mode: 'endless',
    currentPhase: run.currentPhase,
    endlessRunId: run.id,
    endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config },
    endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });

  assert.equal(replayed.elapsedMs, elapsedTick);
  assert.deepEqual(replayed.runtime, gameplayRuntimeSnapshot(game));
  assert.deepEqual(replayed.outcomeEvents, browserOutcomes);
});

test('a complete legitimate phase reaches an authoritative verified descent from raw controls alone', () => {
  const run = endlessRun();
  run.minerProfile = {
    progression: { level: 50, bankedXp: 90_000 },
    gameplay: {
      maximumHealth: 10_000, armorShield: 2_000, pickaxeAttack: 1_500,
      blasterAttack: 1_500, dynamiteAttack: 2_000, healAmount: 500,
      carryCapacity: 100, deathRetentionBps: 8_000, level: 50
    },
    traits: { level: 50, health: 10_000, damage: 1_500, armor: 2_000, speed: 1, luck: 1, crystalCarryCapacity: 100 },
    equipped: {}
  };
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: 1,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  const inputEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  driveEndlessPhaseWithControls(game);
  assert.equal(game.state, 'depthchoice');
  inputEvents.push({ type: 'command', tick: Math.round(game.run.elapsed * 1_000), command: 'descend' });
  const events = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  const replayed = replayArenaTranscript({
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed: run.runSeed,
    tickMs: 20,
    maxTicks: run.config.integrity.maximumPhaseSeconds * 1_000,
    maxEvents: run.config.integrity.maximumInputEventsPerPhase,
    maxDepth: 2,
    verificationMode: 'deterministic-input-replay',
    tuning: {}
  }, events, {
    mode: 'endless', maxDepth: 2, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  assert.equal(replayed.state, 'playing');
  assert.equal(replayed.depth, 2);
  assert.ok(replayed.outcomeEvents.some((event) => event.type === 'phase_completed'));
});

test('a verified Endless extract command banks without an impossible second finish marker', () => {
  const run = endlessRun();
  run.minerProfile = {
    progression: { level: 50, bankedXp: 90_000 },
    gameplay: {
      maximumHealth: 10_000, armorShield: 2_000, pickaxeAttack: 1_500,
      blasterAttack: 1_500, dynamiteAttack: 2_000, healAmount: 500,
      carryCapacity: 100, deathRetentionBps: 8_000, level: 50
    },
    traits: { level: 50, health: 10_000, damage: 1_500, armor: 2_000, speed: 1, luck: 1, crystalCarryCapacity: 100 },
    equipped: {}
  };
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: 1,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  const inputEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  driveEndlessPhaseWithControls(game);
  assert.equal(game.state, 'depthchoice');
  inputEvents.push({ type: 'command', tick: Math.round(game.run.elapsed * 1_000), command: 'extract' });
  const events = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  const replayed = replayArenaTranscript({
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed: run.runSeed,
    tickMs: 20,
    maxTicks: run.config.integrity.maximumPhaseSeconds * 1_000,
    maxEvents: run.config.integrity.maximumInputEventsPerPhase,
    maxDepth: 2,
    verificationMode: 'deterministic-input-replay',
    tuning: {}
  }, events, {
    mode: 'endless', requireTerminal: false, maxDepth: 2, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });

  assert.equal(events.at(-1).type, 'command');
  assert.equal(events.at(-1).command, 'extract');
  assert.equal(replayed.terminal, false);
  assert.equal(replayed.state, 'ended');
  assert.equal(replayed.extracted, true);
  assert.equal(replayed.outcomeEvents.at(-1)?.type, 'extract');
  const verified = verifyEndlessPhaseEvents(run, replayed.outcomeEvents, 1_100_000);
  assert.ok(verified.score > 0);
  assert.ok(verified.score <= run.manifest.pointBudget);

  const delayedBoundary = structuredClone(events);
  delayedBoundary.at(-1).tick += 20;
  const recovered = replayArenaTranscript({
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed: run.runSeed,
    tickMs: 20,
    maxTicks: run.config.integrity.maximumPhaseSeconds * 1_000,
    maxEvents: run.config.integrity.maximumInputEventsPerPhase,
    maxDepth: 2,
    verificationMode: 'deterministic-input-replay',
    tuning: {}
  }, delayedBoundary, {
    mode: 'endless', requireTerminal: false, maxDepth: 2, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  assert.equal(recovered.state, 'ended');
  assert.equal(recovered.extracted, true);
  assert.equal(recovered.boundaryRecoveryCount, 1);
  assert.ok(recovered.boundaryRecoveries.some((entry) => entry.command === 'extract' && entry.state === 'depthchoice'));
});

test('a verified descent carries exact health, inventory, upgrades, and phase-specific RNG into phase two', () => {
  const run = endlessRun();
  run.consumables = {
    loadout: { 'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 1 }
  };
  const browser = createHeadlessEndlessGame(run, run.manifest);
  browser.player.health = 37;
  browser.player.shield = 2;
  browser.player.dynamiteAmmo = 4;
  browser.player.blasterEnergy = 53;
  browser.player.damage *= 1.25;
  browser.player.runUpgradeCounts = { power: 1, blastercap: 1 };
  browser.run.rawScore = 2_345;
  browser.run.kills = 12;
  browser.run.oreBroken = 9;
  browser.run.crystalsCollected = 3;
  browser.run.attackCounter = 17;
  browser.run.consumables.remaining['medic-pack'] = 0;
  browser.run.consumables.medicPacksUsed = 1;
  browser.player.forceFieldRemaining = 1.4;
  browser.run.elapsed = 83.42;
  browser.state = 'depthchoice';
  browser.descend();

  const continuation = captureEndlessContinuation(browser);
  const phaseTwoManifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: 2,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  const server = createHeadlessEndlessGame(run, phaseTwoManifest, 2, continuation);

  assert.equal(browser.run.elapsed, 0);
  assert.deepEqual(captureEndlessContinuation(server), continuation);
  assert.equal(server.run.consumables.remaining['medic-pack'], 0);
  assert.equal(server.run.consumables.medicPacksUsed, 1);
  assert.equal(server.player.forceFieldRemaining, 1.4);
  assert.deepEqual(phaseEntitySignature(server), phaseEntitySignature(browser));
});

test('Endless phase replay treats the authenticated terminal choice as the completion boundary', async () => {
  const run = endlessRun();
  run.currentPhase = 3;
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: run.currentPhase,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  const service = await new CompetitiveReplayService({
    store: new MemoryCompetitiveReplayStore(),
    secret: 'endless-authoritative-replay-test-secret',
    now: () => 1_010_000,
    resolveRun: async (runId) => runId === run.id ? run : null
  }).init();
  const initial = await service.registerEndlessPhase(run, RUN_TOKEN);
  const afterInput = await service.appendEndlessPhase(ADDRESS, {
    runId: run.id,
    runToken: RUN_TOKEN,
    phase: 3,
    previousCheckpoint: initial,
    events: [{ seq: 1, tick: 0, type: 'input', moveX: 0, moveY: 0, aim: null, attack: false, dash: false, weapon: '' }]
  });
  await assert.rejects(
    () => service.appendEndlessPhase(ADDRESS, {
      runId: run.id,
      runToken: RUN_TOKEN,
      phase: 3,
      previousCheckpoint: initial,
      events: [{ seq: 2, tick: 0, type: 'command', command: 'descend' }]
    }),
    (error) => error.code === 'competitive_checkpoint_invalid'
  );
  const finalCheckpoint = await service.appendEndlessPhase(ADDRESS, {
    runId: run.id,
    runToken: RUN_TOKEN,
    phase: 3,
    previousCheckpoint: afterInput,
    events: [{ seq: 2, tick: 0, type: 'command', command: 'descend' }]
  });
  const verified = await service.verifyEndlessPhase({
    run,
    checkpoint: finalCheckpoint,
    action: 'descend'
  });
  assert.equal(verified.evidence.state, 'playing');
  assert.equal(verified.evidence.continuation.version, 2);
  assert.equal(verified.outcomeEvents.at(-1)?.type, 'phase_completed');
  assert.ok(verified.outcomeEvents.some((event) => event.type === 'guardian_defeated'));
  const phase = verifyEndlessPhaseEvents(run, verified.outcomeEvents, 1_010_000);
  assert.equal(phase.requiredKills, run.manifest.gate.requiredCount);
  assert.equal(phase.bossKills, 1);
});

test('reconnect attempts receive independent phase replay chains for the same manifest', async () => {
  const run = endlessRun();
  const service = await new CompetitiveReplayService({
    store: new MemoryCompetitiveReplayStore(),
    secret: 'endless-authoritative-replay-test-secret',
    now: () => 1_010_000,
    resolveRun: async () => run
  }).init();
  const first = await service.registerEndlessPhase(run, RUN_TOKEN);
  const reconnected = { ...run, phaseAttempt: 2 };
  const second = await service.registerEndlessPhase(reconnected, RUN_TOKEN);
  assert.notEqual(first.transcriptHash, second.transcriptHash);
  assert.notEqual(first.signature, second.signature);
});

test('a reconnect can recover a completed signed extraction from the disconnected attempt', async () => {
  const run = endlessRun();
  run.minerProfile = {
    progression: { level: 50, bankedXp: 90_000 },
    gameplay: {
      maximumHealth: 10_000, armorShield: 2_000, pickaxeAttack: 1_500,
      blasterAttack: 1_500, dynamiteAttack: 2_000, healAmount: 500,
      carryCapacity: 100, deathRetentionBps: 8_000, level: 50
    },
    traits: { level: 50, health: 10_000, damage: 1_500, armor: 2_000, speed: 1, luck: 1, crystalCarryCapacity: 100 },
    equipped: {}
  };
  run.manifest = generateEndlessPhase({
    runId: run.id, runSeed: run.runSeed, phase: 1,
    configVersion: run.configVersion, config: run.config, minerProfile: run.minerProfile
  });
  const inputEvents = [];
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true, audio: NOOP_AUDIO,
    onArenaInput(event) { inputEvents.push({ ...event }); }
  });
  game.startRun({
    mode: 'endless', seed: run.runSeed, currentPhase: 1,
    endlessRunId: run.id, endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config }, endlessManifest: run.manifest,
    nftRun: { minerId: run.minerId, profile: run.minerProfile }
  });
  driveEndlessPhaseWithControls(game);
  inputEvents.push({ type: 'command', tick: Math.round(game.run.elapsed * 1_000), command: 'extract' });

  let currentRun = run;
  const service = await new CompetitiveReplayService({
    store: new MemoryCompetitiveReplayStore(),
    secret: 'endless-reconnect-extract-recovery-secret',
    now: () => 1_100_000,
    resolveRun: async () => currentRun
  }).init();
  let checkpoint = await service.registerEndlessPhase(run, RUN_TOKEN);
  const sequenced = inputEvents.map((event, index) => ({ seq: index + 1, ...event }));
  for (let offset = 0; offset < sequenced.length; offset += 256) {
    checkpoint = await service.appendEndlessPhase(ADDRESS, {
      runId: run.id, runToken: RUN_TOKEN, phase: 1,
      previousCheckpoint: checkpoint,
      events: sequenced.slice(offset, offset + 256)
    });
  }
  await service.finalizeEndlessPhase(run, 'disconnected');
  currentRun = { ...run, phaseAttempt: 2 };
  const reconnectedCheckpoint = await service.registerEndlessPhase(currentRun, RUN_TOKEN);

  const recovered = await service.verifyEndlessPhase({
    run: currentRun,
    checkpoint: reconnectedCheckpoint,
    action: 'bank'
  });

  assert.equal(recovered.evidence.state, 'ended');
  assert.equal(recovered.outcomeEvents.at(-1)?.type, 'extract');
});

function createHeadlessEndlessGame(run, manifest, phase = 1, endlessContinuation = null) {
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({
    mode: 'endless',
    seed: run.runSeed,
    currentPhase: phase,
    endlessRunId: run.id,
    endlessConfigVersion: run.configVersion,
    endlessSnapshot: { config: run.config },
    endlessManifest: manifest,
    endlessContinuation,
    nftRun: { minerId: run.minerId, profile: run.minerProfile },
    tuning: { _consumables: structuredClone(run.consumables || { loadout: {} }) }
  });
  return game;
}

function phaseEntitySignature(game) {
  return {
    rooms: game.layout.rooms,
    enemies: game.enemies.map(({ manifestObjectId, x, y, health, maxHealth, damage, speed, kind }) => (
      { manifestObjectId, x, y, health, maxHealth, damage, speed, kind }
    )),
    ores: game.ores.map(({ manifestObjectId, x, y, health, maxHealth, mattCrystal, type }) => (
      { manifestObjectId, x, y, health, maxHealth, mattCrystal, type }
    )),
    pickups: game.pickups.map(({ sourceObjectId, x, y, type, value }) => (
      { sourceObjectId, x, y, type, value }
    ))
  };
}

function driveEndlessPhaseWithControls(game, maximumSteps = 60_000) {
  let waypoint = null;
  let routedTarget = null;
  for (let step = 0; step < maximumSteps; step += 1) {
    if (game.state === 'depthchoice') return;
    if (game.state === 'levelup') {
      game.chooseRunUpgrade(game.pendingUpgradeIds?.[0]);
      continue;
    }
    assert.equal(game.state, 'playing', `Autoplay stopped in unexpected state ${game.state}.`);
    const target = endlessAutoplayTarget(game);
    assert.ok(target, 'Autoplay could not find the next authorized target.');
    const dx = target.x - game.player.x;
    const dy = target.y - game.player.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 55 && (step % 20 === 0 || routedTarget !== target || !waypoint)) {
      waypoint = nextPathWaypoint(game, target);
      routedTarget = target;
    }
    const movementTarget = distance > 55 && waypoint ? waypoint : target;
    const moveX = movementTarget.x - game.player.x;
    const moveY = movementTarget.y - game.player.y;
    const moveDistance = Math.hypot(moveX, moveY);
    game.applyArenaControlStep({
      moveX: distance > 55 && moveDistance > 1 ? moveX / moveDistance : 0,
      moveY: distance > 55 && moveDistance > 1 ? moveY / moveDistance : 0,
      aim: Math.atan2(dy, dx),
      attack: distance < game.player.attackRange + Number(target.radius || 0) - 4,
      dash: false,
      weapon: 'pickaxe'
    }, true);
  }
  assert.fail(`Autoplay did not complete within ${maximumSteps} steps: ${JSON.stringify({
    state: game.state,
    player: { x: game.player.x, y: game.player.y, health: game.player.health },
    requiredRemaining: game.run?.endlessRequiredRemaining,
    bossReady: game.run?.bossReady,
    bossSpawned: game.run?.bossSpawned,
    enemies: game.enemies.filter((enemy) => !enemy.dead).map((enemy) => ({
      id: enemy.manifestObjectId, x: enemy.x, y: enemy.y, hp: enemy.hp,
      required: enemy.requiredForBoss, boss: enemy.isBoss, hidden: enemy.hidden,
      roomId: enemy.roomId
    }))
  })}`);
}

function nextPathWaypoint(game, target) {
  const cell = 42;
  const key = (x, y) => `${x}:${y}`;
  const start = { x: Math.round(game.player.x / cell), y: Math.round(game.player.y / cell) };
  const goal = { x: Math.round(target.x / cell), y: Math.round(target.y / cell) };
  const queue = [start];
  const previous = new Map([[key(start.x, start.y), null]]);
  const directions = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1]
  ];
  let reached = start;
  let best = start;
  while (queue.length) {
    const current = queue.shift();
    if (Math.hypot(current.x - goal.x, current.y - goal.y) < Math.hypot(best.x - goal.x, best.y - goal.y)) {
      best = current;
    }
    if (current.x === goal.x && current.y === goal.y) break;
    for (const [offsetX, offsetY] of directions) {
      const next = { x: current.x + offsetX, y: current.y + offsetY };
      const nextKey = key(next.x, next.y);
      if (previous.has(nextKey)) continue;
      const worldX = next.x * cell;
      const worldY = next.y * cell;
      if (!pointInLayout(game.layout, worldX, worldY, game.player.radius + 2)) continue;
      previous.set(nextKey, current);
      queue.push(next);
    }
  }
  if (reached.x !== goal.x || reached.y !== goal.y) reached = best;
  const path = [reached];
  while (previous.get(key(path[0].x, path[0].y))) {
    path.unshift(previous.get(key(path[0].x, path[0].y)));
  }
  const waypoint = path[Math.min(3, path.length - 1)] || goal;
  return { x: waypoint.x * cell, y: waypoint.y * cell };
}

function endlessAutoplayTarget(game) {
  if (game.portal) return game.portal;
  const lockedRoomId = game.activeLockedRoomId;
  const lockedEnemies = lockedRoomId
    ? game.enemies.filter((enemy) => enemy.roomId === lockedRoomId && !enemy.dead && !enemy.hidden)
    : [];
  if (lockedEnemies.length) return nearest(game.player, lockedEnemies);
  const visibleRequired = game.enemies.filter((enemy) =>
    enemy.requiredForBoss && !enemy.dead && !enemy.hidden
  );
  if (visibleRequired.length) return nearest(game.player, visibleRequired);
  const guardian = game.enemies.find((enemy) => enemy.isBoss && !enemy.dead && !enemy.hidden);
  if (guardian) return guardian;
  if (Number(game.run?.endlessRequiredRemaining || 0) === 0) return game.layout.guardianRoom;
  return nearest(game.player, game.enemies.filter((enemy) => !enemy.dead && !enemy.hidden));
}

function nearest(origin, entries) {
  return [...entries].sort((left, right) =>
    Math.hypot(left.x - origin.x, left.y - origin.y) -
    Math.hypot(right.x - origin.x, right.y - origin.y)
  )[0] || null;
}
