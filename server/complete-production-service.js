import { ProductionMattMineService } from './production-service.js';
import { ApiError } from './errors.js';
import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta,
  findLedgerEntryByIdempotency
} from './nugget-ledger.js';
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
  awardVerifiedAdvertisement,
  confirmRevive,
  createPendingRevive,
  skipAdvertisement
} from './bonus-engine.js';
import {
  DisabledAdvertisementVerifier,
  DisabledRevivePaymentVerifier
} from './external-verifiers.js';
import {
  addEconomyAudit,
  mergeNuggetEconomyConfig
} from './nugget-economy.js';
import {
  applyEconomyLinksToExpansion,
  applyExpansionLinksToTuning,
  economyShadowPatch,
  linkedAdminControlSnapshot,
  reconcileLinkedAdminControls
} from './admin-control-links.js';
import { buildAdminReadiness } from './admin-readiness.js';

const BETA_CAPABILITIES = Object.freeze([
  'jumpDepth', 'jumpRoom', 'triggerBoss', 'spawnBoss', 'setBossPhase',
  'setLevel', 'setHealth', 'setMaximumHealth', 'invulnerability', 'weaponUnlocks',
  'weaponDamage', 'armor', 'movementSpeed', 'dashCooldown', 'talents',
  'restoreHealth', 'refillBlaster', 'resetEnemies', 'clearEnemies', 'spawnEnemy',
  'enemyAI', 'bossAI', 'damageNumbers', 'hitboxes', 'cooldownDebug',
  'seedDisplay', 'exportConfiguration', 'importConfiguration'
]);

export class CompleteProductionMattMineService extends ProductionMattMineService {
  constructor(database, options = {}) {
    super(database, options);
    this.advertisementVerifier = options.advertisementVerifier || new DisabledAdvertisementVerifier();
    this.revivePaymentVerifier = options.revivePaymentVerifier || new DisabledRevivePaymentVerifier();
    this.reviveEligibilityValidator = options.reviveEligibilityValidator || null;
    this.competitiveReplayValidator = options.competitiveReplayValidator || null;
    this.adminControlLinkPromise = null;
  }

