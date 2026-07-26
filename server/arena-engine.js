import { createHash } from 'node:crypto';
import { assertApi } from './errors.js';

export const ARENA_TRANSCRIPT_VERSION = 'matt-arena-transcript-v1';
// Browser telemetry reports elapsed whole milliseconds. The server still
// constrains each timestamp against wall time when a batch arrives.
export const ARENA_TICK_MS = 1;
export const ARENA_MAX_TICKS = 20 * 60_000;
export const ARENA_MAX_EVENTS = 10_000;
export const ARENA_MAX_BATCH_EVENTS = 256;
export const ARENA_EVENT_TYPES = Object.freeze([
  'ore_broken',
  'enemy_killed',
  'damage_taken',
  'guardian_defeated',
  'descend',
  'extract',
  'knockout'
]);

const MAX_DEPTH = 5;
const MIN_SCORING_ACTION_TICKS = 120;
const MIN_DAMAGE_EVENT_TICKS = 250;
const KNOCKOUT_KEEP_BPS = 3_500;

/**
 * Generates the complete, public encounter manifest for a UTC day. The manifest
 * is derived from the server's committed daily seed, so replay never relies on a
 * browser-provided reward, target value, or random roll.
 */
export function buildArenaChallenge(dailySeed) {
  assertApi(
    typeof dailySeed === 'string' && /^[a-f0-9]{64}$/.test(dailySeed),
    500,
    'arena_seed_invalid',
    'The Daily Arena seed is invalid.'
  );
  const random = deterministicWords(dailySeed);
  const depths = [];
  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const crystalGoal = 3 + Math.floor((depth - 1) / 2);
    const oreCount = 11 + depth * 2;
    const enemyCount = 12 + depth * 3;
    const ores = [];
    const enemies = [];
    for (let index = 0; index < oreCount; index += 1) {
      ores.push({
        id: `d${depth}:ore:${index}`,
        crystal: index < crystalGoal,
        value: 500 + random.nextInt(1_001) + depth * 125
      });
    }
    for (let index = 0; index < enemyCount; index += 1) {
      enemies.push({
        id: `d${depth}:enemy:${index}`,
        value: 300 + random.nextInt(701) + depth * 100
      });
    }
    depths.push({
      depth,
      crystalGoal,
      minimumEnemyKills: 5 + depth,
      ores,
      enemies,
      guardian: {
        id: `d${depth}:guardian`,
        value: 8_000 + depth * 4_000
      }
    });
  }
  return {
    version: ARENA_TRANSCRIPT_VERSION,
    tickMs: ARENA_TICK_MS,
    maxTicks: ARENA_MAX_TICKS,
    maxDepth: MAX_DEPTH,
    depths
  };
}

/**
 * Replays the server-stored transcript and returns the only score that can be
 * accepted. A caller may request a non-terminal replay while appending events;
 * final submission must require a terminal extract/knockout event.
 */
