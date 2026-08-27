import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError, assertApi } from './errors.js';
import {
  ENDLESS_MAX_PHASE,
  generateEndlessPhase,
  normalizeEndlessConfig,
  stableFingerprint,
  validateEndlessManifest
} from '../src/game/endlessMine.js';

const EVENT_TYPES = new Set([
  'enemy_killed', 'ore_broken', 'crystal_collected', 'guardian_defeated',
  'phase_completed', 'damage_taken'
]);

export function createEndlessRunRecord({
  id,
  tokenHash,
  address,
  minerId,
  minerProfile,
  runSeed,
  configVersion,
  config,
  startedAt,
  expiresAt,
  payment = null
}) {
  const normalizedConfig = normalizeEndlessConfig(config);
  const manifest = generateEndlessPhase({
    runId: id,
    runSeed,
    phase: 1,
    configVersion,
    config: normalizedConfig,
    minerProfile
  });
  return {
    id,
    tokenHash,
    address: String(address || '').toLowerCase(),
    mode: 'endless',
    status: 'active',
    minerId,
    minerProfile: structuredClone(minerProfile),
    runSeed,
    configVersion,
    config: normalizedConfig,
    currentPhase: 1,
    completedPhases: 0,
    score: 0,
    crystalsCarried: 0,
    crystalsBanked: 0,
    minerXpBanked: 0,
    requiredKills: 0,
    bossKills: 0,
    oreBroken: 0,
    phaseHistory: [],
    phaseStartedAt: startedAt,
    heartbeatCount: 0,
    reconnectCount: 0,
    phaseReconnectCount: 0,
    integrityScore: 100,
    integrityFlags: [],
    manifest,
    rollingDigest: initialEndlessDigest(id, address, runSeed, configVersion),
    checkpointSequence: 0,
    checkpointSignature: '',
    startedAt,
    updatedAt: startedAt,
    lastHeartbeatAt: startedAt,
    expiresAt,
    finishedAt: 0,
    finishReason: '',
    payment: payment ? structuredClone(payment) : null
  };
}

