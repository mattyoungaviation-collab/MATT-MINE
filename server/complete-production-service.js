import { createHash } from 'node:crypto';
import { ProductionMattMineService } from './production-service.js';
import { ApiError, assertApi } from './errors.js';
import { validateRunResult } from './service.js';
import {
  CHARACTER_IDS,
  EXPANSION_SCHEMA,
  defaultExpansionConfig,
  normalizeControllerProfile,
  normalizeExpansionPatch,
  weeklyStageSeed
} from '../src/game/expansionConfig.js';
import { PASS_CHEST_ID, PASS_COSMETICS } from '../src/game/passRewards.js';
import { passLevel, utcWeekKey } from '../src/game/economy.js';
import { endlessLeaderboard, weeklyLeaderboard } from './competition-engine.js';
import {
  confirmRevive,
  createPendingRevive
} from './bonus-engine.js';
import { DisabledRevivePaymentVerifier } from './external-verifiers.js';
import {
  applyExpansionLinksToTuning,
  linkedAdminControlSnapshot,
  reconcileLinkedAdminControls
} from './admin-control-links.js';
import { buildAdminReadiness } from './admin-readiness.js';
import { SERVER_RUN_MODES } from './constants.js';
import { resolveCompetitionSnapshot } from '../src/game/competitionStudio.js';
import {
  PRACTICE_PLAY_POLICY,
  isRetiredRunMode,
  requiresMinerNft
} from './nft-play-policy.js';

const BETA_CAPABILITIES = Object.freeze([
  'jumpDepth', 'jumpRoom', 'triggerBoss', 'spawnBoss', 'setBossPhase',
  'setLevel', 'setHealth', 'setMaximumHealth', 'invulnerability', 'weaponUnlocks',
  'weaponDamage', 'armor', 'movementSpeed', 'dashCooldown', 'talents',
  'restoreHealth', 'refillBlaster', 'resetEnemies', 'clearEnemies', 'spawnEnemy',
  'enemyAI', 'bossAI', 'damageNumbers', 'hitboxes', 'cooldownDebug',
  'seedDisplay', 'exportConfiguration', 'importConfiguration'
]);

const RETIRED_EXPANSION_SETTING_IDS = new Set([
  'deathRetentionFree',
  'advertisementFreeEligible',
  'advertisementPracticeEligible',
  'weeklyCompetitionEnabled',
  'weeklyActiveDayCount',
  'weeklyLockedCharacter',
  'weeklyAttemptLimit',
  'endlessEnabled',
  'endlessHealthGrowth',
  'endlessDamageGrowth',
  'endlessSpeedGrowth',
  'endlessBossFrequency',
  'endlessBossCount',
  'endlessRoomCount',
  'endlessMultiplierGrowth',
  'endlessMaximumScale',
  'endlessSeasonDays',
  ...Array.from({ length: 7 }, (_, index) => {
    const day = index + 1;
    return [
      `weeklyDay${day}Difficulty`,
      `weeklyDay${day}BossCount`,
      `weeklyDay${day}RoomCount`
    ];
  }).flat()
]);

const ACTIVE_EXPANSION_SCHEMA = Object.freeze(
  EXPANSION_SCHEMA.filter((entry) => !RETIRED_EXPANSION_SETTING_IDS.has(entry.id))
);

export class CompleteProductionMattMineService extends ProductionMattMineService {
  constructor(database, options = {}) {
    super(database, options);
    this.revivePaymentVerifier = options.revivePaymentVerifier || new DisabledRevivePaymentVerifier();
    this.reviveEligibilityValidator = options.reviveEligibilityValidator || null;
    this.competitiveReplayValidator = options.competitiveReplayValidator || null;
    this.nftV2AdminService = options.nftV2AdminService || null;
    this.adminControlLinkPromise = null;
  }

  async ensureAdminControlLinks() {
    if (this.adminControlLinkPromise) return this.adminControlLinkPromise;
    this.adminControlLinkPromise = (async () => {
      const timestamp = this.now();
      const reconciled = await this.database.transact((state) => {
        const result = reconcileLinkedAdminControls(state, null, timestamp);
        if (result.mainChanges.length) {
          appendAudit(state, 'ADMIN_CONTROLS_RECONCILED', result.mainChanges.join('; '), timestamp);
        }
        return {
          ...result,
          expansionConfig: structuredClone(state.expansionConfig)
        };
      });
      return reconciled;
    })().catch((error) => {
      this.adminControlLinkPromise = null;
      throw error;
    });
    return this.adminControlLinkPromise;
  }

  async adminOverview(adminKey) {
    this.assertAdminKey(adminKey);
    await this.ensureAdminControlLinks();
    const overview = await super.adminOverview(adminKey);
    const [state, database] = await Promise.all([
      this.database.read(),
      this.database.healthCheck().catch(() => ({ ok: false, kind: this.database.kind || 'unknown' }))
    ]);
    const controlLinks = linkedAdminControlSnapshot(state);
    const replay = this.competitiveReplayValidator?.publicStatus?.() || { configured: false, enabled: false };
    const reviveStatus = this.revivePaymentVerifier?.publicStatus?.() || { configured: false, enabled: false };
    const arena = this.arenaService?.publicConfig?.() || { configured: false, enabled: false };
    const liveSafe = this.arenaService?.deployment || null;
    const treasurySafe = {
      address: liveSafe?.treasurySafe || overview.immutable?.contracts?.safe || '',
      owners: Array.isArray(liveSafe?.safeOwners) ? liveSafe.safeOwners.length : 0,
      threshold: Number(liveSafe?.safeThreshold || 0),
      verified: Array.isArray(liveSafe?.safeOwners) && liveSafe.safeOwners.length === 3 && Number(liveSafe.safeThreshold) === 2
    };
    return {
      ...overview,
      controlLinks,
      readiness: buildAdminReadiness({
        checkedAt: this.now(),
        database,
        payments: overview.payments,
        rewards: overview.rewards,
        arena,
        replay,
        revive: {
          ...reviveStatus,
          eligibilityReady: Boolean(this.reviveEligibilityValidator)
        },
        treasurySafe,
        controlLinks
      })
    };
  }

  async adminGameTuning(adminKey) {
    await this.ensureAdminControlLinks();
    return super.adminGameTuning(adminKey);
  }

  async prepareNftRunAuthorization(token, input = {}) {
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_required', 'NFT V2 gameplay is not enabled.');
    const session = await this.authenticate(token);
    const mode = String(input.mode || '').toLowerCase();
    assertApi(requiresMinerNft(mode) || mode === 'arena', 422, 'nft_map_mode_invalid', 'Choose MATT Arena or Pass Mine.');
    const minerId = selectedMinerId(input.minerId);
    assertApi(minerId > 0, 422, 'miner_selection_required', 'Select a MATT Mine Miner NFT first.');
    return this.nftGameplayService.prepareRunAuthorization({ address: session.address, minerId, mode });
  }

  async adminNftV2Protocol(adminKey) {
    this.assertAdminKey(adminKey);
    assertApi(this.nftV2AdminService, 503, 'nft_v2_admin_disabled', 'NFT V2 on-chain Admin controls are disabled.');
    const state = await this.database.read();
    return {
      status: this.nftV2AdminService.publicStatus(),
      protocol: await this.nftV2AdminService.snapshot(),
      mapDefaults: nftV2MapDefaults(state.competitionStudio, this.now())
    };
  }

  async updateAdminNftV2Economy(adminKey, input) {
    this.assertAdminKey(adminKey);
    assertApi(this.nftV2AdminService, 503, 'nft_v2_admin_disabled', 'NFT V2 on-chain Admin controls are disabled.');
    const reason = adminReason(input?.reason);
    const result = await this.nftV2AdminService.setEconomy(input);
    await this.database.transact((state) => appendAudit(
      state,
      'NFT_V2_ECONOMY_UPDATED',
      `${result.transactions.join(', ')}; ${reason}`,
      this.now()
    ));
    return result;
  }

