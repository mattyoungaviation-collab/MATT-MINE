import { createHash } from 'node:crypto';
import {
  ARENA_FIXED_STEP_MS,
  ARENA_WEAPONS,
  decodeArenaControlState
} from '../src/game/arenaControls.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import { assertApi } from './errors.js';

export const ARENA_TRANSCRIPT_VERSION = 'matt-arena-input-v2';
export const ARENA_TICK_MS = ARENA_FIXED_STEP_MS;
export const ARENA_MAX_TICKS = 20 * 60_000;
export const ARENA_MAX_EVENTS = 20_000;
export const ARENA_MAX_BATCH_EVENTS = 256;
export const ARENA_EVENT_TYPES = Object.freeze(['input', 'command', 'finish']);
export const ARENA_COMMANDS = Object.freeze(['upgrade', 'descend', 'extract']);

const NOOP_AUDIO = Object.freeze({
  startMusic() {},
  stopMusic() {},
  resume() {},
  play() {},
  startBoss() {},
  stopBoss() {}
});

export function buildArenaChallenge(dailySeed) {
  assertApi(
    typeof dailySeed === 'string' && /^[a-f0-9]{64}$/.test(dailySeed),
    500,
    'arena_seed_invalid',
    'The Daily Arena seed is invalid.'
  );
  return {
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed,
    tickMs: ARENA_TICK_MS,
    maxTicks: ARENA_MAX_TICKS,
    maxDepth: 5,
    verificationMode: 'deterministic-input-replay'
  };
}

/**
 * Replays only fixed-step player controls through the same gameplay engine used
 * by the browser. Browser milestones and browser score summaries are never
 * accepted. The resulting terminal state is the sole leaderboard authority.
 */
export function replayArenaTranscript(challenge, inputEvents, options = {}) {
  assertApi(
    challenge?.version === ARENA_TRANSCRIPT_VERSION &&
      typeof challenge.dailySeed === 'string',
    500,
    'arena_challenge_invalid',
    'The Daily Arena challenge is invalid.'
  );
  assertApi(
    Array.isArray(inputEvents) && inputEvents.length <= ARENA_MAX_EVENTS,
    422,
    'arena_transcript_too_large',
    'The Daily Arena input transcript is too large.'
  );

  let finalResult = null;
  let damageTaken = 0;
  let guardianTimeMs = Number.MAX_SAFE_INTEGER;
  let finishSeen = false;
  const game = new MattMineGame(null, defaultProfile(), {
    headless: true,
    audio: NOOP_AUDIO,
    onArenaEvent(event) {
      if (event?.type === 'damage_taken') damageTaken += Math.max(0, Number(event.amount) || 0);
      if (event?.type === 'guardian_defeated') guardianTimeMs = Math.min(guardianTimeMs, Number(event.tick) || 0);
    },
    onRunEnd(result) {
      finalResult = { ...result };
    }
  });
  game.startRun({
    mode: 'arena',
    seed: challenge.dailySeed,
    day: options.day || ''
  });

  let control = decodeArenaControlState({
    moveX: 0,
    moveY: 0,
    aim: null,
    attack: false,
    dash: false,
    weapon: ''
  });
  let lastTick = -1;

  for (let index = 0; index < inputEvents.length; index += 1) {
    const event = normalizeArenaEvent(inputEvents[index], index + 1);
    assertApi(!finishSeen, 422, 'arena_event_after_terminal', 'The input transcript continues after its finish marker.');
    assertApi(event.tick >= lastTick, 422, 'arena_tick_regressed', 'Arena input ticks must be monotonic.');
    assertApi(
      game.advanceArenaToTick(event.tick, control),
      422,
      'arena_replay_stalled',
      'The input transcript skipped a required upgrade, descent, extraction, or knockout boundary.'
    );
    lastTick = event.tick;

    if (event.type === 'input') {
      control = decodeArenaControlState(event);
    } else if (event.type === 'command') {
      applyCommand(game, event);
    } else {
      finishSeen = true;
      assertApi(
        game.state === 'ended' && finalResult,
        422,
        'arena_run_not_terminal',
        'The replayed game has not reached extraction or knockout.'
      );
    }
  }

  if (options.requireTerminal === true) {
    assertApi(finishSeen && finalResult, 422, 'arena_run_not_terminal', 'A verified finish marker is required.');
  }
  const projected = Math.max(0, Math.floor(finalResult?.projected || game.projectedPayout?.() || 0));
  const extracted = finalResult?.extracted === true;
  const score = finalResult
    ? Math.max(0, Math.floor(extracted ? projected : finalResult.banked || 0))
    : 0;
  return {
    terminal: finishSeen,
    extracted,
    score,
    projected,
    depth: Math.max(1, Math.floor(finalResult?.depth || game.run?.depth || 1)),
    guardianTimeMs,
    damageTaken: Math.max(0, Math.round(damageTaken)),
    elapsedMs: Math.max(0, Math.round((game.run?.elapsed || 0) * 1_000)),
    kills: Math.max(0, Math.floor(finalResult?.kills || game.run?.kills || 0)),
    oreBroken: Math.max(0, Math.floor(finalResult?.oreBroken || game.run?.oreBroken || 0)),
    eventCount: inputEvents.length
  };
}