export function verifyEndlessPhaseEvents(run, rawEvents, now = Date.now()) {
  assertApi(run?.status === 'active', 409, 'endless_run_closed', 'This Endless run is no longer active.');
  const manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: run.currentPhase,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  assertApi(
    manifest.fingerprint === run.manifest?.fingerprint && validateEndlessManifest(run.manifest, run.config).ok,
    409,
    'endless_manifest_mismatch',
    'The phase manifest no longer matches the server-authorized run.'
  );
  const maximumEvents = manifest.rules.maximumEvents;
  const serverElapsedMs = Math.max(0, now - Number(run.phaseStartedAt || run.updatedAt || run.startedAt || now));
  assertApi(serverElapsedMs <= manifest.rules.maximumSeconds * 1_000, 422, 'endless_phase_too_long', 'The phase exceeded its maximum verified duration.');
  assertApi(Array.isArray(rawEvents) && rawEvents.length > 0 && rawEvents.length <= maximumEvents, 400, 'endless_events_invalid', `Submit from 1 to ${maximumEvents} phase events.`);
  const byId = new Map(manifest.map.objects.map((object) => [object.id, object]));
  const required = new Set(manifest.gate.requiredEnemyIds);
  const killedRequired = new Set();
  const killedEnemies = new Set();
  const brokenOres = new Set();
  const collectedCrystals = new Set();
  let guardianKilled = false;
  let completed = false;
  let damageTaken = 0;
  let previousTick = 0;
  let score = 0;
  const scoreBreakdown = { naturalEnemies: 0, ore: 0, guardian: 0, completion: 0 };
  const events = rawEvents.map((raw, index) => normalizeEvent(raw, index + 1));
  for (const event of events) {
    assertApi(event.tick >= previousTick, 422, 'endless_event_order', 'Phase event ticks must be ordered.');
    assertApi(event.tick <= manifest.rules.maximumSeconds * 1_000, 422, 'endless_phase_too_long', 'The phase exceeded its maximum verified duration.');
    previousTick = event.tick;
    if (event.type === 'damage_taken') {
      damageTaken += event.amount;
      continue;
    }
    if (event.type === 'enemy_killed') {
      const object = byId.get(event.targetId);
      assertApi(object?.classification === 'natural', 422, 'endless_enemy_unknown', 'An enemy kill is not part of the authorized natural map.');
      assertApi(!killedEnemies.has(event.targetId), 409, 'endless_event_duplicate', 'An enemy cannot be credited twice.');
      killedEnemies.add(event.targetId);
      if (required.has(event.targetId)) killedRequired.add(event.targetId);
      score += object.points;
      scoreBreakdown.naturalEnemies += object.points;
      continue;
    }
    if (event.type === 'ore_broken') {
      const object = byId.get(event.targetId);
      assertApi(object?.classification === 'ore', 422, 'endless_ore_unknown', 'An ore break is not part of the authorized map.');
      assertApi(!brokenOres.has(event.targetId), 409, 'endless_event_duplicate', 'Ore cannot be credited twice.');
      brokenOres.add(event.targetId);
      score += object.points;
      scoreBreakdown.ore += object.points;
      continue;
    }
    if (event.type === 'crystal_collected') {
      const object = byId.get(event.targetId);
      assertApi(object?.mattCrystal === true && brokenOres.has(event.targetId), 422, 'endless_crystal_unknown', 'Only a broken MATT crystal object can enter the carry pack.');
      assertApi(!collectedCrystals.has(event.targetId), 409, 'endless_event_duplicate', 'A crystal cannot enter the carry pack twice.');
      collectedCrystals.add(event.targetId);
      continue;
    }
    if (event.type === 'guardian_defeated') {
      const object = byId.get(event.targetId);
      assertApi(object?.classification === 'boss', 422, 'endless_guardian_unknown', 'The defeated Guardian is not the authorized phase boss.');
      assertApi(killedRequired.size === required.size, 422, 'endless_guardian_locked', 'Every required natural enemy must be defeated before the Guardian.');
      assertApi(!guardianKilled, 409, 'endless_event_duplicate', 'The Guardian cannot be credited twice.');
      guardianKilled = true;
      score += object.points;
      scoreBreakdown.guardian += object.points;
      continue;
    }
    if (event.type === 'phase_completed') {
      assertApi(killedRequired.size === required.size && guardianKilled, 422, 'endless_phase_incomplete', 'Defeat every required enemy and the Guardian before completing the phase.');
      assertApi(!completed, 409, 'endless_event_duplicate', 'A phase can only complete once.');
      completed = true;
      score += manifest.pointLedger.completion;
      scoreBreakdown.completion += manifest.pointLedger.completion;
    }
  }
  assertApi(completed, 422, 'endless_phase_marker_required', 'The server needs the phase-complete marker before banking or descending.');
  assertApi(previousTick <= serverElapsedMs + 10_000, 422, 'endless_event_clock_ahead', 'The phase event clock is ahead of server elapsed time.');
  assertApi(score <= manifest.pointBudget, 422, 'endless_score_over_budget', 'The submitted score exceeds the exact phase budget.');
  const capacity = Math.max(0, Number(
    run.minerProfile?.gameplay?.crystalCarryCapacity ??
    run.minerProfile?.traits?.crystalCarryCapacity ??
    run.minerProfile?.crystalCarryCapacity ?? 0
  ) || 0);
  const configuredUnitCeiling = Math.max(0, Number(run.config?.rewards?.mineableCrystalUnits || 0));
  const rewardUnitCapacity = configuredUnitCeiling > 0 ? Math.min(capacity, configuredUnitCeiling) : capacity;
  const remainingCapacity = Math.max(0, rewardUnitCapacity - Number(run.crystalsCarried || 0));
  const crystalsAdded = Math.min(remainingCapacity, collectedCrystals.size);
  const conversionNumerator = Math.max(0, Number(run.config?.rewards?.crystalConversionNumerator || 0));
  const conversionDenominator = Math.max(1, Number(run.config?.rewards?.crystalConversionDenominator || 1));
  const grossCrystalsEarned = Math.floor(collectedCrystals.size * conversionNumerator / conversionDenominator);
  const digest = hashEndlessCheckpoint(run.rollingDigest, manifest, events);
  return {
    phase: run.currentPhase,
    manifestFingerprint: manifest.fingerprint,
    score,
    maximumScore: manifest.pointBudget,
    scoreBreakdown,
    requiredEnemyIds: [...required],
    killedEnemyIds: [...killedEnemies],
    generatedOreIds: manifest.map.objects.filter((object) => object.classification === 'ore').map((object) => object.id),
    brokenOreIds: [...brokenOres],
    generatedCrystalIds: manifest.map.objects.filter((object) => object.mattCrystal === true).map((object) => object.id),
    minedCrystalIds: [...collectedCrystals],
    guardianId: manifest.map.objects.find((object) => object.classification === 'boss')?.id || '',
    bossAuthorized: killedRequired.size === required.size,
    requiredKills: killedRequired.size,
    bossKills: 1,
    oreBroken: brokenOres.size,
    crystalsAdded,
    grossCrystalsEarned,
    crystalsUnableToCarry: Math.max(0, collectedCrystals.size - crystalsAdded),
    damageTaken: Math.round(damageTaken * 1_000) / 1_000,
    elapsedMs: previousTick,
    eventCount: events.length,
    digest,
    verifiedAt: now
  };
}