  async approveAdminNftV2Map(adminKey, input) {
    this.assertAdminKey(adminKey);
    assertApi(this.nftV2AdminService, 503, 'nft_v2_admin_disabled', 'NFT V2 on-chain Admin controls are disabled.');
    const reason = adminReason(input?.reason);
    const stateBefore = await this.database.read();
    const defaults = nftV2MapDefaults(stateBefore.competitionStudio, this.now());
    const mode = String(input?.mode || '').toLowerCase();
    const selected = defaults[mode];
    assertApi(selected, 422, 'nft_map_snapshot_missing', 'Publish an active mine version before approving its on-chain map.');
    const result = await this.nftV2AdminService.approveMap({ ...input, mapId: selected.mapId, contentHash: selected.contentHash });
    await this.database.transact((state) => {
      state.nftV2Protocol ||= { mapVersions: {} };
      state.nftV2Protocol.mapVersions[result.mode] = result.versionId;
      state.nftV2Protocol.updatedAt = this.now();
      appendAudit(state, 'NFT_V2_MAP_APPROVED', `${result.mode}; ${result.versionId}; ${result.transactionHash}; ${reason}`, this.now());
    });
    return result;
  }

  async updateAdminNftV2PhaseXp(adminKey, input) {
    this.assertAdminKey(adminKey);
    assertApi(this.nftV2AdminService, 503, 'nft_v2_admin_disabled', 'NFT V2 on-chain Admin controls are disabled.');
    const reason = adminReason(input?.reason);
    const result = await this.nftV2AdminService.setPhaseXp(input);
    await this.database.transact((state) => appendAudit(
      state,
      'NFT_V2_PHASE_XP_UPDATED',
      `${result.mode}; ${result.versionId}; ${result.phaseXp.join('/')}; ${result.transactionHash}; ${reason}`,
      this.now()
    ));
    return result;
  }

  async retireAdminNftV2Map(adminKey, input) {
    this.assertAdminKey(adminKey);
    assertApi(this.nftV2AdminService, 503, 'nft_v2_admin_disabled', 'NFT V2 on-chain Admin controls are disabled.');
    const reason = adminReason(input?.reason);
    const result = await this.nftV2AdminService.retireMap(input);
    await this.database.transact((state) => {
      state.nftV2Protocol ||= { mapVersions: {} };
      for (const mode of result.retiredModes) delete state.nftV2Protocol.mapVersions[mode];
      state.nftV2Protocol.updatedAt = this.now();
      appendAudit(state, 'NFT_V2_MAP_RETIRED', `${result.versionId}; ${result.transactionHash}; ${reason}`, this.now());
    });
    return result;
  }

  async startRun(token, mode, input = {}) {
    const normalizedMode = String(mode || '').toLowerCase();
    if (isRetiredRunMode(normalizedMode)) {
      throw new ApiError(
        410,
        'mine_retired',
        'That mine is retired. Choose Practice Mine, MATT Arena, or Pass Mine.'
      );
    }
    const nftGateActive = requiresMinerNft(normalizedMode);
    let gatedMinerId = 0;
    if (nftGateActive) {
      assertApi(
        this.nftGameplayService,
        503,
        'nft_gameplay_required',
        'Pass Mine remains closed until Miner NFT verification is available.'
      );
      const replayModes = this.competitiveReplayValidator?.publicStatus?.().modes || [];
      assertApi(
        replayModes.includes(normalizedMode),
        503,
        'nft_replay_required',
        'This NFT mine remains closed until deterministic server replay verification is active.'
      );
      const session = await this.authenticate(token);
      gatedMinerId = selectedMinerId(input.minerId);
      assertApi(
        gatedMinerId > 0,
        422,
        'miner_selection_required',
        'Select one of this wallet’s MATT Mine Miner NFTs before entering Pass Mine.'
      );
      const selected = await this.nftGameplayService.playerMiner(
        session.address,
        gatedMinerId
      );
      assertApi(
        selected,
        403,
        'miner_nft_required',
        'Select a MATT Mine Miner NFT owned by this wallet before entering a reward-bearing mine.'
      );
      assertApi(
        input.authorization && input.playerSignature,
        422,
        'nft_run_approval_required',
        'Approve this Miner run in Ronin Wallet.'
      );
    }
    const started = await super.startRun(token, mode);
    const replayVerifiedMode = this.competitiveReplayValidator?.publicStatus?.().modes?.includes(started.mode);
    const nftSession = nftGateActive && replayVerifiedMode
      ? await this.authenticate(token)
      : null;
    if (nftGateActive && replayVerifiedMode) {
      let nftRun = null;
      try {
        await this.releaseExpiredNftRuns(nftSession.address, started.runId);
        nftRun = await this.nftGameplayService.beginRun({
          address: nftSession.address,
          minerId: gatedMinerId,
          mode: normalizedMode,
          authorization: input.authorization,
          playerSignature: input.playerSignature
        });
        if (nftRun) {
          started.tuning = {
            ...started.tuning,
            playerMaxHealth: nftRun.profile.gameplay.maximumHealth,
            nftCrystalCarryLimit: nftRun.crystalCarryLimit,
            nftMinerProfile: nftRun.profile
          };
          await this.database.transact((state) => {
            const run = state.runs?.[started.runId];
            if (run) {
              run.nftRun = {
                minerId: nftRun.minerId,
                runId: nftRun.runId,
                beginTransactionHash: nftRun.beginTransactionHash,
                crystalCarryLimit: nftRun.crystalCarryLimit,
                profile: structuredClone(nftRun.profile)
              };
              run.tuning = structuredClone(started.tuning);
            }
          });
          started.nftRun = {
            minerId: nftRun.minerId,
            runId: nftRun.runId,
            beginTransactionHash: nftRun.beginTransactionHash,
            crystalCarryLimit: nftRun.crystalCarryLimit,
            profile: nftRun.profile
          };
        }
      } catch (error) {
        if (nftRun) {
          throw new ApiError(
            503,
            'nft_run_persistence_recovery',
            'The Miner run started on-chain. Refresh to resume the same run.'
          );
        }
        if (error?.nftRunDefinitelyNotStarted === true) {
          await this.rollbackUnstartedPaidNftRun(nftSession.address, started.runId);
        }
        throw error;
      }
    }
    if (started.mode === SERVER_RUN_MODES.PRACTICE) {
      started.practicePolicy = { ...PRACTICE_PLAY_POLICY };
    }
    const reviveInfrastructureReady =
      this.revivePaymentVerifier?.publicStatus?.().configured === true &&
      Boolean(this.reviveEligibilityValidator);
    if (['free', 'paid'].includes(started.mode) && reviveInfrastructureReady) {
      const reviveSnapshot = await this.database.transact((state) => {
        const run = state.runs?.[started.runId];
        const mineAllowsRevive = !run?.competitionSnapshot ||
          run.competitionSnapshot.loadout?.paidRevive === true;
        const eligible =
          state.expansionConfig.settings.paidRevivesEnabled === true &&
          mineAllowsRevive;
        if (run) {
          run.paidReviveEligible = eligible;
          run.reviveLimitPerRun = eligible
            ? Math.max(1, Math.min(3, state.expansionConfig.settings.reviveLimitPerRun))
            : 0;
          run.reviveInvulnerabilitySeconds =
            state.expansionConfig.settings.reviveInvulnerabilitySeconds;
        }
        return {
          eligible,
          limitPerRun: eligible
            ? Math.max(1, Math.min(3, state.expansionConfig.settings.reviveLimitPerRun))
            : 0,
          invulnerabilitySeconds:
            state.expansionConfig.settings.reviveInvulnerabilitySeconds
        };
      });
      started.paidReviveEligible = reviveSnapshot.eligible;
      started.reviveLimitPerRun = reviveSnapshot.limitPerRun;
      started.reviveInvulnerabilitySeconds = reviveSnapshot.invulnerabilitySeconds;
    }
    if (this.competitiveReplayValidator?.publicStatus?.().modes?.includes(started.mode)) {
      try {
        const state = await this.database.read();
        const run = state.runs?.[started.runId];
        started.checkpoint = await this.competitiveReplayValidator.register(run, started.runToken);
        started.verification = 'fixed-step-input-replay';
      } catch (error) {
        if (started.nftRun && this.nftGameplayService) {
          await this.nftGameplayService.cancelRun({
            address: (await this.authenticate(token)).address,
            minerId: started.nftRun.minerId
          }).catch(() => undefined);
        }
        await super.abandonRun(token, {
          runId: started.runId,
          runToken: started.runToken
        }).catch(() => undefined);
        throw error;
      }
    }
    return started;
  }

