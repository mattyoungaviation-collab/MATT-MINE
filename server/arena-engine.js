import { createHash } from 'node:crypto';
import {
  ARENA_FIXED_STEP_MS,
  ARENA_WEAPONS,
  decodeArenaControlState
} from '../src/game/arenaControls.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile, normalizeProfile } from '../src/game/storage.js';
import { assertApi } from './errors.js';

export const ARENA_TRANSCRIPT_VERSION = 'matt-arena-input-v2';
export const ARENA_TICK_MS = ARENA_FIXED_STEP_MS;
export const ARENA_MAX_TICKS = 20 * 60_000;
// A 20-minute run contains 60,000 fixed input steps. Most controls are
// de-duplicated by the browser, but continuous mouse aim can legitimately
// change on every step. Keep room for one input per step plus terminal,
// upgrade, depth, revive, and other command events.
export const ARENA_MAX_EVENTS = Math.ceil(ARENA_MAX_TICKS / ARENA_TICK_MS) + 1_024;
export const ARENA_MAX_BATCH_EVENTS = 256;
export const ARENA_EVENT_TYPES = Object.freeze(['input', 'command', 'finish']);
export const ARENA_COMMANDS = Object.freeze([
  'upgrade',
  'descend',
  'extract',
  'death',
  'revive',
  'decline',
  'time_limit'
]);
export const COMPETITIVE_REPLAY_MODES = Object.freeze(['practice', 'free', 'paid', 'weekly', 'endless']);

const NOOP_AUDIO = Object.freeze({
  startMusic() {},
  stopMusic() {},
  resume() {},
  play() {},
  startBoss() {},
  stopBoss() {}
});

export function buildArenaChallenge(dailySeed, tuning = {}) {
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
    maxEvents: ARENA_MAX_EVENTS,
    maxDepth: 5,
    verificationMode: 'deterministic-input-replay',
    tuning: tuning && typeof tuning === 'object' ? structuredClone(tuning) : {}
  };
}

export function buildCompetitiveChallenge(run) {
  assertApi(
    run && COMPETITIVE_REPLAY_MODES.includes(run.mode) && typeof run.seed === 'string',
    500,
    'competitive_challenge_invalid',
    'The competitive run snapshot is invalid.'
  );
  return {
    version: ARENA_TRANSCRIPT_VERSION,
    dailySeed: run.seed,
    tickMs: ARENA_TICK_MS,
    maxTicks: ARENA_MAX_TICKS,
    maxEvents: ARENA_MAX_EVENTS,
    maxDepth: competitiveMaximumDepth(run),
    verificationMode: 'deterministic-input-replay',
    tuning: structuredClone(run.tuning || {})
  };
}

