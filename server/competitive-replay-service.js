import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ARENA_MAX_BATCH_EVENTS,
  ARENA_MAX_EVENTS,
  ARENA_TICK_MS,
  ARENA_TRANSCRIPT_VERSION,
  arenaBatchRequiresReplay,
  assertArenaTickOrder,
  buildCompetitiveChallenge,
  canonicalJson,
  competitiveMaximumDepth,
  hashArenaEvent,
  normalizeArenaEvent,
  replayArenaTranscript
} from './arena-engine.js';
import { ApiError, assertApi } from './errors.js';

const CLOCK_TOLERANCE_MS = 15_000;
// Practice is the unlimited MATT Mine gameplay lane. It uses the same
// authoritative replay as ranked modes before NFT state can change.
const REPLAY_MODES = new Set(['practice', 'paid']);

export class CompetitiveReplayService {
  constructor(options = {}) {
    this.store = options.store;
    this.secret = String(options.secret || '');
    this.now = options.now || Date.now;
    this.resolveRun = options.resolveRun || null;
    assertApi(this.store, 500, 'competitive_store_missing', 'A competitive replay store is required.');
    assertApi(this.secret.length >= 32, 500, 'competitive_secret_missing', 'A 32-character competitive replay secret is required.');
  }

  async init() {
    await this.store.init();
    return this;
  }

  publicStatus() {
    return {
      configured: true,
      enabled: true,
      modes: [...REPLAY_MODES],
      verification: 'fixed-step-input-replay',
      store: this.store.kind
    };
  }

  async register(run, runToken) {
    assertApi(REPLAY_MODES.has(run?.mode), 500, 'competitive_mode_invalid', 'That run does not use competitive replay.');
    const transcriptHash = createHash('sha256')
      .update(`MATT-COMPETITIVE-V1|${run.id}|${run.seed}`)
      .digest('hex');
    const record = {
      runId: run.id,
      address: run.address,
      mode: run.mode,
      tokenHash: hashToken(runToken),
      status: 'active',
      startedAt: run.startedAt,
      expiresAt: run.expiresAt,
      throughSeq: 0,
      throughTick: 0,
      transcriptHash,
      checkpointSignature: '',
      runSnapshot: structuredClone(run),
      authoritativeState: {},
      buildCommit: run.buildCommit || process.env.RENDER_GIT_COMMIT || 'unknown',
      engineVersion: run.engineVersion || 'game-v4',
      replaySchemaVersion: 'matt-competitive-input-v1',
      mapSnapshotId: run.competitionSnapshot?.id || run.tuning?._competitionSnapshot?.id || '',
      mapHash: hashObject(run.competitionSnapshot || run.tuning?._competitionSnapshot || {}),
      tuningHash: hashObject(run.tuning || {})
    };
    record.checkpointSignature = this.#sign(record);
    await this.store.createRun(record);
    return this.#checkpoint(record);
  }

  async registerEndlessPhase(run, runToken) {
    assertApi(run?.mode === 'endless' && run.status === 'active', 500, 'endless_replay_run_invalid', 'An active Endless run is required for phase replay.');
    const replayId = endlessPhaseReplayId(run);
    const maximumPhaseMs = Math.max(60_000, Number(run.config?.integrity?.maximumPhaseSeconds || 1_200) * 1_000);
    const configuredMaximumInputs = Math.max(100, Number(run.config?.integrity?.maximumInputEventsPerPhase || 750_000));
    const challenge = {
      version: ARENA_TRANSCRIPT_VERSION,
      dailySeed: run.runSeed,
      tickMs: ARENA_TICK_MS,
      maxTicks: maximumPhaseMs,
      maxEvents: Math.min(1_000_000, configuredMaximumInputs, Math.ceil(maximumPhaseMs / ARENA_TICK_MS) + 1_024),
      maxDepth: run.currentPhase + 1,
      verificationMode: 'deterministic-input-replay',
      tuning: {}
    };
    const transcriptHash = createHash('sha256')
      .update(`MATT-ENDLESS-PHASE-V1|${replayId}|${run.runSeed}|${run.manifest?.fingerprint || ''}|${hashObject(run.phaseInitialState || {})}`)
      .digest('hex');
    const snapshot = {
      id: replayId,
      parentRunId: run.id,
      mode: 'endless',
      seed: run.runSeed,
      currentPhase: run.currentPhase,
      phaseAttempt: Number(run.phaseAttempt || 1),
      configVersion: run.configVersion,
      config: structuredClone(run.config),
      manifest: structuredClone(run.manifest),
      minerId: run.minerId,
      minerProfile: structuredClone(run.minerProfile),
      initialState: run.phaseInitialState ? structuredClone(run.phaseInitialState) : null,
      challenge
    };
    const record = {
      runId: replayId,
      address: run.address,
      mode: 'endless-phase',
      tokenHash: hashToken(runToken),
      status: 'active',
      startedAt: run.phaseStartedAt,
      expiresAt: run.expiresAt,
      throughSeq: 0,
      throughTick: 0,
      transcriptHash,
      checkpointSignature: '',
      runSnapshot: snapshot,
      authoritativeState: {},
      buildCommit: run.buildCommit || process.env.RENDER_GIT_COMMIT || 'unknown',
      engineVersion: run.engineVersion || 'game-v4',
      replaySchemaVersion: 'matt-endless-phase-input-v1',
      mapSnapshotId: run.manifest?.fingerprint || '',
      mapHash: hashObject(run.manifest || {}),
      tuningHash: hashObject(run.config || {})
    };
    record.checkpointSignature = this.#sign(record);
    const stored = await this.store.createRun(record);
    assertApi(
      stored.mapHash === record.mapHash && stored.address === record.address,
      409,
      'endless_replay_snapshot_conflict',
      'The stored Endless phase replay does not match this authorized manifest.'
    );
    return this.#checkpoint(stored);
  }