  async releaseExpiredNftRuns(address, exceptRunId = '') {
    const state = await this.database.read();
    const stale = Object.values(state.runs || {}).filter((run) =>
      run.id !== exceptRunId &&
      run.address === address &&
      run.status !== 'active' &&
      run.nftRun?.minerId
    );
    for (const run of stale) {
      await this.nftGameplayService.cancelRun({
        address,
        minerId: run.nftRun.minerId
      });
    }
  }

  async startArenaRun(token, input = {}) {
    assertApi(
      this.nftGameplayService,
      503,
      'nft_gameplay_required',
      'MATT Arena remains closed until Miner NFT verification is available.'
    );
    const session = await this.authenticate(token);
    const minerId = selectedMinerId(input.minerId);
    assertApi(
      minerId > 0,
      422,
      'miner_selection_required',
      'Select one of this wallet’s MATT Mine Miner NFTs before entering MATT Arena.'
    );
    const minerProfile = await this.nftGameplayService.playerMiner(session.address, minerId);
    assertApi(
      minerProfile,
      403,
      'miner_nft_required',
      'MATT Arena requires a MATT Mine Miner NFT owned by the playing wallet.'
    );
    assertApi(
      input.authorization && input.playerSignature,
      422,
      'nft_run_approval_required',
      'Approve this Miner run in Ronin Wallet.'
    );
    const state = await this.database.read();
    const settings = state.expansionConfig.settings;
    const arenaSnapshot = resolveCompetitionSnapshot(
      state.competitionStudio,
      'arena',
      this.now()
    );
    const reviveInfrastructureReady =
      this.revivePaymentVerifier?.publicStatus?.().configured === true &&
      typeof this.arenaService?.validatePaidReviveDeath === 'function';
    const started = await super.startArenaRun(token, {
      ...input,
      nftRun: {
        minerId,
        profile: minerProfile
      },
      paidRevivesEnabled: arenaStudioAllowsPaidRevives(
        arenaSnapshot,
        settings,
        reviveInfrastructureReady
      ),
      reviveLimitPerRun: settings.reviveLimitPerRun,
      reviveInvulnerabilitySeconds: settings.reviveInvulnerabilitySeconds
    });
    let nftRun = null;
    try {
      nftRun = await this.nftGameplayService.beginRun({
        address: session.address,
        minerId,
        mode: 'arena',
        authorization: input.authorization,
        playerSignature: input.playerSignature
      });
      await this.arenaService.store.attachNftRun(
        started.run.runId,
        session.address,
        nftRun
      );
      started.run.nftRun = nftRun;
      started.run.challenge.tuning._nftRun = structuredClone(nftRun);
      return started;
    } catch (error) {
      if (nftRun) {
        throw new ApiError(
          503,
          'nft_run_persistence_recovery',
          'The Arena Miner run started on-chain. Refresh to resume the same run.'
        );
      }
      if (error?.nftRunDefinitelyNotStarted === true) {
        await this.arenaService.store.rollbackUnstartedNftRun(
          started.run.runId,
          session.address,
          this.now()
        );
      }
      throw error;
    }
  }

