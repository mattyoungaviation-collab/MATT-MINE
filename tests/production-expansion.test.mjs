import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { MemoryDatabase } from '../server/database.js';
import {
  CompleteProductionMattMineService,
  arenaStudioAllowsPaidRevives
} from '../server/complete-production-service.js';
import {
  EXPANSION_SCHEMA,
  defaultControllerProfile,
  defaultExpansionConfig,
  defaultPlayerExpansion,
  endlessScale,
  normalizeControllerProfile,
  normalizeExpansionPatch,
  weeklyStageSeed
} from '../src/game/expansionConfig.js';
import { deadZoneVector } from '../src/game/input.js';
import {
  bossAttackConfig,
  bossPhaseForTuning,
  ensureBossScheduler,
  selectBossAttack
} from '../src/game/bossTuning.js';
import {
  consumeWeeklyAttempt,
  createWeeklyStageSnapshot,
  endlessDepthRules,
  endlessLeaderboard,
  finishWeeklyAttempt,
  openWeeklyStage,
  weeklyLeaderboard
} from '../server/competition-engine.js';
import {
  DisabledAdvertisementVerifier,
  DisabledRevivePaymentVerifier,
  calculateAdvertisementBonus,
  calculateDeathRetention
} from '../server/external-verifiers.js';
import { setNuggetLedgerBalance } from '../server/nugget-ledger.js';
import { PASS_CHEST_ID } from '../src/game/passRewards.js';
import { normalizeBetaConfiguration } from '../src/game/betaTools.js';
import {
  awardVerifiedAdvertisement,
  confirmRevive,
  createPendingRevive,
  skipAdvertisement
} from '../server/bonus-engine.js';
import { defaultGameTuning } from '../src/game/tuning.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 27, 12);
const NOOP_AUDIO = {
  startMusic() {}, stopMusic() {}, resume() {}, pause() {}, play() {}, startBoss() {}, stopBoss() {}
};