export function replayArenaTranscript(challenge, inputEvents, options = {}) {
  assertApi(
    challenge?.version === ARENA_TRANSCRIPT_VERSION && Array.isArray(challenge.depths),
    500,
    'arena_challenge_invalid',
    'The Daily Arena challenge is invalid.'
  );
  assertApi(
    Array.isArray(inputEvents) && inputEvents.length <= ARENA_MAX_EVENTS,
    422,
    'arena_transcript_too_large',
    'The Daily Arena transcript is too large.'
  );

  const state = {
    depth: 1,
    projected: 0,
    damageTaken: 0,
    guardianTimeMs: Number.MAX_SAFE_INTEGER,
    terminal: '',
    terminalTick: 0,
    lastTick: -1,
    lastScoringTick: -MIN_SCORING_ACTION_TICKS,
    lastDamageTick: -MIN_DAMAGE_EVENT_TICKS,
    defeatedGuardian: false,
    usedTargets: new Set(),
    crystals: 0,
    enemyKills: 0,
    oreBroken: 0,
    kills: 0,
    depthOreBroken: 0,
    depthEnemyKills: 0
  };

  for (let index = 0; index < inputEvents.length; index += 1) {
    const event = normalizeArenaEvent(inputEvents[index], index + 1);
    assertApi(
      !state.terminal,
      422,
      'arena_event_after_terminal',
      'The transcript contains input after the run ended.'
    );
    assertApi(
      event.tick >= state.lastTick,
      422,
      'arena_tick_regressed',
      'Arena event ticks must be monotonic.'
    );
    state.lastTick = event.tick;
    const depth = challenge.depths[state.depth - 1];

    if (event.type === 'ore_broken') {
      enforceActionCadence(state, event.tick);
      const target = depth.ores[state.depthOreBroken];
      assertTarget(target, state, event.targetId, 'ore');
      state.usedTargets.add(event.targetId);
      state.oreBroken += 1;
      state.depthOreBroken += 1;
      state.crystals += state.depthOreBroken <= depth.crystalGoal ? 1 : 0;
      state.projected += target.value;
    } else if (event.type === 'enemy_killed') {
      enforceActionCadence(state, event.tick);
      const target = depth.enemies[state.depthEnemyKills];
      assertTarget(target, state, event.targetId, 'enemy');
      state.usedTargets.add(event.targetId);
      state.enemyKills += 1;
      state.depthEnemyKills += 1;
      state.kills += 1;
      state.projected += target.value;
    } else if (event.type === 'damage_taken') {
      assertApi(
        event.tick - state.lastDamageTick >= MIN_DAMAGE_EVENT_TICKS,
        422,
        'arena_damage_rate_invalid',
        'Damage events exceed the Daily Arena replay rate.'
      );
      state.lastDamageTick = event.tick;
      state.damageTaken += event.amount;
      assertApi(
        state.damageTaken <= 1_000_000,
        422,
        'arena_damage_invalid',
        'Reported Daily Arena damage is outside the supported range.'
      );
    } else if (event.type === 'guardian_defeated') {
      enforceActionCadence(state, event.tick);
      assertApi(
        !state.usedTargets.has(event.targetId),
        422,
        'arena_guardian_invalid',
        'The Guardian event does not match the active depth.'
      );
      assertApi(
        state.crystals >= depth.crystalGoal,
        422,
        'arena_crystals_required',
        'The active depth does not have enough verified crystals for the Guardian.'
      );
      state.usedTargets.add(event.targetId);
      state.defeatedGuardian = true;
      state.guardianTimeMs = event.tick * ARENA_TICK_MS;
      state.kills += 1;
      state.projected += depth.guardian.value;
    } else if (event.type === 'descend') {
      assertApi(state.defeatedGuardian, 422, 'arena_guardian_required', 'Defeat the Guardian before descending.');
      assertApi(state.depth < MAX_DEPTH, 422, 'arena_max_depth', 'The final depth cannot descend further.');
      if (event.amount !== undefined) {
        assertApi(event.amount === state.depth + 1, 422, 'arena_depth_mismatch', 'The descend event does not match the next depth.');
      }
      state.depth += 1;
      state.crystals = 0;
      state.enemyKills = 0;
      state.depthOreBroken = 0;
      state.depthEnemyKills = 0;
      state.defeatedGuardian = false;
    } else if (event.type === 'extract') {
      assertApi(state.defeatedGuardian, 422, 'arena_guardian_required', 'Defeat the Guardian before extracting.');
      state.terminal = 'extract';
      state.terminalTick = event.tick;
    } else if (event.type === 'knockout') {
      state.terminal = 'knockout';
      state.terminalTick = event.tick;
    }
  }

  if (options.requireTerminal === true) {
    assertApi(state.terminal, 422, 'arena_run_not_terminal', 'Submit an extract or knockout event before finishing.');
  }
  const extracted = state.terminal === 'extract';
  const score = extracted
    ? state.projected
    : Math.floor((state.projected * KNOCKOUT_KEEP_BPS) / 10_000);
  return {
    terminal: Boolean(state.terminal),
    extracted,
    score,
    projected: state.projected,
    depth: state.depth,
    guardianTimeMs: state.guardianTimeMs,
    damageTaken: state.damageTaken,
    elapsedMs: state.terminal ? state.terminalTick * ARENA_TICK_MS : state.lastTick * ARENA_TICK_MS,
    kills: state.kills,
    oreBroken: state.oreBroken,
    eventCount: inputEvents.length
  };
}