  async rollbackUnstartedPaidNftRun(address, runId) {
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      const run = state.runs?.[runId];
      assertApi(run, 404, 'run_not_found', 'The server run was not found.');
      assertApi(run.address === address, 403, 'run_owner_mismatch', 'This run belongs to another wallet.');
      assertApi(run.status === 'active' && !run.nftRun, 409, 'nft_run_already_started', 'This attempt cannot be restored after its on-chain Miner run started.');
      const entitlement = Object.values(state.paidEntitlements || {})
        .find((entry) => entry.address === address && entry.usedRunId === runId);
      assertApi(entitlement, 409, 'paid_run_credit_missing', 'The reserved Pass Mine credit was not found.');
      entitlement.consumedAt = 0;
      entitlement.usedRunId = '';
      run.status = 'expired';
      run.finishedAt = timestamp;
      run.result = null;
      await transaction?.upsertRun(run);
      appendAudit(
        state,
        'NFT_V2_START_ROLLED_BACK',
        `${address}; ${runId}; Pass Mine credit restored before on-chain start`,
        timestamp,
        'SERVER_SECURITY'
      );
      return { restored: true, runId };
    });
  }

  async appendCompetitiveEvents(token, payload) {
    if (!this.competitiveReplayValidator) {
      throw new ApiError(503, 'competitive_replay_validator_missing', 'Deterministic server replay is not configured.');
    }
    const session = await this.authenticate(token);
    return {
      checkpoint: await this.competitiveReplayValidator.append(session.address, payload)
    };
  }

  async me(token) {
    const player = await super.me(token);
    const timestamp = this.now();
    const initial = await this.database.read();
    const hasEarnedUnlock = earnedCharacterIds(
      initial.wallets[player.address],
      initial.expansionConfig
    ).length > 0;
    const snapshot = hasEarnedUnlock
      ? await this.database.transact((next) => {
        const wallet = next.wallets[player.address];
        syncEarnedCharacters(wallet, next.expansionConfig, timestamp);
        return {
          wallet: structuredClone(wallet),
          expansionConfig: structuredClone(next.expansionConfig)
        };
      })
      : {
        wallet: structuredClone(initial.wallets[player.address]),
        expansionConfig: structuredClone(initial.expansionConfig)
      };
    const wallet = snapshot.wallet;
    const expansion = publicExpansion(wallet, snapshot.expansionConfig);
    expansion.settings.paidRevivesEnabled =
      snapshot.expansionConfig.settings.paidRevivesEnabled === true &&
      this.revivePaymentVerifier?.publicStatus?.().configured === true &&
      Boolean(this.reviveEligibilityValidator);
    expansion.settings.weeklyCompetitionEnabled &&= Boolean(this.competitiveReplayValidator);
    expansion.settings.endlessEnabled &&= Boolean(this.competitiveReplayValidator);
    const interruptedNftPractice = Object.values(initial.runs || {})
      .filter((run) =>
        run.address === player.address &&
        run.mode === SERVER_RUN_MODES.PRACTICE &&
        run.status === 'active' &&
        run.expiresAt > timestamp &&
        run.nftRun?.minerId
      )
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0];
    return {
      ...player,
      expansion,
      interruptedNftPractice: interruptedNftPractice ? {
        runId: interruptedNftPractice.id,
        minerId: Number(interruptedNftPractice.nftRun.minerId),
        startedAt: Number(interruptedNftPractice.startedAt || 0),
        expiresAt: Number(interruptedNftPractice.expiresAt || 0)
      } : null,
    };
  }

  async restartInterruptedNftPractice(token) {
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_disabled', 'NFT gameplay is not enabled.');
    const session = await this.authenticate(token);
    const timestamp = this.now();
    const snapshot = await this.database.read();
    const candidate = Object.values(snapshot.runs || {})
      .filter((run) =>
        run.address === session.address &&
        run.mode === SERVER_RUN_MODES.PRACTICE &&
        run.status === 'active' &&
        run.expiresAt > timestamp &&
        run.nftRun?.minerId
      )
      .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0];
    assertApi(candidate, 404, 'interrupted_nft_practice_missing', 'No interrupted NFT Practice run was found.');
    await this.nftGameplayService.cancelRun({
      address: session.address,
      minerId: Number(candidate.nftRun.minerId)
    });
    const interruptedRunId = candidate.id;
    const interrupted = await this.database.transact(async (state, transaction) => {
      const run = Object.values(state.runs || {})
        .filter((activeRun) =>
          activeRun.id === interruptedRunId &&
          activeRun.address === session.address &&
          activeRun.mode === SERVER_RUN_MODES.PRACTICE &&
          activeRun.status === 'active' &&
          activeRun.expiresAt > timestamp &&
          activeRun.nftRun?.minerId
        )
        .sort((left, right) => Number(right.startedAt || 0) - Number(left.startedAt || 0))[0];
      assertApi(run, 404, 'interrupted_nft_practice_missing', 'No interrupted NFT Practice run was found.');
      run.status = 'expired';
      run.finishedAt = timestamp;
      run.result = null;
      run.recoveryRestartedAt = timestamp;
      await transaction?.upsertRun(run);
      appendAudit(
        state,
        'INTERRUPTED_NFT_PRACTICE_RESTARTED',
        `${session.address}; ${run.id}; Miner #${run.nftRun.minerId}`,
        timestamp,
        session.address
      );
      return {
        runId: run.id,
        minerId: Number(run.nftRun.minerId)
      };
    });
    await this.competitiveReplayValidator?.finalize?.(interrupted.runId, 'expired').catch(() => undefined);
    return this.startRun(token, SERVER_RUN_MODES.PRACTICE);
  }

  async recoverLockedMinerRun(token, payload) {
    assertApi(this.nftGameplayService, 503, 'nft_gameplay_disabled', 'NFT gameplay is not enabled.');
    const session = await this.authenticate(token);
    const minerId = Number(payload?.minerId);
    assertApi(Number.isSafeInteger(minerId) && minerId >= 1 && minerId <= 1_000, 422, 'nft_miner_id_invalid', 'Choose a valid Miner number.');

    const before = await this.nftGameplayService.playerMiner(session.address, minerId);
    assertApi(before, 403, 'miner_nft_required', 'A Miner NFT owned by this wallet is required.');
    if (before.gameplay?.runLocked !== true) {
      return { recovered: false, minerId, profile: before };
    }

    const cancellation = await this.nftGameplayService.cancelRun({
      address: session.address,
      minerId
    });
    const timestamp = this.now();
    const expiredRunIds = await this.database.transact(async (state, transaction) => {
      const runIds = [];
      for (const run of Object.values(state.runs || {})) {
        if (
          run.address !== session.address ||
          run.status !== 'active' ||
          Number(run.nftRun?.minerId) !== minerId
        ) continue;
        run.status = 'expired';
        run.finishedAt = timestamp;
        run.result = null;
        run.orphanRecoveryAt = timestamp;
        await transaction?.upsertRun(run);
        runIds.push(run.id);
      }
      appendAudit(
        state,
        'NFT_V2_ORPHAN_RUN_RECOVERED',
        `${session.address}; Miner #${minerId}; ${cancellation.transactionHash || 'already unlocked'}`,
        timestamp,
        session.address
      );
      return runIds;
    });
    await Promise.all(expiredRunIds.map((runId) =>
      this.competitiveReplayValidator?.finalize?.(runId, 'expired').catch(() => undefined)
    ));
    const profile = cancellation.settlement?.profile ||
      await this.nftGameplayService.playerMiner(session.address, minerId);
    return {
      recovered: cancellation.cancelled === true,
      minerId,
      transactionHash: cancellation.transactionHash || null,
      profile
    };
  }

  async adminWallet(adminKey, address) {
    const detail = await super.adminWallet(adminKey, address);
    const state = await this.database.read();
    const normalizedAddress = String(address || '').toLowerCase();
    const wallet = state.wallets[normalizedAddress];
    return {
      ...detail,
      expansion: structuredClone(wallet?.expansion || {})
    };
  }

  async expansionStatus(token) {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const wallet = state.wallets[session.address];
    const expansion = publicExpansion(wallet, state.expansionConfig);
    expansion.settings.paidRevivesEnabled =
      state.expansionConfig.settings.paidRevivesEnabled === true &&
      this.revivePaymentVerifier?.publicStatus?.().configured === true &&
      Boolean(this.reviveEligibilityValidator);
    expansion.settings.weeklyCompetitionEnabled &&= Boolean(this.competitiveReplayValidator);
    expansion.settings.endlessEnabled &&= Boolean(this.competitiveReplayValidator);
    return expansion;
  }

  async updateControllerProfile(token, input) {
    const session = await this.authenticate(token);
    let controller;
    try {
      controller = normalizeControllerProfile(input);
    } catch (error) {
      throw new ApiError(422, 'controller_profile_invalid', error.message);
    }
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      wallet.expansion.controller = controller;
      wallet.updatedAt = timestamp;
      appendActivity(wallet, 'CONTROLLER_PROFILE_UPDATED', 'Server-saved controller mapping updated.', timestamp);
      return { controller: structuredClone(controller) };
    });
  }

  async selectCharacter(token, characterId) {
    const session = await this.authenticate(token);
    const id = String(characterId || '');
    assertCharacter(id);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      const character = state.expansionConfig.characters[id];
      if (!character.enabled) throw new ApiError(409, 'character_disabled', 'That character is currently disabled.');
      if (!wallet.expansion.ownedCharacters.includes(id)) {
        throw new ApiError(403, 'character_not_owned', 'That character is not owned by this wallet.');
      }
      wallet.expansion.selectedCharacter = id;
      wallet.updatedAt = timestamp;
      appendActivity(wallet, 'CHARACTER_SELECTED', id, timestamp);
      return { selectedCharacter: id, character: structuredClone(character) };
    });
  }

  async betaAccess(token) {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const wallet = state.wallets[session.address];
    const allowed = state.expansionConfig.settings.betaModeEnabled && wallet.expansion.betaTester;
    if (!allowed) throw new ApiError(403, 'beta_access_required', 'This wallet is not approved for Beta Testing.');
    return {
      allowed: true,
      banner: 'BETA TESTING · NO REWARDS OR PROGRESSION',
      seed: `MATT-BETA-${this.randomHex(8)}`,
      capabilities: BETA_CAPABILITIES
    };
  }

  async adminExpansion(adminKey) {
    this.assertAdminKey(adminKey);
    await this.ensureAdminControlLinks();
    const state = await this.database.read();
    return {
      schema: ACTIVE_EXPANSION_SCHEMA,
      defaults: defaultExpansionConfig(),
      config: structuredClone(state.expansionConfig),
      blockers: {
        paidRevives: this.revivePaymentVerifier?.publicStatus?.().configured && this.reviveEligibilityValidator
          ? ''
          : 'Exact on-chain revive payment and death replay verifiers are not configured.',
      },
      productionReadiness: {
        competitiveReplay: this.competitiveReplayValidator?.publicStatus?.() || {
          configured: false,
          enabled: false
        },
        paidRevivePayments: this.revivePaymentVerifier?.publicStatus?.() || {
          configured: false,
          enabled: false
        },
        treasurySafe: {
          address: '0xbace355d23d378a6e1add986e53a18dd12e6eeac',
          owners: 3,
          threshold: 2,
          noTimelock: true,
          operatorApproved: true
        }
      },
      betaTesters: Object.values(state.wallets)
        .filter((wallet) => wallet.expansion?.betaTester)
        .map((wallet) => ({ address: wallet.address, name: wallet.identity?.name || '' }))
    };
  }

  async updateAdminExpansion(adminKey, patch, reason) {
    this.assertAdminKey(adminKey);
    const retiredSetting = Object.keys(patch?.settings || {})
      .find((id) => RETIRED_EXPANSION_SETTING_IDS.has(id));
    assertApi(
      !retiredSetting,
      410,
      'mine_control_retired',
      `${retiredSetting} belongs to a retired mine and can no longer be changed.`
    );
    const normalizedReason = adminReason(reason);
    const timestamp = this.now();
    const result = await this.database.transact((state) => {
      let next;
      try {
        next = normalizeExpansionPatch(patch, state.expansionConfig);
      } catch (error) {
        throw new ApiError(422, 'expansion_config_invalid', error.message);
      }
      if (
        next.settings.paidRevivesEnabled &&
        (
          this.revivePaymentVerifier?.publicStatus?.().configured !== true ||
          !this.reviveEligibilityValidator
        )
      ) {
        throw new ApiError(503, 'revive_payment_verifier_missing', 'Paid revives cannot be enabled until exact on-chain payment verification is configured.');
      }
      if ((next.settings.weeklyCompetitionEnabled || next.settings.endlessEnabled) && !this.competitiveReplayValidator) {
        throw new ApiError(
          503,
          'competitive_replay_validator_missing',
          'Weekly and Endless cannot be enabled until deterministic server replay validation is configured.'
        );
      }
      next.revision = state.expansionConfig.revision + 1;
      next.updatedAt = timestamp;
      next.updatedBy = 'SERVER_ADMIN';
      state.expansionConfig = next;
      const linkedChanges = applyExpansionLinksToTuning(state, next);
      appendAudit(
        state,
        'EXPANSION_CONFIG_UPDATED',
        `${normalizedReason}; revision ${next.revision}${linkedChanges.length ? `; linked: ${linkedChanges.join(', ')}` : ''}`,
        timestamp
      );
      return { config: structuredClone(next), linkedChanges, reason: normalizedReason };
    });
    this.adminControlLinkPromise = null;
    return result;
  }

  async setBetaTester(adminKey, address, enabled, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizedWallet(address);
    if (typeof enabled !== 'boolean') throw new ApiError(400, 'beta_access_invalid', 'Beta access must be true or false.');
    const normalizedReason = adminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[normalizedAddress];
      if (!wallet) throw new ApiError(404, 'wallet_missing', 'The player wallet was not found.');
      wallet.expansion.betaTester = enabled;
      wallet.updatedAt = timestamp;
      appendActivity(wallet, enabled ? 'BETA_ACCESS_GRANTED' : 'BETA_ACCESS_REVOKED', normalizedReason, timestamp);
      appendAudit(state, enabled ? 'BETA_ACCESS_GRANTED' : 'BETA_ACCESS_REVOKED', `${normalizedAddress}; ${normalizedReason}`, timestamp);
      return { address: normalizedAddress, betaTester: enabled };
    });
  }

  async grantCharacter(adminKey, address, characterId, enabled, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizedWallet(address);
    const id = String(characterId || '');
    assertCharacter(id);
    if (id === 'matt' && enabled === false) throw new ApiError(422, 'baseline_character_required', 'MATT cannot be revoked.');
    const normalizedReason = adminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[normalizedAddress];
      if (!wallet) throw new ApiError(404, 'wallet_missing', 'The player wallet was not found.');
      const owned = new Set(wallet.expansion.ownedCharacters);
      enabled ? owned.add(id) : owned.delete(id);
      wallet.expansion.ownedCharacters = [...owned];
      if (!owned.has(wallet.expansion.selectedCharacter)) wallet.expansion.selectedCharacter = 'matt';
      wallet.expansion.characterHistory.push({
        action: enabled ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
        characterId: id,
        reason: normalizedReason,
        timestamp
      });
      wallet.expansion.characterHistory = wallet.expansion.characterHistory.slice(-500);
      appendActivity(wallet, enabled ? 'CHARACTER_GRANTED' : 'CHARACTER_REVOKED', `${id}; ${normalizedReason}`, timestamp);
      appendAudit(state, enabled ? 'CHARACTER_GRANTED' : 'CHARACTER_REVOKED', `${normalizedAddress}; ${id}; ${normalizedReason}`, timestamp);
      return publicExpansion(wallet, state.expansionConfig);
    });
  }

  async weeklyCompetitionPreview(adminKey, weekInput) {
    this.assertAdminKey(adminKey);
    const week = /^\d{4}-\d{2}-\d{2}$/.test(String(weekInput || ''))
      ? String(weekInput)
      : utcWeekKey(this.now());
    const state = await this.database.read();
    return {
      week,
      activeDayCount: state.expansionConfig.settings.weeklyActiveDayCount,
      stages: Array.from({ length: 7 }, (_, index) => {
        const day = index + 1;
        return {
          day,
          seed: weeklyStageSeed(week, day),
          difficulty: state.expansionConfig.settings[`weeklyDay${day}Difficulty`],
          bossCount: state.expansionConfig.settings[`weeklyDay${day}BossCount`],
          roomCount: state.expansionConfig.settings[`weeklyDay${day}RoomCount`],
          character: state.expansionConfig.settings.weeklyLockedCharacter
        };
      })
    };
  }

  async competitionLeaderboard(token, mode, periodInput = '') {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const period = /^\d{4}-\d{2}-\d{2}$/.test(String(periodInput || ''))
      ? String(periodInput)
      : utcWeekKey(this.now());
    if (mode === 'weekly') {
      const rows = weeklyLeaderboard(state.weeklyCompetition, period);
      return {
        mode,
        period,
        activeDayCount: state.expansionConfig.settings.weeklyActiveDayCount,
        rows,
        player: rows.find((entry) => entry.address === session.address) || null
      };
    }
    if (mode === 'endless') {
      const rows = endlessLeaderboard(state.endlessCompetition.seasons?.[period]?.results || []);
      return {
        mode,
        period,
        ranking: ['depth', 'score', 'bosses', 'survivalTime'],
        rows,
        player: rows.find((entry) => entry.address === session.address) || null
      };
    }
    throw new ApiError(404, 'competition_mode_unknown', 'Choose weekly or endless competition.');
  }

  async openPassChest(token, chestId) {
    const session = await this.authenticate(token);
    if (String(chestId || '') !== PASS_CHEST_ID) throw new ApiError(400, 'pass_chest_invalid', 'Choose a valid Pass Chest.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      const config = state.expansionConfig.settings;
      if (!config.chestOpeningEnabled) throw new ApiError(503, 'pass_chest_paused', 'Pass chest opening is currently paused.');
      if (wallet.suspended) throw new ApiError(403, 'wallet_suspended', 'This wallet is suspended from opening Pass rewards.');
      const chest = wallet.passInventory.chests[PASS_CHEST_ID];
      if (chest.available <= 0 || chest.opened >= config.chestMaxOpenings) {
        throw new ApiError(409, 'pass_chest_unavailable', 'No unopened Pass Chest is available.');
      }
      const openingNumber = chest.opened + 1;
      let cosmeticId = config.chestCosmeticDropsEnabled ? config.chestCosmeticId : '';
      const alreadyOwned = cosmeticId && wallet.passInventory.cosmetics.includes(cosmeticId);
      if (alreadyOwned) {
        const unowned = Object.keys(PASS_COSMETICS).filter((id) => !wallet.passInventory.cosmetics.includes(id));
        cosmeticId = unowned.length
          ? unowned[deterministicNumber(`${wallet.address}:${openingNumber}:cosmetic`, unowned.length)]
          : '';
      }
      chest.available -= 1;
      chest.opened = openingNumber;
      chest.lastOpenedAt = timestamp;
      if (cosmeticId && !wallet.passInventory.cosmetics.includes(cosmeticId)) {
        wallet.passInventory.cosmetics.push(cosmeticId);
      }
      const cosmetic = cosmeticId ? PASS_COSMETICS[cosmeticId] : null;
      if (cosmetic?.slot && !wallet.passInventory.equipped[cosmetic.slot]) {
        wallet.passInventory.equipped[cosmetic.slot] = cosmeticId;
      }
      wallet.updatedAt = timestamp;
      appendActivity(wallet, 'PASS_CHEST_OPENED', cosmetic?.name || 'No new cosmetic', timestamp);
      return {
        chestId: PASS_CHEST_ID,
        rewards: {
          cosmetic: cosmetic ? structuredClone(cosmetic) : null
        },
        profile: structuredClone(wallet.profile),
        passInventory: structuredClone(wallet.passInventory)
      };
    });
  }

  async requestPaidRevive(token, input = {}) {
    const { session, state: currentState } = await this.authenticateWithState(token);
    const runId = String(input.runId || '');
    const arenaRun = isArenaRunId(runId);
    const arenaValidatorReady =
      arenaRun && typeof this.arenaService?.validatePaidReviveDeath === 'function';
    if (
      !this.revivePaymentVerifier?.publicStatus?.().configured ||
      (!arenaValidatorReady && !this.reviveEligibilityValidator)
    ) {
      throw new ApiError(503, 'revive_payment_verifier_missing', 'Paid revives are disabled until exact payment and death replay verification are configured.');
    }
    const currentRun = currentState.runs?.[runId];
    if (!arenaRun && (!currentRun || currentRun.address !== session.address)) {
      throw new ApiError(404, 'run_not_found', 'The active run was not found.');
    }
    const verifiedDeath = arenaRun
      ? await this.arenaService.validatePaidReviveDeath(
          session.address,
          runId,
          structuredClone(input.deathState || {}),
          currentState.wallets?.[session.address]?.profile || {}
        )
      : await this.reviveEligibilityValidator.validate({
          address: session.address,
          runId,
          run: structuredClone(currentRun),
          submission: structuredClone(input.deathState || {})
        });
    const timestamp = this.now();
    return this.database.transact((state) => {
      state.arenaReviveRuns ||= {};
      const run = arenaRun
        ? (state.arenaReviveRuns[runId] ||= structuredClone(verifiedDeath.reviveRun))
        : state.runs[runId];
      if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The active run was not found.');
      const config = state.expansionConfig.settings;
      if (!config.paidRevivesEnabled) throw new ApiError(503, 'paid_revives_disabled', 'Paid revives are paused.');
      if (run.paidReviveEligible !== true) {
        throw new ApiError(409, 'paid_revive_run_ineligible', 'Paid revives were not enabled when this run started.');
      }
      if (run.status === 'awaiting-revive' && run.pendingRevive?.status === 'pending') {
        return {
          ...structuredClone(run.pendingRevive),
          transaction: this.revivePaymentVerifier.transactionForPayment(
            run.pendingRevive.priceRonWei
          )
        };
      }
      if (run.status !== 'active') throw new ApiError(409, 'revive_run_finalized', 'This run can no longer be revived.');
      run.status = 'awaiting-revive';
      run.playerState = structuredClone(verifiedDeath.playerState);
      try {
        const pending = createPendingRevive(run, config, timestamp);
        pending.authoritativeCheckpoint = {
          replay: structuredClone(verifiedDeath.checkpoint || {}),
          playerState: structuredClone(verifiedDeath.playerState)
        };
        run.pendingRevive = structuredClone(pending);
        return {
          ...pending,
          transaction: this.revivePaymentVerifier.transactionForPayment(pending.priceRonWei)
        };
      } catch (error) {
        throw bonusError(error);
      }
    });
  }

  async confirmPaidRevive(token, input = {}) {
    const { session, state } = await this.authenticateWithState(token);
    if (!this.revivePaymentVerifier?.publicStatus?.().configured) {
      throw new ApiError(503, 'revive_payment_verifier_missing', 'Paid revives are disabled until exact on-chain payment verification is configured.');
    }
    const runId = String(input.runId || '');
    const transactionHash = String(input.transactionHash || '').toLowerCase();
    const timestamp = this.now();
    const arenaRun = state.arenaReviveRuns?.[runId];
    const run = state.runs[runId] || arenaRun;
    if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The pending revive was not found.');
    const existing = state.revivePayments?.[transactionHash];
    if (existing) {
      if (existing.address !== session.address || existing.runId !== runId) {
        throw new ApiError(409, 'revive_transaction_duplicate', 'That payment transaction has already been used for another run.');
      }
      return structuredClone(existing.completedResponse);
    }
    if (arenaRun) {
      await this.arenaService.assertPaidReviveRunOpen(session.address, runId);
    }
    const verified = await this.revivePaymentVerifier.verifyPayment({
      transactionHash,
      address: session.address,
      amountWei: run.pendingRevive?.priceRonWei,
      runId
    });
    return this.database.transact((next) => {
      const activeRun = next.runs[runId] || next.arenaReviveRuns?.[runId];
      const reconciled = next.revivePayments[transactionHash];
      if (reconciled) {
        if (reconciled.address !== session.address || reconciled.runId !== runId) {
          throw new ApiError(409, 'revive_transaction_duplicate', 'That payment transaction has already been used for another run.');
        }
        return structuredClone(reconciled.completedResponse);
      }
      let revived;
      try {
        revived = confirmRevive(activeRun, verified, next.expansionConfig.settings, timestamp);
      } catch (error) {
        throw bonusError(error);
      }
      const completedResponse = { ...revived, alreadyConfirmed: false };
      next.revivePayments[transactionHash] = {
        transactionHash,
        address: session.address,
        runId,
        quoteId: activeRun.pendingRevive?.id || '',
        amountWei: verified.amountWei,
        transactionBlockAt: verified.transactionBlockAt,
        authoritativeCheckpoint: structuredClone(revived.authoritativeCheckpoint || activeRun.playerState || {}),
        completedResponse: structuredClone(completedResponse),
        confirmedAt: timestamp,
        resumedAt: 0
      };
      next.wallets[session.address].expansion.revivePayments[transactionHash] = { runId, timestamp };
      appendActivity(next.wallets[session.address], 'PAID_REVIVE_CONFIRMED', `${runId}; ${transactionHash}`, timestamp);
      appendAudit(next, 'PAID_REVIVE_CONFIRMED', `${session.address}; ${runId}; ${transactionHash}`, timestamp);
      return completedResponse;
    });
  }

  async resumePaidRevive(token, runIdInput) {
    const session = await this.authenticate(token);
    const runId = String(runIdInput || '');
    const timestamp = this.now();
    const snapshot = await this.database.read();
    if (snapshot.arenaReviveRuns?.[runId]) {
      await this.arenaService.assertPaidReviveRunOpen(session.address, runId);
    }
    return this.database.transact((state) => {
      const run = state.runs?.[runId] || state.arenaReviveRuns?.[runId];
      if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The paid revive run was not found.');
      const payment = Object.values(state.revivePayments || {}).find((entry) =>
        entry.address === session.address && entry.runId === runId
      );
      if (!payment) throw new ApiError(404, 'revive_payment_missing', 'No confirmed paid revive exists for this run.');
      payment.resumedAt ||= timestamp;
      run.lastResumedAt = timestamp;
      return {
        runId,
        status: run.status,
        playerState: structuredClone(run.playerState || payment.authoritativeCheckpoint?.playerState || {}),
        checkpoint: structuredClone(payment.authoritativeCheckpoint?.replay || {}),
        reviveCount: Array.isArray(run.revives) ? run.revives.length : 0,
        paidAt: payment.transactionBlockAt,
        resumedAt: payment.resumedAt
      };
    });
  }

  async adminPaymentReconciliation(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const revives = Object.values(state.revivePayments || {});
    let paymentOperations = [];
    if (this.database.kind === 'postgresql') {
      const result = await this.database.query(`SELECT * FROM matt_mine_normalized.payment_operations
        WHERE state <> 'completed' ORDER BY updated_at_ms ASC LIMIT 500`);
      paymentOperations = result.rows;
    }
    return {
      paidButNotResumedRevives: revives.filter((entry) => !entry.resumedAt).map((entry) => ({
        transactionHash: entry.transactionHash,
        address: entry.address,
        runId: entry.runId,
        confirmedAt: entry.confirmedAt
      })),
      paymentOperations
    };
  }

  async cancelPaidRevive(token, runIdInput) {
    const session = await this.authenticate(token);
    const runId = String(runIdInput || '');
    return this.database.transact((state) => {
      const run = state.runs[runId] || state.arenaReviveRuns?.[runId];
      if (!run || run.address !== session.address) {
        throw new ApiError(404, 'run_not_found', 'The pending revive was not found.');
      }
      if (run.status !== 'awaiting-revive' || run.pendingRevive?.status !== 'pending') {
        throw new ApiError(409, 'revive_not_pending', 'This revive is no longer pending.');
      }
      run.pendingRevive.status = 'cancelled';
      run.pendingRevive.cancelledAt = this.now();
      run.status = 'active';
      return { runId, cancelled: true };
    });
  }

  async finishArenaRun(token, payload) {
    const result = await super.finishArenaRun(token, payload);
    if (result.accepted !== false && result.progression?.nftRun?.minerId && this.nftGameplayService) {
      const session = await this.authenticate(token);
      result.nftSettlement = await this.nftGameplayService.settleRun({
        address: session.address,
        minerId: Number(result.progression.nftRun.minerId),
        runId: result.progression.nftRun.runId,
        result: result.result,
        completedPhases: completedPhaseCount(result.result)
      });
    }
    if (result.accepted !== false) {
      await this.#closeArenaReviveRun(payload?.runId, 'finished');
    }
    return result;
  }

  async abandonArenaRun(token, payload) {
    const session = await this.authenticate(token);
    const active = await this.arenaService?.store?.getRun?.(String(payload?.runId || ''));
    const result = await super.abandonArenaRun(token, payload);
    if (active?.tuning?._nftRun?.minerId && this.nftGameplayService) {
      await this.nftGameplayService.cancelRun({
        address: session.address,
        minerId: Number(active.tuning._nftRun.minerId),
        runId: active.tuning._nftRun.runId
      });
    }
    await this.#closeArenaReviveRun(result.runId, 'expired');
    return result;
  }

  async abandonActiveArenaRun(token) {
    const session = await this.authenticate(token);
    const active = await this.arenaService?.store?.activeRun?.(session.address);
    const result = await super.abandonActiveArenaRun(token);
    if (active?.tuning?._nftRun?.minerId && this.nftGameplayService) {
      await this.nftGameplayService.cancelRun({
        address: session.address,
        minerId: Number(active.tuning._nftRun.minerId),
        runId: active.tuning._nftRun.runId
      });
    }
    await this.#closeArenaReviveRun(result.runId, 'expired');
    return result;
  }

  async #closeArenaReviveRun(runIdInput, status) {
    const runId = String(runIdInput || '');
    if (!isArenaRunId(runId)) return;
    const timestamp = this.now();
    await this.database.transact((state) => {
      const run = state.arenaReviveRuns?.[runId];
      if (!run) return;
      run.status = status;
      run.finishedAt ||= timestamp;
      if (run.pendingRevive?.status === 'pending') {
        run.pendingRevive.status = 'cancelled';
        run.pendingRevive.cancelledAt = timestamp;
      }
    });
  }

  async finishRun(token, payload) {
    let verifiedPayload = payload;
    const pendingRun = (await this.database.read()).runs?.[String(payload?.runId || '')];
    if (
      pendingRun &&
      this.competitiveReplayValidator?.publicStatus?.().modes?.includes(pendingRun.mode)
    ) {
      if (!this.competitiveReplayValidator) {
        throw new ApiError(503, 'competitive_replay_validator_missing', 'Competitive result submission requires deterministic server replay.');
      }
      const verified = await this.competitiveReplayValidator.validate({
        run: structuredClone(pendingRun),
        submission: structuredClone(payload?.competitiveCheckpoint || {})
      });
      verifiedPayload = { ...payload, result: verified.result };
    }
    const result = await super.finishRun(token, verifiedPayload);
    let nftSettlement = null;
    if (pendingRun?.nftRun && this.nftGameplayService) {
      const verifiedResult = result?.run?.result || validateRunResult(
        verifiedPayload?.result || {},
        pendingRun,
        this.now()
      );
      nftSettlement = await this.nftGameplayService.settleRun({
        address: pendingRun.address,
        serverRunId: pendingRun.id,
        minerId: pendingRun.nftRun.minerId,
        runId: pendingRun.nftRun.runId,
        result: verifiedResult,
        currentLevel: Number(pendingRun.tuning?.nftMinerProfile?.progression?.level || 1),
        completedPhases: completedPhaseCount(verifiedResult)
      });
      await this.database.transact((state) => {
        const wallet = state.wallets?.[pendingRun.address];
        if (!wallet) return;
        recordNftCrystalBank(wallet, {
          address: pendingRun.address,
          runId: pendingRun.id,
          amount: nftSettlement.crystalsBanked,
          transactionHash: nftSettlement.transactionHash,
          timestamp: this.now()
        });
      });
    }
    if (nftSettlement) {
      result.nftSettlement = nftSettlement;
      result.practiceClaim = null;
      result.nftCrystals = (await this.me(token)).nftCrystals;
    }
    const runId = String(payload?.runId || '');
    if (
      pendingRun &&
      this.competitiveReplayValidator?.publicStatus?.().modes?.includes(pendingRun.mode)
    ) {
      await this.competitiveReplayValidator.finalize(runId, 'finished').catch(() => undefined);
    }
    return result;
  }

  async abandonRun(token, payload) {
    const pendingRun = (await this.database.read()).runs?.[String(payload?.runId || '')];
    if (pendingRun?.nftRun && this.nftGameplayService) {
      const session = await this.authenticate(token);
      assertApi(pendingRun.address === session.address, 403, 'run_owner_mismatch', 'This run belongs to another wallet.');
      const suppliedTokenHash = createHash('sha256').update(String(payload?.runToken || '')).digest('hex');
      assertApi(pendingRun.tokenHash === suppliedTokenHash, 401, 'run_token_rejected', 'The run token is invalid.');
      await this.nftGameplayService.cancelRun({
        address: pendingRun.address,
        minerId: pendingRun.nftRun.minerId,
        runId: pendingRun.nftRun.runId
      });
    }
    const abandoned = await super.abandonRun(token, payload);
    if (this.competitiveReplayValidator && pendingRun) {
      await this.competitiveReplayValidator.finalize(pendingRun.id, 'expired').catch(() => undefined);
    }
    return abandoned;
  }

}

