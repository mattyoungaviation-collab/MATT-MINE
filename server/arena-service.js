import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { encodeFunctionData, formatUnits, getAddress, parseUnits } from 'viem';
import { ApiError, assertApi } from './errors.js';
import { isTransientPostgresError } from './postgres-resilience.js';
import {
  ARENA_MAX_BATCH_EVENTS,
  ARENA_TICK_MS,
  ARENA_TRANSCRIPT_VERSION,
  buildArenaChallenge,
  canonicalJson,
  hashArenaEvent,
  normalizeArenaEvent,
  replayArenaTranscript
} from './arena-engine.js';
import { ARENA_SEED_CAP_RAW } from './arena-store.js';
import {
  ARENA_ERC20_ABI,
  DAILY_ARENA_ABI
} from './arena-chain.js';
import {
  createArenaSettlementDraft,
  utcDayId
} from './arena-settlement.js';
import { createSafeTransactionBuilderFile } from './safe-transaction-builder.js';

const DAY_MS = 86_400_000;
const RUN_TTL_MS = 20 * 60_000;
const ENTRY_CONFIRMATION_BUFFER_MS = 5 * 60_000;
const ENTRY_CUTOFF_WINDOW_MS = RUN_TTL_MS + ENTRY_CONFIRMATION_BUFFER_MS;
const EVENT_CLOCK_TOLERANCE_MS = 750;
const MIN_ENTRY_FEE_RAW = 25_000n * 10n ** 18n;
const MAX_ENTRY_FEE_RAW = 1_000_000n * 10n ** 18n;

// v2.0 records only normalized fixed-step controls. The server runs those
// controls through the same deterministic game engine and derives the terminal
// score without accepting browser milestones or browser summaries.
export const ARENA_REPLAY_READY = true;

export class DailyArenaService {
  constructor(options = {}) {
    assertApi(options.store, 500, 'arena_store_missing', 'Daily Arena storage is not configured.');
    assertApi(options.chain, 500, 'arena_chain_missing', 'The Daily Arena chain adapter is not configured.');
    assertApi(
      typeof options.receiptSecret === 'string' && options.receiptSecret.length >= 32,
      500,
      'arena_receipt_secret_invalid',
      'MATT_MINE_ARENA_RECEIPT_SECRET must contain at least 32 characters.'
    );
    this.store = options.store;
    this.chain = options.chain;
    this.receiptSecret = options.receiptSecret;
    this.seedSecret = options.seedSecret || options.receiptSecret;
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || ((bytes) => randomBytes(bytes).toString('hex'));
    this.safeAddress = getAddress(options.safeAddress);
    this.liveRequested = options.liveEnabled === true;
    this.liveEnabled = this.liveRequested && ARENA_REPLAY_READY;
    this.getTuning = options.getTuning || (async () => ({}));
    this.deployment = null;
  }

  async init() {
    await this.store.init();
    this.deployment = typeof this.chain.validateDeployment === 'function'
      ? await this.chain.validateDeployment()
      : null;
    return this;
  }

  publicConfig() {
    return {
      enabled: this.liveEnabled,
      configured: true,
      previewAvailable: true,
      replayReady: ARENA_REPLAY_READY,
      verificationMode: 'deterministic-input-replay',
      liveBlocker: this.liveEnabled
        ? ''
        : this.liveRequested
          ? 'input_replay_not_ready'
          : 'arena_live_not_requested',
      deploymentPinned: this.deployment?.pinned === true,
      chain: this.chain.publicConfig(),
      transcriptVersion: ARENA_TRANSCRIPT_VERSION,
      tickMs: ARENA_TICK_MS,
      runTtlSeconds: RUN_TTL_MS / 1_000,
      entryConfirmationBufferSeconds: ENTRY_CONFIRMATION_BUFFER_MS / 1_000,
      entryCutoffSeconds: ENTRY_CUTOFF_WINDOW_MS / 1_000,
      seedCapRaw: ARENA_SEED_CAP_RAW,
      seedCapMatt: formatUnits(BigInt(ARENA_SEED_CAP_RAW), 18),
      unlimitedPaidEntries: true,
      scoring: {
        dailyBestPerWallet: true,
        tieOrder: [
          'score:desc',
          'depth:desc',
          'guardianTimeMs:asc',
          'damageTaken:asc',
          'elapsedMs:asc',
          'entryTransactionHash:asc'
        ],
        winnerWeightsPercent: [30, 18, 12, 8, 7, 6, 5.5, 5, 4.5, 4]
      }
    };
  }

  async health() {
    return {
      enabled: this.liveEnabled,
      liveRequested: this.liveRequested,
      replayReady: ARENA_REPLAY_READY,
      storage: await this.store.healthCheck(),
      contract: this.chain.contractAddress,
      deployment: this.deployment || { pinned: false }
    };
  }

  async config(requestedDay = '') {
    const timestamp = this.now();
    const day = normalizeDay(requestedDay, timestamp);
    let contest;
    try {
      contest = await this.#ensureDay(day, timestamp);
    } catch (error) {
      if (error?.code === 'arena_day_not_scheduled') {
        const chainDay = await this.chain.dayStatus(day).catch(() => ({
          entriesPaused: false,
          settlementPaused: false
        }));
        return publicUnscheduledDay(
          day,
          timestamp,
          this.publicConfig(),
          this.#dailySeed(day),
          chainDay
        );
      }
      throw error;
    }
    return publicDay(contest, timestamp, this.publicConfig());
  }

