import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, assertApi } from './errors.js';
import {
  applyEndlessPhaseCheckpoint,
  createEndlessRunRecord,
  endlessMinerCarryCapacity,
  endlessLeaderboard,
  endlessSmartEngineRecommendation,
  publicEndlessCheckpoint,
  sealEndlessPhaseVerification,
  signEndlessCheckpoint,
  validEndlessCheckpoint,
  verifyEndlessPhaseEvents
} from './endless-engine.js';
import { normalizeEndlessConfig, validateEndlessConfig } from '../src/game/endlessMine.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

function latestEndlessCheckpointTransaction(run = {}) {
  const transactions = Array.isArray(run.chainTransactions) ? run.chainTransactions : [];
  const checkpoint = [...transactions].reverse().find((entry) =>
    entry?.type === 'checkpoint' && TRANSACTION_HASH_PATTERN.test(String(entry.hash || ''))
  );
  if (checkpoint) return checkpoint.hash;
  const start = [...transactions].reverse().find((entry) =>
    entry?.type === 'start' && TRANSACTION_HASH_PATTERN.test(String(entry.hash || ''))
  );
  return start?.hash || '';
}

export const endlessServiceMethods = {
  async endlessStatus() {
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const version = store.activeConfigVersion;
    const published = store.configVersions[version];
    const activation = validateEndlessConfig(published.config, { forActivation: published.config.rewards.enabled });
    const payment = this.endlessPaymentVerifier?.publicStatus?.() || null;
    const paidEntryEnabled = published.config.entry.paidEnabled === true;
    const paymentReady = !paidEntryEnabled || payment?.configured === true;
    const operations = publicEndlessOperations(store.operations);
    return {
      mode: 'endless',
      permanent: true,
      tagline: 'Different map. Different experience. Same opportunity.',
      enabled: published.config.enabled === true && operations.newEntriesEnabled,
      configuredEnabled: published.config.enabled === true,
      nftRequired: true,
      paidEntryEnabled,
      entryPriceMatt: published.config.entry.mattPrice,
      entryRules: publicEndlessEntryRules(published.config.entry),
      paymentReady,
      payment: paidEntryEnabled ? payment : null,
      entryTransaction: paidEntryEnabled && paymentReady
        ? this.endlessPaymentVerifier.transactionForPayment(published.config.entry.mattPrice)
        : null,
      rewardsEnabled: published.config.rewards.enabled === true && activation.ok && Boolean(this.endlessRewardSettler) && operations.rewardsEnabled,
      runApprovalRequired: published.config.rewards.enabled === true && activation.ok && Boolean(this.endlessRewardSettler),
      rewardReadiness: operations.rewardsEnabled === false
        ? 'operations-paused'
        : activation.ok ? (this.endlessRewardSettler ? 'ready' : 'settler-required') : 'configuration-required',
      rewardErrors: activation.errors,
      operations,
      inputReplayReady: Boolean(this.competitiveReplayValidator?.registerEndlessPhase && this.competitiveReplayValidator?.verifyEndlessPhase),
      configVersion: version,
      generatorVersion: published.config.generatorVersion,
      leaderboardScopes: operations.leaderboardSubmissionsEnabled
        ? ['daily', 'weekly', 'season', 'all-time'].filter((scope) => published.config.leaderboards?.[scope === 'all-time' ? 'allTime' : scope] !== false)
        : []
    };
  },

  async prepareEndlessEntry(token, input = {}) {
    const session = await this.authenticate(token);
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_required', 'Endless requires live Miner NFT ownership verification.');
    const minerId = Number(input.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000_000, 422, 'miner_selection_required', 'Select one of this wallet’s Miner NFTs before entering Endless.');
    const minerProfile = await this.nftGameplayService.playerMiner(session.address, minerId);
    assertApi(minerProfile, 403, 'miner_nft_required', 'Endless requires a Miner NFT owned by this wallet.');
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const configVersion = store.activeConfigVersion;
    const published = store.configVersions[configVersion];
    assertApi(store.operations?.newEntriesEnabled !== false, 503, 'endless_entries_paused', 'New Endless entries are temporarily paused. Active runs are preserved.');
    assertApi(published?.config?.enabled === true, 503, 'endless_mode_disabled', 'Endless is temporarily paused.');
    const config = normalizeEndlessConfig(published.config);
    const activation = validateEndlessConfig(config, { forActivation: config.rewards.enabled });
    assertApi(activation.ok, 503, 'endless_economy_not_ready', activation.errors.join(' '));
    assertApi(this.competitiveReplayValidator?.registerEndlessPhase, 503, 'endless_input_replay_required', 'Endless entry remains closed until authoritative phase replay is available.');
    const eligibility = assertEndlessEntryEligible(state, session.address, minerId, minerProfile, config, this.now());
    const payment = this.endlessPaymentVerifier?.publicStatus?.() || null;
    if (config.entry.paidEnabled) {
      assertApi(payment?.configured === true, 503, 'endless_payment_verifier_required', 'Paid Endless entry remains closed until transaction verification is available. No payment was requested.');
    }
    return {
      eligible: true,
      configVersion,
      paidEntryEnabled: config.entry.paidEnabled,
      entryPriceMatt: config.entry.mattPrice,
      entryRules: publicEndlessEntryRules(config.entry),
      usage: eligibility,
      payment: config.entry.paidEnabled ? payment : null,
      entryTransaction: config.entry.paidEnabled
        ? this.endlessPaymentVerifier.transactionForPayment(config.entry.mattPrice)
        : null,
      runApprovalRequired: config.rewards.enabled === true && Boolean(this.endlessRewardSettler)
    };
  },

  async prepareEndlessRunAuthorization(token, input = {}) {
    const session = await this.authenticate(token);
    assertApi(this.endlessRewardSettler?.prepareRunAuthorization, 503, 'endless_reward_settler_required', 'Endless on-chain settlement is not configured.');
    const minerId = Number(input.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000_000, 422, 'miner_selection_required', 'Select one of this wallet’s Miner NFTs before entering Endless.');
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const config = normalizeEndlessConfig(store.configVersions[store.activeConfigVersion].config);
    const activation = validateEndlessConfig(config, { forActivation: config.rewards.enabled });
    assertApi(config.rewards.enabled && activation.ok, 409, 'endless_rewards_inactive', 'This free Endless version does not need an on-chain reward approval.');
    const miner = await this.nftGameplayService?.playerMiner(session.address, minerId);
    assertApi(miner, 403, 'miner_nft_required', 'Endless requires a Miner NFT owned by this wallet.');
    return this.endlessRewardSettler.prepareRunAuthorization({
      address: session.address,
      minerId,
      economyVersion: config.rewards.economyVersion,
      economyConfig: config.rewards
    });
  },

  async startEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_required', 'Endless requires live Miner NFT ownership verification.');
    const minerId = Number(input.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000_000, 422, 'miner_selection_required', 'Select one of this wallet’s Miner NFTs before entering Endless.');
    const minerProfile = await this.nftGameplayService.playerMiner(session.address, minerId);
    assertApi(minerProfile, 403, 'miner_nft_required', 'Endless requires a Miner NFT owned by this wallet.');
    const preflightState = await this.database.read();
    const preflightStore = preflightState.endlessCompetition;
    const preflightVersion = preflightStore.activeConfigVersion;
    const preflightPublished = preflightStore.configVersions[preflightVersion];
    assertApi(preflightStore.operations?.newEntriesEnabled !== false, 503, 'endless_entries_paused', 'New Endless entries are temporarily paused. Active runs are preserved.');
    assertApi(preflightPublished?.config?.enabled === true, 503, 'endless_mode_disabled', 'Endless is temporarily paused.');
    const preflightConfig = normalizeEndlessConfig(preflightPublished.config);
    assertApi(this.competitiveReplayValidator?.registerEndlessPhase, 503, 'endless_input_replay_required', 'Endless entry remains closed until authoritative phase replay is available. No payment was requested.');
    const submittedPaymentHash = String(input.entryTransactionHash || '').toLowerCase();
    if (TRANSACTION_HASH_PATTERN.test(submittedPaymentHash)) {
      assertApi(!preflightStore.paymentTransactions[submittedPaymentHash], 409, 'payment_already_consumed', 'This MATT entry payment has already started an Endless run.');
    }
    assertEndlessEntryEligible(preflightState, session.address, minerId, minerProfile, preflightConfig, this.now());
    let payment = null;
    if (preflightConfig.entry.paidEnabled) {
      assertApi(this.endlessPaymentVerifier, 503, 'endless_payment_verifier_required', 'Paid Endless entry remains closed until transaction verification is available.');
      assertApi(TRANSACTION_HASH_PATTERN.test(String(input.entryTransactionHash || '')), 400, 'invalid_transaction_hash', 'Confirm the Endless MATT entry transaction in Ronin Wallet first.');
      payment = await this.endlessPaymentVerifier.verifyPayment({
        transactionHash: input.entryTransactionHash,
        address: session.address,
        mattPrice: preflightConfig.entry.mattPrice
      });
      assertApi(payment?.transactionHash === String(input.entryTransactionHash).toLowerCase(), 422, 'endless_payment_verification_mismatch', 'The verified MATT payment does not match the submitted transaction.');
    } else {
      assertApi(!input.entryTransactionHash, 422, 'endless_payment_not_required', 'This Endless configuration is free. Do not send a MATT entry payment.');
    }
    const timestamp = this.now();
    const runId = `run_${this.randomHex(12)}`;
    const runToken = this.randomHex(24);
    const runSeed = `MATT-ENDLESS-${this.randomHex(24)}`;
    let chainStart = null;
    let inputCheckpoint = null;
    let created;
    try {
      created = await this.database.transact(async (state, transaction) => {
        assertApi(!state.operations.maintenanceMode, 503, 'maintenance_mode', state.operations.announcement || 'MATT Mine is temporarily under maintenance.');
        const wallet = state.wallets[session.address];
        assertApi(wallet && !wallet.suspended, 403, 'wallet_suspended', 'This wallet cannot enter ranked play.');
        const store = state.endlessCompetition;
        assertApi(store.operations?.newEntriesEnabled !== false, 503, 'endless_entries_paused', 'New Endless entries are temporarily paused. Active runs are preserved.');
        const version = store.activeConfigVersion;
        assertApi(version === preflightVersion, 409, 'endless_config_changed', 'The Endless entry settings changed while the transaction confirmed. Refresh and try again.');
        const published = store.configVersions[version];
        assertApi(published?.config?.enabled === true, 503, 'endless_mode_disabled', 'Endless is temporarily paused.');
        const config = normalizeEndlessConfig(published.config);
        const activation = validateEndlessConfig(config, { forActivation: config.rewards.enabled });
        assertApi(activation.ok, 503, 'endless_economy_not_ready', activation.errors.join(' '));
        assertApi(this.competitiveReplayValidator?.registerEndlessPhase, 503, 'endless_input_replay_required', 'Endless entry remains closed until authoritative phase replay is available.');
        if (config.rewards.enabled) {
          assertApi(this.endlessRewardSettler, 503, 'endless_reward_settler_required', 'Endless rewards remain closed until checkpoint settlement is available.');
          assertApi(input.authorization && input.playerSignature, 422, 'endless_run_approval_required', 'Approve this Endless Miner lock in Ronin Wallet.');
        }
        if (config.entry.paidEnabled) {
          assertApi(this.endlessPaymentVerifier, 503, 'endless_payment_verifier_required', 'Paid Endless entry remains closed until transaction verification is available.');
          assertApi(payment?.transactionHash, 422, 'endless_payment_confirmation_required', 'Confirm the one-time Endless MATT entry transaction before starting.');
          assertApi(Number(payment.amountMatt) === config.entry.mattPrice, 422, 'payment_amount_mismatch', 'The MATT entry payment amount must match the active Admin price exactly.');
          assertApi(payment.payer === session.address, 403, 'payment_wallet_mismatch', 'This MATT payment was sent by another wallet.');
          assertApi(!store.paymentTransactions[payment.transactionHash], 409, 'payment_already_consumed', 'This MATT entry payment has already started an Endless run.');
        }
        assertEndlessEntryEligible(state, session.address, minerId, minerProfile, config, timestamp);
        if (config.rewards.enabled) {
          chainStart = await this.endlessRewardSettler.beginRun({
            address: session.address,
            minerId,
            economyVersion: config.rewards.economyVersion,
            economyConfig: config.rewards,
            authorization: input.authorization,
            playerSignature: input.playerSignature
          });
        }
        const record = createEndlessRunRecord({
          id: runId,
          tokenHash: endlessTokenHash(runToken),
          address: session.address,
          minerId,
          minerProfile,
          runSeed,
          configVersion: version,
          config,
          startedAt: timestamp,
          expiresAt: timestamp + config.integrity.reconnectWindowSeconds * 1_000,
          payment,
          chainRun: chainStart?.chainRun || null
        });
        if (chainStart?.transactionHash) record.chainTransactions.push({ type: 'start', hash: chainStart.transactionHash, recordedAt: timestamp });
        record.checkpointSignature = signEndlessCheckpoint(record, this.endlessCheckpointSecret);
        inputCheckpoint = await this.competitiveReplayValidator.registerEndlessPhase(record, runToken);
        store.runs[runId] = record;
        if (payment) {
          store.paymentTransactions[payment.transactionHash] = {
            ...structuredClone(payment),
            runId,
            configVersion: version,
            consumedAt: timestamp
          };
        }
        state.runs[runId] = record;
        await transaction?.upsertEndlessConfig?.(published, true);
        await transaction?.upsertEndlessRun?.(record);
        await transaction?.upsertEndlessPayment?.(
          record,
          payment ? store.paymentTransactions[payment.transactionHash] : null
        );
        return structuredClone(record);
      });
    } catch (error) {
      if (chainStart?.chainRun && this.endlessRewardSettler?.cancelUnstarted) {
        try {
          await this.endlessRewardSettler.cancelUnstarted({ minerId, chainRun: chainStart.chainRun });
        } catch (cancellationError) {
          const uncertain = new ApiError(503, 'endless_start_uncertain', 'The server could not save or release the confirmed Endless Miner lock. Recovery is required before this Miner can start again.');
          uncertain.cause = cancellationError;
          throw uncertain;
        }
      }
      throw error;
    }
    return publicEndlessRun(created, runToken, inputCheckpoint);
  },

  async checkpointEndlessPhase(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    const before = await this.database.read();
    const replayRun = before.endlessCompetition.runs[runId];
    assertEndlessRunOwner(replayRun, session.address, runToken);
    if (previouslyAcceptedEndlessBank(replayRun, input.previousCheckpoint, input.action, this.endlessCheckpointSecret)) {
      return recoveredEndlessBankResponse(replayRun, before.endlessCompetition.operations);
    }
    assertApi(replayRun.expiresAt > timestamp, 410, 'endless_run_expired', 'The reconnect window for this Endless run expired.');
    assertApi(validEndlessCheckpoint(replayRun, input.previousCheckpoint, this.endlessCheckpointSecret), 401, 'endless_checkpoint_invalid', 'Use the latest server-signed Endless checkpoint.');
    assertApi(this.competitiveReplayValidator?.verifyEndlessPhase, 503, 'endless_input_replay_required', 'Authoritative Endless phase replay is unavailable.');
    const replay = await this.competitiveReplayValidator.verifyEndlessPhase({
      run: replayRun,
      checkpoint: input.inputCheckpoint,
      action: String(input.action || '')
    });
    const replayIdentity = {
      id: replayRun.id,
      currentPhase: replayRun.currentPhase,
      phaseAttempt: replayRun.phaseAttempt
    };
    let nextInputCheckpoint = null;
    const result = await this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(run, session.address, runToken);
      assertApi(!run.adminTerminationPending, 409, 'run_admin_termination_pending', 'An administrator is ending this run, so its checkpoint was not accepted.');
      assertApi(run.expiresAt > timestamp, 410, 'endless_run_expired', 'The reconnect window for this Endless run expired.');
      assertApi(validEndlessCheckpoint(run, input.previousCheckpoint, this.endlessCheckpointSecret), 401, 'endless_checkpoint_invalid', 'Use the latest server-signed Endless checkpoint.');
      const operations = state.endlessCompetition.operations || {};
      if (String(input.action || '') === 'bank') {
        assertApi(operations.bankingEnabled !== false, 503, 'endless_banking_paused', 'Endless banking is temporarily paused. Your signed run checkpoint remains active.');
      } else if (Number(operations.temporaryMaximumPhase || 0) > 0) {
        assertApi(run.currentPhase < Number(operations.temporaryMaximumPhase), 422, 'endless_temporary_phase_limit', 'This run reached the temporary Admin phase ceiling. Bank the verified run instead.');
      }
      recordHeartbeatIntegrity(run, timestamp);
      const verification = verifyEndlessPhaseEvents(run, replay.outcomeEvents, timestamp);
      verification.inputReplay = structuredClone(replay.evidence);
      verification.runId = run.id;
      verification.phaseSeed = run.manifest.seed;
      verification.configVersion = run.configVersion;
      verification.checkpointSequence = Number(run.checkpointSequence || 0) + 1;
      verification.phaseStartedAt = run.phaseStartedAt;
      verification.phaseCompletedAt = timestamp;
      verification.previousCheckpoint = run.rollingDigest;
      verification.crystalsCarried = Number(run.crystalsCarried || 0) + verification.crystalsAdded;
      verification.minerXp = Math.max(0, Math.min(
        Number(run.config.rewards.phaseXp || 0),
        Number(run.config.rewards.maximumRunXp || 0) -
          Number(run.completedPhases || 0) * Number(run.config.rewards.phaseXp || 0)
      ));
      verification.integrityState = {
        score: run.integrityScore,
        flags: [...run.integrityFlags],
        phaseAttempt: run.phaseAttempt
      };
      verification.digest = sealEndlessPhaseVerification(run, verification);
      const nextManifest = applyEndlessPhaseCheckpoint(run, verification, String(input.action || ''), timestamp);
      if (run.config.rewards.enabled) {
        const chainCheckpoint = await this.endlessRewardSettler.checkpoint({
          address: run.address,
          minerId: run.minerId,
          chainRun: run.chainRun,
          completedPhases: run.completedPhases,
          minedCrystalUnits: run.crystalsCarried,
          rollingDigest: run.rollingDigest
        });
        run.chainRun = chainCheckpoint.chainRun;
        if (chainCheckpoint.transactionHash) {
          run.chainTransactions.push({ type: 'checkpoint', phase: run.completedPhases, hash: chainCheckpoint.transactionHash, recordedAt: timestamp });
          run.chainTransactions = run.chainTransactions.slice(-50);
        }
      }
      run.checkpointSignature = signEndlessCheckpoint(run, this.endlessCheckpointSecret);
      if (run.status === 'active') {
        nextInputCheckpoint = await this.competitiveReplayValidator.registerEndlessPhase(run, runToken);
      }
      state.runs[runId] = run;
      if (run.status === 'banked' && operations.leaderboardSubmissionsEnabled !== false) {
        finalizeLeaderboardEntry(state.endlessCompetition, run);
      }
      await transaction?.upsertEndlessRun?.(run);
      await transaction?.insertEndlessCheckpoint?.(run, verification);
      if (run.status === 'banked' && operations.leaderboardSubmissionsEnabled !== false) {
        const leaderboard = state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === run.id);
        await transaction?.upsertEndlessLeaderboard?.(leaderboard, run);
      }
      return {
        run: structuredClone(run),
        verification,
        nextManifest: nextManifest ? structuredClone(nextManifest) : null,
        rewardsOperational: operations.rewardsEnabled !== false,
        leaderboardSubmitted: run.status === 'banked' && operations.leaderboardSubmissionsEnabled !== false
      };
    });
    await this.competitiveReplayValidator.finalizeEndlessPhase(replayIdentity, 'verified').catch(() => undefined);
    let rewardSettlement = null;
    if (result.run.status === 'banked' && result.run.config.rewards.enabled && result.rewardsOperational) {
      try {
        rewardSettlement = { pending: false, receipt: await this.settleEndlessRewards(result.run) };
      } catch (error) {
        await markEndlessSettlementPending(this, result.run.id, error);
        rewardSettlement = { pending: true, error: 'Verified rewards are queued for retry.' };
      }
    } else if (result.run.status === 'banked' && result.run.config.rewards.enabled) {
      await markEndlessSettlementPending(this, result.run.id, { code: 'endless_rewards_paused' });
      rewardSettlement = { pending: true, error: 'Verified rewards are paused by Admin and remain safely queued.' };
    }
    return {
      checkpoint: publicEndlessCheckpoint(result.run),
      phase: publicEndlessPhaseVerification(result.verification),
      run: publicEndlessRun(result.run),
      nextManifest: result.nextManifest,
      nextInputCheckpoint,
      summary: result.run.status === 'banked'
        ? { ...endlessBankSummary(result.run), leaderboardSubmitted: result.leaderboardSubmitted }
        : null,
      rewardSettlement
    };
  },

  async retryEndlessSettlement(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const state = await this.database.read();
    const run = state.endlessCompetition.runs[runId];
    assertApi(run && run.address === session.address, 404, 'endless_run_missing', 'The Endless run was not found.');
    assertApi(run.status === 'banked' && run.config.rewards.enabled, 409, 'endless_settlement_unavailable', 'This run has no pending Endless reward settlement.');
    assertApi(state.endlessCompetition.operations?.rewardsEnabled !== false, 503, 'endless_rewards_paused', 'Endless reward settlement is temporarily paused by Admin. The verified reward remains queued.');
    if (run.rewardSettlement?.settled === true) {
      return { settled: true, alreadySettled: true, receipt: structuredClone(run.rewardSettlement) };
    }
    const receipt = await this.settleEndlessRewards(structuredClone(run));
    return { settled: true, receipt };
  },

  async heartbeatEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(run, session.address, runToken);
      assertApi(run.status === 'active', 409, 'endless_run_closed', 'This Endless run is no longer active.');
      assertApi(validEndlessCheckpoint(run, input.checkpoint, this.endlessCheckpointSecret), 401, 'endless_checkpoint_invalid', 'Use the latest server-signed Endless checkpoint.');
      run.lastHeartbeatAt = timestamp;
      run.updatedAt = timestamp;
      run.heartbeatCount = Number(run.heartbeatCount || 0) + 1;
      run.expiresAt = timestamp + run.config.integrity.reconnectWindowSeconds * 1_000;
      state.runs[runId] = run;
      await transaction?.upsertEndlessRun?.(run);
      return { acknowledgedAt: timestamp, expiresAt: run.expiresAt, checkpoint: publicEndlessCheckpoint(run) };
    });
  },

  async appendEndlessInputs(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const state = await this.database.read();
    const run = state.endlessCompetition.runs[runId];
    assertApi(run && run.address === session.address, 404, 'endless_run_missing', 'The Endless run was not found.');
    assertApi(!run.adminTerminationPending, 409, 'run_admin_termination_pending', 'An administrator is ending this run, so no more inputs were accepted.');
    assertApi(this.competitiveReplayValidator?.appendEndlessPhase, 503, 'endless_input_replay_required', 'Authoritative Endless phase replay is unavailable.');
    return {
      inputCheckpoint: await this.competitiveReplayValidator.appendEndlessPhase(session.address, {
        ...input,
        runId,
        phase: run.currentPhase
      })
    };
  },

  async reconnectEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    let inputCheckpoint = null;
    let previousReplayIdentity = null;
    const run = await this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(run, session.address, runToken);
      assertApi(run.status === 'active' && run.expiresAt > timestamp, 410, 'endless_reconnect_expired', 'This Endless run can no longer be reconnected.');
      const integrity = run.config.integrity;
      assertApi(Number(run.reconnectCount || 0) < integrity.maximumReconnectsPerRun, 429, 'endless_reconnect_limit', 'This run reached its reconnect limit.');
      assertApi(Number(run.phaseReconnectCount || 0) < integrity.maximumReconnectsPerPhase, 429, 'endless_phase_reconnect_limit', 'This phase reached its reconnect limit.');
      previousReplayIdentity = { id: run.id, currentPhase: run.currentPhase, phaseAttempt: run.phaseAttempt };
      run.reconnectCount = Number(run.reconnectCount || 0) + 1;
      run.phaseReconnectCount = Number(run.phaseReconnectCount || 0) + 1;
      run.phaseAttempt = Number(run.phaseAttempt || 1) + 1;
      run.lastHeartbeatAt = timestamp;
      run.updatedAt = timestamp;
      run.expiresAt = timestamp + integrity.reconnectWindowSeconds * 1_000;
      assertApi(this.competitiveReplayValidator?.registerEndlessPhase, 503, 'endless_input_replay_required', 'Authoritative Endless phase replay is unavailable.');
      inputCheckpoint = await this.competitiveReplayValidator.registerEndlessPhase(run, runToken);
      state.runs[runId] = run;
      await transaction?.upsertEndlessRun?.(run);
      return structuredClone(run);
    });
    await this.competitiveReplayValidator?.finalizeEndlessPhase?.(previousReplayIdentity, 'disconnected').catch(() => undefined);
    return publicEndlessRun(run, runToken, inputCheckpoint);
  },

  async resumeEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    const minerId = Number(input.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000_000, 422, 'miner_selection_required', 'Select the locked Miner whose Endless run you want to resume.');
    const timestamp = this.now();
    const runToken = this.randomHex(24);
    let inputCheckpoint = null;
    let previousReplayIdentity = null;
    const run = await this.database.transact(async (state, transaction) => {
      const matches = Object.values(state.endlessCompetition.runs).filter((candidate) =>
        candidate.address === session.address &&
        Number(candidate.minerId) === minerId &&
        candidate.status === 'active'
      );
      assertApi(matches.length === 1, 404, 'endless_active_run_missing', `Miner #${minerId} does not have one active Endless run to resume.`);
      const current = matches[0];
      assertApi(!current.adminTerminationPending, 409, 'run_admin_termination_pending', 'An administrator is ending this run. Wait for that operation to finish.');
      assertApi(current.expiresAt > timestamp, 410, 'endless_reconnect_expired', 'This Endless run is outside its published reconnect window and must be forfeited.');
      const integrity = current.config.integrity;
      assertApi(Number(current.reconnectCount || 0) < integrity.maximumReconnectsPerRun, 429, 'endless_reconnect_limit', 'This run reached its reconnect limit and must be forfeited.');
      assertApi(Number(current.phaseReconnectCount || 0) < integrity.maximumReconnectsPerPhase, 429, 'endless_phase_reconnect_limit', 'This phase reached its reconnect limit and must be forfeited.');
      previousReplayIdentity = { id: current.id, currentPhase: current.currentPhase, phaseAttempt: current.phaseAttempt };
      current.tokenHash = endlessTokenHash(runToken);
      current.reconnectCount = Number(current.reconnectCount || 0) + 1;
      current.phaseReconnectCount = Number(current.phaseReconnectCount || 0) + 1;
      current.phaseAttempt = Number(current.phaseAttempt || 1) + 1;
      current.lastHeartbeatAt = timestamp;
      current.updatedAt = timestamp;
      current.expiresAt = timestamp + integrity.reconnectWindowSeconds * 1_000;
      assertApi(this.competitiveReplayValidator?.registerEndlessPhase, 503, 'endless_input_replay_required', 'Authoritative Endless phase replay is unavailable.');
      inputCheckpoint = await this.competitiveReplayValidator.registerEndlessPhase(current, runToken);
      state.runs[current.id] = current;
      await transaction?.upsertEndlessRun?.(current);
      return structuredClone(current);
    });
    await this.competitiveReplayValidator?.finalizeEndlessPhase?.(previousReplayIdentity, 'disconnected').catch(() => undefined);
    return publicEndlessRun(run, runToken, inputCheckpoint);
  },

  async abandonEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    const run = await this.database.transact(async (state, transaction) => {
      const current = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(current, session.address, runToken);
      assertApi(current.status === 'active', 409, 'endless_run_closed', 'This Endless run is already closed.');
      const knockout = input.reason === 'knockout';
      if (current.config.rewards.enabled) {
        const receipt = current.completedPhases > 0
          ? await this.endlessRewardSettler.settle({
              address: current.address,
              minerId: current.minerId,
              chainRun: current.chainRun,
              completedPhases: current.completedPhases,
              minedCrystalUnits: current.crystalsCarried,
              rollingDigest: current.rollingDigest,
              outcome: 'death'
            })
          : await this.endlessRewardSettler.cancelUnstarted({ minerId: current.minerId, chainRun: current.chainRun });
        current.rewardSettlement = current.completedPhases > 0 ? { settled: true, ...structuredClone(receipt), settledAt: timestamp } : null;
        current.crystalsBanked = Math.max(0, Number(receipt.crystalsBanked || 0));
        current.minerXpBanked = Math.max(0, Number(receipt.minerXpBanked || 0));
        if (receipt.transactionHash) {
          current.chainTransactions.push({ type: current.completedPhases > 0 ? 'death-settlement' : 'start-cancel', hash: receipt.transactionHash, recordedAt: timestamp });
          current.chainTransactions = current.chainTransactions.slice(-50);
        }
      }
      current.status = knockout ? 'knocked_out' : 'abandoned';
      current.finishReason = knockout ? 'knockout' : 'abandoned';
      current.finishedAt = timestamp;
      current.updatedAt = timestamp;
      current.checkpointSignature = signEndlessCheckpoint(current, this.endlessCheckpointSecret);
      state.runs[runId] = current;
      if (knockout && current.completedPhases > 0 && state.endlessCompetition.operations?.leaderboardSubmissionsEnabled !== false) {
        finalizeLeaderboardEntry(state.endlessCompetition, current);
      }
      await transaction?.upsertEndlessRun?.(current);
      if (knockout && current.completedPhases > 0 && state.endlessCompetition.operations?.leaderboardSubmissionsEnabled !== false) {
        const leaderboard = state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === current.id);
        await transaction?.upsertEndlessLeaderboard?.(leaderboard, current);
      }
      return structuredClone(current);
    });
    await this.competitiveReplayValidator?.finalizeEndlessPhase?.(run, 'abandoned').catch(() => undefined);
    return { run: publicEndlessRun(run), summary: endlessBankSummary(run) };
  },

  async endlessLeaderboard(token, scope = 'all-time', board = 'score') {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const config = state.endlessCompetition.configVersions[state.endlessCompetition.activeConfigVersion].config;
    assertApi(state.endlessCompetition.operations?.leaderboardSubmissionsEnabled !== false, 503, 'endless_leaderboards_paused', 'Endless leaderboards are temporarily paused by Admin. Verified run history remains stored.');
    assertApi(['daily', 'weekly', 'season', 'all-time'].includes(scope), 400, 'endless_leaderboard_scope', 'Choose a daily, weekly, seasonal, or all-time Endless board.');
    const scopeKey = scope === 'all-time' ? 'allTime' : scope;
    assertApi(config.leaderboards?.[scopeKey] !== false, 404, 'endless_leaderboard_disabled', 'This Endless leaderboard scope is disabled in the active configuration.');
    assertApi(board !== 'deepest' || scope === 'all-time', 422, 'endless_deepest_scope', 'Deepest descent is an all-time board.');
    const rows = endlessLeaderboard(
      state.endlessCompetition.leaderboardEntries,
      scope,
      this.now(),
      config.leaderboards.seasonDays,
      board
    ).map((row) => ({
      ...row,
      isPlayer: row.address === session.address,
      identity: publicEndlessLeaderboardIdentity(state.wallets?.[row.address])
    }));
    return {
      mode: 'endless',
      scope,
      board,
      player: rows.find((row) => row.address === session.address) || null,
      rows
    };
  },

  async endlessPlayer(token) {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const [storedRuns, durableLifetime] = await Promise.all([
      this.database.readEndlessPlayerRuns?.(session.address, 100),
      this.database.readEndlessPlayerSummary?.(session.address)
    ]);
    const runs = (Array.isArray(storedRuns)
      ? storedRuns
      : Object.values(state.endlessCompetition.runs).filter((run) => run.address === session.address)
    )
      .filter((run) => run.status !== 'active')
      .sort((left, right) => Number(right.finishedAt || right.updatedAt || 0) - Number(left.finishedAt || left.updatedAt || 0));
    const entries = state.endlessCompetition.leaderboardEntries || [];
    const scoreRanks = leaderboardRankMap(entries, 'score', this.now());
    const depthRanks = leaderboardRankMap(entries, 'deepest', this.now());
    const allHistory = runs.map((run) => publicEndlessHistoryRun(
      run,
      scoreRanks.get(run.id) || 0,
      depthRanks.get(run.id) || 0
    ));
    const lifetime = durableLifetime || endlessLifetimeStats(allHistory);
    const history = allHistory.slice(0, 100);
    return {
      mode: 'endless',
      lifetime,
      history,
      historyLimit: 100,
      hasMoreHistory: Number(lifetime.totalRuns || 0) > history.length
    };
  },

  async adminEndless(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const activeRuns = Object.values(store.runs).filter((run) => run.status === 'active');
    const activeConfig = store.configVersions[store.activeConfigVersion];
    const history = Object.values(store.configVersions).sort((a, b) => b.version - a.version);
    return {
      status: await this.endlessStatus(),
      activeConfig: structuredClone(activeConfig),
      configHistory: history.map((value, index) => ({
        ...structuredClone(value),
        active: value.version === store.activeConfigVersion,
        changedSettings: changedConfigPaths(history[index + 1]?.config, value.config).slice(0, 40)
      })),
      operations: publicEndlessOperations(store.operations),
      monitoring: endlessMonitoring(store, this.now()),
      activeRuns: activeRuns.map((run) => adminRunSummary(run)),
      recentRuns: Object.values(store.runs).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map((run) => adminRunSummary(run)),
      smartEngine: structuredClone(store.smartEngine)
    };
  },

  async updateEndlessOperations(adminKey, input = {}) {
    this.assertAdminKey(adminKey);
    const reason = endlessAdminReason(input.reason);
    const patch = normalizeEndlessOperationsPatch(input.patch);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const store = state.endlessCompetition;
      store.operations = {
        ...store.operations,
        ...patch,
        alertThresholds: {
          ...store.operations?.alertThresholds,
          ...(patch.alertThresholds || {})
        },
        updatedAt: timestamp,
        updatedBy: 'SERVER_ADMIN',
        reason
      };
      const changed = Object.keys(patch).join(', ');
      state.audit.push({
        action: 'ENDLESS_OPERATIONS_UPDATED',
        details: `${reason}; ${changed}`.slice(0, 500),
        timestamp,
        address: 'SERVER_ADMIN'
      });
      state.audit = state.audit.slice(-2_000);
      return publicEndlessOperations(store.operations);
    });
  },

  async adminEndlessRun(adminKey, runIdInput) {
    this.assertAdminKey(adminKey);
    const runId = cleanRunId(runIdInput);
    const state = await this.database.read();
    const compatibilityRun = state.endlessCompetition.runs[runId];
    const durable = await this.database.readEndlessRunReview?.(runId);
    const run = durable?.run || compatibilityRun;
    assertApi(run, 404, 'endless_run_missing', 'The Endless run was not found.');
    return adminRunReview(run, {
      phases: durable?.phases || run.phaseHistory || [],
      integrityEvents: durable?.integrityEvents || run.integrityFlags || [],
      payment: durable?.payment || run.payment || null,
      settlementTransactions: durable?.settlementTransactions || run.chainTransactions || [],
      leaderboardEntry: state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === run.id) || null
    });
  },

  async terminateEndlessRun(adminKey, runIdInput, input = {}) {
    this.assertAdminKey(adminKey);
    const runId = cleanRunId(runIdInput);
    const reason = endlessAdminReason(input.reason);
    const timestamp = this.now();
    let reserved;
    await this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertApi(run, 404, 'endless_run_missing', 'The Endless run was not found.');
      assertApi(run.status === 'active', 409, 'endless_run_closed', 'Only an active Endless run can be terminated.');
      assertApi(!run.adminTerminationPending, 409, 'run_admin_termination_pending', 'This Endless run is already being terminated.');
      run.adminTerminationPending = true;
      run.updatedAt = timestamp;
      state.runs[runId] = run;
      await transaction?.upsertEndlessRun?.(run);
      reserved = structuredClone(run);
    });
    let receipt = null;
    try {
      if (reserved.config.rewards.enabled) {
        assertApi(this.endlessRewardSettler, 503, 'endless_reward_settler_required', 'The on-chain Endless operator is required to release this Miner safely.');
        receipt = reserved.completedPhases > 0
          ? await this.endlessRewardSettler.settle({
              address: reserved.address,
              minerId: reserved.minerId,
              chainRun: reserved.chainRun,
              completedPhases: reserved.completedPhases,
              minedCrystalUnits: reserved.crystalsCarried,
              rollingDigest: reserved.rollingDigest,
              outcome: 'death'
            })
          : await this.endlessRewardSettler.cancelUnstarted({ minerId: reserved.minerId, chainRun: reserved.chainRun });
      }
      const rejected = await this.database.transact(async (state, transaction) => {
        const run = state.endlessCompetition.runs[runId];
        assertApi(run?.status === 'active' && run.adminTerminationPending, 409, 'admin_run_termination_changed', 'The Endless run changed while it was being terminated.');
        run.status = 'rejected';
        run.finishReason = 'admin_rejected';
        run.finishedAt = this.now();
        run.updatedAt = run.finishedAt;
        run.adminTerminationPending = false;
        run.adminReview = { decision: 'rejected', reason, reviewedAt: run.finishedAt, reviewedBy: 'SERVER_ADMIN' };
        if (receipt) {
          run.rewardSettlement = { settled: true, rejected: true, ...structuredClone(receipt), settledAt: run.finishedAt };
          run.crystalsBanked = Math.max(0, Number(receipt.crystalsBanked || 0));
          run.minerXpBanked = Math.max(0, Number(receipt.minerXpBanked || 0));
          if (receipt.transactionHash) {
            run.chainTransactions ||= [];
            run.chainTransactions.push({ type: 'admin-rejection', hash: receipt.transactionHash, recordedAt: run.finishedAt });
            run.chainTransactions = run.chainTransactions.slice(-50);
          }
        }
        state.runs[runId] = run;
        state.audit.push({ action: 'ENDLESS_RUN_REJECTED', details: `${runId}; ${reason}`.slice(0, 500), timestamp: run.finishedAt, address: 'SERVER_ADMIN' });
        state.audit = state.audit.slice(-2_000);
        await transaction?.upsertEndlessRun?.(run);
        return structuredClone(run);
      });
      await this.competitiveReplayValidator?.finalizeEndlessPhase?.(reserved, 'admin_rejected').catch(() => undefined);
      return adminRunSummary(rejected);
    } catch (error) {
      await this.database.transact(async (state, transaction) => {
        const run = state.endlessCompetition.runs[runId];
        if (!run || run.status !== 'active') return;
        run.adminTerminationPending = false;
        run.updatedAt = this.now();
        state.runs[runId] = run;
        await transaction?.upsertEndlessRun?.(run);
      }).catch(() => undefined);
      throw error;
    }
  },

  async publishEndlessConfig(adminKey, input = {}) {
    this.assertAdminKey(adminKey);
    const reason = String(input.reason || '').trim().slice(0, 500);
    assertApi(reason.length >= 8, 422, 'admin_reason_required', 'Provide a meaningful reason for this Endless configuration version.');
    const requestedConfig = input.config && typeof input.config === 'object' ? input.config : {};
    const normalized = normalizeEndlessConfig(requestedConfig);
    const validation = validateEndlessConfig(requestedConfig, { forActivation: normalized.enabled && normalized.rewards.enabled });
    assertApi(validation.ok, 422, 'endless_config_invalid', 'The Endless configuration is invalid.', validation.errors);
    const config = validation.config;
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      const store = state.endlessCompetition;
      const version = Math.max(0, ...Object.keys(store.configVersions).map(Number)) + 1;
      const record = { version, config, publishedAt: timestamp, activatedAt: timestamp, publishedBy: 'SERVER_ADMIN', reason };
      store.configVersions[version] = record;
      store.activeConfigVersion = version;
      state.audit.push({ action: 'ENDLESS_CONFIG_PUBLISHED', details: `v${version}; ${reason}`, timestamp, address: 'SERVER_ADMIN' });
      state.audit = state.audit.slice(-2_000);
      await transaction?.upsertEndlessConfig?.(record, true);
      return structuredClone(record);
    });
  },

  async evaluateEndlessSmartEngine(adminKey) {
    this.assertAdminKey(adminKey);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const store = state.endlessCompetition;
      const config = store.configVersions[store.activeConfigVersion].config;
      const samples = store.leaderboardEntries.map((entry) => ({
        verified: entry.verified,
        phaseCount: entry.deepestPhase,
        averagePhaseSeconds: entry.deepestPhase > 0 ? entry.survivalMs / 1_000 / entry.deepestPhase : 0
      }));
      const recommendation = endlessSmartEngineRecommendation(samples, config, timestamp);
      if (recommendation) store.smartEngine.recommendations.push(recommendation);
      store.smartEngine.recommendations = store.smartEngine.recommendations.slice(-500);
      store.smartEngine.lastEvaluatedAt = timestamp;
      return recommendation;
    });
  },

  async settleEndlessRewards(run) {
    assertApi(this.endlessRewardSettler, 503, 'endless_reward_settler_required', 'Endless reward settlement is not configured.');
    const receipt = await this.endlessRewardSettler.settle({
      runId: run.id,
      address: run.address,
      minerId: run.minerId,
      completedPhases: run.completedPhases,
      crystalsCarried: run.crystalsCarried,
      minedCrystalUnits: run.crystalsCarried,
      rollingDigest: run.rollingDigest,
      economyVersion: run.config.rewards.economyVersion,
      phaseXp: run.config.rewards.phaseXp,
      crystalConversionNumerator: run.config.rewards.crystalConversionNumerator,
      crystalConversionDenominator: run.config.rewards.crystalConversionDenominator,
      mineableCrystalUnits: run.config.rewards.mineableCrystalUnits,
      maximumPayoutNumerator: run.config.rewards.maximumPayoutNumerator,
      maximumPayoutDenominator: run.config.rewards.maximumPayoutDenominator,
      maximumDailyPayoutNumerator: run.config.rewards.maximumDailyPayoutNumerator,
      maximumDailyPayoutDenominator: run.config.rewards.maximumDailyPayoutDenominator,
      maximumPhases: run.config.rewards.maximumPhases,
      maximumRunXp: run.config.rewards.maximumRunXp,
      maximumWalletXpPerDay: run.config.rewards.maximumWalletXpPerDay,
      maximumMinerXpPerDay: run.config.rewards.maximumMinerXpPerDay,
      checkpointTimeoutSeconds: run.config.rewards.checkpointTimeoutSeconds,
      failedRunsRetainXp: run.config.rewards.failedRunsRetainXp,
      crystalsEnabled: run.config.rewards.crystalsEnabled,
      minerXpEnabled: run.config.rewards.minerXpEnabled,
      chainRun: structuredClone(run.chainRun),
      fromTransactionHash: latestEndlessCheckpointTransaction(run),
      outcome: 'extraction'
    });
    await this.database.transact(async (state, transaction) => {
      const stored = state.endlessCompetition.runs[run.id];
      if (!stored || stored.rewardSettlement?.settled === true) return;
      stored.rewardSettlement = { settled: true, ...structuredClone(receipt), settledAt: this.now() };
      stored.crystalsBanked = Math.max(0, Number(receipt.crystalsBanked || 0));
      stored.minerXpBanked = Math.max(0, Number(receipt.minerXpBanked || 0));
      if (TRANSACTION_HASH_PATTERN.test(String(receipt.transactionHash || '')) &&
          !stored.chainTransactions?.some((entry) => entry.hash === receipt.transactionHash)) {
        stored.chainTransactions ||= [];
        stored.chainTransactions.push({ type: 'settlement', hash: receipt.transactionHash, recordedAt: this.now() });
        stored.chainTransactions = stored.chainTransactions.slice(-50);
      }
      const leaderboard = state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === run.id);
      if (leaderboard) leaderboard.crystalsBanked = stored.crystalsBanked;
      state.runs[run.id] = stored;
      await transaction?.upsertEndlessRun?.(stored);
      if (leaderboard) await transaction?.upsertEndlessLeaderboard?.(leaderboard, stored);
    });
    return receipt;
  }
};