export function arenaStudioAllowsPaidRevives(snapshot, settings = {}, infrastructureReady = false) {
  return infrastructureReady === true &&
    settings.paidRevivesEnabled === true &&
    snapshot?.loadout?.paidRevive === true;
}

function completedPhaseMask(result = {}) {
  if (Number.isSafeInteger(result.completedPhases)) return result.completedPhases;
  const depth = Math.max(1, Math.min(5, Math.floor(Number(result.depth) || 1)));
  let mask = 0;
  const completedDepths = result.extracted === true ? depth : Math.max(0, depth - 1);
  for (let index = 0; index < completedDepths; index += 1) mask |= 1 << index;
  return mask;
}

export function completedPhaseCount(result = {}) {
  const mask = completedPhaseMask(result);
  return mask.toString(2).split('1').length - 1;
}

function selectedMinerId(value) {
  const minerId = Number(value || 0);
  return Number.isSafeInteger(minerId) && minerId > 0 && minerId <= 1_000 ? minerId : 0;
}

export function recordNftCrystalBank(wallet, input = {}) {
  // Remove obsolete claim payloads that may still exist in pre-retirement JSON rows.
  if (Object.hasOwn(wallet, 'practiceClaims')) delete wallet.practiceClaims;
  wallet.nftCrystalLedger ||= [];
  const runId = String(input.runId || '').slice(0, 120);
  const id = `nft-run-bank:${runId}`;
  // NFT-enabled runs settle MATT Crystals through the V2 gameplay service.
  if (wallet.nftCrystalLedger.some((entry) => entry.id === id)) return false;
  const amount = Math.max(0, Math.floor(Number(input.amount || 0)));
  wallet.nftCrystalBalance = Math.max(0, Math.floor(Number(wallet.nftCrystalBalance || 0))) + amount;
  wallet.nftCrystalLedger.push({
    id,
    walletAddress: String(input.address || wallet.address || '').toLowerCase(),
    runId,
    type: 'RUN_BANK',
    amount,
    balance: wallet.nftCrystalBalance,
    transactionHash: typeof input.transactionHash === 'string' ? input.transactionHash : '',
    timestamp: Math.max(0, Math.floor(Number(input.timestamp || Date.now())))
  });
  wallet.nftCrystalLedger = wallet.nftCrystalLedger.slice(-10_000);
  return true;
}