  async quoteEntry(address, input = {}) {
    this.assertLive();
    const timestamp = this.now();
    const day = normalizeDay(input.day || '', timestamp);
    assertApi(day === utcDayKey(timestamp), 409, 'arena_entry_day_invalid', 'Daily Arena entries can only be purchased for the current UTC day.');
    const contest = await this.#ensureDay(day, timestamp);
    assertOpen(contest, timestamp);
    assertApi(!contest.entriesPaused, 503, 'arena_entries_paused', 'Daily Arena entry purchase is paused onchain.');
    assertApi(
      dayEndMs(day) - timestamp >= ENTRY_CUTOFF_WINDOW_MS,
      409,
      'arena_entry_cutoff',
      'Daily Arena entry closes early enough to confirm and complete a full attempt before 00:00 UTC.'
    );
    const quote = await this.chain.quoteEntry(address, day, contest.feeRaw);
    return {
      quote: {
        ...quote,
        expiresAt: Math.min(timestamp + 5 * 60_000, dayEndMs(day)),
        snapshotAt: contest.snapshotAt
      }
    };
  }

  async confirmEntry(address, enterTransactionHash) {
    this.assertLive();
    const timestamp = this.now();
    const verified = await this.chain.verifyEntryPurchase(
      enterTransactionHash,
      address
    );
    const day = verified.day;
    const contest = await this.#ensureDay(day, timestamp);
    assertApi(
      verified.amountRaw === contest.feeRaw,
      422,
      'arena_fee_mismatch',
      'The confirmed Arena entry did not pay the immutable fee for its event day.'
    );
    assertApi(
      Number.isSafeInteger(verified.blockTimestampMs) && verified.blockTimestampMs > 0,
      503,
      'arena_block_time_unavailable',
      'The confirmed Arena entry block time could not be verified.'
    );
    assertApi(
      verified.blockTimestampMs <= dayEndMs(day) - ENTRY_CUTOFF_WINDOW_MS,
      422,
      'arena_entry_after_cutoff',
      'This Arena entry was mined after the server-authoritative daily cutoff.'
    );
    const entryId = `arena_entry_${createHash('sha256').update(verified.paymentKey).digest('hex').slice(0, 24)}`;
    const stored = await this.store.confirmEntry({
      entryId,
      ...verified,
      confirmedAt: timestamp
    });
    await this.#reconcileDay(day);
    const attempts = await this.store.unusedEntries(address, day);
    return {
      entry: stored.entry,
      alreadyConfirmed: stored.alreadyConfirmed,
      unusedAttempts: attempts.length
    };
  }