function assertEndlessRunOwner(run, address, runToken) {
  assertApi(run && run.address === address, 404, 'endless_run_missing', 'The Endless run was not found.');
  assertApi(safeHashEqual(run.tokenHash, endlessTokenHash(runToken)), 401, 'run_token_rejected', 'The Endless run token is invalid.');
}

function finalizeLeaderboardEntry(store, run) {
  if (store.leaderboardEntries.some((entry) => entry.runId === run.id)) return;
  store.leaderboardEntries.push({
    runId: run.id,
    address: run.address,
    minerId: run.minerId,
    minerLevel: Number(run.minerProfile?.progression?.level ?? run.minerProfile?.traits?.level ?? 0),
    minerCapability: Number(run.manifest?.capability?.rating || 0),
    maximumDifficulty: Number(run.maximumDifficulty || 0),
    deepestPhase: run.completedPhases,
    score: run.score,
    scoreBreakdown: structuredClone(run.scoreBreakdown || {}),
    enemyBreakdown: structuredClone(run.enemyBreakdown || {}),
    oreBreakdown: structuredClone(run.oreBreakdown || {}),
    crystalsMined: Number(run.crystalsMined || 0),
    crystalsBanked: run.crystalsBanked,
    minerXp: Number(run.minerXpBanked || 0),
    requiredKills: Number(run.requiredKills || 0),
    bossKills: Number(run.bossKills || 0),
    oreBroken: Number(run.oreBroken || 0),
    integrityScore: Number(run.integrityScore ?? 100),
    survivalMs: run.finishedAt - run.startedAt,
    finishedAt: run.finishedAt,
    configVersion: run.configVersion,
    digest: run.rollingDigest,
    verified: true
  });
  store.leaderboardEntries = store.leaderboardEntries.slice(-100_000);
}