function harness(options = {}) {
  let counter = 0;
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => START,
    publicOrigin: ORIGIN,
    adminKey: 'admin-test-key',
    verifySignature: async () => true,
    competitiveReplayValidator: options.competitive
      ? { validate: async ({ submission }) => ({ result: structuredClone(submission) }) }
      : null,
    revivePaymentVerifier: options.revivePaymentVerifier,
    reviveEligibilityValidator: options.reviveEligibilityValidator,
    arenaService: options.arenaService,
    randomHex(bytes) {
      counter += 1;
      return counter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return { database, service };
}

async function login(service, address = ADDRESS) {
  const challenge = await service.createChallenge({ address, chainId: 2020, origin: ORIGIN });
  const session = await service.verifyChallenge({
    address,
    nonce: challenge.nonce,
    signature: `0x${'11'.repeat(65)}`
  });
  await service.setPlayerIdentity(session.token, { name: address === ADDRESS ? 'ExpansionMiner' : 'OtherMiner' });
  return session.token;
}

test('boss phases expose every real attack and enforce independent deterministic cooldowns', () => {
  const config = {};
  assert.equal(bossPhaseForTuning(65, 100, config), 2);
  for (const attack of ['slam', 'volley', 'radial', 'summon']) {
    assert.equal(bossAttackConfig(config, 2, attack).id, attack);
  }
  const first = { id: 7 };
  const second = { id: 8 };
  const attackA = selectBossAttack(first, config, 2, 10, 0);
  const attackB = selectBossAttack(second, config, 2, 10, 0);
  assert.ok(attackA);
  assert.ok(attackB);
  assert.equal(ensureBossScheduler(first).sequence, 1);
  assert.equal(ensureBossScheduler(second).sequence, 1);
  assert.equal(selectBossAttack(first, config, 2, 10.01, 0), null);
  const clone = { id: 7 };
  assert.equal(selectBossAttack(clone, config, 2, 10, 0).id, attackA.id);
  const disabled = { bossPhase2SlamEnabled: false, bossPhase2VolleyEnabled: false, bossPhase2RadialEnabled: false, bossPhase2SummonEnabled: false };
  assert.equal(selectBossAttack({ id: 9 }, disabled, 2, 10, 0), null);
});

test('default Guardian durability targets a readable final encounter under a fixed upgraded build', () => {
  const tuning = defaultGameTuning().free;
  const guardianHealth = 820 * tuning.bossHealthMultiplier;
  const fixedBuildDamage = 20 * 1.2 * tuning.pickaxeDamageMultiplier;
  const fixedBuildAttacksPerSecond = 1 / (tuning.pickaxeCooldown || .34);
  const readableCombatUptime = .75;
  const estimatedSeconds = guardianHealth / (fixedBuildDamage * fixedBuildAttacksPerSecond * readableCombatUptime);
  assert.ok(estimatedSeconds >= 24 && estimatedSeconds <= 42, `estimated fight was ${estimatedSeconds.toFixed(2)} seconds`);
});

test('expansion schema rejects unknown and unsafe settings while preserving verifier blockers', async () => {
  const defaults = defaultExpansionConfig();
  assert.equal(defaults.settings.chestBaseNuggets, 250_000);
  assert.equal(defaults.settings.deathRetentionFree, 50);
  assert.equal(defaults.settings.paidRevivesEnabled, false);
  assert.throws(() => normalizeExpansionPatch({ settings: { mystery: 1 } }, defaults), /Unknown/);
  assert.throws(() => normalizeExpansionPatch({ settings: { weeklyActiveDayCount: 8 } }, defaults), /between 1 and 7/);
  const { service } = harness();
  await assert.rejects(
    () => service.updateAdminExpansion('admin-test-key', { settings: { paidRevivesEnabled: true } }, 'attempt live revive'),
    (error) => error.code === 'revive_payment_verifier_missing'
  );
  await assert.rejects(
    () => service.updateAdminExpansion('admin-test-key', { settings: { advertisementRewardsEnabled: true } }, 'attempt live ads'),
    (error) => error.code === 'advertisement_provider_disabled'
  );
  await assert.rejects(
    () => service.updateAdminExpansion('admin-test-key', { settings: { weeklyCompetitionEnabled: true } }, 'attempt unverified weekly'),
    (error) => error.code === 'mine_control_retired'
  );
  const admin = await service.adminExpansion('admin-test-key');
  assert.equal(admin.schema.some((entry) => entry.category === 'Weekly Competition'), false);
  assert.equal(admin.schema.some((entry) => entry.category === 'Endless Mode'), false);
  assert.equal(admin.schema.some((entry) => entry.id === 'advertisementPracticeEligible'), false);
});

test('Admin controller defaults initialize new wallets and remain player-overridable', async () => {
  const { service } = harness();
  await service.updateAdminExpansion('admin-test-key', {
    settings: {
      controllerDeadZone: .27,
      controllerAimSensitivity: 1.45,
      controllerVibration: false
    }
  }, 'Set controller defaults for new players');
  const token = await login(service, OTHER);
  const player = await service.me(token);
  assert.equal(player.expansion.controller.deadZone, .27);
  assert.equal(player.expansion.controller.aimSensitivity, 1.45);
  assert.equal(player.expansion.controller.vibration, false);

  const updated = await service.updateControllerProfile(token, {
    ...player.expansion.controller,
    deadZone: .12
  });
  assert.equal(updated.controller.deadZone, .12);
});

test('Pass chest awards the configured 250,000 through the server ledger exactly once', async () => {
  const { database, service } = harness();
  const token = await login(service);
  await database.transact((state) => {
    state.wallets[ADDRESS].passInventory.chests[PASS_CHEST_ID].available = 1;
  });
  const opened = await service.openPassChest(token, PASS_CHEST_ID);
  assert.equal(opened.rewards.nuggets, 250_000);
  assert.equal(opened.profile.bankedNuggets, 250_000);
  await assert.rejects(
    () => service.openPassChest(token, PASS_CHEST_ID),
    (error) => error.code === 'pass_chest_unavailable'
  );
  const state = await database.read();
  assert.equal(state.wallets[ADDRESS].nuggetLedger.filter((entry) => entry.type === 'CHEST_REWARD').length, 1);
});

test('beta access is server entitled, audited, and never available to an ordinary wallet', async () => {
  const { database, service } = harness();
  const token = await login(service);
  await service.updateAdminExpansion('admin-test-key', { settings: { betaModeEnabled: true } }, 'open controlled beta');
  await assert.rejects(() => service.betaAccess(token), (error) => error.code === 'beta_access_required');
  await service.setBetaTester('admin-test-key', ADDRESS, true, 'approved tester');
  const beta = await service.betaAccess(token);
  assert.equal(beta.allowed, true);
  assert.match(beta.banner, /NO REWARDS/);
  assert.ok(beta.capabilities.includes('spawnBoss'));
  const state = await database.read();
  assert.equal(state.wallets[ADDRESS].expansion.betaTester, true);
  assert.ok(state.audit.some((entry) => entry.action === 'BETA_ACCESS_GRANTED'));
});

test('Beta completion awards no nuggets, Pass XP, profile progress, or leaderboard result', async () => {
  const { database, service } = harness();
  const token = await login(service);
  await service.updateAdminExpansion('admin-test-key', { settings: { betaModeEnabled: true } }, 'open rewardless beta');
  await service.setBetaTester('admin-test-key', ADDRESS, true, 'approved tester');
  const run = await service.startRun(token, 'beta');
  const finished = await service.finishRun(token, {
    runId: run.runId,
    runToken: run.runToken,
    result: {
      extracted: true,
      projected: 1_000,
      banked: 1_000,
      depth: 1,
      kills: 0,
      oreBroken: 0,
      elapsed: 0
    }
  });
  const wallet = (await database.read()).wallets[ADDRESS];
  assert.equal(wallet.profile.bankedNuggets, 0);
  assert.equal(wallet.profile.totalRuns, 0);
  assert.equal(wallet.passProgress.xp, 0);
  assert.equal(wallet.nuggetLedger.length, 0);
  assert.deepEqual(finished.leaderboard.rows, []);
});

test('Beta remains private while Weekly and Endless stay retired', async () => {
  const { service } = harness({ competitive: true });
  const token = await login(service);
  await assert.rejects(() => service.startRun(token, 'beta'), (error) => error.code === 'beta_mode_disabled');
  await service.updateAdminExpansion('admin-test-key', {
    settings: { betaModeEnabled: true }
  }, 'enable controlled test modes');
  await assert.rejects(() => service.startRun(token, 'beta'), (error) => error.code === 'beta_access_required');
  await service.setBetaTester('admin-test-key', ADDRESS, true, 'approved tester');
  const beta = await service.startRun(token, 'beta');
  assert.equal(beta.mode, 'beta');
  assert.match(beta.seed, /^MATT-BETA-/);
  await assert.rejects(() => service.startRun(token, 'weekly'), (error) => error.code === 'mine_retired');
  await assert.rejects(() => service.startRun(token, 'endless'), (error) => error.code === 'mine_retired');
});

test('characters require ownership and purchases use the authoritative nugget ledger', async () => {
  const { database, service } = harness();
  const token = await login(service);
  await assert.rejects(() => service.selectCharacter(token, 'ronke'), (error) => error.code === 'character_not_owned');
  await database.transact((state) => {
    setNuggetLedgerBalance(state.wallets[ADDRESS], 500_000, {
      type: 'ADMIN_ADJUSTMENT',
      adminActor: 'TEST',
      idempotencyKey: 'test-character-funds'
    });
  });
  const purchased = await service.purchaseCharacter(token, 'ronke');
  assert.ok(purchased.ownedCharacters.includes('ronke'));
  assert.equal((await database.read()).wallets[ADDRESS].profile.bankedNuggets, 100_000);
  const selected = await service.selectCharacter(token, 'ronke');
  assert.equal(selected.selectedCharacter, 'ronke');
  await service.grantCharacter('admin-test-key', ADDRESS, 'ronke', false, 'balance review');
  assert.equal((await database.read()).wallets[ADDRESS].expansion.selectedCharacter, 'matt');
  await database.transact((state) => {
    state.wallets[ADDRESS].passProgress.xp = 3_800;
  });
  const player = await service.me(token);
  assert.ok(player.expansion.ownedCharacters.includes('adl-dyno'));
});

test('character definitions apply health, movement, mining, weapon, armor, and energy stats', () => {
  const tuning = defaultGameTuning().practice;
  const character = defaultExpansionConfig().characters['adl-dyno'];
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO });
  game.startRun({ mode: 'practice', seed: 'CHARACTER-STATS', tuning, characterId: 'adl-dyno', character });
  assert.equal(game.player.maxHealth, tuning.playerMaxHealth * 1.35);
  assert.equal(game.player.speed, tuning.playerSpeed * .86);
  assert.equal(game.player.damage, tuning.playerBaseDamage * 1.24);
  assert.equal(game.player.attackCooldown, tuning.pickaxeCooldown / 1.22);
  assert.equal(game.player.blasterDamageScale, tuning.blasterDamageMultiplier * .82);
  assert.equal(game.player.blasterEnergyMax, tuning.blasterEnergy * .9);
  assert.equal(game.player.armor, .08);
});