export function applyEndlessPhaseCheckpoint(run, verification, action, now = Date.now()) {
  assertApi(['descend', 'bank'].includes(action), 400, 'endless_action_invalid', 'Choose descend or bank.');
  assertApi(verification.phase === run.currentPhase, 409, 'endless_phase_sequence', 'Use the current server phase checkpoint.');
  run.completedPhases += 1;
  run.score += verification.score;
  run.crystalsCarried += verification.crystalsAdded;
  run.requiredKills += verification.requiredKills;
  run.bossKills += verification.bossKills;
  run.oreBroken += verification.oreBroken;
  run.phaseHistory.push({ ...verification, action });
  if (run.phaseHistory.length > 500) run.phaseHistory = run.phaseHistory.slice(-500);
  run.rollingDigest = verification.digest;
  run.checkpointSequence += 1;
  run.updatedAt = now;
  run.lastHeartbeatAt = now;
  run.expiresAt = now + run.config.integrity.reconnectWindowSeconds * 1_000;
  if (action === 'bank') {
    run.status = 'banked';
    run.finishedAt = now;
    run.finishReason = 'banked';
    return null;
  }
  const configuredMaximumPhase = Math.min(ENDLESS_MAX_PHASE, Math.max(1, Number(run.config?.rewards?.maximumPhases || ENDLESS_MAX_PHASE)));
  assertApi(run.currentPhase < configuredMaximumPhase, 422, 'endless_phase_limit', 'This run reached its versioned phase ceiling.');
  run.currentPhase += 1;
  run.phaseStartedAt = now;
  run.phaseReconnectCount = 0;
  run.manifest = generateEndlessPhase({
    runId: run.id,
    runSeed: run.runSeed,
    phase: run.currentPhase,
    configVersion: run.configVersion,
    config: run.config,
    minerProfile: run.minerProfile
  });
  return run.manifest;
}

export function signEndlessCheckpoint(run, secret) {
  return createHmac('sha256', String(secret || ''))
    .update(`${run.id}|${run.address}|${run.checkpointSequence}|${run.currentPhase}|${run.rollingDigest}|${run.status}`)
    .digest('hex');
}

export function validEndlessCheckpoint(run, checkpoint, secret) {
  const supplied = String(checkpoint?.signature || '');
  const expected = signEndlessCheckpoint(run, secret);
  return Number(checkpoint?.sequence) === run.checkpointSequence &&
    Number(checkpoint?.phase) === run.currentPhase &&
    String(checkpoint?.digest || '') === run.rollingDigest &&
    safeEqual(supplied, expected);
}

export function publicEndlessCheckpoint(run) {
  return {
    sequence: run.checkpointSequence,
    phase: run.currentPhase,
    digest: run.rollingDigest,
    signature: run.checkpointSignature
  };
}