function leaderboardRankMap(entries, board, timestamp) {
  return new Map(endlessLeaderboard(entries, 'all-time', timestamp, 30, board)
    .map((row) => [row.runId, row.rank]));
}

function publicEndlessLeaderboardIdentity(wallet) {
  return {
    name: String(wallet?.identity?.name || ''),
    avatarUrl: String(wallet?.identity?.avatarUrl || '')
  };
}

function publicEndlessHistoryRun(run, scoreRank, depthRank) {
  const finishedAt = Number(run.finishedAt || run.updatedAt || 0);
  const status = String(run.status || 'unknown');
  const verified = ['banked', 'knocked_out'].includes(status) && Number(run.completedPhases || 0) > 0;
  return {
    runId: run.id,
    finishedAt,
    minerId: Number(run.minerId || 0),
    minerLevel: Number(run.minerProfile?.progression?.level ?? run.minerProfile?.traits?.level ?? 0),
    minerCapability: Number(run.manifest?.capability?.rating || 0),
    highestPhase: Number(run.completedPhases || 0),
    maximumDifficulty: Number(run.maximumDifficulty || 0),
    score: Number(run.score || 0),
    scoreBreakdown: structuredClone(run.scoreBreakdown || {}),
    crystalsMined: Number(run.crystalsMined || 0),
    crystalsBanked: Number(run.crystalsBanked || 0),
    crystalsLost: Number(run.crystalsLost || 0),
    enemiesDefeated: Number(run.requiredKills || 0) + Number(run.bossKills || 0),
    enemyBreakdown: structuredClone(run.enemyBreakdown || {}),
    guardiansDefeated: Number(run.bossKills || 0),
    oreBroken: Number(run.oreBroken || 0),
    oreBreakdown: structuredClone(run.oreBreakdown || {}),
    minerXp: Number(run.minerXpBanked || 0),
    minerXpEarned: Number(run.minerXpEarned || 0),
    minerXpBanked: Number(run.minerXpBanked || 0),
    rewardPending: run.rewardSettlement?.pending === true && run.rewardSettlement?.settled !== true,
    rewardSettled: run.rewardSettlement?.settled === true,
    durationMs: Math.max(0, finishedAt - Number(run.startedAt || finishedAt)),
    scoreRank: Number(scoreRank || 0),
    depthRank: Number(depthRank || 0),
    status,
    result: run.finishReason || status,
    verified,
    verificationStatus: status === 'rejected' ? 'rejected' : verified ? 'verified' : 'not_ranked',
    integrityScore: Number(run.integrityScore ?? 100),
    configVersion: Number(run.configVersion || 0)
  };
}