test('controller profiles normalize remaps and dead zones without duplicate gameplay buttons', () => {
  assert.deepEqual(deadZoneVector(.05, .05, .18), { x: 0, y: 0 });
  assert.ok(deadZoneVector(.8, 0, .18).x > .7);
  const profile = normalizeControllerProfile({ ...defaultPlayerExpansion().controller, deadZone: .22 });
  assert.equal(profile.deadZone, .22);
  assert.throws(() => normalizeControllerProfile({
    ...profile,
    mapping: { ...profile.mapping, attack: 1, dash: 1 }
  }), /assigned more than once/);
  assert.deepEqual(defaultControllerProfile().mapping, {
    attack: 7,
    dash: 10,
    pickaxe: 4,
    dynamite: 2,
    blaster: 5,
    interact: 3,
    pause: 9,
    confirm: 0,
    cancel: 1,
    menuUp: 12,
    menuDown: 13,
    menuLeft: 14,
    menuRight: 15
  });
  const migrated = normalizeControllerProfile({
    mapping: {
      attack: 0, dash: 1, pickaxe: 4, dynamite: 2, blaster: 5, interact: 3,
      pause: 9, confirm: 0, cancel: 1, menuUp: 12, menuDown: 13, menuLeft: 14, menuRight: 15
    }
  });
  assert.equal(migrated.layoutVersion, 2);
  assert.equal(migrated.mapping.attack, 7);
  assert.equal(migrated.mapping.dash, 10);
});

