import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, assertApi } from './errors.js';
import {
  applyEndlessPhaseCheckpoint,
  createEndlessRunRecord,
  endlessLeaderboard,
  endlessSmartEngineRecommendation,
  publicEndlessCheckpoint,
  signEndlessCheckpoint,
  validEndlessCheckpoint,
  verifyEndlessPhaseEvents
} from './endless-engine.js';
import { normalizeEndlessConfig, validateEndlessConfig } from '../src/game/endlessMine.js';

export const endlessServiceMethods = {
  async endlessStatus() {
    const state = await this.database.read();
    const store = state.endlessCompetition;
    const version = store.activeConfigVersion;
    const published = store.configVersions[version];
    const activation = validateEndlessConfig(published.config, { forActivation: published.config.rewards.enabled });
    return {
      mode: 'endless',
      permanent: true,
      tagline: 'Different map. Different experience. Same opportunity.',
      enabled: published.config.enabled === true,
      nftRequired: true,
      paidEntryEnabled: published.config.entry.paidEnabled === true,
      entryPriceMatt: published.config.entry.mattPrice,
      rewardsEnabled: published.config.rewards.enabled === true && activation.ok && Boolean(this.endlessRewardSettler),
      rewardReadiness: activation.ok ? (this.endlessRewardSettler ? 'ready' : 'settler-required') : 'configuration-required',
      rewardErrors: activation.errors,
      configVersion: version,
      generatorVersion: published.config.generatorVersion,
      leaderboardScopes: ['daily', 'weekly', 'season', 'all-time']
    };
  },

  async startEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_required', 'Endless requires live Miner NFT ownership verification.');
    const minerId = Number(input.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000_000, 422, 'miner_selection_required', 'Select one of this wallet’s Miner NFTs before entering Endless.');
    const minerProfile = await this.nftGameplayService.playerMiner(session.address, minerId);
    assertApi(minerProfile, 403, 'miner_nft_required', 'Endless requires a Miner NFT owned by this wallet.');
    const timestamp = this.now();
    const runId = `run_${this.randomHex(12)}`;
    const runToken = this.randomHex(24);
    const runSeed = `MATT-ENDLESS-${this.randomHex(24)}`;
    const created = await this.database.transact(async (state, transaction) => {
      assertApi(!state.operations.maintenanceMode, 503, 'maintenance_mode', state.operations.announcement || 'MATT Mine is temporarily under maintenance.');
      const wallet = state.wallets[session.address];
      assertApi(wallet && !wallet.suspended, 403, 'wallet_suspended', 'This wallet cannot enter ranked play.');
      const store = state.endlessCompetition;
      const version = store.activeConfigVersion;
      const published = store.configVersions[version];
      assertApi(published?.config?.enabled === true, 503, 'endless_mode_disabled', 'Endless is temporarily paused.');
      const config = normalizeEndlessConfig(published.config);
      const activation = validateEndlessConfig(config, { forActivation: config.rewards.enabled });
      assertApi(activation.ok, 503, 'endless_economy_not_ready', activation.errors.join(' '));
      if (config.rewards.enabled) {
        assertApi(this.endlessRewardSettler, 503, 'endless_reward_settler_required', 'Endless rewards remain closed until checkpoint settlement is available.');
      }
      if (config.entry.paidEnabled) {
        assertApi(this.endlessPaymentVerifier, 503, 'endless_payment_verifier_required', 'Paid Endless entry remains closed until transaction verification is available.');
        throw new ApiError(409, 'endless_payment_confirmation_required', 'Confirm the one-time Endless entry transaction before starting.');
      }
      const active = Object.values(store.runs).find((run) =>
        run.address === session.address && run.status === 'active'
      );
      assertApi(!active, 409, 'endless_run_active', 'Reconnect to or finish the current Endless run first.');
      const activeRanked = Object.values(state.runs).find((run) =>
        run.address === session.address && run.status === 'active' && !['practice', 'beta'].includes(run.mode)
      );
      assertApi(!activeRanked, 409, 'ranked_run_active', 'Finish or reconnect to the current ranked run before starting Endless.');
      const minerBusy = Object.values(state.runs).find((run) =>
        activeRunMinerId(run) === minerId && ['active', 'settlement_pending'].includes(run.status)
      );
      assertApi(!minerBusy, 409, 'nft_miner_in_run', `Miner #${minerId} is already active in Endless.`);
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
        expiresAt: timestamp + config.integrity.reconnectWindowSeconds * 1_000
      });
      record.checkpointSignature = signEndlessCheckpoint(record, this.endlessCheckpointSecret);
      store.runs[runId] = record;
      state.runs[runId] = record;
      await transaction?.upsertRun(record);
      return structuredClone(record);
    });
    return publicEndlessRun(created, runToken);
  },

  async checkpointEndlessPhase(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    const result = await this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(run, session.address, runToken);
      assertApi(run.expiresAt > timestamp, 410, 'endless_run_expired', 'The reconnect window for this Endless run expired.');
      assertApi(validEndlessCheckpoint(run, input.previousCheckpoint, this.endlessCheckpointSecret), 401, 'endless_checkpoint_invalid', 'Use the latest server-signed Endless checkpoint.');
      recordHeartbeatIntegrity(run, timestamp);
      const verification = verifyEndlessPhaseEvents(run, input.events, timestamp);
      const nextManifest = applyEndlessPhaseCheckpoint(run, verification, String(input.action || ''), timestamp);
      run.checkpointSignature = signEndlessCheckpoint(run, this.endlessCheckpointSecret);
      state.runs[runId] = run;
      await transaction?.upsertRun(run);
      if (run.status === 'banked') {
        finalizeLeaderboardEntry(state.endlessCompetition, run);
      }
      return {
        run: structuredClone(run),
        verification,
        nextManifest: nextManifest ? structuredClone(nextManifest) : null
      };
    });
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
      phase: result.verification,
      run: publicEndlessRun(result.run),
      nextManifest: result.nextManifest,
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
      await transaction?.upsertRun(run);
      return { acknowledgedAt: timestamp, expiresAt: run.expiresAt, checkpoint: publicEndlessCheckpoint(run) };
    });
  },

  async reconnectEndlessRun(token, input = {}) {
    const session = await this.authenticate(token);
    const runId = cleanRunId(input.runId);
    const runToken = cleanRunToken(input.runToken);
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      const run = state.endlessCompetition.runs[runId];
      assertEndlessRunOwner(run, session.address, runToken);
      assertApi(run.status === 'active' && run.expiresAt > timestamp, 410, 'endless_reconnect_expired', 'This Endless run can no longer be reconnected.');
      const integrity = run.config.integrity;
      assertApi(Number(run.reconnectCount || 0) < integrity.maximumReconnectsPerRun, 429, 'endless_reconnect_limit', 'This run reached its reconnect limit.');
      assertApi(Number(run.phaseReconnectCount || 0) < integrity.maximumReconnectsPerPhase, 429, 'endless_phase_reconnect_limit', 'This phase reached its reconnect limit.');
      run.reconnectCount = Number(run.reconnectCount || 0) + 1;
      run.phaseReconnectCount = Number(run.phaseReconnectCount || 0) + 1;
      run.lastHeartbeatAt = timestamp;
      run.updatedAt = timestamp;
      run.expiresAt = timestamp + integrity.reconnectWindowSeconds * 1_000;
      state.runs[runId] = run;
      await transaction?.upsertRun(run);
      return publicEndlessRun(run, runToken);
    });
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
      current.status = knockout ? 'knocked_out' : 'abandoned';
      current.finishReason = knockout ? 'knockout' : 'abandoned';
      current.finishedAt = timestamp;
      current.updatedAt = timestamp;
      current.checkpointSignature = signEndlessCheckpoint(current, this.endlessCheckpointSecret);
      state.runs[runId] = current;
      await transaction?.upsertRun(current);
      if (knockout && current.completedPhases > 0) finalizeLeaderboardEntry(state.endlessCompetition, current);
      return structuredClone(current);
    });
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
    return this.database.transact((state) => {
      const store = state.endlessCompetition;
      const version = Math.max(0, ...Object.keys(store.configVersions).map(Number)) + 1;
      const record = { version, config, publishedAt: timestamp, publishedBy: 'SERVER_ADMIN', reason };
      store.configVersions[version] = record;
      store.activeConfigVersion = version;
      state.audit.push({ action: 'ENDLESS_CONFIG_PUBLISHED', details: `v${version}; ${reason}`, timestamp, address: 'SERVER_ADMIN' });
      state.audit = state.audit.slice(-2_000);
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
      rollingDigest: run.rollingDigest,
      economyVersion: run.config.rewards.economyVersion,
      phaseXp: run.config.rewards.phaseXp,
      crystalConversionNumerator: run.config.rewards.crystalConversionNumerator,
      crystalConversionDenominator: run.config.rewards.crystalConversionDenominator
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
      await transaction?.upsertRun(stored);
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

function publicEndlessRun(run, runToken = '') {
  return {
    runId: run.id,
    ...(runToken ? { runToken } : {}),
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
    manifest: structuredClone(run.manifest),
    checkpoint: publicEndlessCheckpoint(run),
    expiresAt: run.expiresAt,
    startedAt: run.startedAt,
    minerProfile: structuredClone(run.minerProfile),
    nftRun: { minerId: run.minerId, profile: structuredClone(run.minerProfile) }
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
    digest: run.rollingDigest,
    integrityScore: Number(run.integrityScore ?? 100),
    integrityFlags: structuredClone(run.integrityFlags || [])
  };
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
  run.integrityFlags = run.integrityFlags.slice(-500);
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
    await transaction?.upsertRun(run);
  });
}
