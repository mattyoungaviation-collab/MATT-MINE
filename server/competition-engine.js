import { endlessScale, weeklyStageSeed } from '../src/game/expansionConfig.js';

export function createWeeklyStageSnapshot(week, dayNumber, config, openedAt) {
  const settings = config.settings || config;
  return Object.freeze({
    week,
    day: dayNumber,
    seed: weeklyStageSeed(week, dayNumber),
    characterId: settings.weeklyLockedCharacter,
    difficulty: settings[`weeklyDay${dayNumber}Difficulty`],
    bossCount: settings[`weeklyDay${dayNumber}BossCount`],
    roomCount: settings[`weeklyDay${dayNumber}RoomCount`],
    openedAt,
    immutable: true
  });
}

export function openWeeklyStage(store, week, dayNumber, config, openedAt) {
  store.weeks ||= {};
  store.weeks[week] ||= { stages: {}, results: {} };
  const weekState = store.weeks[week];
  weekState.stages[dayNumber] ||= createWeeklyStageSnapshot(week, dayNumber, config, openedAt);
  return structuredClone(weekState.stages[dayNumber]);
}

export function consumeWeeklyAttempt(store, week, dayNumber, address, runId, timestamp) {
  const weekState = store.weeks?.[week];
  if (!weekState?.stages?.[dayNumber]) throw new Error('weekly_stage_not_open');
  weekState.results ||= {};
  weekState.results[address] ||= {};
  if (weekState.results[address][dayNumber]) throw new Error('weekly_attempt_used');
  weekState.results[address][dayNumber] = {
    runId,
    status: 'active',
    score: 0,
    completed: false,
    elapsed: 0,
    startedAt: timestamp,
    finishedAt: 0
  };
  return structuredClone(weekState.results[address][dayNumber]);
}

export function finishWeeklyAttempt(store, week, dayNumber, address, result, timestamp) {
  const attempt = store.weeks?.[week]?.results?.[address]?.[dayNumber];
  if (!attempt || attempt.status !== 'active') throw new Error('weekly_attempt_not_active');
  attempt.status = 'finished';
  attempt.score = safeScore(result.score);
  attempt.completed = result.completed === true;
  attempt.elapsed = safeScore(result.elapsed);
  attempt.finishedAt = timestamp;
  return structuredClone(attempt);
}

export function weeklyLeaderboard(store, week) {
  const results = store.weeks?.[week]?.results || {};
  return Object.entries(results).map(([address, days]) => {
    const attempts = Object.values(days);
    const completedDays = attempts.filter((entry) => entry.completed).length;
    return {
      address,
      completedDays,
      score: attempts.reduce((sum, entry) => sum + safeScore(entry.score), 0),
      successfulElapsed: attempts.filter((entry) => entry.completed).reduce((sum, entry) => sum + safeScore(entry.elapsed), 0),
      finishedAt: Math.max(0, ...attempts.map((entry) => safeScore(entry.finishedAt))),
      days: structuredClone(days)
    };
  }).sort((left, right) =>
    right.completedDays - left.completedDays ||
    right.score - left.score ||
    left.successfulElapsed - right.successfulElapsed ||
    left.finishedAt - right.finishedAt ||
    left.address.localeCompare(right.address)
  ).map((entry, index) => ({ rank: index + 1, ...entry }));
}

export function endlessSnapshot(season, config, startedAt) {
  const settings = config.settings || config;
  return Object.freeze({
    season,
    startedAt,
    healthGrowth: settings.endlessHealthGrowth,
    damageGrowth: settings.endlessDamageGrowth,
    speedGrowth: settings.endlessSpeedGrowth,
    bossFrequency: settings.endlessBossFrequency,
    bossCount: settings.endlessBossCount,
    roomCount: settings.endlessRoomCount,
    multiplierGrowth: settings.endlessMultiplierGrowth,
    maximumScale: settings.endlessMaximumScale,
    immutable: true
  });
}

export function endlessDepthRules(depth, snapshot) {
  const settings = {
    endlessHealthGrowth: snapshot.healthGrowth,
    endlessDamageGrowth: snapshot.damageGrowth,
    endlessSpeedGrowth: snapshot.speedGrowth,
    endlessMultiplierGrowth: snapshot.multiplierGrowth,
    endlessMaximumScale: snapshot.maximumScale
  };
  const scale = endlessScale(depth, settings);
  return {
    ...scale,
    bossCount: depth % snapshot.bossFrequency === 0
      ? Math.min(10, snapshot.bossCount + Math.floor(depth / 10))
      : 0,
    roomCount: Math.min(30, snapshot.roomCount + Math.floor((depth - 1) / 3))
  };
}

export function endlessLeaderboard(results = []) {
  return results.filter((entry) => entry?.verified === true).map((entry) => ({
    address: String(entry.address || '').toLowerCase(),
    depth: safeScore(entry.depth),
    score: safeScore(entry.score),
    bosses: safeScore(entry.bosses),
    survivalTime: safeScore(entry.survivalTime),
    runId: String(entry.runId || '')
  })).sort((left, right) =>
    right.depth - left.depth ||
    right.score - left.score ||
    right.bosses - left.bosses ||
    right.survivalTime - left.survivalTime ||
    left.address.localeCompare(right.address)
  ).map((entry, index) => ({ rank: index + 1, ...entry }));
}

function safeScore(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