export function normalizeArenaEvent(input, expectedSequence) {
  assertApi(
    input && typeof input === 'object' && !Array.isArray(input),
    400,
    'arena_event_invalid',
    'Each Daily Arena input must be an object.'
  );
  const seq = strictInteger(input.seq, 1, ARENA_MAX_EVENTS, 'seq');
  const tick = strictInteger(input.tick, 0, ARENA_MAX_TICKS, 'tick');
  assertApi(
    tick % ARENA_TICK_MS === 0,
    400,
    'arena_tick_invalid',
    `Daily Arena ticks must align to ${ARENA_TICK_MS}ms fixed steps.`
  );
  const type = String(input.type || '');
  assertApi(seq === expectedSequence, 409, 'arena_event_sequence_invalid', 'Daily Arena inputs must be contiguous and in order.');
  assertApi(ARENA_EVENT_TYPES.includes(type), 400, 'arena_event_type_invalid', 'Only raw Daily Arena inputs are accepted.');

  const event = { seq, tick, type };
  const allowedKeys = new Set(['seq', 'tick', 'type']);
  if (type === 'input') {
    for (const key of ['moveX', 'moveY', 'aim', 'attack', 'dash', 'weapon']) allowedKeys.add(key);
    event.moveX = strictInteger(input.moveX, -1_000, 1_000, 'moveX');
    event.moveY = strictInteger(input.moveY, -1_000, 1_000, 'moveY');
    event.aim = input.aim === null ? null : strictInteger(input.aim, -31_416, 31_416, 'aim');
    assertApi(typeof input.attack === 'boolean' && typeof input.dash === 'boolean', 400, 'arena_event_field_invalid', 'Arena attack and dash inputs must be booleans.');
    assertApi(ARENA_WEAPONS.includes(String(input.weapon || '')), 400, 'arena_event_field_invalid', 'The Arena weapon input is invalid.');
    event.attack = input.attack;
    event.dash = input.dash;
    event.weapon = String(input.weapon || '');
  } else if (type === 'command') {
    allowedKeys.add('command');
    allowedKeys.add('value');
    event.command = String(input.command || '');
    assertApi(ARENA_COMMANDS.includes(event.command), 400, 'arena_command_invalid', 'The Arena command is invalid.');
    if (event.command === 'upgrade') {
      assertApi(typeof input.value === 'string' && /^[a-z]{3,20}$/.test(input.value), 400, 'arena_upgrade_invalid', 'The Arena upgrade choice is invalid.');
      event.value = input.value;
    } else {
      assertApi(input.value === undefined, 400, 'arena_event_fields_invalid', 'This Arena command does not accept a value.');
    }
  }
  assertApi(
    Object.keys(input).every((key) => allowedKeys.has(key)),
    400,
    'arena_event_fields_invalid',
    'The Daily Arena input contains unsupported fields.'
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

function applyCommand(game, event) {
  if (event.command === 'upgrade') {
    assertApi(
      game.state === 'levelup' && game.pendingUpgradeIds?.includes(event.value),
      422,
      'arena_upgrade_not_offered',
      'The replayed game did not offer that upgrade.'
    );
    game.chooseRunUpgrade(event.value);
    assertApi(game.state === 'playing', 422, 'arena_upgrade_rejected', 'The replayed upgrade was rejected.');
    return;
  }
  assertApi(
    game.state === 'depthchoice' && game.run?.bossKilled === true,
    422,
    'arena_guardian_required',
    'The replayed Guardian must be defeated before this command.'
  );
  if (event.command === 'descend') {
    const depth = game.run.depth;
    assertApi(depth < 5, 422, 'arena_max_depth', 'The final Arena depth cannot descend further.');
    game.descend();
    assertApi(game.state === 'playing' && game.run.depth === depth + 1, 422, 'arena_depth_mismatch', 'The replayed descent failed.');
    return;
  }
  game.extract();
  assertApi(game.state === 'ended', 422, 'arena_extract_rejected', 'The replayed extraction failed.');
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
