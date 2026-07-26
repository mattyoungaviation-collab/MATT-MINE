import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADMIN_ROLES,
  RUN_MODES,
  consumeRun,
  defaultEconomyState,
  estimatedLeaderboardReward,
  passIsActive,
  claimLatestReward,
  passPoolMatt,
  previewLeaderboard,
  publishRewardEpoch,
  purchasePaidRun,
  purchasePass,
  recordRun,
  runAccess,
  runSeed,
  updateAdminSettings,
  utcDayKey,
  utcWeekKey,
  weeklyUserScore
} from '../src/game/economy.js';

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0);

test('UTC entitlement keys are stable and the free ranked run can only be consumed once daily', () => {
  const initial = defaultEconomyState();
  assert.equal(utcDayKey(NOW), '2026-07-25');
  assert.equal(utcWeekKey(NOW), '2026-07-20');
  assert.equal(runAccess(initial, RUN_MODES.FREE, NOW).allowed, true);
  const first = consumeRun(initial, RUN_MODES.FREE, NOW);
  assert.equal(first.ok, true);
  assert.equal(first.state.daily['2026-07-25'].freeRunUsed, true);
  assert.equal(runAccess(first.state, RUN_MODES.FREE, NOW).allowed, false);
  assert.equal(runAccess(first.state, RUN_MODES.FREE, NOW + 86_400_000).allowed, true);
});

test('pass and paid-run purchases route purchased MATT 70/20/10 with zero burn', () => {
  const pass = purchasePass(defaultEconomyState(), NOW);
  assert.equal(pass.ok, true);
  assert.equal(passIsActive(pass.state, NOW), true);
  assert.equal(pass.state.accounting.ronFromPasses, 95);
  const paid = purchasePaidRun(pass.state, NOW);
  assert.equal(paid.ok, true);
  assert.equal(paid.priceRon, 10);
  assert.equal(paid.mattBought, 137_880);
  assert.equal(paid.current, 96_516);
  assert.equal(paid.future, 27_576);
  assert.equal(paid.reserve, 13_788);
  assert.equal(paid.current + paid.future + paid.reserve, paid.mattBought);
  assert.equal('burnedMatt' in paid.state.accounting, false);
  const consumed = consumeRun(paid.state, RUN_MODES.PAID, NOW);
  assert.equal(consumed.ok, true);
  assert.equal(consumed.rewardWeight, 2);
  assert.equal(consumed.state.player.paidRunCredits, 0);
  assert.equal(consumed.state.daily['2026-07-25'].paidRunsUsed, 1);
});

test('weekly leaderboard uses the best score per day and keeps free and pass boards separate', () => {
  let state = defaultEconomyState();
  for (const [mode, dayOffset, score] of [
    [RUN_MODES.FREE, 0, 100],
    [RUN_MODES.FREE, 1, 200],
    [RUN_MODES.PAID, 0, 300],
    [RUN_MODES.PAID, 0, 500],
    [RUN_MODES.PAID, 1, 400]
  ]) {
    const timestamp = NOW + dayOffset * 86_400_000;
    const result = recordRun(state, {
      mode,
      projected: score,
      day: utcDayKey(timestamp),
      week: utcWeekKey(timestamp),
      extracted: true
    }, timestamp);
    state = result.state;
  }
  assert.equal(weeklyUserScore(state, RUN_MODES.FREE, NOW), 300);
  assert.equal(weeklyUserScore(state, RUN_MODES.PAID, NOW), 900);
  const board = previewLeaderboard(state, RUN_MODES.PAID, NOW);
  assert.equal(board.filter((row) => row.isPlayer).length, 1);
  assert.ok(board.every((row, index) => row.rank === index + 1));
});

test('reward estimate uses separate pools and paid purchases grow only the pass pool', () => {
  const pass = purchasePass(defaultEconomyState(), NOW);
  const paid = purchasePaidRun(pass.state, NOW);
  assert.equal(passPoolMatt(paid.state), 5_096_516);
  assert.equal(estimatedLeaderboardReward(paid.state, RUN_MODES.FREE, 1), 500_000);
  assert.equal(estimatedLeaderboardReward(paid.state, RUN_MODES.PAID, 1), 1_019_303);
});

test('admin roles enforce price, treasury, and pause boundaries with immediate audit entries', () => {
  const initial = defaultEconomyState();
  const denied = updateAdminSettings(initial, { passPriceRon: 99 }, ADMIN_ROLES.GAME, NOW);
  assert.equal(denied.ok, false);
  const price = updateAdminSettings(initial, { passPriceRon: 99 }, ADMIN_ROLES.PRICE, NOW);
  assert.equal(price.ok, true);
  assert.equal(price.state.settings.passPriceRon, 99);
  const treasury = updateAdminSettings(price.state, { freeWeeklyPoolMatt: 3_000_000 }, ADMIN_ROLES.TREASURY, NOW);
  assert.equal(treasury.ok, true);
  const paused = updateAdminSettings(treasury.state, { rankedPaused: true }, ADMIN_ROLES.PAUSER, NOW);
  assert.equal(paused.ok, true);
  assert.equal(paused.state.settings.rankedPaused, true);
  assert.equal(paused.state.audit.at(-1).action, 'ADMIN_SETTINGS_UPDATED');
});

test('official daily seeds are deterministic and separated by leaderboard', () => {
  assert.equal(runSeed(RUN_MODES.FREE, NOW), runSeed(RUN_MODES.FREE, NOW));
  assert.notEqual(runSeed(RUN_MODES.FREE, NOW), runSeed(RUN_MODES.PAID, NOW));
});


test('published reward epochs are immutable records and local claims can only happen once', () => {
  let state = defaultEconomyState();
  state = recordRun(state, { mode: RUN_MODES.FREE, projected: 9000, day: utcDayKey(NOW), week: utcWeekKey(NOW), extracted: true }, NOW).state;
  const published = publishRewardEpoch(state, ADMIN_ROLES.REWARD, NOW);
  assert.equal(published.ok, true);
  assert.equal(published.state.publishedRewards.length, 1);
  assert.equal(publishRewardEpoch(published.state, ADMIN_ROLES.REWARD, NOW).ok, false);
  const claimed = claimLatestReward(published.state, NOW + 1);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.epoch.claimedAt, NOW + 1);
  assert.equal(claimLatestReward(claimed.state, NOW + 2).ok, false);
});