test('production profile and Admin surfaces expose remapping and every expansion section', async () => {
  const [index, admin, script] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/admin.js', import.meta.url), 'utf8')
  ]);
  assert.match(index, /controller-mapping-grid/);
  assert.match(index, /controller-pause-overlay/);
  assert.match(index, /id="extract-button"/);
  assert.match(index, /id="descend-button"/);
  assert.match(admin, /tab-expansion/);
  assert.match(admin, /reset-expansion/);
  for (const section of [
    'Chest Rewards', 'Death and Revives', 'Controller Defaults',
    'Advertisement Rewards', 'Beta Testing', 'Weekly Competition', 'Endless Mode'
  ]) {
    assert.ok(EXPANSION_SCHEMA.some((entry) => entry.category === section), `${section} missing`);
  }
  assert.match(admin, /Export validated preset/);
  assert.match(script, /downloadJson/);
});

test('weekly snapshots are immutable, one-attempt, deterministic, and rank all tie breakers', () => {
  const config = defaultExpansionConfig();
  const store = { weeks: {} };
  const week = '2026-07-27';
  const opened = openWeeklyStage(store, week, 1, config, START);
  assert.equal(opened.seed, weeklyStageSeed(week, 1));
  config.settings.weeklyDay1Difficulty = 5;
  assert.equal(openWeeklyStage(store, week, 1, config, START + 1).difficulty, 1);
  consumeWeeklyAttempt(store, week, 1, ADDRESS, 'run-a', START);
  assert.throws(() => consumeWeeklyAttempt(store, week, 1, ADDRESS, 'run-b', START), /used/);
  finishWeeklyAttempt(store, week, 1, ADDRESS, { score: 900, completed: true, elapsed: 90 }, START + 90);
  consumeWeeklyAttempt(store, week, 1, OTHER, 'run-c', START);
  finishWeeklyAttempt(store, week, 1, OTHER, { score: 900, completed: false, elapsed: 80 }, START + 80);
  const board = weeklyLeaderboard(store, week);
  assert.equal(board[0].address, ADDRESS);
  assert.equal(board[0].completedDays, 1);
  assert.equal(createWeeklyStageSnapshot(week, 7, config, START).day, 7);
});