  async appendEndlessPhase(address, payload = {}) {
    assertApi(this.resolveRun, 503, 'endless_replay_run_resolver_missing', 'The Endless replay run resolver is unavailable.');
    const parent = await this.resolveRun(String(payload.runId || ''));
    assertApi(parent?.mode === 'endless' && parent.address === address, 404, 'endless_run_missing', 'The Endless run was not found.');
    assertApi(parent.status === 'active', 409, 'endless_run_closed', 'This Endless run is no longer active.');
    assertApi(Number(payload.phase) === parent.currentPhase, 409, 'endless_phase_sequence', 'Submit inputs for the current Endless phase.');
    const replayId = endlessPhaseReplayId(parent);
    const run = await this.#authenticatedRun(address, replayId, payload.runToken);
    assertApi(run.status === 'active', 409, 'competitive_transcript_closed', 'The Endless phase input transcript is closed.');
    assertApi(run.expiresAt > this.now(), 410, 'run_expired', 'The run expired before this input batch arrived.');
    const checkpoint = normalizeCheckpoint(payload.previousCheckpoint);
    assertApi(this.#validCheckpoint(run, checkpoint), 401, 'competitive_checkpoint_invalid', 'Use the latest server-signed Endless input checkpoint.');
    assertApi(
      Array.isArray(payload.events) && payload.events.length > 0 && payload.events.length <= ARENA_MAX_BATCH_EVENTS,
      400,
      'competitive_event_batch_invalid',
      `Submit from 1 to ${ARENA_MAX_BATCH_EVENTS} Endless inputs per batch.`
    );
    let transcriptHash = run.transcriptHash;
    const timestamp = this.now();
    const limits = run.runSnapshot?.challenge || {};
    const events = payload.events.map((raw, index) => {
      const event = normalizeArenaEvent(raw, run.throughSeq + index + 1, limits);
      transcriptHash = hashArenaEvent(transcriptHash, event);
      return { ...event, eventHash: transcriptHash, receivedAt: timestamp };
    });
    const maximumEvents = Number(run.runSnapshot?.challenge?.maxEvents || ARENA_MAX_EVENTS);
    assertApi(run.throughSeq + events.length <= maximumEvents, 422, 'competitive_transcript_too_large', 'The Endless phase input transcript exceeded its configured limit.');
    assertArenaTickOrder(events, run.throughTick);
    const throughTick = events.at(-1).tick;
    const clockToleranceMs = Math.max(1_000, Number(run.runSnapshot?.config?.integrity?.inputClockToleranceSeconds || 10) * 1_000);
    assertApi(throughTick <= timestamp - run.startedAt + clockToleranceMs, 422, 'competitive_event_clock_ahead', 'The Endless phase input transcript is ahead of server time.');
    const next = {
      ...run,
      throughSeq: run.throughSeq + events.length,
      throughTick,
      transcriptHash
    };
    next.checkpointSignature = this.#sign(next);
    await this.store.appendEvents(replayId, run.throughSeq, events, next);
    return this.#checkpoint(next);
  }

  async verifyEndlessPhase({ run, checkpoint, action }) {
    const replayId = endlessPhaseReplayId(run);
    const transcript = await this.store.getRun(replayId);
    assertApi(transcript?.address === run.address && transcript.mode === 'endless-phase', 404, 'endless_replay_missing', 'The authoritative Endless phase input transcript was not found.');
    assertApi(this.#validCheckpoint(transcript, normalizeCheckpoint(checkpoint)), 401, 'competitive_checkpoint_invalid', 'Finish with the latest server-signed Endless input checkpoint.');
    const events = (await this.store.getEvents(replayId)).map(publicEvent);
    const expectedCommand = action === 'bank' ? 'extract' : 'descend';
    const last = events.at(-1);
    assertApi(last?.type === 'command' && last.command === expectedCommand, 422, 'endless_replay_action_missing', 'The authoritative input transcript is missing the selected bank or descend action.');
    const snapshot = transcript.runSnapshot;
    assertApi(snapshot?.manifest?.fingerprint === run.manifest?.fingerprint, 409, 'endless_replay_manifest_mismatch', 'The replay manifest does not match the current server phase.');
    const replayed = replayArenaTranscript(snapshot.challenge, events, {
      mode: 'endless',
      // The authenticated extract command is the Endless phase's terminal
      // barrier. It must remain the last event, so requiring a second finish
      // marker here would make a valid bank transcript impossible.
      requireTerminal: false,
      maxDepth: run.currentPhase + 1,
      currentPhase: run.currentPhase,
      endlessRunId: run.id,
      endlessConfigVersion: run.configVersion,
      endlessSnapshot: { config: run.config },
      endlessManifest: run.manifest,
      nftRun: { minerId: run.minerId, profile: run.minerProfile },
      endlessContinuation: snapshot.initialState || null
    });
    if (action === 'bank') {
      assertApi(replayed.state === 'ended' && replayed.extracted, 422, 'endless_replay_not_banked', 'The authoritative replay did not reach a valid banked state.');
    } else {
      assertApi(replayed.state === 'playing' && replayed.depth === run.currentPhase + 1, 422, 'endless_replay_not_descended', 'The authoritative replay did not complete and descend from the current phase.');
    }
    return {
      replayId,
      outcomeEvents: replayed.outcomeEvents,
      evidence: {
        schemaVersion: transcript.replaySchemaVersion,
        eventCount: replayed.eventCount,
        transcriptHash: transcript.transcriptHash,
        runtime: replayed.runtime,
        rawScore: replayed.rawScore,
        state: replayed.state,
        playerState: structuredClone(replayed.phaseState?.player || {}),
        inventoryState: {
          weapon: replayed.phaseState?.player?.weapon || 'pickaxe',
          unlockedWeapons: structuredClone(replayed.phaseState?.player?.unlockedWeapons || {}),
          dynamiteAmmo: Number(replayed.phaseState?.player?.dynamiteAmmo || 0),
          blasterEnergy: Number(replayed.phaseState?.player?.blasterEnergy || 0),
          runUpgradeCounts: structuredClone(replayed.phaseState?.player?.runUpgradeCounts || {})
        },
        continuation: structuredClone(replayed.continuation)
      }
    };
  }

  async finalizeEndlessPhase(run, status = 'verified') {
    return this.store.closeRun(endlessPhaseReplayId(run), status);
  }

  async append(address, payload = {}) {
    let run = await this.#authenticatedRun(address, payload.runId, payload.runToken);
    run = await this.#ensureRunSnapshot(run);
    assertApi(run.status === 'active', 409, 'competitive_transcript_closed', 'The competitive transcript is closed.');
    assertApi(run.expiresAt > this.now(), 410, 'run_expired', 'The run expired before this input batch arrived.');
    const checkpoint = normalizeCheckpoint(payload.previousCheckpoint);
    assertApi(this.#validCheckpoint(run, checkpoint), 401, 'competitive_checkpoint_invalid', 'Use the latest server-signed competitive checkpoint.');
    assertApi(
      Array.isArray(payload.events) && payload.events.length > 0 && payload.events.length <= ARENA_MAX_BATCH_EVENTS,
      400,
      'competitive_event_batch_invalid',
      `Submit from 1 to ${ARENA_MAX_BATCH_EVENTS} competitive inputs per batch.`
    );
    let transcriptHash = run.transcriptHash;
    const timestamp = this.now();
    const events = payload.events.map((raw, index) => {
      const event = normalizeArenaEvent(raw, run.throughSeq + index + 1);
      transcriptHash = hashArenaEvent(transcriptHash, event);
      return { ...event, eventHash: transcriptHash, receivedAt: timestamp };
    });
    assertApi(
      run.throughSeq + events.length <= ARENA_MAX_EVENTS,
      422,
      'competitive_transcript_too_large',
      'The competitive transcript exceeded the event limit.'
    );
    const throughTick = events.at(-1).tick;
    assertArenaTickOrder(events, run.throughTick);
    assertApi(
      throughTick <= timestamp - run.startedAt + CLOCK_TOLERANCE_MS,
      422,
      'competitive_event_clock_ahead',
      'The competitive transcript is ahead of server time.'
    );
    const snapshot = run.runSnapshot;
    assertApi(snapshot?.id === run.runId, 500, 'competitive_run_snapshot_missing', 'The immutable competitive run snapshot is unavailable.');
    let authoritativeState = run.authoritativeState || {};
    // Raw controls are normalized, ordered, clock bounded, and hash chained.
    // Defer the expensive full-history gameplay replay until a command or
    // finish barrier; replaying every control-only batch is quadratic in round
    // length and can drive a small production instance out of memory.
    if (arenaBatchRequiresReplay(events)) {
      const allEvents = [...await this.store.getEvents(run.runId), ...events].map(publicEvent);
      const includesRevive = allEvents.some((event) =>
        event.type === 'command' && event.command === 'revive'
      );
      const currentStateRun = this.resolveRun && includesRevive
        ? await this.resolveRun(run.runId)
        : snapshot;
      authoritativeState = replayArenaTranscript(
        buildCompetitiveChallenge(snapshot),
        allEvents,
        replayOptions(snapshot, false, currentStateRun)
      );
    }
    const next = {
      ...run,
      throughSeq: run.throughSeq + events.length,
      throughTick,
      transcriptHash,
      authoritativeState
    };
    next.checkpointSignature = this.#sign(next);
    await this.store.appendEvents(run.runId, run.throughSeq, events, next);
    return this.#checkpoint(next);
  }

  async validate({ run, submission = {} }) {
    let transcript = await this.store.getRun(run.id);
    assertApi(transcript, 404, 'competitive_transcript_missing', 'The competitive transcript was not found.');
    assertApi(transcript.address === run.address && transcript.mode === run.mode, 403, 'competitive_transcript_mismatch', 'The competitive transcript does not match this run.');
    if (!transcript.runSnapshot?.id) transcript = await this.#hydrateRunSnapshot(transcript, run);
    const checkpoint = normalizeCheckpoint(submission.checkpoint || submission);
    assertApi(this.#validCheckpoint(transcript, checkpoint), 401, 'competitive_checkpoint_invalid', 'Finish with the latest server-signed competitive checkpoint.');
    const replayed = transcript.authoritativeState || {};
    assertApi(replayed.terminal === true, 422, 'arena_run_not_terminal', 'A verified finish marker is required.');
    return {
      result: {
        extracted: replayed.extracted,
        projected: replayed.projected,
        banked: replayed.banked,
        depth: replayed.depth,
        kills: replayed.kills,
        oreBroken: replayed.oreBroken,
        elapsed: replayed.elapsed,
        bossTelemetry: replayed.bossTelemetry,
        crystalsCarried: replayed.crystalsCarried,
        completedPhases: replayed.completedPhases
      },
      replay: {
        version: 'matt-competitive-input-v1',
        eventCount: replayed.eventCount,
        transcriptHash: transcript.transcriptHash,
        runtime: replayed.runtime || null
      }
    };
  }

  async finalize(runId, status = 'finished') {
    return this.store.closeRun(runId, status);
  }

  async validateDeath({ address, runId, run: stateRun, submission = {} }) {
    let transcript = await this.store.getRun(runId);
    assertApi(transcript && transcript.address === address, 404, 'competitive_transcript_missing', 'The active run transcript was not found.');
    const checkpoint = normalizeCheckpoint(submission.checkpoint || submission);
    assertApi(this.#validCheckpoint(transcript, checkpoint), 401, 'competitive_checkpoint_invalid', 'Use the latest server-signed checkpoint for revive eligibility.');
    assertApi(stateRun, 422, 'revive_run_snapshot_missing', 'The server run snapshot is required for death replay.');
    if (!transcript.runSnapshot?.id) transcript = await this.#hydrateRunSnapshot(transcript, stateRun);
    const replayed = transcript.authoritativeState || {};
    assertApi(replayed.awaitingRevive, 409, 'revive_death_not_verified', 'The replay did not reach a paid-revive knockout.');
    return {
      checkpoint: this.#checkpoint(transcript),
      playerState: {
        health: 0,
        maximumHealth: replayed.maximumHealth,
        depth: replayed.depth,
        elapsed: replayed.elapsed
      }
    };
  }

  async #authenticatedRun(address, runId, runToken) {
    const run = await this.store.getRun(String(runId || ''));
    assertApi(run && run.address === address, 404, 'competitive_transcript_missing', 'The competitive transcript was not found.');
    assertApi(safeEqual(run.tokenHash, hashToken(runToken)), 401, 'run_token_rejected', 'The run token is invalid.');
    return run;
  }

  async #ensureRunSnapshot(run) {
    if (run.runSnapshot?.id) return run;
    assertApi(this.resolveRun, 503, 'competitive_run_snapshot_resolver_missing', 'The active-run compatibility resolver is unavailable.');
    const snapshot = await this.resolveRun(run.runId);
    assertApi(snapshot?.id === run.runId, 503, 'competitive_run_snapshot_missing', 'The immutable active-run snapshot is unavailable.');
    return this.#hydrateRunSnapshot(run, snapshot);
  }

  async #hydrateRunSnapshot(run, snapshot) {
    const competition = snapshot.competitionSnapshot || snapshot.tuning?._competitionSnapshot || {};
    return this.store.hydrateRunSnapshot(run.runId, structuredClone(snapshot), {
      buildCommit: snapshot.buildCommit || 'legacy-active-run',
      engineVersion: snapshot.engineVersion || 'game-v4',
      replaySchemaVersion: 'matt-competitive-input-v1',
      mapSnapshotId: competition.id || '',
      mapHash: hashObject(competition),
      tuningHash: hashObject(snapshot.tuning || {})
    });
  }

  #checkpoint(run) {
    return {
      throughSeq: run.throughSeq,
      throughTick: run.throughTick,
      transcriptHash: run.transcriptHash,
      signature: run.checkpointSignature
    };
  }

  #sign(run) {
    return createHmac('sha256', this.secret)
      .update(`${run.runId}|${run.address}|${run.throughSeq}|${run.throughTick}|${run.transcriptHash}`)
      .digest('hex');
  }