function endlessLifetimeStats(history) {
  const totalRuns = history.length;
  const sum = (key) => history.reduce((total, run) => total + Number(run[key] || 0), 0);
  const maximum = (key) => history.reduce((best, run) => Math.max(best, Number(run[key] || 0)), 0);
  const totalDurationMs = sum('durationMs');
  return {
    totalRuns,
    verifiedRuns: history.filter((run) => run.verified).length,
    bankedRuns: history.filter((run) => run.status === 'banked').length,
    knockouts: history.filter((run) => run.status === 'knocked_out').length,
    abandonedRuns: history.filter((run) => run.status === 'abandoned').length,
    highestScore: maximum('score'),
    deepestPhase: maximum('highestPhase'),
    highestCapability: maximum('minerCapability'),
    crystalsMined: sum('crystalsMined'),
    crystalsBanked: sum('crystalsBanked'),
    enemiesDefeated: sum('enemiesDefeated'),
    guardiansDefeated: sum('guardiansDefeated'),
    oreBroken: sum('oreBroken'),
    minerXpEarned: sum('minerXpEarned'),
    minerXpBanked: sum('minerXpBanked'),
    totalDurationMs,
    longestRunMs: maximum('durationMs'),
    averageScore: totalRuns ? Math.round(sum('score') / totalRuns) : 0,
    averagePhase: totalRuns ? Math.round(sum('highestPhase') / totalRuns * 100) / 100 : 0,
    averageCrystalsBanked: totalRuns ? Math.round(sum('crystalsBanked') / totalRuns * 100) / 100 : 0
  };
}