test('Endless scaling is safeguarded and its leaderboard stays separate and deterministic', () => {
  const snapshot = {
    healthGrowth: .5, damageGrowth: .4, speedGrowth: .2, multiplierGrowth: .5,
    maximumScale: 3, bossFrequency: 2, bossCount: 1, roomCount: 8
  };
  const rules = endlessDepthRules(100, snapshot);
  assert.equal(rules.health, 3);
  assert.equal(rules.damage, 3);
  assert.equal(rules.speed, 3);
  assert.equal(rules.bossCount, 10);
  assert.equal(endlessScale(1, defaultExpansionConfig().settings).multiplier, 1);
  const board = endlessLeaderboard([
    { address: OTHER, depth: 9, score: 1000, bosses: 4, survivalTime: 500, runId: 'b', verified: true },
    { address: ADDRESS, depth: 10, score: 1, bosses: 1, survivalTime: 10, runId: 'a', verified: true },
    { address: ADDRESS, depth: 99, score: 99, verified: false }
  ]);
  assert.equal(board[0].address, ADDRESS);
  assert.equal(board.length, 2);
});

test('death retention floors to 50 percent and external reward interfaces fail closed', async () => {
  assert.deepEqual(calculateDeathRetention(101, 50), { earned: 101, retained: 50, lost: 51 });
  assert.equal(calculateAdvertisementBonus(101, 5), 5);
  await assert.rejects(() => new DisabledAdvertisementVerifier().verifyCompletion(), /signed advertisement/);
  await assert.rejects(() => new DisabledRevivePaymentVerifier().verifyPayment(), /on-chain revive/);
});

test('Beta developer configurations validate level jumps, talents, health, and enemy controls', () => {
  const config = normalizeBetaConfiguration({
    depth: 12,
    level: 50,
    health: 400,
    maximumHealth: 500,
    talents: { drone: 4, dynamite: 7 },
    enemyType: 'spitter',
    enemyCount: 25,
    hitboxes: true
  });
  assert.equal(config.depth, 12);
  assert.equal(config.talents.drone, 4);
  assert.equal(config.enemyCount, 25);
  assert.equal(config.hitboxes, true);
  assert.throws(() => normalizeBetaConfiguration({ enemyType: 'unknown' }), /Unknown/);
});

test('revive state preserves the run and rejects duplicate or finalized payments', () => {
  const config = {
    paidRevivesEnabled: true,
    reviveLimitPerRun: 1,
    revivePriceRonWei: '10000000000000000000',
    reviveInvulnerabilitySeconds: 3
  };
  const run = {
    id: 'run_same',
    status: 'awaiting-revive',
    finishedAt: 0,
    playerState: { health: 0, maximumHealth: 144 },
    revives: []
  };
  const pending = createPendingRevive(run, config, START);
  const restored = confirmRevive(run, {
    amountWei: pending.priceRonWei,
    transactionHash: `0x${'33'.repeat(32)}`
  }, config, START + 1);
  assert.equal(restored.runId, 'run_same');
  assert.equal(restored.playerState.health, 144);
  assert.equal(restored.reviveCount, 1);
  assert.equal(run.status, 'active');
  assert.throws(() => createPendingRevive({ ...run, status: 'awaiting-revive' }, config, START + 2), /limit/);
});

test('MATT Arena paid revive requires both global approval and its published Studio switch', () => {
  const enabledSnapshot = { loadout: { paidRevive: true } };
  const disabledSnapshot = { loadout: { paidRevive: false } };
  assert.equal(arenaStudioAllowsPaidRevives(enabledSnapshot, { paidRevivesEnabled: true }, true), true);
  assert.equal(arenaStudioAllowsPaidRevives(disabledSnapshot, { paidRevivesEnabled: true }, true), false);
  assert.equal(arenaStudioAllowsPaidRevives(enabledSnapshot, { paidRevivesEnabled: false }, true), false);
  assert.equal(arenaStudioAllowsPaidRevives(enabledSnapshot, { paidRevivesEnabled: true }, false), false);
});