  async startRun(address, input = {}) {
    this.assertLive();
    const timestamp = this.now();
    const day = utcDayKey(timestamp);
    const contest = await this.#ensureDay(day, timestamp);
    assertOpen(contest, timestamp);
    assertApi(
      dayEndMs(day) - timestamp >= RUN_TTL_MS,
      409,
      'arena_window_closing',
      'There is not enough time to complete the maximum Daily Arena run before the UTC snapshot.'
    );
    const activeRun = await this.store.activeRun(address);
    if (
      activeRun &&
      (activeRun.expiresAt <= timestamp || dayEndMs(activeRun.day) <= timestamp)
    ) {
      await this.store.expireRun(activeRun.runId, timestamp);
    }
    const runId = `arena_run_${this.randomHex(12)}`;
    const runToken = this.randomHex(32);
    const entryId = typeof input.entryId === 'string' ? input.entryId : '';
    const startedAt = timestamp;
    const expiresAt = Math.min(timestamp + RUN_TTL_MS, dayEndMs(day));
    const entryCandidates = await this.store.unusedEntries(address, day);
    const selected = entryId
      ? entryCandidates.find((entry) => entry.entryId === entryId)
      : entryCandidates[0];
    assertApi(selected, 409, 'arena_attempt_required', 'Confirm an unused Daily Arena entry before starting.');
    const receipt = {
      version: ARENA_TRANSCRIPT_VERSION,
      runId,
      entryId: selected.entryId,
      address,
      day,
      dailySeed: contest.deterministicSeed,
      entryTransactionHash: selected.transactionHash,
      issuedAt: startedAt,
      expiresAt,
      nonce: this.randomHex(16),
      tuning: await this.getTuning(day)
    };
    const receiptSignature = this.#sign('run-receipt', receipt);
    const transcriptHash = createHash('sha256')
      .update(`matt-arena-transcript-start|${receiptSignature}`)
      .digest('hex');
    const checkpoint = this.#checkpoint({
      runId,
      address,
      throughSeq: 0,
      throughTick: 0,
      transcriptHash
    });
    const consumed = await this.store.consumeEntry(address, day, selected.entryId, {
      runId,
      address,
      day,
      tokenHash: hashToken(runToken),
      receiptSignature,
      status: 'active',
      startedAt,
      expiresAt,
      throughSeq: 0,
      throughTick: 0,
      transcriptHash,
      checkpointSignature: checkpoint.signature,
      tuning: receipt.tuning
    });
    return {
      run: {
        runId,
        runToken,
        day,
        dailySeed: contest.deterministicSeed,
        entryId: consumed.entry.entryId,
        entryTransactionHash: consumed.entry.transactionHash,
        issuedAt: startedAt,
        expiresAt,
        receipt: { ...receipt, signature: receiptSignature },
        checkpoint,
        challenge: buildArenaChallenge(contest.deterministicSeed, receipt.tuning)
      }
    };
  }

  async appendEvents(address, payload) {
    this.assertLive();
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'arena_events_invalid', 'A Daily Arena event batch is required.');
    const run = await this.#authenticatedRun(address, payload.runId, payload.runToken);
    const timestamp = this.now();
    await this.#assertRunOpen(run, timestamp);
    const suppliedCheckpoint = normalizeCheckpoint(payload.previousCheckpoint);
    const rawEvents = payload.events;
    assertApi(
      Array.isArray(rawEvents) && rawEvents.length > 0 && rawEvents.length <= ARENA_MAX_BATCH_EVENTS,
      400,
      'arena_event_batch_invalid',
      `Submit from 1 to ${ARENA_MAX_BATCH_EVENTS} Daily Arena events per batch.`
    );

    assertApi(
      this.#validCheckpointSignature(run, suppliedCheckpoint),
      401,
      'arena_checkpoint_signature_invalid',
      'The Daily Arena checkpoint signature is invalid.'
    );
    if (!checkpointMatches(run, suppliedCheckpoint)) {
      const existingEvents = await this.store.getEvents(run.runId);
      const retryStart = suppliedCheckpoint.throughSeq;
      const existingSlice = existingEvents.slice(retryStart, retryStart + rawEvents.length);
      const retryEvents = rawEvents.map((event, index) => normalizeArenaEvent(event, retryStart + index + 1));
      if (
        existingSlice.length === retryEvents.length &&
        existingSlice.every((event, index) =>
          canonicalJson(publicTranscriptEvent(event)) === canonicalJson(retryEvents[index])
        )
      ) {
        return { checkpoint: this.#publicCheckpoint(run), acceptedEvents: 0, idempotentReplay: true };
      }
      throw new ApiError(409, 'arena_checkpoint_stale', 'The Daily Arena checkpoint is stale.');
    }
    let transcriptHash = run.transcriptHash;
    const receivedEvents = rawEvents.map((raw, index) => {
      const event = normalizeArenaEvent(raw, run.throughSeq + index + 1);
      transcriptHash = hashArenaEvent(transcriptHash, event);
      return {
        ...event,
        eventHash: transcriptHash,
        receivedAt: timestamp
      };
    });
    const throughTick = receivedEvents.at(-1).tick;
    const elapsedWallMs = timestamp - run.startedAt;
    assertApi(
      throughTick <= elapsedWallMs + EVENT_CLOCK_TOLERANCE_MS,
      422,
      'arena_event_clock_ahead',
      'The Daily Arena transcript is ahead of server time.'
    );
    const existingEvents = await this.store.getEvents(run.runId);
    replayArenaTranscript(
      buildArenaChallenge((await this.store.getDay(run.day)).deterministicSeed, run.tuning),
      [...existingEvents, ...receivedEvents].map(publicTranscriptEvent)
    );
    const nextCheckpoint = this.#checkpoint({
      runId: run.runId,
      address,
      throughSeq: run.throughSeq + receivedEvents.length,
      throughTick,
      transcriptHash
    });
    await this.store.appendEvents(run.runId, run.throughSeq, receivedEvents, {
      throughSeq: nextCheckpoint.throughSeq,
      throughTick: nextCheckpoint.throughTick,
      transcriptHash: nextCheckpoint.transcriptHash,
      checkpointSignature: nextCheckpoint.signature
    });
    return {
      checkpoint: nextCheckpoint,
      acceptedEvents: receivedEvents.length,
      idempotentReplay: false
    };
  }

  async finishRun(address, payload) {
    this.assertLive();
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'arena_finish_invalid', 'A Daily Arena finish request is required.');
    assertApi(
      !Object.hasOwn(payload, 'result') && !Object.hasOwn(payload, 'summary'),
      400,
      'arena_browser_summary_rejected',
      'Daily Arena scores are produced only by server replay; browser summaries are not accepted.'
    );
    let run = await this.#authenticatedRun(address, payload.runId, payload.runToken);
    if (run.status === 'finished') {
      const leaderboard = await this.#leaderboardAfterFinalization(run);
      return { accepted: true, alreadyFinished: true, result: run.result, leaderboard };
    }
    const timestamp = this.now();
    await this.#assertRunOpen(run, timestamp);
    const checkpoint = normalizeCheckpoint(payload.checkpoint);
    assertApi(
      checkpointMatches(run, checkpoint) && this.#validCheckpointSignature(run, checkpoint),
      401,
      'arena_checkpoint_signature_invalid',
      'Finish with the latest server-signed Daily Arena checkpoint.'
    );
    const storedEvents = await this.store.getEvents(run.runId);
    const challenge = buildArenaChallenge((await this.store.getDay(run.day)).deterministicSeed, run.tuning);
    const replayed = replayArenaTranscript(
      challenge,
      storedEvents.map(publicTranscriptEvent),
      { requireTerminal: true }
    );
    const result = {
      ...replayed,
      replayVersion: ARENA_TRANSCRIPT_VERSION,
      transcriptHash: run.transcriptHash
    };
    const finished = await this.store.finishRun(run.runId, result, timestamp);
    run = finished.run;
    const leaderboard = await this.#leaderboardAfterFinalization(run, timestamp);
    return {
      accepted: true,
      alreadyFinished: finished.alreadyFinished,
      result: run.result,
      leaderboard
    };
  }

  async #leaderboardAfterFinalization(run, timestamp = this.now()) {
    try {
      return await this.store.leaderboard(run.day, [], timestamp);
    } catch (error) {
      if (!isTransientPostgresError(error)) throw error;
      return {
        day: run.day,
        status: 'reconnecting',
        closed: false,
        provisional: true,
        finalized: false,
        participantCount: 0,
        entryCount: 0,
        entryPoolRaw: '0',
        seedRaw: '0',
        prizePoolRaw: '0',
        rows: [],
        playerScore: Number(run.result?.score || 0),
        playerRank: 0,
        temporarilyUnavailable: true,
        message: 'Your Arena score is saved. The leaderboard is reconnecting to PostgreSQL.'
      };
    }
  }

  async abandonRun(address, payload) {
    this.assertLive();
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'arena_abandon_invalid', 'A Daily Arena abandonment request is required.');
    const run = await this.#authenticatedRun(address, payload.runId, payload.runToken);
    assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
    const abandoned = await this.store.expireRun(run.runId, this.now());
    return {
      abandoned: true,
      runId: abandoned.runId,
      status: abandoned.status
    };
  }

  async abandonActiveRun(address) {
    const run = await this.store.activeRun(address);
    assertApi(
      run,
      404,
      'arena_active_run_missing',
      'This wallet does not have an active Daily Arena run.'
    );
    const abandoned = await this.store.expireRun(run.runId, this.now());
    return {
      abandoned: true,
      runId: abandoned.runId,
      status: abandoned.status,
      entryConsumed: true
    };
  }

  async adminActiveRuns(address = '') {
    return this.store.activeRuns(address);
  }

  async adminExpireActiveRuns(address = '') {
    const runs = await this.store.expireActiveRuns(address, this.now());
    return {
      affected: runs.length,
      runIds: runs.map((run) => run.runId)
    };
  }

  async leaderboard(dayInput, suspendedAddresses = []) {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    await this.#ensureDay(day, timestamp);
    if (dayEndMs(day) <= timestamp) await this.#reconcileDay(day);
    return this.store.leaderboard(day, suspendedAddresses, timestamp);
  }

  async playerStatus(address, dayInput = '') {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    await this.#ensureDay(day, timestamp);
    const [status, leaderboard, refundRaw] = await Promise.all([
      this.store.playerStatus(address, day),
      this.store.leaderboard(day, [], timestamp),
      this.chain.refundable(address, day).catch(() => '0')
    ]);
    const row = leaderboard.rows.find((entry) => entry.address === address);
    return {
      day,
      entries: status.confirmedEntries,
      unusedAttempts: status.unusedAttempts,
      runCount: status.runCount,
      activeRunId: status.activeRun?.runId || '',
      bestScore: status.best?.score || 0,
      rank: row?.rank || 0,
      refundRaw,
      refundable: BigInt(refundRaw) > 0n
    };
  }

  async prepareRefund(address, dayInput = '') {
    const day = normalizeDay(dayInput || '', this.now());
    await this.#ensureDay(day, this.now());
    return this.chain.quoteRefund(address, day);
  }

  async prepareDay(input = {}) {
    const timestamp = this.now();
    const day = normalizeDay(input.day || '', timestamp);
    assertApi(
      ARENA_REPLAY_READY,
      409,
      'arena_schedule_security_gate',
      'Daily Arena scheduling is blocked until input-only deterministic replay is release-ready.'
    );
    assertApi(dayStartMs(day) > timestamp, 409, 'arena_snapshot_immutable', 'Daily Arena configuration is immutable from 00:00 UTC.');
    const feeRaw = boundedRaw(
      input.feeRaw ?? parseMatt(input.feeMatt, 'arena_fee_invalid'),
      MIN_ENTRY_FEE_RAW,
      MAX_ENTRY_FEE_RAW,
      'arena_fee_invalid'
    );
    const seedRaw = boundedRaw(
      input.seedRaw ?? parseMatt(input.seedMatt ?? '0', 'arena_seed_amount_invalid'),
      0n,
      BigInt(ARENA_SEED_CAP_RAW),
      'arena_seed_amount_invalid'
    );
    const reason = normalizeReason(input.reason);
    const draftKey = `configure:${day}`;
    const existingDraft = await this.store.getAdminDraft(draftKey);
    if (existingDraft) {
      return { ...existingDraft, alreadyPrepared: true };
    }
    const chainDay = await this.chain.dayStatus(day);
    assertApi(
      chainDay.status === 0,
      409,
      'arena_day_already_scheduled',
      'This Daily Arena day is already scheduled onchain; a duplicate Safe package would revert.'
    );
    const dayId = BigInt(utcDayId(day));
    const transactions = [{
      to: this.chain.contractAddress,
      value: '0',
      data: encodeFunctionData({
        abi: DAILY_ARENA_ABI,
        functionName: 'scheduleDay',
        args: [dayId, feeRaw]
      })
    }];
    if (seedRaw > 0n) {
      transactions.push({
        to: this.chain.mattTokenAddress,
        value: '0',
        data: encodeFunctionData({
          abi: ARENA_ERC20_ABI,
          functionName: 'approve',
          args: [this.chain.contractAddress, seedRaw]
        })
      });
      transactions.push({
        to: this.chain.contractAddress,
        value: '0',
        data: encodeFunctionData({
          abi: DAILY_ARENA_ABI,
          functionName: 'seedDay',
          args: [dayId, seedRaw]
        })
      });
    }
    const contest = await this.store.scheduleDay({
      day,
      snapshotAt: dayEndMs(day),
      feeRaw: feeRaw.toString(),
      seedRaw: seedRaw.toString(),
      deterministicSeed: this.#dailySeed(day),
      transcriptVersion: ARENA_TRANSCRIPT_VERSION,
      status: 'scheduled',
      chainStatus: 0,
      configurationState: 'prepared',
      createdAt: timestamp
    });
    const prepared = {
      day: publicDay(contest, timestamp, this.publicConfig()),
      safe: createSafeTransactionBuilderFile(transactions, {
        chainId: 2020,
        createdAt: timestamp,
        safeAddress: this.safeAddress,
        name: `MATT Mine Daily Arena configuration: ${day}`,
        description: `Schedule the immutable UTC fee, then approve and seed the Arena pool in order. Reason: ${reason}`
      }),
      transactions,
      reason,
      createdAt: timestamp,
      warning: 'Prepared only. Execute after the v2.0 replay deployment is healthy and before the selected UTC day begins.'
    };
    const stored = await this.store.saveAdminDraft(draftKey, prepared);
    return { ...stored.draft, alreadyPrepared: stored.alreadyCreated };
  }

  async prepareSeedTopUp(dayInput, input = {}) {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    const reason = normalizeReason(input.reason);
    const amountRaw = boundedRaw(
      input.seedRaw ?? parseMatt(input.seedMatt, 'arena_seed_amount_invalid'),
      1n,
      BigInt(ARENA_SEED_CAP_RAW),
      'arena_seed_amount_invalid'
    );
    assertApi(
      ARENA_REPLAY_READY,
      409,
      'arena_seed_security_gate',
      'Treasury seed top-ups are blocked until input-only deterministic replay is release-ready.'
    );
    const chainDay = await this.chain.dayStatus(day);
    assertApi(chainDay.status === 1, 409, 'arena_day_not_seedable', 'Only an onchain scheduled, unsettled Arena day can receive seed MATT.');
    const cumulative = BigInt(chainDay.seededRaw) + amountRaw;
    assertApi(
      cumulative <= BigInt(ARENA_SEED_CAP_RAW),
      409,
      'arena_seed_cap_exceeded',
      'The cumulative onchain Daily Arena seed cannot exceed 10,000,000 MATT.'
    );
    const draftKey = `seed:${day}:${chainDay.seededRaw}:${amountRaw}`;
    const existing = await this.store.getAdminDraft(draftKey);
    if (existing) return { ...existing, alreadyPrepared: true };
    const transactions = [
      {
        to: this.chain.mattTokenAddress,
        value: '0',
        data: encodeFunctionData({
          abi: ARENA_ERC20_ABI,
          functionName: 'approve',
          args: [this.chain.contractAddress, amountRaw]
        })
      },
      {
        to: this.chain.contractAddress,
        value: '0',
        data: encodeFunctionData({
          abi: DAILY_ARENA_ABI,
          functionName: 'seedDay',
          args: [BigInt(utcDayId(day)), amountRaw]
        })
      }
    ];
    const prepared = {
      day,
      amountRaw: amountRaw.toString(),
      cumulativeSeedRaw: cumulative.toString(),
      reason,
      createdAt: timestamp,
      transactions,
      safe: createSafeTransactionBuilderFile(transactions, {
        chainId: 2020,
        createdAt: timestamp,
        safeAddress: this.safeAddress,
        name: `MATT Mine Daily Arena seed top-up: ${day}`,
        description: `Approve and seed this incremental MATT amount in order. Reason: ${reason}`
      })
    };
    const stored = await this.store.saveAdminDraft(draftKey, prepared);
    return { ...stored.draft, alreadyPrepared: stored.alreadyCreated };
  }

  async prepareControl(actionInput, reasonInput) {
    const timestamp = this.now();
    const action = String(actionInput || '').toLowerCase().replaceAll('_', '-');
    const definitions = {
      'pause-entries': { functionName: 'pauseEntries', field: 'entriesPaused', expected: false },
      'unpause-entries': { functionName: 'unpauseEntries', field: 'entriesPaused', expected: true },
      'pause-settlement': { functionName: 'pauseSettlement', field: 'settlementPaused', expected: false },
      'unpause-settlement': { functionName: 'unpauseSettlement', field: 'settlementPaused', expected: true }
    };
    const definition = definitions[action];
    assertApi(definition, 400, 'arena_control_invalid', 'Unknown Daily Arena pause control.');
    assertApi(
      ARENA_REPLAY_READY || action !== 'unpause-entries',
      409,
      'arena_unpause_security_gate',
      'Daily Arena entries cannot be unpaused until input-only deterministic replay is release-ready.'
    );
    const reason = normalizeReason(reasonInput);
    const controls = await this.chain.dayStatus(utcDayKey(timestamp));
    assertApi(
      controls[definition.field] === definition.expected,
      409,
      'arena_control_already_set',
      'The requested Daily Arena pause state is already active onchain.'
    );
    const draftKey = `control:${action}:${controls[definition.field]}`;
    const existing = await this.store.getAdminDraft(draftKey);
    if (existing) return { ...existing, alreadyPrepared: true };
    const transaction = {
      to: this.chain.contractAddress,
      value: '0',
      data: encodeFunctionData({
        abi: DAILY_ARENA_ABI,
        functionName: definition.functionName
      })
    };
    const prepared = {
      action,
      reason,
      createdAt: timestamp,
      transaction,
      transactions: [transaction],
      requiredSigner: 'Daily Arena emergency pauser EOA',
      broadcast: false,
      safe: null,
      warning: 'Direct emergency-pauser instruction only. The Treasury Safe does not hold PAUSER_ROLE.'
    };
    const stored = await this.store.saveAdminDraft(draftKey, prepared);
    return { ...stored.draft, alreadyPrepared: stored.alreadyCreated };
  }

  async createSettlement(dayInput, suspendedAddresses = [], reasonInput = '') {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    const reason = normalizeReason(reasonInput);
    assertApi(dayEndMs(day) <= timestamp, 409, 'arena_day_not_closed', 'Daily Arena settlement can only be prepared after 00:00 UTC.');
    await this.#ensureDay(day, timestamp);
    const chainDay = await this.chain.dayStatus(day);
    assertApi(chainDay.status !== 3, 409, 'arena_day_cancelled', 'A cancelled Daily Arena day cannot be settled.');
    assertApi(chainDay.status !== 2, 409, 'arena_day_already_settled', 'This Daily Arena day is already settled onchain.');
    assertApi(chainDay.status === 1, 409, 'arena_day_not_scheduled', 'Only a scheduled Daily Arena day can be settled.');
    assertApi(!chainDay.settlementPaused, 409, 'arena_settlement_paused', 'Daily Arena settlement is paused onchain.');
    const existing = await this.store.getSettlementDraft(day);
    if (existing) return { draft: existing, alreadyCreated: true };
    await this.#reconcileDay(day, chainDay);
    const leaderboard = await this.store.finalizeDay(day, suspendedAddresses);
    const draft = {
      id: `arena_settlement_${day}`,
      createdAt: timestamp,
      ...createArenaSettlementDraft({
        day,
        contractAddress: this.chain.contractAddress,
        safeAddress: this.safeAddress,
        poolRaw: leaderboard.prizePoolRaw,
        entries: leaderboard.rows,
        reason,
        createdAt: timestamp
      }),
      reason
    };
    const stored = await this.store.saveSettlementDraft(day, draft);
    return {
      draft: stored.draft,
      alreadyCreated: stored.alreadyCreated
    };
  }

  async settlement(dayInput) {
    const day = normalizeDay(dayInput || '', this.now());
    const draft = await this.store.getSettlementDraft(day);
    assertApi(draft, 404, 'arena_settlement_missing', 'The Daily Arena settlement draft was not found.');
    return draft;
  }

  assertLive() {
    assertApi(
      this.liveEnabled,
      503,
      'arena_live_disabled',
      'Paid Daily Arena entry is not enabled on this server deployment.'
    );
  }

  async adminOverview(dayInput, suspendedAddresses = []) {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    const contest = await this.#ensureDay(day, timestamp);
    const [leaderboard, chainDay] = await Promise.all([
      this.store.leaderboard(day, suspendedAddresses, timestamp),
      this.chain.dayStatus(day)
    ]);
    return {
      day,
      config: publicDay(contest, timestamp, this.publicConfig()),
      leaderboard,
      settlement: await this.store.getSettlementDraft(day),
      controls: {
        entriesPaused: chainDay.entriesPaused,
        settlementPaused: chainDay.settlementPaused
      }
    };
  }

  async prepareCancellation(dayInput, reasonInput) {
    const timestamp = this.now();
    const day = normalizeDay(dayInput || '', timestamp);
    const reason = normalizeReason(reasonInput);
    await this.#ensureDay(day, timestamp);
    const chainDay = await this.chain.dayStatus(day);
    assertApi(chainDay.status === 1, 409, 'arena_day_not_cancellable', 'Only an onchain scheduled, unsettled Arena day can be cancelled.');
    const draftKey = `cancel:${day}`;
    const existing = await this.store.getAdminDraft(draftKey);
    if (existing) return { ...existing, alreadyPrepared: true };
    const transaction = {
      to: this.chain.contractAddress,
      value: '0',
      data: encodeFunctionData({
        abi: DAILY_ARENA_ABI,
        functionName: 'cancelDay',
        args: [BigInt(utcDayId(day))]
      })
    };
    const prepared = {
      day,
      reason,
      transaction,
      safe: createSafeTransactionBuilderFile([transaction], {
        chainId: 2020,
        createdAt: timestamp,
        safeAddress: this.safeAddress,
        name: `MATT Mine Daily Arena cancellation: ${day}`,
        description: `Cancel the Arena day and enable entrant refunds. Reason: ${reason}`
      })
    };
    const stored = await this.store.saveAdminDraft(draftKey, prepared);
    return { ...stored.draft, alreadyPrepared: stored.alreadyCreated };
  }

  async #ensureDay(day, timestamp) {
    let existing = await this.store.getDay(day);
    const start = dayStartMs(day);
    const chainDay = await this.chain.dayStatus(day);
    if (chainDay.status === 0) {
      assertApi(
        existing && start > timestamp && existing.configurationState === 'prepared',
        409,
        'arena_day_not_scheduled',
        'This UTC day is not scheduled on the Daily Arena contract.'
      );
      return {
        ...existing,
        entriesPaused: chainDay.entriesPaused,
        settlementPaused: chainDay.settlementPaused
      };
    }
    if (!existing) {
      existing = await this.store.ensureDay({
        day,
        snapshotAt: dayEndMs(day),
        feeRaw: chainDay.entryFeeRaw,
        seedRaw: chainDay.seededRaw,
        deterministicSeed: this.#dailySeed(day),
        transcriptVersion: ARENA_TRANSCRIPT_VERSION,
        status: chainDay.status === 3
          ? 'cancelled'
          : chainDay.status === 2
            ? 'settled'
            : start > timestamp
              ? 'scheduled'
              : 'open',
        chainStatus: chainDay.status,
        configurationState: 'confirmed',
        entryPoolRaw: chainDay.entryPoolRaw,
        entryCount: Number(chainDay.entryCount),
        createdAt: timestamp
      });
    }
    assertApi(
      existing.feeRaw === chainDay.entryFeeRaw,
      409,
      'arena_fee_snapshot_mismatch',
      'The onchain Arena fee does not match the immutable 00:00 UTC server snapshot.'
    );
    const reconciled = await this.#reconcileDay(day, chainDay);
    return {
      ...reconciled,
      entriesPaused: chainDay.entriesPaused,
      settlementPaused: chainDay.settlementPaused
    };
  }

  async #reconcileDay(day, suppliedChainDay = null) {
    const chainDay = suppliedChainDay || await this.chain.dayStatus(day);
    const existing = await this.store.getDay(day);
    const localStatus = existing?.status === 'finalized'
      ? 'finalized'
      : chainDay.status === 1 &&
          dayStartMs(day) <= this.now() &&
          this.now() < dayEndMs(day)
        ? 'open'
        : 'scheduled';
    return this.store.reconcileDay(day, {
      entryPoolRaw: chainDay.entryPoolRaw,
      seedRaw: chainDay.seededRaw,
      entryCount: Number(chainDay.entryCount),
      chainStatus: chainDay.status,
      status: localStatus
    });
  }

  async #authenticatedRun(address, runId, runToken) {
    assertApi(/^arena_run_[a-f0-9]{24}$/.test(runId || ''), 400, 'arena_run_id_invalid', 'The Daily Arena run identifier is invalid.');
    assertApi(/^[a-f0-9]{64}$/.test(runToken || ''), 400, 'arena_run_token_invalid', 'The Daily Arena run token is invalid.');
    const run = await this.store.getRun(runId);
    assertApi(run, 404, 'arena_run_missing', 'The Daily Arena run was not found.');
    assertApi(run.address === address, 403, 'arena_run_owner_mismatch', 'This Daily Arena run belongs to another wallet.');
    assertApi(safeEqual(run.tokenHash, hashToken(runToken)), 401, 'arena_run_token_rejected', 'The Daily Arena run token is invalid.');
    return run;
  }

  async #assertRunOpen(run, timestamp) {
    assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
    if (run.expiresAt <= timestamp || dayEndMs(run.day) <= timestamp) {
      await this.store.expireRun(run.runId, timestamp);
      throw new ApiError(410, 'arena_run_expired', 'The Daily Arena run expired before submission.');
    }
  }

  #dailySeed(day) {
    return createHmac('sha256', this.seedSecret)
      .update(`matt-mine-daily-arena-seed-v1|${day}`)
      .digest('hex');
  }

  #sign(domain, value) {
    return createHmac('sha256', this.receiptSecret)
      .update(`${domain}|${canonicalJson(value)}`)
      .digest('hex');
  }

  #checkpoint(fields) {
    return {
      throughSeq: fields.throughSeq,
      throughTick: fields.throughTick,
      transcriptHash: fields.transcriptHash,
      signature: this.#sign('checkpoint', {
        runId: fields.runId,
        address: fields.address,
        throughSeq: fields.throughSeq,
        throughTick: fields.throughTick,
        transcriptHash: fields.transcriptHash
      })
    };
  }

  #publicCheckpoint(run) {
    return {
      throughSeq: run.throughSeq,
      throughTick: run.throughTick,
      transcriptHash: run.transcriptHash,
      signature: run.checkpointSignature
    };
  }

  #validCheckpointSignature(run, checkpoint) {
    const expected = this.#checkpoint({
      runId: run.runId,
      address: run.address,
      throughSeq: checkpoint.throughSeq,
      throughTick: checkpoint.throughTick,
      transcriptHash: checkpoint.transcriptHash
    });
    return safeEqual(expected.signature, checkpoint.signature);
  }
}