function publicEndlessRun(run, runToken = '', inputCheckpoint = null) {
  return {
    runId: run.id,
    ...(runToken ? { runToken } : {}),
    ...(inputCheckpoint ? { inputCheckpoint: structuredClone(inputCheckpoint), inputVerification: 'fixed-step-phase-replay' } : {}),
    mode: 'endless',
    status: run.status,
    minerId: run.minerId,
    runSeed: run.runSeed,
    seed: run.runSeed,
    configVersion: run.configVersion,
    endlessSnapshot: { config: structuredClone(run.config) },
    currentPhase: run.currentPhase,
    completedPhases: run.completedPhases,
    score: run.score,
    crystalsCarried: run.crystalsCarried,
    phaseInitialState: run.phaseInitialState ? structuredClone(run.phaseInitialState) : null,
    manifest: structuredClone(run.manifest),
    checkpoint: publicEndlessCheckpoint(run),
    expiresAt: run.expiresAt,
    startedAt: run.startedAt,
    payment: publicEndlessPayment(run.payment),
    minerProfile: structuredClone(run.minerProfile),
    nftRun: { minerId: run.minerId, profile: structuredClone(run.minerProfile) }
  };
}

function previouslyAcceptedEndlessBank(run, checkpoint, action, secret) {
  if (String(action || '') !== 'bank' || run?.status !== 'banked' || run.finishReason !== 'banked') return false;
  const verification = Array.isArray(run.phaseHistory) ? run.phaseHistory.at(-1) : null;
  if (!verification || Number(run.checkpointSequence || 0) !== Number(checkpoint?.sequence || 0) + 1) return false;
  const previous = {
    ...run,
    checkpointSequence: Number(checkpoint.sequence),
    currentPhase: Number(verification.phase),
    rollingDigest: String(verification.previousCheckpoint || ''),
    status: 'active'
  };
  return validEndlessCheckpoint(previous, checkpoint, secret);
}