export function endlessLeaderboard(entries, scope = 'all-time', timestamp = Date.now(), seasonDays = 30) {
  const bounds = leaderboardBounds(scope, timestamp, seasonDays);
  const eligible = (Array.isArray(entries) ? entries : []).filter((entry) =>
    entry?.verified === true && entry.finishedAt >= bounds.from && entry.finishedAt < bounds.to
  );
  const best = new Map();
  for (const entry of eligible) {
    const current = best.get(entry.address);
    if (!current || compareLeaderboard(entry, current) < 0) best.set(entry.address, entry);
  }
  return [...best.values()].sort(compareLeaderboard).slice(0, 100).map((entry, index) => ({
    rank: index + 1,
    address: entry.address,
    runId: entry.runId,
    deepestPhase: entry.deepestPhase,
    score: entry.score,
    crystalsBanked: entry.crystalsBanked,
    survivalMs: entry.survivalMs,
    finishedAt: entry.finishedAt
  }));
}

export function endlessSmartEngineRecommendation(runs, configInput, now = Date.now()) {
  const config = normalizeEndlessConfig(configInput);
  const verified = (Array.isArray(runs) ? runs : []).filter((run) => run?.verified === true && run.phaseCount > 0);
  if (!config.smartEngine.enabled || verified.length < config.smartEngine.minimumSamples) return null;
  const clearTimes = verified.map((run) => run.averagePhaseSeconds).filter(Number.isFinite).sort((a, b) => a - b);
  const median = clearTimes[Math.floor(clearTimes.length / 2)];
  const target = config.smartEngine.targetClearSeconds;
  const rawAdjustment = Math.round((median / target - 1) * 10_000);
  const limit = config.smartEngine.maximumAdjustmentBps;
  const adjustmentBps = Math.max(-limit, Math.min(limit, rawAdjustment));
  return {
    id: `smart-${now}-${stableFingerprint({ median, target, adjustmentBps, samples: verified.length })}`,
    status: 'recommendation-only',
    samples: verified.length,
    medianPhaseSeconds: median,
    targetPhaseSeconds: target,
    suggestedDifficultyAdjustmentBps: adjustmentBps,
    createdAt: now
  };
}

function normalizeEvent(raw, sequence) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const type = String(source.type || '');
  assertApi(EVENT_TYPES.has(type), 400, 'endless_event_type', 'Unknown Endless phase event.');
  const tick = Number(source.tick);
  assertApi(Number.isSafeInteger(tick) && tick >= 0, 400, 'endless_event_tick', 'Endless event ticks must be non-negative integers.');
  const targetId = String(source.targetId || '').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 100);
  const amount = type === 'damage_taken' ? Math.max(0, Math.min(1_000_000, Number(source.amount) || 0)) : 0;
  return { sequence, type, tick, ...(targetId ? { targetId } : {}), ...(amount ? { amount } : {}) };
}

function initialEndlessDigest(id, address, seed, configVersion) {
  return createHash('sha256').update(`MATT-ENDLESS|${id}|${address}|${seed}|${configVersion}`).digest('hex');
}

function hashEndlessCheckpoint(previous, manifest, events) {
  return createHash('sha256')
    .update(`${previous}|${manifest.fingerprint}|${canonical(events)}`)
    .digest('hex');
}

function leaderboardBounds(scope, timestamp, seasonDays) {
  const day = 86_400_000;
  const date = new Date(timestamp);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (scope === 'daily') return { from: dayStart, to: dayStart + day };
  if (scope === 'weekly') {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const from = dayStart - mondayOffset * day;
    return { from, to: from + 7 * day };
  }
  if (scope === 'season') {
    const length = Math.max(1, Math.floor(seasonDays)) * day;
    const from = Math.floor(timestamp / length) * length;
    return { from, to: from + length };
  }
  assertApi(scope === 'all-time', 400, 'endless_leaderboard_scope', 'Choose daily, weekly, season, or all-time.');
  return { from: 0, to: Number.MAX_SAFE_INTEGER };
}

function compareLeaderboard(left, right) {
  return Number(right.deepestPhase || 0) - Number(left.deepestPhase || 0) ||
    Number(right.score || 0) - Number(left.score || 0) ||
    Number(right.crystalsBanked || 0) - Number(left.crystalsBanked || 0) ||
    Number(right.survivalMs || 0) - Number(left.survivalMs || 0) ||
    Number(left.finishedAt || 0) - Number(right.finishedAt || 0) ||
    String(left.runId || '').localeCompare(String(right.runId || ''));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