function publicExpansion(wallet, config) {
  const expansion = wallet?.expansion || {};
  const owned = Array.isArray(expansion.ownedCharacters) ? expansion.ownedCharacters : ['matt'];
  return {
    betaTester: expansion.betaTester === true,
    betaAvailable: config?.settings?.betaModeEnabled === true && expansion.betaTester === true,
    ownedCharacters: [...owned],
    selectedCharacter: owned.includes(expansion.selectedCharacter) ? expansion.selectedCharacter : 'matt',
    controller: structuredClone(expansion.controller || {}),
    characters: Object.fromEntries(Object.entries(config?.characters || {}).map(([id, character]) => [
      id,
      {
        ...structuredClone(character),
        owned: owned.includes(id)
      }
    ])),
    settings: {
      paidRevivesEnabled: false,
      weeklyCompetitionEnabled: config?.settings?.weeklyCompetitionEnabled === true,
      endlessEnabled: config?.settings?.endlessEnabled === true
    }
  };
}

function syncEarnedCharacters(wallet, config, timestamp) {
  if (!wallet?.expansion || !config?.characters) return [];
  const owned = new Set(wallet.expansion.ownedCharacters || ['matt']);
  const unlocked = earnedCharacterIds(wallet, config);
  for (const id of unlocked) {
    const character = config.characters[id];
    const passUnlocked =
      character.passRequirement > 0 &&
      passLevel(wallet.passProgress?.xp || 0).level >= character.passRequirement;
    owned.add(id);
    wallet.expansion.characterHistory.push({
      action: passUnlocked ? 'PASS_UNLOCKED' : 'PROGRESSION_UNLOCKED',
      characterId: id,
      timestamp
    });
    appendActivity(wallet, 'CHARACTER_UNLOCKED', `${id}; ${passUnlocked ? 'Pass' : 'progression'}`, timestamp);
  }
  wallet.expansion.ownedCharacters = [...owned];
  wallet.expansion.characterHistory = wallet.expansion.characterHistory.slice(-500);
  if (unlocked.length) wallet.updatedAt = timestamp;
  return unlocked;
}