function recoveredEndlessBankResponse(run, operations = {}) {
  const verification = Array.isArray(run.phaseHistory) ? run.phaseHistory.at(-1) : null;
  const rewardsEnabled = run.config?.rewards?.enabled === true;
  const settled = run.rewardSettlement?.settled === true;
  return {
    checkpoint: publicEndlessCheckpoint(run),
    phase: publicEndlessPhaseVerification(verification),
    run: publicEndlessRun(run),
    nextManifest: null,
    nextInputCheckpoint: null,
    summary: {
      ...endlessBankSummary(run),
      leaderboardSubmitted: operations.leaderboardSubmissionsEnabled !== false
    },
    rewardSettlement: rewardsEnabled
      ? settled
        ? { pending: false, receipt: structuredClone(run.rewardSettlement) }
        : { pending: true, error: 'Verified rewards are queued for retry.' }
      : null,
    alreadyAccepted: true
  };
}

function publicEndlessPhaseVerification(verification) {
  return {
    phase: verification.phase,
    score: verification.score,
    maximumScore: verification.maximumScore,
    scoreBreakdown: structuredClone(verification.scoreBreakdown),
    requiredKills: verification.requiredKills,
    bossKills: verification.bossKills,
    oreBroken: verification.oreBroken,
    crystalsAdded: verification.crystalsAdded,
    crystalsUnableToCarry: verification.crystalsUnableToCarry,
    damageTaken: verification.damageTaken,
    elapsedMs: verification.elapsedMs,
    eventCount: verification.eventCount,
    verifiedAt: verification.verifiedAt,
    integrity: 'verified'
  };
}

function endlessBankSummary(run) {
  return {
    status: run.status,
    deepestPhase: run.completedPhases,
    totalScore: run.score,
    requiredEnemiesDefeated: run.requiredKills,
    guardiansDefeated: run.bossKills,
    oreBroken: run.oreBroken,
    crystalsCarried: run.crystalsCarried,
    crystalsBanked: run.crystalsBanked,
    minerXpBanked: run.minerXpBanked,
    survivalMs: Math.max(0, (run.finishedAt || run.updatedAt) - run.startedAt),
    digest: run.rollingDigest,
    integrityScore: Number(run.integrityScore ?? 100),
    integrityFlags: structuredClone(run.integrityFlags || [])
  };
}

function adminRunSummary(run) {
  return {
    runId: run.id,
    address: run.address,
    minerId: run.minerId,
    status: run.status,
    currentPhase: run.currentPhase,
    completedPhases: run.completedPhases,
    score: run.score,
    crystalsCarried: run.crystalsCarried,
    configVersion: run.configVersion,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    lastHeartbeatAt: run.lastHeartbeatAt,
    expiresAt: run.expiresAt,
    payment: publicEndlessPayment(run.payment),
    digest: run.rollingDigest,
    integrityScore: Number(run.integrityScore ?? 100),
    integrityFlags: structuredClone(run.integrityFlags || [])
  };
}

function publicEndlessPayment(payment) {
  if (!payment) return null;
  return {
    status: 'confirmed',
    asset: 'MATT',
    amountMatt: Number(payment.amountMatt || 0),
    transactionHash: String(payment.transactionHash || ''),
    blockNumber: String(payment.blockNumber || ''),
    confirmations: Number(payment.confirmations || 0),
    recipient: String(payment.recipient || '')
  };
}

function publicEndlessEntryRules(entry = {}) {
  return {
    entriesPerWallet: Number(entry.entriesPerWallet || 0),
    entriesPerMiner: Number(entry.entriesPerMiner || 0),
    resetPeriodHours: Number(entry.resetPeriodHours || 24),
    resetUtcHour: Number(entry.resetUtcHour || 0),
    cooldownSeconds: Number(entry.cooldownSeconds || 0),
    maximumActiveRunsPerWallet: Number(entry.maximumActiveRunsPerWallet || 1),
    maximumActiveRunsPerMiner: 1,
    minimumMinerLevel: Number(entry.minimumMinerLevel || 1),
    abandonedRunsConsumeEntry: entry.abandonedRunsConsumeEntry !== false
  };
}

