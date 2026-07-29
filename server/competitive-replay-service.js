import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ARENA_MAX_BATCH_EVENTS,
  ARENA_MAX_EVENTS,
  buildCompetitiveChallenge,
  canonicalJson,
  competitiveMaximumDepth,
  hashArenaEvent,
  normalizeArenaEvent,
  replayArenaTranscript
} from './arena-engine.js';
import { ApiError, assertApi } from './errors.js';

const CLOCK_TOLERANCE_MS = 15_000;
const REPLAY_MODES = new Set(['free', 'paid', 'weekly', 'endless']);

export class CompetitiveReplayService {
  constructor(options = {}) {
    this.store = options.store;
    this.secret = String(options.secret || '');
    this.now = options.now || Date.now;
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
      checkpointSignature: ''
    };
    record.checkpointSignature = this.#sign(record);
    await this.store.createRun(record);
    return this.#checkpoint(record);
  }

  async append(address, payload = {}) {
    const run = await this.#authenticatedRun(address, payload.runId, payload.runToken);
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
    assertApi(
      throughTick <= timestamp - run.startedAt + CLOCK_TOLERANCE_MS,
      422,
      'competitive_event_clock_ahead',
      'The competitive transcript is ahead of server time.'
    );
    const next = {
      ...run,
      throughSeq: run.throughSeq + events.length,
      throughTick,
      transcriptHash
    };
    next.checkpointSignature = this.#sign(next);
    await this.store.appendEvents(run.runId, run.throughSeq, events, next);
    return this.#checkpoint(next);
  }

  async validate({ run, submission = {} }) {
    const transcript = await this.store.getRun(run.id);
    assertApi(transcript, 404, 'competitive_transcript_missing', 'The competitive transcript was not found.');
    assertApi(transcript.address === run.address && transcript.mode === run.mode, 403, 'competitive_transcript_mismatch', 'The competitive transcript does not match this run.');
    const checkpoint = normalizeCheckpoint(submission.checkpoint || submission);
    assertApi(this.#validCheckpoint(transcript, checkpoint), 401, 'competitive_checkpoint_invalid', 'Finish with the latest server-signed competitive checkpoint.');
    const events = await this.store.getEvents(run.id);
    const replayed = replayArenaTranscript(
      buildCompetitiveChallenge(run),
      events.map(publicEvent),
      {
        requireTerminal: true,
        mode: run.mode,
        day: run.day,
        week: run.week,
        maxDepth: competitiveMaximumDepth(run),
        characterId: run.characterId,
        character: run.character,
        profile: run.playerProfile,
        weeklyStage: run.weeklyStage,
        endlessSnapshot: run.endlessSnapshot,
        allowPaidRevive: run.paidReviveEligible === true,
        reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds
      }
    );
    return {
      result: {
        extracted: replayed.extracted,
        projected: replayed.projected,
        banked: replayed.banked,
        depth: replayed.depth,
        kills: replayed.kills,
        oreBroken: replayed.oreBroken,
        elapsed: replayed.elapsed,
        bossTelemetry: replayed.bossTelemetry
      },
      replay: {
        version: 'matt-competitive-input-v1',
        eventCount: replayed.eventCount,
        transcriptHash: transcript.transcriptHash
      }
    };
  }

  async finalize(runId, status = 'finished') {
    return this.store.closeRun(runId, status);
  }

  async validateDeath({ address, runId, run: stateRun, submission = {} }) {
    const transcript = await this.store.getRun(runId);
    assertApi(transcript && transcript.address === address, 404, 'competitive_transcript_missing', 'The active run transcript was not found.');
    const checkpoint = normalizeCheckpoint(submission.checkpoint || submission);
    assertApi(this.#validCheckpoint(transcript, checkpoint), 401, 'competitive_checkpoint_invalid', 'Use the latest server-signed checkpoint for revive eligibility.');
    const events = await this.store.getEvents(runId);
    assertApi(stateRun, 422, 'revive_run_snapshot_missing', 'The server run snapshot is required for death replay.');
    const replayed = replayArenaTranscript(
      buildCompetitiveChallenge(stateRun),
      events.map(publicEvent),
      {
        requireTerminal: false,
        mode: stateRun.mode,
        day: stateRun.day,
        week: stateRun.week,
        maxDepth: competitiveMaximumDepth(stateRun),
        characterId: stateRun.characterId,
        character: stateRun.character,
        profile: stateRun.playerProfile,
        weeklyStage: stateRun.weeklyStage,
        endlessSnapshot: stateRun.endlessSnapshot,
        allowPaidRevive: stateRun.paidReviveEligible === true,
        reviveInvulnerabilitySeconds: stateRun.reviveInvulnerabilitySeconds
      }
    );
    assertApi(replayed.awaitingRevive, 409, 'revive_death_not_verified', 'The replay did not reach a paid-revive knockout.');
    return {
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