function normalizeCheckpoint(input) {
  assertApi(input && typeof input === 'object' && !Array.isArray(input), 400, 'arena_checkpoint_invalid', 'A server-issued Daily Arena checkpoint is required.');
  assertApi(Number.isSafeInteger(input.throughSeq) && input.throughSeq >= 0, 400, 'arena_checkpoint_invalid', 'The Daily Arena checkpoint sequence is invalid.');
  assertApi(Number.isSafeInteger(input.throughTick) && input.throughTick >= 0, 400, 'arena_checkpoint_invalid', 'The Daily Arena checkpoint tick is invalid.');
  assertApi(/^[a-f0-9]{64}$/.test(input.transcriptHash || ''), 400, 'arena_checkpoint_invalid', 'The Daily Arena transcript hash is invalid.');
  assertApi(/^[a-f0-9]{64}$/.test(input.signature || ''), 400, 'arena_checkpoint_invalid', 'The Daily Arena checkpoint signature is invalid.');
  return {
    throughSeq: input.throughSeq,
    throughTick: input.throughTick,
    transcriptHash: input.transcriptHash,
    signature: input.signature
  };
}

function checkpointMatches(run, checkpoint) {
  return (
    checkpoint.throughSeq === run.throughSeq &&
    checkpoint.throughTick === run.throughTick &&
    checkpoint.transcriptHash === run.transcriptHash &&
    checkpoint.signature === run.checkpointSignature
  );
}