function assertEndlessEntryEligible(state, address, minerId, minerProfile, config, timestamp) {
  assertApi(!state.operations.maintenanceMode, 503, 'maintenance_mode', state.operations.announcement || 'MATT Mine is temporarily under maintenance.');
  const wallet = state.wallets[address];
  assertApi(wallet && !wallet.suspended, 403, 'wallet_suspended', 'This wallet cannot enter ranked play.');
  const entry = config.entry;
  const minerLevel = Math.max(0, Number(minerProfile?.progression?.level ?? minerProfile?.traits?.level ?? 0));
  assertApi(minerLevel >= entry.minimumMinerLevel, 403, 'endless_miner_level_required', `Endless currently requires Miner level ${entry.minimumMinerLevel} or higher.`);

  const endlessRuns = Object.values(state.endlessCompetition.runs);
  const activeStatuses = new Set(['active', 'settlement_pending']);
  const walletActive = endlessRuns.filter((run) => run.address === address && activeStatuses.has(run.status));
  assertApi(walletActive.length < entry.maximumActiveRunsPerWallet, 409, 'endless_wallet_active_limit', `This wallet already has ${walletActive.length} active Endless run${walletActive.length === 1 ? '' : 's'}; the current limit is ${entry.maximumActiveRunsPerWallet}.`);
  const activeRanked = Object.values(state.runs).find((run) =>
    run.address === address && activeStatuses.has(run.status) && !['practice', 'beta', 'endless'].includes(run.mode)
  );
  assertApi(!activeRanked, 409, 'ranked_run_active', 'Finish or reconnect to the current ranked run before starting Endless.');
  const minerBusy = Object.values(state.runs).find((run) =>
    activeRunMinerId(run) === minerId && activeStatuses.has(run.status)
  );
  assertApi(!minerBusy, 409, 'nft_miner_in_run', `Miner #${minerId} is already active in a run. Each Miner can have only one active run.`);

  const window = endlessEntryWindow(timestamp, entry.resetPeriodHours, entry.resetUtcHour);
  const consumingRuns = endlessRuns.filter((run) => {
    if (run.address !== address || Number(run.startedAt || 0) < window.startedAt) return false;
    return run.status !== 'abandoned' || entry.abandonedRunsConsumeEntry;
  });
  const walletUsed = consumingRuns.length;
  const minerUsed = consumingRuns.filter((run) => Number(run.minerId) === minerId).length;
  if (entry.entriesPerWallet > 0) {
    assertApi(walletUsed < entry.entriesPerWallet, 429, 'endless_wallet_entry_limit', `This wallet used all ${entry.entriesPerWallet} Endless entries for the current reset period.`);
  }
  if (entry.entriesPerMiner > 0) {
    assertApi(minerUsed < entry.entriesPerMiner, 429, 'endless_miner_entry_limit', `Miner #${minerId} used all ${entry.entriesPerMiner} Endless entries for the current reset period.`);
  }
  const latestEntryAt = consumingRuns.reduce(
    (latest, run) => Math.max(latest, Number(run.startedAt || 0)),
    0
  );
  const cooldownEndsAt = latestEntryAt + entry.cooldownSeconds * 1_000;
  assertApi(entry.cooldownSeconds === 0 || cooldownEndsAt <= timestamp, 429, 'endless_entry_cooldown', `This wallet can enter Endless again after ${new Date(cooldownEndsAt).toISOString()}.`);

  return {
    resetStartedAt: window.startedAt,
    resetAt: window.endsAt,
    walletEntriesUsed: walletUsed,
    walletEntriesRemaining: entry.entriesPerWallet > 0 ? entry.entriesPerWallet - walletUsed : null,
    minerEntriesUsed: minerUsed,
    minerEntriesRemaining: entry.entriesPerMiner > 0 ? entry.entriesPerMiner - minerUsed : null,
    activeRunsForWallet: walletActive.length,
    activeRunsRemainingForWallet: entry.maximumActiveRunsPerWallet - walletActive.length,
    cooldownEndsAt: entry.cooldownSeconds > 0 && latestEntryAt > 0 ? cooldownEndsAt : 0,
    minerLevel
  };
}

function endlessEntryWindow(timestamp, periodHours, resetUtcHour) {
  const periodMs = Number(periodHours) * 60 * 60 * 1_000;
  const anchorMs = Number(resetUtcHour) * 60 * 60 * 1_000;
  const startedAt = Math.floor((timestamp - anchorMs) / periodMs) * periodMs + anchorMs;
  return { startedAt, endsAt: startedAt + periodMs };
}

function publicEndlessOperations(input = {}) {
  return {
    newEntriesEnabled: input.newEntriesEnabled !== false,
    bankingEnabled: input.bankingEnabled !== false,
    rewardsEnabled: input.rewardsEnabled !== false,
    leaderboardSubmissionsEnabled: input.leaderboardSubmissionsEnabled !== false,
    temporaryMaximumPhase: Number(input.temporaryMaximumPhase || 0),
    monitoringWindowHours: Number(input.monitoringWindowHours || 24),
    alertThresholds: structuredClone(input.alertThresholds || {}),
    updatedAt: Number(input.updatedAt || 0),
    updatedBy: String(input.updatedBy || 'SYSTEM_BOOTSTRAP'),
    reason: String(input.reason || '')
  };
}

function normalizeEndlessOperationsPatch(input) {
  assertApi(input && typeof input === 'object' && !Array.isArray(input), 400, 'endless_operations_patch_invalid', 'Endless operations changes must be an object.');
  const allowed = new Set([
    'newEntriesEnabled', 'bankingEnabled', 'rewardsEnabled',
    'leaderboardSubmissionsEnabled', 'temporaryMaximumPhase',
    'monitoringWindowHours', 'alertThresholds'
  ]);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  assertApi(unknown.length === 0, 422, 'endless_operations_field_unknown', `Unknown Endless operations field: ${unknown[0] || ''}.`);
  const patch = {};
  for (const key of ['newEntriesEnabled', 'bankingEnabled', 'rewardsEnabled', 'leaderboardSubmissionsEnabled']) {
    if (input[key] === undefined) continue;
    assertApi(typeof input[key] === 'boolean', 422, 'endless_operations_boolean_invalid', `${key} must be true or false.`);
    patch[key] = input[key];
  }
  if (input.temporaryMaximumPhase !== undefined) {
    patch.temporaryMaximumPhase = endlessAdminInteger(input.temporaryMaximumPhase, 0, 1_000_000, 'Temporary maximum phase');
  }
  if (input.monitoringWindowHours !== undefined) {
    patch.monitoringWindowHours = endlessAdminInteger(input.monitoringWindowHours, 1, 8_760, 'Monitoring window hours');
  }
  if (input.alertThresholds !== undefined) {
    assertApi(input.alertThresholds && typeof input.alertThresholds === 'object' && !Array.isArray(input.alertThresholds), 422, 'endless_alert_thresholds_invalid', 'Alert thresholds must be an object.');
    const bounds = {
      staleHeartbeatSeconds: [10, 86_400],
      unexpectedlyDeepPhase: [1, 1_000_000],
      maximumRunMinutes: [1, 525_600],
      maximumPendingSettlements: [0, 1_000_000],
      maximumFlaggedRuns: [0, 1_000_000],
      maximumDisconnectRateBps: [0, 10_000]
    };
    const thresholdUnknown = Object.keys(input.alertThresholds).filter((key) => !bounds[key]);
    assertApi(thresholdUnknown.length === 0, 422, 'endless_alert_threshold_unknown', `Unknown Endless alert threshold: ${thresholdUnknown[0] || ''}.`);
    patch.alertThresholds = Object.fromEntries(Object.entries(input.alertThresholds).map(([key, value]) => [
      key,
      endlessAdminInteger(value, bounds[key][0], bounds[key][1], key)
    ]));
  }
  assertApi(Object.keys(patch).length > 0, 400, 'endless_operations_patch_empty', 'Change at least one Endless operations setting.');
  return patch;
}