function earnedCharacterIds(wallet, config) {
  if (!wallet?.expansion || !config?.characters) return [];
  const owned = new Set(wallet.expansion.ownedCharacters || ['matt']);
  const currentPassLevel = passLevel(wallet.passProgress?.xp || 0).level;
  return Object.entries(config.characters)
    .filter(([id, character]) => {
      if (owned.has(id) || character.enabled !== true) return false;
      const passUnlocked = character.passRequirement > 0 && currentPassLevel >= character.passRequirement;
      const progressionUnlocked =
        character.progressionRequirement > 0 &&
        Number(wallet.profile?.totalRuns || 0) >= character.progressionRequirement;
      return passUnlocked || progressionUnlocked;
    })
    .map(([id]) => id);
}

function bonusError(error) {
  if (error instanceof ApiError) return error;
  const code = String(error?.code || error?.message || 'bonus_action_failed').slice(0, 80);
  return new ApiError(409, code, String(error?.message || 'The bonus action could not be completed.'));
}

function assertCharacter(id) {
  if (!CHARACTER_IDS.includes(id)) throw new ApiError(422, 'character_unknown', 'Choose a valid playable character.');
}

function adminReason(value) {
  const reason = typeof value === 'string' ? value.trim().slice(0, 240) : '';
  if (reason.length < 4) throw new ApiError(400, 'admin_reason_required', 'Provide a short written reason.');
  return reason;
}