  #validCheckpoint(run, checkpoint) {
    return checkpoint.throughSeq === run.throughSeq &&
      checkpoint.throughTick === run.throughTick &&
      checkpoint.transcriptHash === run.transcriptHash &&
      safeEqual(checkpoint.signature, this.#sign(run));
  }
}

function endlessPhaseReplayId(run) {
  const runId = String(run?.id || run?.runId || '');
  const phase = Number(run?.currentPhase || 0);
  const attempt = Number(run?.phaseAttempt || 1);
  assertApi(/^run_[a-f0-9]{24}$/.test(runId) && Number.isSafeInteger(phase) && phase > 0 && Number.isSafeInteger(attempt) && attempt > 0, 500, 'endless_replay_identity_invalid', 'The Endless phase replay identity is invalid.');
  return `${runId}:phase:${phase}:attempt:${attempt}`;
}

function normalizeCheckpoint(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    throughSeq: Number(source.throughSeq || 0),
    throughTick: Number(source.throughTick || 0),
    transcriptHash: String(source.transcriptHash || ''),
    signature: String(source.signature || '')
  };
}

function publicEvent(event) {
  const copy = structuredClone(event);
  delete copy.eventHash;
  delete copy.receivedAt;
  return copy;
}

function hashToken(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameCompetitiveEvent(left, right) {
  return canonicalJson(publicEvent(left)) === canonicalJson(publicEvent(right));
}

function replayOptions(run, requireTerminal, currentStateRun = run) {
  return {
    requireTerminal,
    mode: run.mode,
    day: run.day,
    week: run.week,
    maxDepth: competitiveMaximumDepth(run),
    characterId: run.characterId,
    character: run.character,
    profile: run.playerProfile,
    nftRun: run.nftRun || null,
    weeklyStage: run.weeklyStage,
    endlessSnapshot: run.endlessSnapshot,
    allowPaidRevive: run.paidReviveEligible === true,
    reviveLimitPerRun: run.reviveLimitPerRun || 0,
    confirmedPaidRevives: Array.isArray(currentStateRun?.revives)
      ? currentStateRun.revives.length
      : 0,
    reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds
  };
}

function hashObject(value) {
  return createHash('sha256').update(canonicalJson(value || {})).digest('hex');
}