function endlessMonitoring(store, timestamp) {
  const operations = publicEndlessOperations(store.operations);
  const thresholds = operations.alertThresholds;
  const windowStart = timestamp - operations.monitoringWindowHours * 60 * 60 * 1_000;
  const runs = Object.values(store.runs || {});
  const windowRuns = runs.filter((run) => Number(run.startedAt || 0) >= windowStart || Number(run.updatedAt || 0) >= windowStart);
  const active = runs.filter((run) => run.status === 'active');
  const finished = windowRuns.filter((run) => run.status !== 'active');
  const staleRuns = active.filter((run) => timestamp - Number(run.lastHeartbeatAt || run.startedAt || timestamp) > thresholds.staleHeartbeatSeconds * 1_000);
  const flaggedRuns = windowRuns.filter((run) => Number(run.integrityScore ?? 100) < 100 || (run.integrityFlags || []).length > 0);
  const disconnectedRuns = windowRuns.filter((run) => Number(run.reconnectCount || 0) > 0 || run.status === 'expired');
  const pendingSettlements = runs.filter((run) => run.rewardSettlement?.pending === true && run.rewardSettlement?.settled !== true);
  const completedDurations = finished.map((run) => Math.max(0, Number(run.finishedAt || run.updatedAt || 0) - Number(run.startedAt || 0))).filter(Boolean);
  const averageRunMinutes = completedDurations.length
    ? completedDurations.reduce((total, value) => total + value, 0) / completedDurations.length / 60_000
    : 0;
  const deepestPhase = windowRuns.reduce((maximum, run) => Math.max(maximum, Number(run.completedPhases || 0)), 0);
  const disconnectRateBps = windowRuns.length ? Math.round(disconnectedRuns.length * 10_000 / windowRuns.length) : 0;
  const dayStart = Math.floor(timestamp / 86_400_000) * 86_400_000;
  const weekStart = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * 86_400_000;
  const monthStart = Date.UTC(new Date(timestamp).getUTCFullYear(), new Date(timestamp).getUTCMonth(), 1);
  const payments = Object.values(store.paymentTransactions || {});
  const collected = (from) => payments.filter((payment) => Number(payment.consumedAt || 0) >= from)
    .reduce((total, payment) => total + Number(payment.amountMatt || 0), 0);
  const uniquePayers = new Set(payments.filter((payment) => Number(payment.consumedAt || 0) >= windowStart).map((payment) => payment.payer)).size;
  const crystalsToday = runs.filter((run) => Number(run.finishedAt || 0) >= dayStart)
    .reduce((total, run) => total + Number(run.crystalsBanked || 0), 0);
  const xpInWindow = windowRuns.reduce((total, run) => total + Number(run.minerXpBanked || 0), 0);
  const alerts = [];
  if (staleRuns.length) alerts.push(endlessAlert('stale_heartbeat', 'critical', `${staleRuns.length} active run(s) exceeded the heartbeat threshold.`, staleRuns.length, 0));
  if (deepestPhase >= thresholds.unexpectedlyDeepPhase) alerts.push(endlessAlert('unexpected_depth', 'warning', `A run reached phase ${deepestPhase} inside the monitoring window.`, deepestPhase, thresholds.unexpectedlyDeepPhase));
  if (averageRunMinutes > thresholds.maximumRunMinutes) alerts.push(endlessAlert('run_duration', 'warning', 'Average completed run duration is above target.', averageRunMinutes, thresholds.maximumRunMinutes));
  if (pendingSettlements.length > thresholds.maximumPendingSettlements) alerts.push(endlessAlert('pending_settlements', 'critical', 'Pending reward settlements exceeded the configured threshold.', pendingSettlements.length, thresholds.maximumPendingSettlements));
  if (flaggedRuns.length > thresholds.maximumFlaggedRuns) alerts.push(endlessAlert('integrity_flags', 'critical', 'Flagged runs exceeded the configured threshold.', flaggedRuns.length, thresholds.maximumFlaggedRuns));
  if (disconnectRateBps > thresholds.maximumDisconnectRateBps) alerts.push(endlessAlert('disconnect_rate', 'warning', 'Disconnect rate exceeded the configured threshold.', disconnectRateBps, thresholds.maximumDisconnectRateBps));
  const activeConfig = store.configVersions?.[store.activeConfigVersion]?.config;
  const dailyCeiling = Number(activeConfig?.rewards?.maximumDailyPayoutNumerator || 0) / Math.max(1, Number(activeConfig?.rewards?.maximumDailyPayoutDenominator || 1));
  if (dailyCeiling > 0 && crystalsToday > dailyCeiling) alerts.push(endlessAlert('crystals_daily_ceiling', 'critical', 'Daily CRYSTALS settlement exceeded the active hard ceiling.', crystalsToday, dailyCeiling));
  return {
    windowHours: operations.monitoringWindowHours,
    generatedAt: timestamp,
    counts: {
      activeRuns: active.length,
      completedRuns: finished.length,
      uniqueWallets: new Set(windowRuns.map((run) => run.address)).size,
      uniqueMiners: new Set(windowRuns.map((run) => Number(run.minerId))).size,
      staleRuns: staleRuns.length,
      flaggedRuns: flaggedRuns.length,
      pendingSettlements: pendingSettlements.length
    },
    performance: { deepestPhase, averageRunMinutes, disconnectRateBps, crystalsToday, xpInWindow },
    entries: {
      freeRuns: windowRuns.filter((run) => !run.payment).length,
      paidRuns: windowRuns.filter((run) => run.payment).length,
      mattCollectedToday: collected(dayStart),
      mattCollectedWeek: collected(weekStart),
      mattCollectedMonth: collected(monthStart),
      uniquePayingWallets: uniquePayers
    },
    alerts
  };
}

function endlessAlert(code, severity, message, observed, threshold) {
  return { code, severity, message, observed: Number(observed), threshold: Number(threshold) };
}

function adminRunReview(run, details) {
  const phases = Array.isArray(details.phases) ? details.phases : [];
  const scoreBreakdown = {};
  for (const phase of phases) {
    for (const [key, value] of Object.entries(phase.scoreBreakdown || {})) {
      scoreBreakdown[key] = Number(scoreBreakdown[key] || 0) + Number(value || 0);
    }
  }
  const profile = run.minerProfile || {};
  return {
    runId: run.id,
    wallet: run.address,
    minerId: Number(run.minerId),
    minerLevel: Number(profile.progression?.level ?? profile.traits?.level ?? 0),
    minerCapability: structuredClone(run.manifest?.minerCapability || profile.gameplay || {}),
    equipment: structuredClone(profile.equipped || {}),
    attachedItems: structuredClone(profile.attached || profile.attachments || {}),
    status: run.status,
    finishReason: run.finishReason || '',
    startTime: Number(run.startedAt || 0),
    endTime: Number(run.finishedAt || 0),
    durationMs: Math.max(0, Number(run.finishedAt || run.updatedAt || 0) - Number(run.startedAt || 0)),
    highestPhase: Number(run.completedPhases || 0),
    currentPhase: Number(run.currentPhase || 0),
    score: Number(run.score || 0),
    scoreBreakdown,
    oreBreakdown: { broken: Number(run.oreBroken || 0) },
    enemyBreakdown: { requiredDefeated: Number(run.requiredKills || 0), guardiansDefeated: Number(run.bossKills || 0) },
    crystalsBreakdown: { carried: Number(run.crystalsCarried || 0), banked: Number(run.crystalsBanked || 0) },
    maximumCarry: endlessMinerCarryCapacity(profile),
    minerXpBanked: Number(run.minerXpBanked || 0),
    phaseHistory: structuredClone(phases),
    verification: { digest: run.rollingDigest || '', checkpointSequence: Number(run.checkpointSequence || 0), status: details.leaderboardEntry?.verified ? 'verified' : run.status },
    integrityScore: Number(run.integrityScore ?? 100),
    integrityFlags: structuredClone(details.integrityEvents || []),
    disconnectHistory: { reconnects: Number(run.reconnectCount || 0), currentPhaseReconnects: Number(run.phaseReconnectCount || 0) },
    payment: publicEndlessPayment(details.payment),
    rewardStatus: structuredClone(run.rewardSettlement || null),
    leaderboardStatus: details.leaderboardEntry ? 'submitted' : 'not_submitted',
    settlementTransactions: structuredClone(details.settlementTransactions || []),
    configVersion: Number(run.configVersion || 0),
    config: structuredClone(run.config || {}),
    manifest: structuredClone(run.manifest || {}),
    adminReview: structuredClone(run.adminReview || null)
  };
}

function changedConfigPaths(previous, current, prefix = '') {
  if (!previous) return flattenConfigPaths(current, prefix);
  const keys = new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
  const changed = [];
  for (const key of keys) {
    const path = prefix ? `${prefix}.${key}` : key;
    const left = previous?.[key];
    const right = current?.[key];
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
      changed.push(...changedConfigPaths(left, right, path));
    } else if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(path);
  }
  return changed;
}

function flattenConfigPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return prefix ? [prefix] : [];
  return Object.entries(value).flatMap(([key, child]) => flattenConfigPaths(child, prefix ? `${prefix}.${key}` : key));
}

function endlessAdminReason(value) {
  const reason = String(value || '').trim().slice(0, 500);
  assertApi(reason.length >= 8, 422, 'admin_reason_required', 'Provide a meaningful reason for this Endless Admin action.');
  return reason;
}

function endlessAdminInteger(value, minimum, maximum, label) {
  const number = Number(value);
  assertApi(Number.isSafeInteger(number) && number >= minimum && number <= maximum, 422, 'endless_operations_value_invalid', `${label} must be a whole number from ${minimum} to ${maximum}.`);
  return number;
}

function cleanRunId(value) {
  const id = String(value || '');
  assertApi(/^run_[a-f0-9]{24}$/.test(id), 400, 'invalid_run_id', 'The Endless run identifier is invalid.');
  return id;
}

function cleanRunToken(value) {
  const token = String(value || '');
  assertApi(/^[a-f0-9]{48}$/.test(token), 400, 'invalid_run_token', 'The Endless run token is invalid.');
  return token;
}

function endlessTokenHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function safeHashEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function activeRunMinerId(run) {
  return Number(
    run?.minerId ||
    run?.nftRun?.minerId ||
    run?.pendingNftRun?.minerId ||
    run?.tuning?._nftRun?.minerId ||
    0
  );
}

function recordHeartbeatIntegrity(run, timestamp) {
  const intervalMs = run.config.integrity.heartbeatSeconds * 1_000;
  const missed = Math.max(0, Math.floor((timestamp - Number(run.lastHeartbeatAt || timestamp)) / intervalMs) - 1);
  if (missed <= run.config.integrity.missedHeartbeatTolerance) return;
  const flag = {
    code: 'missed_heartbeats',
    phase: run.currentPhase,
    observed: missed,
    tolerance: run.config.integrity.missedHeartbeatTolerance,
    timestamp
  };
  run.integrityFlags ||= [];
  run.integrityFlags.push(flag);
  run.integrityFlags = run.integrityFlags.slice(-50);
  run.integrityScore = Math.max(0, Number(run.integrityScore ?? 100) - Math.min(25, missed));
}

async function markEndlessSettlementPending(service, runId, error) {
  await service.database.transact(async (state, transaction) => {
    const run = state.endlessCompetition.runs[runId];
    if (!run || run.rewardSettlement?.settled === true) return;
    run.rewardSettlement = {
      pending: true,
      attempts: Number(run.rewardSettlement?.attempts || 0) + 1,
      lastAttemptAt: service.now(),
      lastError: String(error?.code || 'settlement_temporarily_unavailable').slice(0, 120)
    };
    state.runs[runId] = run;
    await transaction?.upsertEndlessRun?.(run);
  });
}