function publicTranscriptEvent(event) {
  const output = {
    seq: event.seq,
    tick: event.tick,
    type: event.type
  };
  if (event.type === 'input') {
    return {
      ...output,
      moveX: event.moveX,
      moveY: event.moveY,
      aim: event.aim,
      attack: event.attack,
      dash: event.dash,
      weapon: event.weapon
    };
  }
  if (event.type === 'command') {
    return {
      ...output,
      command: event.command,
      ...(event.value ? { value: event.value } : {})
    };
  }
  return output;
}

function publicDay(day, timestamp, config) {
  const feeMatt = formatUnits(BigInt(day.feeRaw), 18);
  const seedMatt = formatUnits(BigInt(day.seedRaw), 18);
  const entryPoolMatt = formatUnits(BigInt(day.entryPoolRaw), 18);
  const prizePoolRaw = (BigInt(day.entryPoolRaw) + BigInt(day.seedRaw)).toString();
  const prizePoolMatt = formatUnits(BigInt(prizePoolRaw), 18);
  return {
    enabled: config.enabled,
    configured: config.configured,
    previewAvailable: config.previewAvailable,
    replayReady: config.replayReady,
    verificationMode: config.verificationMode,
    liveBlocker: config.liveBlocker,
    day: day.day,
    dayId: day.dayId,
    snapshotAt: day.snapshotAt,
    entryCutoffAt: day.snapshotAt - ENTRY_CUTOFF_WINDOW_MS,
    immutable: timestamp >= day.snapshotAt,
    status: day.status,
    chainStatus: day.chainStatus,
    configurationState: day.configurationState,
    entriesPaused: day.entriesPaused === true,
    settlementPaused: day.settlementPaused === true,
    paused: day.entriesPaused === true,
    fee: {
      raw: day.feeRaw,
      matt: feeMatt
    },
    feeRaw: day.feeRaw,
    feeMatt,
    seed: {
      raw: day.seedRaw,
      matt: seedMatt,
      capRaw: day.seedCapRaw,
      capMatt: formatUnits(BigInt(day.seedCapRaw), 18)
    },
    seedRaw: day.seedRaw,
    seedMatt,
    deterministicSeed: day.deterministicSeed,
    entryCount: day.entryCount,
    entryPoolRaw: day.entryPoolRaw,
    entryPoolMatt,
    prizePoolRaw,
    prizePoolMatt,
    totalPoolRaw: prizePoolRaw,
    totalPoolMatt: prizePoolMatt,
    transcriptVersion: day.transcriptVersion,
    winnerWeightsPercent: config.scoring.winnerWeightsPercent
  };
}