  async ensureAdminControlLinks() {
    if (this.adminControlLinkPromise) return this.adminControlLinkPromise;
    this.adminControlLinkPromise = (async () => {
      const timestamp = this.now();
      const economy = this.nuggetEconomyStore ? await this.nuggetEconomyStore.read() : null;
      const reconciled = await this.database.transact((state) => {
        const result = reconcileLinkedAdminControls(state, economy?.config, timestamp);
        if (result.mainChanges.length) {
          appendAudit(state, 'ADMIN_CONTROLS_RECONCILED', result.mainChanges.join('; '), timestamp);
        }
        return {
          ...result,
          expansionConfig: structuredClone(state.expansionConfig)
        };
      });
      if (this.nuggetEconomyStore && reconciled.economyChanges.length) {
        await this.nuggetEconomyStore.transact((state) => {
          state.config = mergeNuggetEconomyConfig(
            state.config,
            reconciled.shadowPatch,
            'SERVER_ADMIN_LINK_SYNC',
            timestamp
          );
          addEconomyAudit(
            state,
            'SERVER_ADMIN_LINK_SYNC',
            'LINKED_CONTROLS_RECONCILED',
            reconciled.economyChanges.join('; '),
            timestamp
          );
        });
      }
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
    const [state, economy, database] = await Promise.all([
      this.database.read(),
      this.nuggetEconomyStore ? this.nuggetEconomyStore.read() : Promise.resolve(null),
      this.database.healthCheck().catch(() => ({ ok: false, kind: this.database.kind || 'unknown' }))
    ]);
    const controlLinks = linkedAdminControlSnapshot(state, economy?.config);
    const replay = this.competitiveReplayValidator?.publicStatus?.() || { configured: false, enabled: false };
    const reviveStatus = this.revivePaymentVerifier?.publicStatus?.() || { configured: false, enabled: false };
    const advertisementStatus = this.advertisementVerifier?.publicStatus?.() || { configured: false, enabled: false };
    const arena = this.arenaService?.publicConfig?.() || { configured: false, enabled: false };
    const treasurySafe = {
      address: overview.immutable?.contracts?.safe || '',
      owners: 3,
      threshold: 1
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
        advertisements: advertisementStatus,
        nuggetPayments: {
          configured: Boolean(this.nuggetEconomyStore && this.nuggetPaymentVerifier),
          enabled: this.nuggetPaymentsEnabled
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

  async startRun(token, mode) {
    if (['weekly', 'endless'].includes(String(mode || '').toLowerCase()) && !this.competitiveReplayValidator) {
      throw new ApiError(
        503,
        'competitive_replay_validator_missing',
        'This competition remains disabled until deterministic server replay validation is configured.'
      );
    }
    const started = await super.startRun(token, mode);
    const reviveInfrastructureReady =
      this.revivePaymentVerifier?.publicStatus?.().configured === true &&
      Boolean(this.reviveEligibilityValidator);
    if (['free', 'paid'].includes(started.mode) && reviveInfrastructureReady) {
      const reviveSnapshot = await this.database.transact((state) => {
        const run = state.runs?.[started.runId];
        const eligible = state.expansionConfig.settings.paidRevivesEnabled === true;
        if (run) {
          run.paidReviveEligible = eligible;
          run.reviveInvulnerabilitySeconds =
            state.expansionConfig.settings.reviveInvulnerabilitySeconds;
        }
        return {
          eligible,
          invulnerabilitySeconds:
            state.expansionConfig.settings.reviveInvulnerabilitySeconds
        };
      });
      started.paidReviveEligible = reviveSnapshot.eligible;
      started.reviveInvulnerabilitySeconds = reviveSnapshot.invulnerabilitySeconds;
    }
    if (this.competitiveReplayValidator?.publicStatus?.().modes?.includes(started.mode)) {
      const state = await this.database.read();
      const run = state.runs?.[started.runId];
      started.checkpoint = await this.competitiveReplayValidator.register(run, started.runToken);
      started.verification = 'fixed-step-input-replay';
    }
    return started;
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
    expansion.settings.advertisementRewardsEnabled =
      snapshot.expansionConfig.settings.advertisementRewardsEnabled === true &&
      this.advertisementVerifier?.publicStatus?.().configured === true;
    expansion.settings.weeklyCompetitionEnabled &&= Boolean(this.competitiveReplayValidator);
    expansion.settings.endlessEnabled &&= Boolean(this.competitiveReplayValidator);
    return {
      ...player,
      expansion,
      ...(player.nuggetEconomy ? { nuggetEconomy: {
        ...player.nuggetEconomy,
        pendingPracticeClaims: Object.values(wallet?.practiceClaims || {})
          .filter((claim) => claim?.status === 'pending')
          .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
          .map((claim) => structuredClone(claim))
      } } : {})
    };
  }

  async adminWallet(adminKey, address) {
    const detail = await super.adminWallet(adminKey, address);
    const state = await this.database.read();
    const normalizedAddress = String(address || '').toLowerCase();
    const wallet = state.wallets[normalizedAddress];
    return {
      ...detail,
      expansion: structuredClone(wallet?.expansion || {}),
      nuggetEconomy: {
        ...(detail.nuggetEconomy || {}),
        ledger: structuredClone(wallet?.nuggetLedger || []),
        pendingPracticeClaims: structuredClone(wallet?.practiceClaims || {})
      }
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
    expansion.settings.advertisementRewardsEnabled =
      state.expansionConfig.settings.advertisementRewardsEnabled === true &&
      this.advertisementVerifier?.publicStatus?.().configured === true;
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

  async purchaseCharacter(token, characterId) {
    const session = await this.authenticate(token);
    const id = String(characterId || '');
    assertCharacter(id);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      const character = state.expansionConfig.characters[id];
      if (!character.enabled) throw new ApiError(409, 'character_disabled', 'That character is currently disabled.');
      if (wallet.expansion.ownedCharacters.includes(id)) {
        throw new ApiError(409, 'character_already_owned', 'That character is already owned.');
      }
      if (character.nuggetPrice <= 0) {
        throw new ApiError(409, 'character_not_purchasable', 'That character unlocks through progression or the Pass.');
      }
      const update = applyNuggetLedgerDelta(wallet, -character.nuggetPrice, {
        type: NUGGET_LEDGER_TYPES.CHARACTER_PURCHASE,
        idempotencyKey: `character-purchase:${session.address}:${id}`,
        details: `Permanent character unlock: ${id}`,
        timestamp
      });
      if (update.skipped) throw new ApiError(409, 'character_purchase_duplicate', 'That character purchase was already processed.');
      wallet.expansion.ownedCharacters.push(id);
      wallet.expansion.characterHistory.push({ action: 'PURCHASED', characterId: id, timestamp });
      wallet.expansion.characterHistory = wallet.expansion.characterHistory.slice(-500);
      wallet.updatedAt = timestamp;
      appendActivity(wallet, 'CHARACTER_PURCHASED', `${id}; ${character.nuggetPrice} nuggets`, timestamp);
      return publicExpansion(wallet, state.expansionConfig);
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
      schema: EXPANSION_SCHEMA,
      defaults: defaultExpansionConfig(),
      config: structuredClone(state.expansionConfig),
      blockers: {
        paidRevives: this.revivePaymentVerifier?.publicStatus?.().configured && this.reviveEligibilityValidator
          ? ''
          : 'Exact on-chain revive payment and death replay verifiers are not configured.',
        advertisements: this.advertisementVerifier?.publicStatus?.().configured
          ? ''
          : 'Signed advertisement provider completion verifier is not configured.',
        weeklyCompetition: this.competitiveReplayValidator ? '' : 'Deterministic replay validation is not configured.',
        endless: this.competitiveReplayValidator ? '' : 'Deterministic replay validation is not configured.'
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
        advertisementRewards: this.advertisementVerifier?.publicStatus?.() || {
          configured: false,
          enabled: false
        },
        treasurySafe: {
          address: '0xbace355d23d378a6e1add986e53a18dd12e6eeac',
          owners: 3,
          threshold: 1,
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
      if (
        next.settings.advertisementRewardsEnabled &&
        this.advertisementVerifier?.publicStatus?.().configured !== true
      ) {
        throw new ApiError(503, 'advertisement_provider_disabled', 'Advertisement rewards cannot be enabled until a signed provider verifier is configured.');
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
    if (this.nuggetEconomyStore) {
      const shadowPatch = economyShadowPatch(result.config);
      await this.nuggetEconomyStore.transact((state) => {
        const before = {
          advertisementRewardsEnabled: state.config.advertisementRewardsEnabled === true,
          characterUnlockPrices: { ...state.config.characterUnlockPrices }
        };
        const next = mergeNuggetEconomyConfig(state.config, shadowPatch, 'SERVER_ADMIN_LINK_SYNC', timestamp);
        const changed = JSON.stringify(before) !== JSON.stringify(shadowPatch);
        state.config = next;
        if (changed) {
          addEconomyAudit(
            state,
            'SERVER_ADMIN_LINK_SYNC',
            'LINKED_CONTROLS_SYNCHRONIZED',
            `Expansion revision ${result.config.revision}; ${normalizedReason}`,
            timestamp
          );
        }
      });
    }
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
      const bonusSpan = config.chestBonusMax - config.chestBonusMin;
      const bonus = bonusSpan > 0
        ? config.chestBonusMin + deterministicNumber(`${wallet.address}:${openingNumber}`, bonusSpan + 1)
        : config.chestBonusMin;
      let cosmeticId = config.chestCosmeticDropsEnabled ? config.chestCosmeticId : '';
      const alreadyOwned = cosmeticId && wallet.passInventory.cosmetics.includes(cosmeticId);
      if (alreadyOwned && config.chestDuplicateCosmetic === 'reroll') {
        const unowned = Object.keys(PASS_COSMETICS).filter((id) => !wallet.passInventory.cosmetics.includes(id));
        cosmeticId = unowned.length
          ? unowned[deterministicNumber(`${wallet.address}:${openingNumber}:cosmetic`, unowned.length)]
          : '';
      }
      const duplicateNuggets =
        alreadyOwned && config.chestDuplicateCosmetic === 'nuggets'
          ? config.chestDuplicateNuggets
          : 0;
      const nuggets = config.chestBaseNuggets + bonus + duplicateNuggets;
      const ledgerUpdate = applyNuggetLedgerDelta(wallet, nuggets, {
        type: NUGGET_LEDGER_TYPES.CHEST_REWARD,
        idempotencyKey: `pass-chest:${wallet.address}:${PASS_CHEST_ID}:${openingNumber}`,
        details: `Pass chest opening ${PASS_CHEST_ID}`,
        timestamp
      });
      if (ledgerUpdate.skipped) throw new ApiError(409, 'duplicate_chest_reward', 'That Pass chest reward was already awarded.');
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
      appendActivity(wallet, 'PASS_CHEST_OPENED', `${cosmetic?.name || 'No cosmetic'} and ${nuggets} nuggets`, timestamp);
      return {
        chestId: PASS_CHEST_ID,
        rewards: {
          cosmetic: cosmetic ? structuredClone(cosmetic) : null,
          nuggets,
          baseNuggets: config.chestBaseNuggets,
          bonus,
          duplicateNuggets
        },
        profile: structuredClone(wallet.profile),
        passInventory: structuredClone(wallet.passInventory)
      };
    });
  }

  async requestPaidRevive(token, input = {}) {
    const { session, state: currentState } = await this.authenticateWithState(token);
    if (!this.revivePaymentVerifier?.publicStatus?.().configured || !this.reviveEligibilityValidator) {
      throw new ApiError(503, 'revive_payment_verifier_missing', 'Paid revives are disabled until exact payment and death replay verification are configured.');
    }
    const runId = String(input.runId || '');
    const currentRun = currentState.runs?.[runId];
    if (!currentRun || currentRun.address !== session.address) {
      throw new ApiError(404, 'run_not_found', 'The active run was not found.');
    }
    const verifiedDeath = await this.reviveEligibilityValidator.validate({
      address: session.address,
      runId,
      run: structuredClone(currentRun),
      submission: structuredClone(input.deathState || {})
    });
    const timestamp = this.now();
    return this.database.transact((state) => {
      const run = state.runs[runId];
      if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The active run was not found.');
      if (run.status !== 'active') throw new ApiError(409, 'revive_run_finalized', 'This run can no longer be revived.');
      const config = state.expansionConfig.settings;
      if (!config.paidRevivesEnabled) throw new ApiError(503, 'paid_revives_disabled', 'Paid revives are paused.');
      run.status = 'awaiting-revive';
      run.playerState = structuredClone(verifiedDeath.playerState);
      try {
        const pending = createPendingRevive(run, config, timestamp);
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
    const run = state.runs[runId];
    if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The pending revive was not found.');
    const verified = await this.revivePaymentVerifier.verifyPayment({
      transactionHash,
      address: session.address,
      amountWei: run.pendingRevive?.priceRonWei,
      runId
    });
    return this.database.transact((next) => {
      const activeRun = next.runs[runId];
      if (next.revivePayments[transactionHash]) {
        throw new ApiError(409, 'revive_transaction_duplicate', 'That payment transaction has already been used.');
      }
      let revived;
      try {
        revived = confirmRevive(activeRun, verified, next.expansionConfig.settings, timestamp);
      } catch (error) {
        throw bonusError(error);
      }
      next.revivePayments[transactionHash] = {
        transactionHash,
        address: session.address,
        runId,
        amountWei: verified.amountWei,
        confirmedAt: timestamp
      };
      next.wallets[session.address].expansion.revivePayments[transactionHash] = { runId, timestamp };
      appendActivity(next.wallets[session.address], 'PAID_REVIVE_CONFIRMED', `${runId}; ${transactionHash}`, timestamp);
      appendAudit(next, 'PAID_REVIVE_CONFIRMED', `${session.address}; ${runId}; ${transactionHash}`, timestamp);
      return revived;
    });
  }

  async cancelPaidRevive(token, runIdInput) {
    const session = await this.authenticate(token);
    const runId = String(runIdInput || '');
    return this.database.transact((state) => {
      const run = state.runs[runId];
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

  async skipAdvertisementBonus(token, runId) {
    const session = await this.authenticate(token);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const run = state.runs[String(runId || '')];
      if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The finished run was not found.');
      try {
        return skipAdvertisement(run, timestamp);
      } catch (error) {
        throw bonusError(error);
      }
    });
  }

  async confirmAdvertisementBonus(token, input = {}) {
    const session = await this.authenticate(token);
    if (!this.advertisementVerifier?.publicStatus?.().configured) {
      throw new ApiError(503, 'advertisement_provider_disabled', 'Advertisement rewards require a signed provider completion verifier.');
    }
    const timestamp = this.now();
    return this.database.transact(async (state) => {
      const run = state.runs[String(input.runId || '')];
      const wallet = state.wallets[session.address];
      if (!run || run.address !== session.address) throw new ApiError(404, 'run_not_found', 'The finished run was not found.');
      const config = state.expansionConfig.settings;
      if (!advertisementModeEligible(run.mode, config)) {
        throw new ApiError(409, 'advertisement_mode_ineligible', 'This run mode is not eligible for an advertisement bonus.');
      }
      const dayStart = Math.floor(timestamp / 86_400_000) * 86_400_000;
      const awardedToday = Object.values(wallet.expansion.adCompletions || {})
        .filter((entry) => Number(entry.timestamp || 0) >= dayStart).length;
      if (awardedToday >= config.advertisementDailyWalletLimit) {
        throw new ApiError(409, 'advertisement_daily_limit', 'This wallet reached its UTC daily advertisement reward limit.');
      }
      try {
        return await awardVerifiedAdvertisement({
          wallet,
          run,
          completion: input.completion,
          config,
          verifier: this.advertisementVerifier,
          timestamp
        });
      } catch (error) {
        throw bonusError(error);
      }
    });
  }

  async adminNuggetEconomy(adminKey) {
    await this.ensureAdminControlLinks();
    return super.adminNuggetEconomy(adminKey);
  }

  async updateAdminNuggetEconomy(adminKey, patch, reason) {
    this.assertAdminKey(adminKey);
    if (
      patch?.advertisementRewardsEnabled === true &&
      this.advertisementVerifier?.publicStatus?.().configured !== true
    ) {
      throw new ApiError(
        503,
        'advertisement_provider_disabled',
        'Advertisement rewards cannot be enabled until a signed provider or server-to-server completion verifier is configured.'
      );
    }
    const normalizedReason = adminReason(reason);
    const timestamp = this.now();
    const result = await super.updateAdminNuggetEconomy(adminKey, patch, normalizedReason);
    this.adminControlLinkPromise = null;
    const linkedChanges = await this.database.transact((state) => {
      const changes = applyEconomyLinksToExpansion(state, result.editableConfig, timestamp);
      applyExpansionLinksToTuning(state);
      if (changes.length) {
        appendAudit(
          state,
          'LINKED_ADMIN_CONTROLS_UPDATED',
          `${changes.join('; ')}; ${normalizedReason}`,
          timestamp
        );
      }
      return changes;
    });
    return { ...result, linkedChanges };
  }

  async quoteNuggetPurchase(token, input = {}) {
    await this.pruneExpiredPaymentReservations();
    return super.quoteNuggetPurchase(token, input);
  }

  async quotePracticeClaim(token, input = {}) {
    await this.pruneExpiredPaymentReservations();
    return super.quotePracticeClaim(token, input);
  }

  async reserveQuote(input) {
    await this.pruneExpiredPaymentReservations();
    return super.reserveQuote(input);
  }

  async practiceRunClaim(token, payload = {}) {
    const result = await super.practiceRunClaim(token, payload);
    if (!result?.alreadyConfirmed || result.profile) return result;
    const player = await super.me(token);
    const state = await this.database.read();
    const wallet = state.wallets[player.address];
    const claim = wallet?.practiceClaims?.[payload.runId];
    return {
      ...result,
      practiceClaim: structuredClone(claim || result.practiceClaim),
      profile: structuredClone(wallet?.profile || player.profile)
    };
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
    const runId = String(payload?.runId || '');
    if (
      pendingRun &&
      this.competitiveReplayValidator?.publicStatus?.().modes?.includes(pendingRun.mode)
    ) {
      await this.competitiveReplayValidator.finalize(runId, 'finished').catch(() => undefined);
    }
    const finished = result?.run?.result;
    const isDeathRetention =
      result?.accepted === true &&
      finished &&
      finished.extracted === false &&
      result.run?.mode !== 'practice' &&
      Number(finished.banked || 0) > 0;
    if (!isDeathRetention) return result;

    const timestamp = this.now();
    const corrected = await this.database.transact((state) => {
      const run = state.runs[runId];
      const wallet = run ? state.wallets[run.address] : null;
      if (!wallet) return null;
      const sourceKey = `run-complete:${runId}:banked`;
      const source = findLedgerEntryByIdempotency(wallet.nuggetLedger, sourceKey);
      if (!source || source.type !== NUGGET_LEDGER_TYPES.RUN_EXTRACTION) return null;

      const correctionKey = `run-death-retention:${runId}:reverse`;
      const creditKey = `run-death-retention:${runId}:credit`;
      if (findLedgerEntryByIdempotency(wallet.nuggetLedger, creditKey)) {
        return structuredClone(wallet.profile);
      }

      applyNuggetLedgerDelta(wallet, -source.amount, {
        type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
        runId,
        idempotencyKey: correctionKey,
        adminActor: 'SYSTEM_CLASSIFICATION',
        details: `Append-only reversal of legacy extraction classification for knockout run ${runId}`,
        timestamp
      });
      applyNuggetLedgerDelta(wallet, source.amount, {
        type: NUGGET_LEDGER_TYPES.RUN_DEATH_RETENTION,
        runId,
        idempotencyKey: creditKey,
        adminActor: 'SYSTEM_CLASSIFICATION',
        details: `Server-validated knockout retention for run ${runId}`,
        timestamp
      });
      wallet.updatedAt = timestamp;
      wallet.activity ||= [];
      wallet.activity.push({
        id: `activity-${timestamp}-${wallet.activity.length + 1}`,
        action: 'RUN_DEATH_RETENTION_RECORDED',
        details: `${runId}; retained ${source.amount} nuggets`,
        timestamp
      });
      wallet.activity = wallet.activity.slice(-500);
      state.audit ||= [];
      state.audit.push({
        id: `audit-${timestamp}-${state.audit.length + 1}`,
        actor: 'SYSTEM_CLASSIFICATION',
        action: 'RUN_DEATH_RETENTION_RECORDED',
        details: `${runId}; retained ${source.amount} nuggets using append-only correction`,
        timestamp
      });
      state.audit = state.audit.slice(-2_000);
      return structuredClone(wallet.profile);
    });

    return corrected
      ? { ...result, profile: corrected }
      : result;
  }

  async pruneExpiredPaymentReservations() {
    if (!this.nuggetEconomyStore) return;
    const timestamp = this.now();
    await this.nuggetEconomyStore.transact((state) => {
      for (const quote of Object.values(state.quotes || {})) {
        if (quote.status !== 'verifying' || quote.expiresAt > timestamp) continue;
        quote.status = 'expired';
        quote.failureCode = 'quote_expired';
        const hash = quote.transactionHash;
        quote.transactionHash = '';
        if (
          hash &&
          state.usedTransactions?.[hash]?.quoteId === quote.id &&
          !state.usedTransactions[hash].confirmedAt
        ) {
          delete state.usedTransactions[hash];
        }
      }
    });
  }
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
      advertisementRewardsEnabled: false,
      weeklyCompetitionEnabled: config?.settings?.weeklyCompetitionEnabled === true,
      endlessEnabled: config?.settings?.endlessEnabled === true
    }
  };
}

function advertisementModeEligible(mode, config) {
  return (
    (mode === 'practice' && config.advertisementPracticeEligible) ||
    (mode === 'free' && config.advertisementFreeEligible) ||
    (mode === 'paid' && config.advertisementPaidEligible)
  );
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

function normalizedWallet(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) throw new ApiError(400, 'invalid_address', 'A valid Ronin wallet address is required.');
  return address;
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

function appendAudit(state, action, details, timestamp) {
  state.audit ||= [];
  state.audit.push({
    id: `audit-${timestamp}-${state.audit.length + 1}`,
    actor: 'SERVER_ADMIN',
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