export function competitiveMaximumDepth(run = {}) {
  if (run.mode === 'endless') return 1_000;
  const publishedDepths = run.competitionSnapshot?.depths?.length
    ?? run.tuning?._competitionSnapshot?.depths?.length;
  return Number.isSafeInteger(publishedDepths)
    ? Math.max(1, Math.min(5, publishedDepths))
    : 5;
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
  const game = new MattMineGame(
    null,
    options.profile ? normalizeProfile(options.profile) : defaultProfile(),
    {
      headless: true,
      audio: NOOP_AUDIO,
      onArenaEvent(event) {
        if (event?.type === 'damage_taken') damageTaken += Math.max(0, Number(event.amount) || 0);
        if (event?.type === 'guardian_defeated') guardianTimeMs = Math.min(guardianTimeMs, Number(event.tick) || 0);
      },
      onRunEnd(result) {
        finalResult = { ...result };
      }
    }
  );
  const replayMode = options.mode || 'arena';
  assertApi(
    replayMode === 'arena' || COMPETITIVE_REPLAY_MODES.includes(replayMode),
    500,
    'replay_mode_invalid',
    'The deterministic replay mode is invalid.'
  );
  game.startRun({
    mode: replayMode,
    seed: challenge.dailySeed,
    day: options.day || '',
    week: options.week || '',
    tuning: challenge.tuning || {},
    characterId:
      options.characterId ||
      challenge.tuning?._competitionSnapshot?.loadout?.characterId ||
      'matt',
    character:
      options.character ||
      challenge.tuning?._competitionCharacter ||
      {},
    weeklyStage: options.weeklyStage || null,
    endlessSnapshot: options.endlessSnapshot || null,
    roundDurationMs: replayMode === 'arena' ? challenge.maxTicks : 0,
    allowPaidRevive: options.allowPaidRevive === true,
    reviveLimitPerRun:
      options.reviveLimitPerRun ||
      challenge.tuning?._paidRevive?.limitPerRun ||
      Math.max(1, Math.floor(Number(options.confirmedPaidRevives || 0))),
    reviveInvulnerabilitySeconds: options.reviveInvulnerabilitySeconds
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
  let reviveCommands = 0;

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
      if (event.command === 'revive') reviveCommands += 1;
      applyReplayCommand(game, event, {
        mode: replayMode,
        allowPaidRevive: options.allowPaidRevive === true,
        confirmedPaidRevives: Math.max(0, Math.floor(Number(options.confirmedPaidRevives || 0))),
        reviveCommandIndex: reviveCommands,
        maxTicks: challenge.maxTicks,
        maxDepth: Number.isSafeInteger(options.maxDepth)
          ? options.maxDepth
          : challenge.maxDepth
      });
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
    banked: Math.max(0, Math.floor(finalResult?.banked || 0)),
    lost: Math.max(0, Math.floor(finalResult?.lost || 0)),
    depth: Math.max(1, Math.floor(finalResult?.depth || game.run?.depth || 1)),
    guardianTimeMs,
    damageTaken: Math.max(0, Math.round(damageTaken)),
    elapsedMs: Math.max(0, Math.round((game.run?.elapsed || 0) * 1_000)),
    elapsed: Math.max(0, Number(finalResult?.elapsed || game.run?.elapsed || 0)),
    kills: Math.max(0, Math.floor(finalResult?.kills || game.run?.kills || 0)),
    oreBroken: Math.max(0, Math.floor(finalResult?.oreBroken || game.run?.oreBroken || 0)),
    bossTelemetry: finalResult?.bossTelemetry || null,
    crystalsCarried: Math.max(0, Math.floor(finalResult?.crystalsCarried || game.run?.crystalsCollected || 0)),
    completedPhases: Math.max(0, Math.min(0x1f, Math.floor(finalResult?.completedPhases || 0))),
    maximumHealth: Math.max(1, Number(game.player?.maxHealth || 100)),
    eventCount: inputEvents.length,
    timeLimitReached: finalResult?.timeLimitReached === true,
    awaitingRevive: game.state === 'awaitingrevive'
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

export function assertArenaTickOrder(events, previousTick = 0) {
  let lastTick = previousTick;
  for (const event of events) {
    assertApi(event.tick >= lastTick, 422, 'arena_tick_regressed', 'Arena input ticks must be monotonic.');
    lastTick = event.tick;
  }
}

export function arenaBatchRequiresReplay(events) {
  return events.some((event) => event.type !== 'input');
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function applyReplayCommand(game, event, options = {}) {
  if (event.command === 'upgrade') {
    assertApi(
      game.state === 'levelup' && game.pendingUpgradeIds?.includes(event.value),
      422,
      'arena_upgrade_not_offered',
      'The replayed game did not offer that upgrade.'
    );
    const previousCount = Number(game.player?.runUpgradeCounts?.[event.value] || 0);
    const blasterUpgradeQueued = game.pendingBlasterUpgrade === true;
    game.chooseRunUpgrade(event.value);
    const upgradeApplied = Number(game.player?.runUpgradeCounts?.[event.value] || 0) === previousCount + 1;
    const queuedBlasterOfferOpened =
      blasterUpgradeQueued &&
      game.state === 'levelup' &&
      Array.isArray(game.pendingUpgradeIds) &&
      game.pendingUpgradeIds.length > 0 &&
      !game.pendingUpgradeIds.includes(event.value);
    assertApi(
      upgradeApplied && (game.state === 'playing' || queuedBlasterOfferOpened),
      422,
      'arena_upgrade_rejected',
      'The replayed upgrade was rejected.'
    );
    return;
  }
  if (event.command === 'death') {
    assertApi(
      game.state === 'awaitingrevive',
      422,
      'revive_death_not_verified',
      'The replay did not reach a paid-revive knockout.'
    );
    return;
  }
  if (event.command === 'revive') {
    assertApi(
      options.allowPaidRevive === true &&
        options.confirmedPaidRevives >= options.reviveCommandIndex,
      422,
      'revive_payment_not_confirmed',
      'The replayed paid revive does not have a verified payment.'
    );
    assertApi(
      game.applyPaidRevive({ record: false }),
      422,
      'revive_command_rejected',
      'The replayed paid revive was rejected.'
    );
    return;
  }
  if (event.command === 'decline') {
    assertApi(
      options.allowPaidRevive === true && game.declinePaidRevive({ record: false }) !== false,
      422,
      'revive_decline_rejected',
      'The replayed revive decline was rejected.'
    );
    return;
  }
  if (event.command === 'time_limit') {
    assertApi(
      options.mode === 'arena' &&
        Number.isSafeInteger(options.maxTicks) &&
        event.tick === options.maxTicks,
      422,
      'arena_time_limit_invalid',
      'The Arena time limit can only close a run at the authoritative final tick.'
    );
    assertApi(
      game.endArenaTimeLimit({
        record: false,
        roundDurationMs: options.maxTicks
      }),
      422,
      'arena_time_limit_rejected',
      'The replayed Arena run could not be extracted at the time limit.'
    );
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
    assertApi(options.mode !== 'weekly', 422, 'weekly_single_depth', 'Weekly competition ends after one mine.');
    const maxDepth = Number.isSafeInteger(options.maxDepth) ? options.maxDepth : 5;
    assertApi(
      options.mode === 'endless' || depth < maxDepth,
      422,
      'arena_max_depth',
      'The final competition depth cannot descend further.'
    );
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