function publicUnscheduledDay(day, timestamp, config, deterministicSeed, controls = {}) {
  return {
    enabled: false,
    configured: true,
    previewAvailable: config.previewAvailable,
    replayReady: config.replayReady,
    verificationMode: config.verificationMode,
    liveBlocker: config.liveBlocker,
    day,
    dayId: utcDayId(day),
    snapshotAt: dayEndMs(day),
    entryCutoffAt: dayEndMs(day) - ENTRY_CUTOFF_WINDOW_MS,
    immutable: timestamp >= dayEndMs(day),
    status: 'unscheduled',
    chainStatus: 0,
    configurationState: 'unprepared',
    entriesPaused: controls.entriesPaused === true,
    settlementPaused: controls.settlementPaused === true,
    paused: controls.entriesPaused === true,
    fee: { raw: '0', matt: '0' },
    feeRaw: '0',
    feeMatt: '0',
    seed: {
      raw: '0',
      matt: '0',
      capRaw: ARENA_SEED_CAP_RAW,
      capMatt: formatUnits(BigInt(ARENA_SEED_CAP_RAW), 18)
    },
    seedRaw: '0',
    seedMatt: '0',
    deterministicSeed,
    entryCount: 0,
    uniquePlayers: 0,
    entryPoolRaw: '0',
    entryPoolMatt: '0',
    prizePoolRaw: '0',
    prizePoolMatt: '0',
    totalPoolRaw: '0',
    totalPoolMatt: '0',
    transcriptVersion: ARENA_TRANSCRIPT_VERSION,
    winnerWeightsPercent: config.scoring.winnerWeightsPercent
  };
}