export function normalizeArenaEvent(input, expectedSequence) {
  assertApi(
    input && typeof input === 'object' && !Array.isArray(input),
    400,
    'arena_event_invalid',
    'Each Daily Arena event must be an object.'
  );
  const seq = strictInteger(input.seq, 1, ARENA_MAX_EVENTS, 'seq');
  const tick = strictInteger(input.tick, 0, ARENA_MAX_TICKS, 'tick');
  const type = String(input.type || '');
  assertApi(
    seq === expectedSequence,
    409,
    'arena_event_sequence_invalid',
    'Daily Arena events must be contiguous and in order.'
  );
  assertApi(
    ARENA_EVENT_TYPES.includes(type),
    400,
    'arena_event_type_invalid',
    'The Daily Arena event type is not supported.'
  );

  const allowedKeys = new Set(['seq', 'tick', 'type']);
  const event = { seq, tick, type };
  if (['ore_broken', 'enemy_killed', 'guardian_defeated'].includes(type)) {
    assertApi(
      Number.isSafeInteger(input.targetId) && input.targetId > 0 && input.targetId <= 1_000_000_000,
      400,
      'arena_target_invalid',
      'The Daily Arena target identifier is invalid.'
    );
    allowedKeys.add('targetId');
    event.targetId = input.targetId;
  }
  if (type === 'damage_taken') {
    allowedKeys.add('amount');
    assertApi(
      Number.isFinite(input.amount) && input.amount > 0 && input.amount <= 10_000,
      400,
      'arena_event_field_invalid',
      'Daily Arena damage must be greater than zero and no more than 10,000.'
    );
    event.amount = Math.max(1, Math.round(input.amount));
  }
  if (type === 'descend' && input.amount !== undefined) {
    allowedKeys.add('amount');
    event.amount = strictInteger(input.amount, 2, 5, 'amount');
  }
  assertApi(
    Object.keys(input).every((key) => allowedKeys.has(key)),
    400,
    'arena_event_fields_invalid',
    'The Daily Arena event contains unsupported fields.'
  );
  return event;
}

export function hashArenaEvent(previousHash, event) {
  assertApi(/^[a-f0-9]{64}$/.test(previousHash || ''), 500, 'arena_hash_invalid', 'The transcript hash is invalid.');
  return createHash('sha256')
    .update(`${previousHash}|${canonicalJson(event)}`)
    .digest('hex');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function deterministicWords(seed) {
  let counter = 0;
  return {
    nextInt(max) {
      const digest = createHash('sha256')
        .update(`${seed}:${counter++}`)
        .digest();
      return digest.readUInt32BE(0) % max;
    }
  };
}

function strictInteger(value, min, max, field) {
  assertApi(
    Number.isSafeInteger(value) && value >= min && value <= max,
    400,
    'arena_event_field_invalid',
    `Daily Arena ${field} must be an integer from ${min} to ${max}.`
  );
  return value;
}

function assertTarget(target, state, targetId, kind) {
  assertApi(target, 422, 'arena_target_unavailable', `The ${kind} target is not part of the active Daily Arena depth.`);
  assertApi(!state.usedTargets.has(targetId), 409, 'arena_target_reused', 'A Daily Arena target cannot score twice.');
}

function enforceActionCadence(state, tick) {
  assertApi(
    tick - state.lastScoringTick >= MIN_SCORING_ACTION_TICKS,
    422,
    'arena_action_rate_invalid',
    'Scoring actions exceed the Daily Arena replay rate.'
  );
  state.lastScoringTick = tick;
}
