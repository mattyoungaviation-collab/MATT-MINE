import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, assertApi } from './errors.js';
import {
  applyEndlessPhaseCheckpoint,
  createEndlessRunRecord,
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
    return {
      mode: 'endless',
      permanent: true,
      tagline: 'Different map. Different experience. Same opportunity.',
      enabled: published.config.enabled === true,
      nftRequired: true,
      paidEntryEnabled,
      entryPriceMatt: published.config.entry.mattPrice,
      entryRules: publicEndlessEntryRules(published.config.entry),
      paymentReady,
      payment: paidEntryEnabled ? payment : null,
      entryTransaction: paidEntryEnabled && paymentReady
        ? this.endlessPaymentVerifier.transactionForPayment(published.config.entry.mattPrice)
        : null,
      rewardsEnabled: published.config.rewards.enabled === true && activation.ok && Boolean(this.endlessRewardSettler),
      runApprovalRequired: published.config.rewards.enabled === true && activation.ok && Boolean(this.endlessRewardSettler),
      rewardReadiness: activation.ok ? (this.endlessRewardSettler ? 'ready' : 'settler-required') : 'configuration-required',
      rewardErrors: activation.errors,
      inputReplayReady: Boolean(this.competitiveReplayValidator?.registerEndlessPhase && this.competitiveReplayValidator?.verifyEndlessPhase),
      configVersion: version,
      generatorVersion: published.config.generatorVersion,
      leaderboardScopes: ['daily', 'weekly', 'season', 'all-time']
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
      assertApi(run.expiresAt > timestamp, 410, 'endless_run_expired', 'The reconnect window for this Endless run expired.');
      assertApi(validEndlessCheckpoint(run, input.previousCheckpoint, this.endlessCheckpointSecret), 401, 'endless_checkpoint_invalid', 'Use the latest server-signed Endless checkpoint.');
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
      if (run.status === 'banked') {
        finalizeLeaderboardEntry(state.endlessCompetition, run);
      }
      await transaction?.upsertEndlessRun?.(run);
      await transaction?.insertEndlessCheckpoint?.(run, verification);
      if (run.status === 'banked') {
        const leaderboard = state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === run.id);
        await transaction?.upsertEndlessLeaderboard?.(leaderboard, run);
      }
      return {
        run: structuredClone(run),
        verification,
        nextManifest: nextManifest ? structuredClone(nextManifest) : null
      };
    });
    await this.competitiveReplayValidator.finalizeEndlessPhase(replayIdentity, 'verified').catch(() => undefined);
    let rewardSettlement = null;
    if (result.run.status === 'banked' && result.run.config.rewards.enabled) {
      try {
        rewardSettlement = { pending: false, receipt: await this.settleEndlessRewards(result.run) };
      } catch (error) {
        await markEndlessSettlementPending(this, result.run.id, error);
        rewardSettlement = { pending: true, error: 'Verified rewards are queued for retry.' };
      }
    }
    return {
      checkpoint: publicEndlessCheckpoint(result.run),
      phase: publicEndlessPhaseVerification(result.verification),
      run: publicEndlessRun(result.run),
      nextManifest: result.nextManifest,
      nextInputCheckpoint,
      summary: result.run.status === 'banked' ? endlessBankSummary(result.run) : null,
      rewardSettlement
    };
  },

  async retryEndlessSettlement(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const state = await this.database.read();
    const run = state.endlessCompetition.runs[runId];
    assertEndlessRunOwner(run, session.address, runToken);
    assertApi(run.status === 'banked' && run.config.rewards.enabled, 409, 'endless_settlement_unavailable', 'This run has no pending Endless reward settlement.');
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
      if (knockout && current.completedPhases > 0) finalizeLeaderboardEntry(state.endlessCompetition, current);
      await transaction?.upsertEndlessRun?.(current);
      if (knockout && current.completedPhases > 0) {
        const leaderboard = state.endlessCompetition.leaderboardEntries.find((entry) => entry.runId === current.id);
        await transaction?.upsertEndlessLeaderboard?.(leaderboard, current);
      }
      return structuredClone(current);
    });
    await this.competitiveReplayValidator?.finalizeEndlessPhase?.(run, 'abandoned').catch(() => undefined);
    return { run: publicEndlessRun(run), summary: endlessBankSummary(run) };
  },

  async endlessLeaderboard(token, scope = 'all-time') {
    await this.authenticate(token);
    const state = await this.database.read();
    const config = state.endlessCompetition.configVersions[state.endlessCompetition.activeConfigVersion].config;
    return {
      mode: 'endless',
      scope,
      rows: endlessLeaderboard(state.endlessCompetition.leaderboardEntries, scope, this.now(), config.leaderboards.seasonDays)
    };
  },

  async adminEndless(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const activeRuns = Object.values(store.runs).filter((run) => run.status === 'active');
    const activeConfig = store.configVersions[store.activeConfigVersion];
    return {
      status: await this.endlessStatus(),
      activeConfig: structuredClone(activeConfig),
      configHistory: Object.values(store.configVersions).sort((a, b) => b.version - a.version).map((value) => structuredClone(value)),
      activeRuns: activeRuns.map((run) => adminRunSummary(run)),
      recentRuns: Object.values(store.runs).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100).map((run) => adminRunSummary(run)),
      smartEngine: structuredClone(store.smartEngine)
    };
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
      const record = { version, config, publishedAt: timestamp, publishedBy: 'SERVER_ADMIN', reason };
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
      outcome: 'extraction'
    });
    await this.database.transact(async (state, transaction) => {
      const stored = state.endlessCompetition.runs[run.id];
      if (!stored || stored.rewardSettlement?.settled === true) return;
      stored.rewardSettlement = { settled: true, ...structuredClone(receipt), settledAt: this.now() };
      stored.crystalsBanked = Math.max(0, Number(receipt.crystalsBanked || 0));
      stored.minerXpBanked = Math.max(0, Number(receipt.minerXpBanked || 0));
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
    deepestPhase: run.completedPhases,
    score: run.score,
    crystalsBanked: run.crystalsBanked,
    survivalMs: run.finishedAt - run.startedAt,
    finishedAt: run.finishedAt,
    configVersion: run.configVersion,
    digest: run.rollingDigest,
    verified: true
  });
  store.leaderboardEntries = store.leaderboardEntries.slice(-100_000);
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