function normalizeDay(value, timestamp) {
  const day = value || utcDayKey(timestamp);
  assertApi(/^\d{4}-\d{2}-\d{2}$/.test(day), 400, 'arena_day_invalid', 'Use a UTC day in YYYY-MM-DD format.');
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  assertApi(
    Number.isSafeInteger(parsed) && new Date(parsed).toISOString().slice(0, 10) === day,
    400,
    'arena_day_invalid',
    'The UTC Arena day is invalid.'
  );
  return day;
}

function utcDayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayStartMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function dayEndMs(day) {
  return dayStartMs(day) + DAY_MS;
}

function assertOpen(day, timestamp) {
  assertApi(day.chainStatus === 1, 409, 'arena_day_not_open', 'This Daily Arena day is not open onchain.');
  assertApi(
    !['cancelled', 'finalized', 'settled'].includes(day.status),
    409,
    'arena_day_closed',
    'This Daily Arena day is closed.'
  );
  assertApi(
    timestamp >= dayStartMs(day.day) && timestamp < dayEndMs(day.day),
    409,
    'arena_day_closed',
    'This Daily Arena day is closed.'
  );
}

function boundedRaw(value, minimum, maximum, code) {
  try {
    const parsed = BigInt(value);
    assertApi(parsed >= minimum && parsed <= maximum, 400, code, 'The raw MATT amount is outside the contract limits.');
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    throw new ApiError(400, code, 'Enter a raw MATT amount as an integer string.');
  }
}

function parseMatt(value, code) {
  assertApi(typeof value === 'string' || typeof value === 'number', 400, code, 'Enter a MATT amount.');
  try {
    return parseUnits(String(value), 18);
  } catch {
    throw new ApiError(400, code, 'Enter a valid MATT amount with no more than 18 decimal places.');
  }
}

function normalizeReason(value) {
  assertApi(typeof value === 'string' && value.trim().length >= 4, 400, 'arena_reason_required', 'Provide an operational reason of at least four characters.');
  return value.trim().slice(0, 280);
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