function nftV2MapDefaults(studio, timestamp) {
  return Object.fromEntries([['arena', 'arena'], ['paid', 'pass']].flatMap(([mode, slot]) => {
    const snapshot = resolveCompetitionSnapshot(studio, slot, timestamp);
    if (!snapshot) return [];
    const seed = String(snapshot.id || `${slot}-${timestamp}`);
    const mapId = sha256Bytes32(`matt-mine-map:${mode}:${seed}`);
    const fingerprint = String(snapshot.fingerprint || '').replace(/^0x/, '');
    const contentHash = /^[a-f0-9]{64}$/i.test(fingerprint)
      ? `0x${fingerprint.toLowerCase()}`
      : sha256Bytes32(JSON.stringify(snapshot));
    return [[mode, { seed, mapId, contentHash, snapshotName: snapshot.name || snapshot.title || seed }]];
  }));
}

function sha256Bytes32(value) {
  return `0x${createHash('sha256').update(String(value)).digest('hex')}`;
}

function normalizedWallet(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new ApiError(400, 'invalid_address', 'A valid Ronin wallet address is required.');
  return address;
}

function isArenaRunId(value) {
  return /^arena_run_[a-f0-9]{24}$/.test(String(value || ''));
}

function appendActivity(wallet, action, details, timestamp) {
  wallet.activity ||= [];
  wallet.activity.push({
    id: `activity-${timestamp}-${wallet.activity.length + 1}`,
    action,
    details: String(details).slice(0, 500),
    timestamp
  });
  wallet.activity = wallet.activity.slice(-500);
}

function appendAudit(state, action, details, timestamp, actor = 'SERVER_ADMIN') {
  state.audit ||= [];
  state.audit.push({
    id: `audit-${timestamp}-${state.audit.length + 1}`,
    actor,
    action,
    details: String(details).slice(0, 500),
    timestamp
  });
  state.audit = state.audit.slice(-2_000);
}

function deterministicNumber(seed, modulo) {
  let hash = 2166136261;
  for (const char of String(seed)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % Math.max(1, modulo);
}