test('Arena revive payment is authoritative, retry-safe, and recorded exactly once', async () => {
  const runId = `arena_run_${'a'.repeat(24)}`;
  const transactionHash = `0x${'44'.repeat(32)}`;
  let openChecks = 0;
  const arenaService = {
    publicConfig: () => ({ enabled: true }),
    async validatePaidReviveDeath(address, requestedRunId) {
      assert.equal(address, ADDRESS);
      assert.equal(requestedRunId, runId);
      return {
        checkpoint: { throughSeq: 2, throughTick: 7_240 },
        playerState: { health: 0, maximumHealth: 100, depth: 1, elapsed: 7.24 },
        reviveRun: {
          id: runId,
          address,
          status: 'active',
          startedAt: START,
          expiresAt: START + 60_000,
          finishedAt: 0,
          paidReviveEligible: true,
          reviveInvulnerabilitySeconds: 3,
          revives: []
        }
      };
    },
    async assertPaidReviveRunOpen(address, requestedRunId) {
      assert.equal(address, ADDRESS);
      assert.equal(requestedRunId, runId);
      openChecks += 1;
    }
  };
  const revivePaymentVerifier = {
    publicStatus: () => ({ configured: true }),
    transactionForPayment: (priceRonWei) => ({
      to: OTHER,
      value: `0x${BigInt(priceRonWei).toString(16)}`,
      data: '0x'
    }),
    async verifyPayment(input) {
      assert.equal(input.runId, runId);
      assert.equal(input.address, ADDRESS);
      assert.equal(input.transactionHash, transactionHash);
      return {
        transactionHash,
        amountWei: input.amountWei,
        transactionBlockAt: START + 1
      };
    }
  };
  const { database, service } = harness({
    arenaService,
    revivePaymentVerifier,
    reviveEligibilityValidator: { validate: async () => ({}) }
  });
  const token = await login(service);
  await database.transact((state) => {
    state.expansionConfig.settings.paidRevivesEnabled = true;
    state.expansionConfig.settings.reviveLimitPerRun = 1;
    state.expansionConfig.settings.reviveInvulnerabilitySeconds = 3;
  });

  const pending = await service.requestPaidRevive(token, {
    runId,
    deathState: { checkpoint: { throughSeq: 2 } }
  });
  assert.equal(pending.priceRonWei, '10000000000000000000');
  assert.equal(pending.transaction.to, OTHER);

  const confirmed = await service.confirmPaidRevive(token, { runId, transactionHash });
  assert.equal(confirmed.reviveCount, 1);
  assert.equal(confirmed.playerState.health, 100);
  assert.equal(confirmed.alreadyConfirmed, false);

  const retried = await service.confirmPaidRevive(token, { runId, transactionHash });
  assert.deepEqual(retried, confirmed);
  assert.equal(openChecks, 1);

  const state = await database.read();
  assert.equal(state.arenaReviveRuns[runId].revives.length, 1);
  assert.equal(Object.keys(state.revivePayments).length, 1);
  assert.equal(state.revivePayments[transactionHash].runId, runId);
});

test('advertisement bonuses require a verified provider completion and remain idempotent per run', async () => {
  const wallet = {
    address: ADDRESS,
    profile: { bankedNuggets: 0 },
    nuggetLedger: [],
    expansion: defaultPlayerExpansion()
  };
  const run = { id: 'run-ad', status: 'finished', result: { banked: 10_000 } };
  const config = {
    advertisementRewardsEnabled: true,
    advertisementBonusMinPercent: 1,
    advertisementBonusMaxPercent: 5
  };
  const verifier = {
    async verifyCompletion() {
      return { completionId: 'provider-1', percent: 5, expiresAt: START + 1000 };
    }
  };
  const result = await awardVerifiedAdvertisement({
    wallet, run, completion: { token: 'signed' }, config, verifier, timestamp: START
  });
  assert.equal(result.amount, 500);
  assert.equal(wallet.profile.bankedNuggets, 500);
  await assert.rejects(
    () => awardVerifiedAdvertisement({ wallet, run, completion: {}, config, verifier, timestamp: START }),
    /already/
  );
  const skipped = skipAdvertisement({ id: 'other', status: 'finished', result: { banked: 10 } }, START);
  assert.equal(skipped.status, 'skipped');
});
