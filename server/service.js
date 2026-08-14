import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { META_UPGRADES, metaUpgradeCost } from '../src/game/config.js';
import { GAMEPLAY_LOBBIES, GAME_TUNING_SCHEMA, normalizeTuningPatch } from '../src/game/tuning.js';
import { normalizeKeybindings } from '../src/game/keybindings.js';
import { passLevel, utcDayKey, utcWeekKey } from '../src/game/economy.js';
import {
  COSMETIC_SLOTS,
  PASS_CHEST_BONUS_NUGGETS,
  PASS_CHEST_ID,
  PASS_COSMETICS,
  PASS_REWARD_LEVELS,
  canEquipCosmetic
} from '../src/game/passRewards.js';
import {
  AUTH_CHALLENGE_TTL_MS,
  MAX_RUN_SCORE,
  MIN_RANKED_RUN_WINDOW_MS,
  RONIN_CHAINS,
  RUN_TTL_MS,
  SERVER_RUN_MODES,
  SESSION_TTL_MS
} from './constants.js';
import { buildSignInMessage, normalizeOrigin } from './auth-message.js';
import { ApiError, assertApi } from './errors.js';
import { PRACTICE_PLAY_POLICY } from './nft-play-policy.js';
import { validateAvatarDataUrl, validateUsername } from './identity.js';
import { MATT_MINE_LAUNCH_PRICES } from './payment-verifier.js';
import { isTransientPostgresError } from './postgres-resilience.js';
import { applyMinePassGameplayBenefits } from './pass-benefits.js';
import { defaultWalletState } from './state.js';
import {
  createAdminSafeTransactionFile,
  listAdminContractActions,
  MATT_MINE_ADMIN_CONTRACTS,
  prepareAdminContractTransactions
} from './admin-controls.js';
import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta
} from './nugget-ledger.js';
import { applyTuningLinksToExpansion } from './admin-control-links.js';
import {
  consumeWeeklyAttempt,
  endlessLeaderboard,
  endlessSnapshot,
  finishWeeklyAttempt,
  openWeeklyStage,
  weeklyLeaderboard
} from './competition-engine.js';
import {
  COMPETITION_SLOTS,
  competitionSlotForMode,
  normalizeCompetitionDraft,
  resolveCompetitionSnapshot,
  validateCompetitionDraft
} from '../src/game/competitionStudio.js';

const FREE_PASS_XP = 25;
const PAID_PASS_XP = 100;
const ARENA_PASS_XP = PAID_PASS_XP;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_STEP_UP_TTL_MS = 5 * 60 * 1000;

export class MattMineService {
  constructor(database, options = {}) {
    this.database = database;
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || ((bytes) => randomBytes(bytes).toString('hex'));
    this.verifySignature = options.verifySignature || verifyMessage;
    this.paymentVerifier = options.paymentVerifier || null;
    this.rewardManager = options.rewardManager || null;
    this.arenaService = options.arenaService || null;
    this.nftMetadataService = options.nftMetadataService || null;
    this.nftGameplayService = options.nftGameplayService || null;
    this.arenaLeaderboardRequests = new Map();
    this.mainnetTransactionsEnabled =
      options.mainnetTransactionsEnabled === true && Boolean(this.paymentVerifier);
    const configuredChainId = Number(options.chainId ?? RONIN_CHAINS.MAINNET);
    this.publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : null;
    this.adminKey = options.adminKey || '';
    this.adminWalletAllowlist = new Set((Array.isArray(options.adminWallets) ? options.adminWallets : [])
      .map((address) => String(address).toLowerCase())
      .filter((address) => /^0x[a-f0-9]{40}$/.test(address)));
    this.appVersion = String(options.appVersion || 'unknown');
    this.buildCommit = String(options.buildCommit || process.env.RENDER_GIT_COMMIT || 'unknown').slice(0, 80);
    this.eligibilityPolicy = options.eligibilityPolicy || null;
    const walletConnectProjectId = String(options.walletConnectProjectId || '').trim();
    assertApi(
      !walletConnectProjectId || /^[a-fA-F0-9]{32}$/.test(walletConnectProjectId),
      500,
      'invalid_walletconnect_project_id',
      'VITE_WALLETCONNECT_PROJECT_ID must be a 32-character Reown project ID.'
    );
    this.walletConnectProjectId = walletConnectProjectId;
    assertApi(
      configuredChainId === RONIN_CHAINS.MAINNET,
      500,
      'invalid_server_chain',
      'MATT Mine only supports Ronin Mainnet (chain 2020).'
    );
    this.chainId = RONIN_CHAINS.MAINNET;
  }

  config() {
    return {
      chainId: this.chainId,
      chainName: 'Ronin Mainnet',
      walletMode: this.walletConnectProjectId
        ? 'ronin-injected-or-walletconnect'
        : 'ronin-injected-provider',
      walletConnect: {
        enabled: Boolean(this.walletConnectProjectId),
        projectId: this.walletConnectProjectId
      },
      rankedServerEnabled: true,
      paidRunsEnabled: this.mainnetTransactionsEnabled,
      realPaymentsEnabled: this.mainnetTransactionsEnabled,
      mattClaimsEnabled: Boolean(this.rewardManager),
      mainnetTransactionsEnabled: this.mainnetTransactionsEnabled,
      practice: PRACTICE_PLAY_POLICY,
      arena: this.arenaService
        ? this.arenaService.publicConfig()
        : { enabled: false },
      nft: this.nftMetadataService
        ? {
            ...this.nftMetadataService.publicStatus(),
            gameplay: this.nftGameplayService
              ? this.nftGameplayService.publicStatus()
              : { enabled: false }
          }
        : { enabled: false },
      eligibility: this.eligibilityPolicy
        ? this.eligibilityPolicy.publicStatus()
        : { configured: process.env.NODE_ENV !== 'production' },
      operations: awaitlessPublicOperations(this.cachedOperations),
      ...(this.rewardManager
        ? { rewards: this.rewardManager.publicConfig() }
        : {}),
      ...(this.mainnetTransactionsEnabled
        ? { payments: this.paymentVerifier.publicConfig() }
        : {})
    };
  }

  async health() {
    let database;
    try {
      database = await this.database.healthCheck();
      if (!this.cachedOperations) {
        const state = await this.database.read();
        this.cachedOperations = state.operations;
      }
    } catch (error) {
      database = {
        ok: false,
        kind: this.database.kind || 'unknown',
        temporarilyUnavailable: isTransientPostgresError(error)
      };
    }
    let arena;
    try {
      arena = this.arenaService
        ? await this.arenaService.health()
        : { enabled: false };
    } catch (error) {
      arena = {
        enabled: Boolean(this.arenaService),
        ok: false,
        temporarilyUnavailable: isTransientPostgresError(error)
      };
    }
    return {
      version: this.appVersion,
      commit: this.buildCommit,
      database,
      degraded: database.ok === false || arena.ok === false,
      chainId: this.chainId,
      paymentsEnabled: this.mainnetTransactionsEnabled,
      rewardsEnabled: Boolean(this.rewardManager),
      rewardPublishingEnabled: this.rewardManager?.publicationEnabled === true,
      arena
    };
  }

  async publicPaymentStatus() {
    if (this.mainnetTransactionsEnabled) return this.paymentVerifier.publicStatus();
    return {
      live: false,
      pass: {
        priceRonWei: MATT_MINE_LAUNCH_PRICES.passPriceRonWei,
        paused: true
      },
      paidRuns: {
        priceRonWei: MATT_MINE_LAUNCH_PRICES.paidRunPriceRonWei,
        paused: true
      }
    };
  }

  async createChallenge({ address, chainId, origin }) {
    const normalizedAddress = normalizeAddress(address);
    const normalizedOrigin = normalizeOrigin(origin);
    const requestedChainId = Number(chainId);
    assertApi(requestedChainId === this.chainId, 409, 'wrong_chain', `Switch Ronin Wallet to chain ${this.chainId}.`);
    if (this.publicOrigin) {
      assertApi(normalizedOrigin === this.publicOrigin, 403, 'origin_mismatch', 'Sign-in origin does not match the configured MATT Mine origin.');
    }

    const timestamp = this.now();
    const nonce = this.randomHex(12);
    const issuedAt = new Date(timestamp).toISOString();
    const expirationTime = new Date(timestamp + AUTH_CHALLENGE_TTL_MS).toISOString();
    const message = buildSignInMessage({
      origin: normalizedOrigin,
      address: normalizedAddress,
      chainId: this.chainId,
      nonce,
      issuedAt,
      expirationTime
    });

    await this.database.transact((state) => {
      pruneSecurityRecords(state, timestamp);
      for (const [key, challenge] of Object.entries(state.challenges)) {
        if (challenge.address === normalizedAddress) delete state.challenges[key];
      }
      state.challenges[nonce] = {
        nonce,
        address: normalizedAddress,
        chainId: this.chainId,
        origin: normalizedOrigin,
        message,
        createdAt: timestamp,
        expiresAt: timestamp + AUTH_CHALLENGE_TTL_MS
      };
      addAudit(state, normalizedAddress, 'AUTH_CHALLENGE_CREATED', `chain ${this.chainId}`, timestamp);
    });

    return { address: normalizedAddress, chainId: this.chainId, nonce, message, expirationTime };
  }

  async verifyChallenge({ address, nonce, signature }) {
    const normalizedAddress = normalizeAddress(address);
    assertApi(typeof nonce === 'string' && /^[a-f0-9]{24}$/.test(nonce), 400, 'invalid_nonce', 'The sign-in nonce is invalid.');
    assertApi(typeof signature === 'string' && /^0x[a-fA-F0-9]{130}$/.test(signature), 400, 'invalid_signature', 'The wallet signature is invalid.');
    const timestamp = this.now();
    const snapshot = await this.database.read();
    const challenge = snapshot.challenges[nonce];
    assertApi(challenge, 401, 'challenge_not_found', 'The sign-in challenge is missing or already used.');
    assertApi(challenge.address === normalizedAddress, 401, 'address_mismatch', 'The signature address does not match the challenge.');
    assertApi(challenge.chainId === this.chainId, 401, 'chain_mismatch', 'The sign-in challenge was created for another chain.');
    assertApi(challenge.expiresAt > timestamp, 401, 'challenge_expired', 'The sign-in challenge expired. Request a new one.');

    const valid = await this.verifySignature({
      address: normalizedAddress,
      message: challenge.message,
      signature
    });
    assertApi(valid, 401, 'signature_rejected', 'Ronin Wallet signature verification failed.');

    const token = this.randomHex(32);
    const tokenHash = hashToken(token);
    const expiresAt = timestamp + SESSION_TTL_MS;
    const result = await this.database.transact((state) => {
      const current = state.challenges[nonce];
      assertApi(current && current.expiresAt > timestamp, 401, 'challenge_used', 'The sign-in challenge was already used.');
      delete state.challenges[nonce];
      if (!state.wallets[normalizedAddress]) state.wallets[normalizedAddress] = defaultWalletState(normalizedAddress, timestamp);
      state.sessions[tokenHash] = {
        tokenHash,
        address: normalizedAddress,
        createdAt: timestamp,
        expiresAt
      };
      state.wallets[normalizedAddress].updatedAt = timestamp;
      addAudit(state, normalizedAddress, 'SESSION_CREATED', `expires ${new Date(expiresAt).toISOString()}`, timestamp);
      return publicWalletSnapshot(state, normalizedAddress, timestamp);
    });

    result.entitlements.paidRunsEnabled = this.mainnetTransactionsEnabled;
    const hydrated = await this.hydratePlayerScores(result);
    return { token, expiresAt, ...hydrated };
  }

  async signOut(token) {
    const tokenHash = hashToken(assertToken(token));
    await this.database.transact((state) => {
      delete state.sessions[tokenHash];
    });
    return { signedOut: true };
  }

  async me(token) {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const player = publicWalletSnapshot(state, session.address, this.now());
    player.entitlements.paidRunsEnabled = this.mainnetTransactionsEnabled;
    const hydrated = await this.hydratePlayerScores(player);
    if (this.nftMetadataService) {
      const miners = typeof this.nftMetadataService.playerMiners === 'function'
        ? await this.nftMetadataService.playerMiners(session.address)
        : [await this.nftMetadataService.playerMiner(session.address)].filter(Boolean);
      hydrated.nftMiners = miners;
      hydrated.nftMiner = miners[0] || null;
    }
    return hydrated;
  }

  async setPlayerIdentity(token, input = {}) {
    const session = await this.authenticate(token);
    const username = validateUsername(input.name);
    const avatarDataUrl = validateAvatarDataUrl(input.avatarDataUrl, { optional: true });
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      assertApi(!wallet.identity.name, 409, 'username_permanent', 'Your miner name is already set and cannot be changed.');
      const duplicate = Object.values(state.wallets).find((candidate) =>
        candidate.address !== session.address &&
        candidate.identity?.nameKey === username.key
      );
      assertApi(!duplicate, 409, 'username_taken', 'That miner name is already taken.');
      wallet.identity = {
        name: username.name,
        nameKey: username.key,
        avatarDataUrl,
        createdAt: timestamp,
        avatarUpdatedAt: avatarDataUrl ? timestamp : 0
      };
      wallet.updatedAt = timestamp;
      addAudit(state, session.address, 'MINER_IDENTITY_CREATED', username.name, timestamp);
      return { identity: publicIdentity(wallet) };
    });
  }

  async updatePlayerAvatar(token, avatarDataUrl) {
    const session = await this.authenticate(token);
    const normalizedAvatar = validateAvatarDataUrl(avatarDataUrl);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      assertIdentityReady(wallet);
      wallet.identity.avatarDataUrl = normalizedAvatar;
      wallet.identity.avatarUpdatedAt = Math.max(timestamp, Number(wallet.identity.avatarUpdatedAt || 0) + 1);
      wallet.updatedAt = timestamp;
      addAudit(state, session.address, 'MINER_AVATAR_UPDATED', `${normalizedAvatar.length} bytes encoded`, timestamp);
      return { identity: publicIdentity(wallet) };
    });
  }

  async updatePlayerKeybindings(token, input) {
    const session = await this.authenticate(token);
    let keybindings;
    try {
      keybindings = normalizeKeybindings(input);
    } catch (error) {
      throw new ApiError(422, 'invalid_keybindings', error.message);
    }
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      wallet.keybindings = keybindings;
      wallet.updatedAt = timestamp;
      addPlayerActivity(wallet, 'KEYBINDINGS_UPDATED', 'Custom controls saved', timestamp);
      addAudit(state, session.address, 'KEYBINDINGS_UPDATED', 'Custom controls saved', timestamp);
      return { keybindings: structuredClone(keybindings) };
    });
  }

  async profileAvatar(address) {
    const normalizedAddress = normalizeAddress(address);
    const state = await this.database.read();
    const wallet = state.wallets[normalizedAddress];
    const match = wallet?.identity?.avatarDataUrl?.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
    assertApi(match, 404, 'avatar_missing', 'This miner has not uploaded a profile picture.');
    return {
      contentType: `image/${match[1]}`,
      body: Buffer.from(match[2], 'base64'),
      updatedAt: Number(wallet.identity.avatarUpdatedAt || 0)
    };
  }

  async paymentStatus(token) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const state = await this.database.read();
    const wallet = requireWallet(state, session.address);
    const chain = await this.paymentVerifier.status(session.address);
    return {
      address: session.address,
      suspended: wallet.suspended,
      confirmedCredits: unusedPaidEntitlements(state, session.address).length,
      passProgress: publicPassProgress(wallet),
      passInventory: publicPassInventory(wallet),
      ...chain
    };
  }

  async confirmPassPurchase(token, transactionHash) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const before = await this.database.read();
    assertApi(!before.operations.purchasesPaused, 503, 'server_purchases_paused', 'Pass purchases are temporarily paused by MATT Mine.');
    assertMineOperationOpen(before.operations, 'pass', 'payments', 'Pass payments are paused in the Mine Operations console.');
    const wallet = requireWallet(before, session.address);
    assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from Pass purchases.');
    const verified = await this.paymentVerifier.verifyPassPurchase(transactionHash, session.address);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const currentWallet = requireWallet(state, session.address);
      assertApi(!currentWallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from Pass purchases.');
      const existing = state.passPurchases[verified.key];
      if (existing) {
        assertApi(existing.address === session.address, 409, 'payment_already_owned', 'This Pass payment is already registered to another wallet.');
        return {
          purchase: structuredClone(existing),
          passProgress: publicPassProgress(currentWallet),
          passInventory: publicPassInventory(currentWallet),
          rewards: [],
          alreadyConfirmed: true
        };
      }
      state.passPurchases[verified.key] = {
        ...verified,
        confirmedAt: timestamp
      };
      const rewards = syncPassRewardsForWallet(currentWallet, timestamp);
      currentWallet.updatedAt = timestamp;
      addAudit(
        state,
        session.address,
        'PASS_PAYMENT_CONFIRMED',
        `${verified.transactionHash} expires ${new Date(verified.expiresAt).toISOString()}`,
        timestamp
      );
      return {
        purchase: structuredClone(state.passPurchases[verified.key]),
        passProgress: publicPassProgress(currentWallet),
        passInventory: publicPassInventory(currentWallet),
        rewards,
        alreadyConfirmed: false
      };
    });
  }

  async passRewards(token) {
    const session = await this.authenticate(token);
    const state = await this.database.read();
    const wallet = requireWallet(state, session.address);
    return {
      passProgress: publicPassProgress(wallet),
      passInventory: publicPassInventory(wallet)
    };
  }

  async syncPassRewards(token) {
    const session = await this.authenticate(token);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from Pass rewards.');
      const hasPassHistory = Object.values(state.passPurchases)
        .some((purchase) => purchase.address === session.address);
      assertApi(hasPassHistory, 403, 'pass_not_owned', 'Purchase the MATT Mine Pass before unlocking Pass rewards.');
      const rewards = syncPassRewardsForWallet(wallet, timestamp);
      wallet.updatedAt = timestamp;
      if (rewards.length) {
        addAudit(state, session.address, 'PASS_REWARDS_UNLOCKED', rewards.map((reward) => reward.name).join(', '), timestamp);
      }
      return {
        rewards,
        passProgress: publicPassProgress(wallet),
        passInventory: publicPassInventory(wallet)
      };
    });
  }

  async equipPassCosmetic(token, slot, cosmeticId) {
    const session = await this.authenticate(token);
    const normalizedSlot = String(slot || '');
    const normalizedCosmeticId = String(cosmeticId || '');
    assertApi(COSMETIC_SLOTS.includes(normalizedSlot), 400, 'cosmetic_slot_invalid', 'Choose a valid cosmetic slot.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from cosmetic changes.');
      if (normalizedCosmeticId) {
        assertApi(
          canEquipCosmetic(wallet.passInventory, normalizedSlot, normalizedCosmeticId),
          403,
          'cosmetic_not_owned',
          'That cosmetic is not owned by this wallet.'
        );
      }
      wallet.passInventory.equipped[normalizedSlot] = normalizedCosmeticId;
      wallet.updatedAt = timestamp;
      addAudit(
        state,
        session.address,
        normalizedCosmeticId ? 'PASS_COSMETIC_EQUIPPED' : 'PASS_COSMETIC_UNEQUIPPED',
        `${normalizedSlot}: ${normalizedCosmeticId || 'none'}`,
        timestamp
      );
      return { passInventory: publicPassInventory(wallet) };
    });
  }

  async openPassChest(token, chestId) {
    const session = await this.authenticate(token);
    const normalizedChestId = String(chestId || '');
    assertApi(normalizedChestId === PASS_CHEST_ID, 400, 'pass_chest_invalid', 'Choose a valid Pass Chest.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from opening Pass rewards.');
      const chest = wallet.passInventory.chests[PASS_CHEST_ID];
      assertApi(chest.available > 0, 409, 'pass_chest_unavailable', 'No unopened Pass Chest is available.');
      chest.available -= 1;
      chest.opened += 1;
      chest.lastOpenedAt = timestamp;
      unlockCosmetic(wallet, 'molten_pickaxe');
      if (!wallet.passInventory.equipped.weapon) wallet.passInventory.equipped.weapon = 'molten_pickaxe';
      const ledgerUpdate = applyNuggetLedgerDelta(wallet, PASS_CHEST_BONUS_NUGGETS, {
        type: NUGGET_LEDGER_TYPES.CHEST_REWARD,
        idempotencyKey: `pass-chest:${wallet.address}:${PASS_CHEST_ID}:${chest.opened}`,
        details: `Pass chest opening ${PASS_CHEST_ID}`
      });
      assertApi(!ledgerUpdate.skipped, 409, 'duplicate_chest_reward', 'That Pass chest reward was already awarded.');
      wallet.updatedAt = timestamp;
      addAudit(
        state,
        session.address,
        'PASS_CHEST_OPENED',
        `Molten Pickaxe and ${PASS_CHEST_BONUS_NUGGETS} nuggets`,
        timestamp
      );
      return {
        chestId: PASS_CHEST_ID,
        rewards: {
          cosmetic: structuredClone(PASS_COSMETICS.molten_pickaxe),
          nuggets: PASS_CHEST_BONUS_NUGGETS
        },
        profile: structuredClone(wallet.profile),
        passInventory: publicPassInventory(wallet)
      };
    });
  }

  async quotePaidRun(token) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const state = await this.database.read();
    assertApi(!state.operations.purchasesPaused, 503, 'server_purchases_paused', 'Paid-run purchases are temporarily paused by MATT Mine.');
    assertMineOperationOpen(state.operations, 'pass', 'payments', 'Pass Mine payments are paused.');
    const wallet = requireWallet(state, session.address);
    assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from paid-run purchases.');
    return this.paymentVerifier.quotePaidRun(session.address);
  }

  async confirmPaidRunPurchase(token, transactionHash) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const before = await this.database.read();
    assertApi(!before.operations.purchasesPaused, 503, 'server_purchases_paused', 'Paid-run purchases are temporarily paused by MATT Mine.');
    assertMineOperationOpen(before.operations, 'pass', 'payments', 'Pass Mine payments are paused.');
    const wallet = requireWallet(before, session.address);
    assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from paid-run purchases.');
    const verified = await this.paymentVerifier.verifyPaidRunPurchase(transactionHash, session.address);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const currentWallet = requireWallet(state, session.address);
      assertApi(!currentWallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from paid-run purchases.');
      const existing = state.paidEntitlements[verified.key];
      if (existing) {
        assertApi(existing.address === session.address, 409, 'payment_already_owned', 'This payment is already registered to another wallet.');
        return {
          entitlement: structuredClone(existing),
          confirmedCredits: unusedPaidEntitlements(state, session.address).length,
          alreadyConfirmed: true
        };
      }
      state.paidEntitlements[verified.key] = {
        ...verified,
        confirmedAt: timestamp,
        consumedAt: 0,
        usedRunId: ''
      };
      addAudit(
        state,
        session.address,
        'PAID_RUN_PAYMENT_CONFIRMED',
        `${verified.transactionHash} entitlement ${verified.entitlementId}`,
        timestamp
      );
      return {
        entitlement: structuredClone(state.paidEntitlements[verified.key]),
        confirmedCredits: unusedPaidEntitlements(state, session.address).length,
        alreadyConfirmed: false
      };
    });
  }

  async startRun(token, mode) {
    const session = await this.authenticate(token);
    const normalizedMode = String(mode || '');
    assertApi(Object.values(SERVER_RUN_MODES).includes(normalizedMode), 400, 'invalid_run_mode', 'Unknown run mode.');
    const operationState = await this.database.read();
    assertApi(!operationState.operations.maintenanceMode, 503, 'maintenance_mode', operationState.operations.announcement || 'MATT Mine is temporarily under maintenance.');
    if (normalizedMode === SERVER_RUN_MODES.FREE) {
      assertApi(!operationState.operations.freeRankedPaused, 503, 'free_ranked_paused', 'Free ranked runs are temporarily paused.');
    }
    if (normalizedMode === SERVER_RUN_MODES.PAID) {
      assertApi(!operationState.operations.passRankedPaused, 503, 'pass_ranked_paused', 'Pass ranked runs are temporarily paused.');
    }
    const operationMine = mineForRunMode(normalizedMode);
    if (operationMine) {
      assertMineOperationOpen(operationState.operations, operationMine, 'entries', `${mineDisplayName(operationMine)} is not accepting new runs.`);
    }
    if (normalizedMode === SERVER_RUN_MODES.BETA) {
      assertApi(operationState.expansionConfig.settings.betaModeEnabled, 503, 'beta_mode_disabled', 'Beta Testing is currently disabled.');
      assertApi(operationState.wallets[session.address]?.expansion?.betaTester === true, 403, 'beta_access_required', 'This wallet is not approved for Beta Testing.');
    }
    if (normalizedMode === SERVER_RUN_MODES.WEEKLY) {
      assertApi(operationState.expansionConfig.settings.weeklyCompetitionEnabled, 503, 'weekly_competition_disabled', 'Weekly competition is not open.');
    }
    if (normalizedMode === SERVER_RUN_MODES.ENDLESS) {
      assertApi(operationState.expansionConfig.settings.endlessEnabled, 503, 'endless_mode_disabled', 'Endless mode is not open.');
    }
    let passActiveAtStart = false;
    let paymentStatus = null;
    if (this.mainnetTransactionsEnabled && normalizedMode !== SERVER_RUN_MODES.BETA) {
      paymentStatus = typeof this.paymentVerifier?.status === 'function'
        ? await this.paymentVerifier.status(session.address).catch((error) => {
            if (normalizedMode === SERVER_RUN_MODES.PAID) throw error;
            return null;
          })
        : null;
      passActiveAtStart = paymentStatus?.pass?.active === true;
    }
    if (normalizedMode === SERVER_RUN_MODES.PAID) {
      assertApi(
        this.mainnetTransactionsEnabled,
        403,
        'paid_runs_disabled',
        'Paid ranked runs remain disabled until live payment verification is enabled.'
      );
      assertApi(paymentStatus.pass.active, 403, 'active_pass_required', 'An active MATT Mine Pass is required.');
      assertApi(!paymentStatus.paidRuns.paused, 503, 'paid_runs_paused', 'Paid ranked runs are currently paused.');
    }
    const timestamp = this.now();
    const runId = `run_${this.randomHex(12)}`;
    const runToken = this.randomHex(24);
    const runTokenHash = hashToken(runToken);

    return this.database.transact(async (state, transaction) => {
      const wallet = requireWallet(state, session.address);
      await expireOldRuns(state, timestamp, transaction);
      const betaMode = normalizedMode === SERVER_RUN_MODES.BETA;
      if (normalizedMode !== SERVER_RUN_MODES.PRACTICE && !betaMode) {
        assertIdentityReady(wallet);
        assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from ranked play.');
        const activeRanked = Object.values(state.runs).find((run) =>
          run.address === session.address &&
          ![SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.BETA].includes(run.mode) &&
          run.status === 'active'
        );
        assertApi(!activeRanked, 409, 'ranked_run_active', 'Finish or expire the current ranked run before starting another.');
      }

      const day = utcDayKey(timestamp);
      const week = utcWeekKey(timestamp);
      const weekEndsAt = Date.parse(`${week}T00:00:00.000Z`) + 7 * 24 * 60 * 60 * 1000;
      if (normalizedMode !== SERVER_RUN_MODES.PRACTICE && !betaMode) {
        assertApi(
          weekEndsAt - timestamp >= MIN_RANKED_RUN_WINDOW_MS,
          409,
          'ranked_window_closing',
          'Ranked entries are closed for the final five minutes so the leaderboard can finalize exactly at zero.'
        );
      }
      const competitionSlotId = competitionSlotForMode(normalizedMode);
      const competitionSnapshot = competitionSlotId
        ? resolveCompetitionSnapshot(state.competitionStudio, competitionSlotId, timestamp)
        : null;
      const authoredAttemptLimit = Math.max(0, Math.floor(competitionSnapshot?.rules?.attemptLimit || 0));
      if (authoredAttemptLimit > 0 && normalizedMode === SERVER_RUN_MODES.PAID) {
        const attempts = Object.values(state.runs).filter((existingRun) =>
          existingRun.address === session.address &&
          existingRun.day === day &&
          existingRun.competitionSlotId === competitionSlotId &&
          existingRun.competitionSnapshot?.id === competitionSnapshot.id &&
          ['active', 'finished'].includes(existingRun.status)
        ).length;
        assertApi(
          attempts < authoredAttemptLimit,
          409,
          'competition_attempt_limit',
          `This mine allows ${authoredAttemptLimit} attempt${authoredAttemptLimit === 1 ? '' : 's'} per UTC day.`
        );
      }
      if (normalizedMode === SERVER_RUN_MODES.FREE) {
        const daily = wallet.daily[day] || { freeRunUsed: false, freeRunId: '' };
        assertApi(!daily.freeRunUsed, 409, 'free_run_used', 'Today’s free ranked run has already been used.');
        wallet.daily[day] = { freeRunUsed: true, freeRunId: runId };
      }
      if (normalizedMode === SERVER_RUN_MODES.PAID) {
        const entitlement = unusedPaidEntitlements(state, session.address)[0];
        assertApi(entitlement, 409, 'paid_run_credit_required', 'Purchase and confirm a paid-run credit first.');
        entitlement.consumedAt = timestamp;
        entitlement.usedRunId = runId;
      }

      let weeklyStage = null;
      if (normalizedMode === SERVER_RUN_MODES.WEEKLY) {
        const weekStartedAt = Date.parse(`${week}T00:00:00.000Z`);
        const dayNumber = Math.floor((timestamp - weekStartedAt) / 86_400_000) + 1;
        assertApi(dayNumber <= state.expansionConfig.settings.weeklyActiveDayCount, 409, 'weekly_stage_locked', 'This weekly stage is not open yet.');
        weeklyStage = openWeeklyStage(state.weeklyCompetition, week, dayNumber, state.expansionConfig, timestamp);
        try {
          consumeWeeklyAttempt(state.weeklyCompetition, week, dayNumber, session.address, runId, timestamp);
        } catch (error) {
          throw new ApiError(409, error.message, error.message === 'weekly_attempt_used'
            ? 'Today’s weekly competition attempt has already been used.'
            : 'The weekly stage is unavailable.');
        }
      }

      const seed = normalizedMode === SERVER_RUN_MODES.FREE
        ? `MATT-MINE-${day}-FREE`
        : normalizedMode === SERVER_RUN_MODES.PAID
          ? `MATT-MINE-${day}-PAID`
          : normalizedMode === SERVER_RUN_MODES.WEEKLY
            ? weeklyStage.seed
            : normalizedMode === SERVER_RUN_MODES.ENDLESS
              ? `MATT-ENDLESS-${week}-${session.address}`
              : normalizedMode === SERVER_RUN_MODES.BETA
                ? `MATT-BETA-${day}-${this.randomHex(10)}`
                : `MATT-PRACTICE-${day}-${this.randomHex(10)}`;
      const selectedCharacterId = normalizedMode === SERVER_RUN_MODES.WEEKLY
        ? state.expansionConfig.settings.weeklyLockedCharacter
        : wallet.expansion?.selectedCharacter || 'matt';
      const lockedCharacterId = competitionSnapshot?.loadout?.characterId || selectedCharacterId;
      const selectedCharacter = state.expansionConfig?.characters?.[lockedCharacterId];
      const lockedByCompetition = Boolean(competitionSnapshot?.loadout?.characterId);
      assertApi(
        selectedCharacter && (
          lockedByCompetition ||
          (
            selectedCharacter.enabled === true &&
            (
              normalizedMode === SERVER_RUN_MODES.WEEKLY ||
              wallet.expansion?.ownedCharacters?.includes(lockedCharacterId)
            )
          )
        ),
        409,
        'selected_character_unavailable',
        'Select an enabled character owned by this wallet.'
      );
      const baseTuning = structuredClone(state.gameTuning[normalizedMode] || state.gameTuning.practice);
      if (normalizedMode === SERVER_RUN_MODES.PRACTICE) {
        baseTuning.practicePolicy = { ...PRACTICE_PLAY_POLICY };
      }
      // Pin the authoritative profile used when the run is issued. This keeps
      // browser gameplay and deterministic replay aligned after Admin changes
      // a logged-in player's permanent ranks.
      baseTuning._playerProfile = structuredClone(wallet.profile);
      const retentionPercent = normalizedMode === SERVER_RUN_MODES.FREE
        ? state.expansionConfig.settings.deathRetentionFree
        : normalizedMode === SERVER_RUN_MODES.PAID
          ? state.expansionConfig.settings.deathRetentionPaid
          : state.expansionConfig.settings.deathRetentionPractice;
      baseTuning.deathKeepFraction = retentionPercent / 100;
      if (competitionSnapshot) {
        baseTuning._competitionSnapshot = structuredClone(competitionSnapshot);
        baseTuning.safeStartSeconds = competitionSnapshot.rules.safeStartSeconds;
        baseTuning.playerMaxHealth = competitionSnapshot.loadout.startingHealth;
        baseTuning.dynamiteStartAmmo = competitionSnapshot.loadout.startingDynamite;
        baseTuning.blasterEnergy = competitionSnapshot.loadout.blasterEnergy;
        baseTuning.ignorePermanentUpgrades = competitionSnapshot.loadout.permanentUpgrades === false;
        baseTuning.disableRunUpgrades = competitionSnapshot.loadout.runUpgrades === false;
        baseTuning.maximumDrones = competitionSnapshot.loadout.maximumDrones;
      }
      if (weeklyStage) {
        baseTuning.enemyHealthMultiplier = (baseTuning.enemyHealthMultiplier || 1) * weeklyStage.difficulty;
        baseTuning.enemyDamageMultiplier = (baseTuning.enemyDamageMultiplier || 1) * weeklyStage.difficulty;
        baseTuning.roomsPerDepth = weeklyStage.roomCount;
        for (let depth = 1; depth <= 5; depth += 1) {
          baseTuning[`depth${depth}GuardianBosses`] = weeklyStage.bossCount;
        }
      }
      applyMinePassGameplayBenefits(baseTuning, passActiveAtStart);
      let immutableEndlessSnapshot = null;
      if (normalizedMode === SERVER_RUN_MODES.ENDLESS) {
        state.endlessCompetition.seasons ||= {};
        state.endlessCompetition.seasons[week] ||= {
          snapshot: endlessSnapshot(week, state.expansionConfig, timestamp),
          results: []
        };
        immutableEndlessSnapshot = structuredClone(state.endlessCompetition.seasons[week].snapshot);
      }
      const serverRun = {
        id: runId,
        tokenHash: runTokenHash,
        address: session.address,
        mode: normalizedMode,
        seed,
        day,
        week,
        status: 'active',
        startedAt: timestamp,
        expiresAt: [SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.BETA].includes(normalizedMode)
          ? timestamp + RUN_TTL_MS
          : Math.min(timestamp + RUN_TTL_MS, weekEndsAt),
        finishedAt: 0,
        passActiveAtStart,
        passXpAwarded: 0,
        result: null,
        playerProfile: structuredClone(wallet.profile),
        characterId: lockedCharacterId,
        character: structuredClone(selectedCharacter),
        competitionSlotId,
        competitionSnapshot: competitionSnapshot ? structuredClone(competitionSnapshot) : null,
        weeklyStage,
        endlessSnapshot: immutableEndlessSnapshot,
        tuning: baseTuning
      };
      state.runs[runId] = serverRun;
      await transaction?.upsertRun(serverRun);
      wallet.updatedAt = timestamp;
      addPlayerActivity(wallet, 'RUN_STARTED', `${normalizedMode} ${runId}`, timestamp);
      addAudit(state, session.address, 'SERVER_RUN_STARTED', `${normalizedMode} ${runId}`, timestamp);
      return {
        runId,
        runToken,
        mode: normalizedMode,
        seed,
        day,
        week,
        rewardWeight: normalizedMode === SERVER_RUN_MODES.FREE
          ? 1
          : normalizedMode === SERVER_RUN_MODES.PAID
            ? 2
            : 0,
        expiresAt: serverRun.expiresAt,
        tuning: structuredClone(serverRun.tuning),
        characterId: lockedCharacterId,
        character: structuredClone(selectedCharacter),
        competitionSlotId,
        competitionSnapshot: competitionSnapshot ? structuredClone(competitionSnapshot) : null,
        weeklyStage: weeklyStage ? structuredClone(weeklyStage) : null,
        endlessSnapshot: serverRun.endlessSnapshot ? structuredClone(serverRun.endlessSnapshot) : null
      };
    });
  }

  async finishRun(token, payload) {
    const session = await this.authenticate(token);
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'invalid_run_result', 'A run result is required.');
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const runToken = typeof payload.runToken === 'string' ? payload.runToken : '';
    assertApi(/^run_[a-f0-9]{24}$/.test(runId), 400, 'invalid_run_id', 'The run identifier is invalid.');
    assertApi(/^[a-f0-9]{48}$/.test(runToken), 400, 'invalid_run_token', 'The run token is invalid.');
    const timestamp = this.now();

    const completed = await this.database.transact(async (state, transaction) => {
      const wallet = requireWallet(state, session.address);
      let run = state.runs[runId];
      if (!run && transaction?.normalizedLeaderboards) {
        const storedStatus = await transaction.storedRunStatus(runId);
        if (storedStatus === 'finished') {
          throw new ApiError(409, 'run_already_finished', 'This run was already submitted.');
        }
        if (storedStatus === 'expired') {
          throw new ApiError(410, 'run_expired', 'The run expired before it was submitted.');
        }
      }
      assertApi(run, 404, 'run_not_found', 'The server run was not found.');
      assertApi(run.address === session.address, 403, 'run_owner_mismatch', 'This run belongs to another wallet.');
      assertApi(safeTokenEqual(run.tokenHash, hashToken(runToken)), 401, 'run_token_rejected', 'The run token is invalid.');
      if (run.status === 'finished' && run.result) {
        return {
          accepted: true,
          alreadyFinished: true,
          run: publicRun(run),
          practiceClaim: structuredClone(wallet.practiceClaims?.[runId] || null),
          profile: structuredClone(wallet.profile),
          passProgress: publicPassProgress(wallet),
          passInventory: publicPassInventory(wallet),
          passRewardsUnlocked: [],
          mode: run.mode,
          week: run.week
        };
      }
      assertApi(run.status === 'active', 409, 'run_already_finished', 'This run was already submitted.');
      assertApi(run.expiresAt > timestamp, 410, 'run_expired', 'The run expired before it was submitted.');
      const operationMine = mineForRunMode(run.mode);
      if (operationMine) {
        assertMineOperationOpen(state.operations, operationMine, 'results', `${mineDisplayName(operationMine)} result submission is paused. This active run remains recoverable.`);
      }
      if (![SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.BETA].includes(run.mode)) {
        assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from ranked score submission.');
      }

      const result = validateRunResult(payload.result, run, timestamp);
      run.status = 'finished';
      run.finishedAt = timestamp;
      run.result = result;
      const practiceClaim = null;
      if (run.mode === SERVER_RUN_MODES.PRACTICE && wallet.practiceClaims?.[runId]) {
        // Keep the public Practice lane permanently rewardless. Historical
        // claims can still be resolved through their original records, but a
        // newly finished Practice run can never create one.
        delete wallet.practiceClaims[runId];
      } else if ([SERVER_RUN_MODES.FREE, SERVER_RUN_MODES.PAID].includes(run.mode)) {
        const _ledgerUpdate = applyNuggetLedgerDelta(wallet, result.banked, {
          type: NUGGET_LEDGER_TYPES.RUN_EXTRACTION,
          runId,
          idempotencyKey: `run-complete:${runId}:banked`
        });
        if (_ledgerUpdate.skipped) {
          // If the same submission is retried after a restart, keep the same outcome without mutation.
        }
      }
      if (run.mode === SERVER_RUN_MODES.WEEKLY) {
        finishWeeklyAttempt(
          state.weeklyCompetition,
          run.week,
          run.weeklyStage.day,
          session.address,
          { score: result.score, completed: result.extracted, elapsed: result.elapsed },
          timestamp
        );
      }
      if (run.mode === SERVER_RUN_MODES.ENDLESS) {
        state.endlessCompetition.seasons ||= {};
        state.endlessCompetition.seasons[run.week] ||= { snapshot: run.endlessSnapshot, results: [] };
        state.endlessCompetition.seasons[run.week].results.push({
          address: session.address,
          runId,
          depth: result.depth,
          score: result.score,
          bosses: result.bossTelemetry?.completedBosses || (result.bossTelemetry?.encounterDuration > 0 ? 1 : 0),
          survivalTime: result.elapsed,
          verified: true,
          finishedAt: timestamp
        });
      }
      if (run.mode !== SERVER_RUN_MODES.BETA) {
        wallet.profile.bestDepth = Math.max(wallet.profile.bestDepth, result.depth);
        wallet.profile.bestScore = Math.max(wallet.profile.bestScore, result.score);
        wallet.profile.totalRuns += 1;
      }
      const passXpAwarded = run.mode === SERVER_RUN_MODES.BETA ? 0 : Math.round((run.passActiveAtStart
        ? run.mode === SERVER_RUN_MODES.PAID
          ? PAID_PASS_XP
          : run.mode === SERVER_RUN_MODES.FREE
            ? FREE_PASS_XP
            : 0
        : 0) * (run.tuning?.passXpMultiplier ?? 1));
      run.passXpAwarded = passXpAwarded;
      if (passXpAwarded > 0) {
        wallet.passProgress.xp += passXpAwarded;
        wallet.passProgress.updatedAt = timestamp;
      }
      const passRewardsUnlocked = passXpAwarded > 0
        ? syncPassRewardsForWallet(wallet, timestamp)
        : [];
      wallet.updatedAt = timestamp;
      await transaction?.recordFinishedRun(run);
      addPlayerActivity(wallet, 'RUN_FINISHED', `${run.mode} score ${result.score}`, timestamp);
      addAudit(state, session.address, 'SERVER_RUN_VERIFIED', `${run.mode} score ${result.score}`, timestamp);
      return {
        accepted: true,
        run: publicRun(run),
        practiceClaim,
        profile: structuredClone(wallet.profile),
        passProgress: publicPassProgress(wallet),
        passInventory: publicPassInventory(wallet),
        passRewardsUnlocked,
        mode: run.mode,
        week: run.week
      };
    });
    let leaderboard;
    try {
      if (completed.mode === SERVER_RUN_MODES.WEEKLY || completed.mode === SERVER_RUN_MODES.ENDLESS) {
        const state = await this.database.read();
        leaderboard = completed.mode === SERVER_RUN_MODES.WEEKLY
          ? { mode: 'weekly', week: completed.week, rows: weeklyLeaderboard(state.weeklyCompetition, completed.week) }
          : { mode: 'endless', season: completed.week, rows: endlessLeaderboard(state.endlessCompetition.seasons?.[completed.week]?.results || []) };
      } else if (completed.mode === SERVER_RUN_MODES.BETA) {
        leaderboard = { mode: 'beta', rows: [], excludedFromRewards: true };
      } else {
        leaderboard = await this.leaderboardFor(completed.mode, completed.week, session.address);
      }
    } catch (error) {
      if (!isTransientPostgresError(error)) throw error;
      leaderboard = finalizationLeaderboardFallback(completed);
    }
    return {
      accepted: completed.accepted,
      alreadyFinished: completed.alreadyFinished === true,
      run: completed.run,
      practiceClaim: completed.practiceClaim || null,
      profile: completed.profile,
      passProgress: completed.passProgress,
      passInventory: completed.passInventory,
      passRewardsUnlocked: completed.passRewardsUnlocked,
      leaderboard
    };
  }

  async practiceRunClaim(token, payload) {
    const session = await this.authenticate(token);
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'invalid_claim_request', 'A structured claim request is required.');
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const action = typeof payload.action === 'string' ? payload.action : '';
    assertApi(/^(claim|decline)$/.test(action), 400, 'invalid_claim_action', 'Claim action must be claim or decline.');
    const rawTransactionHash = typeof payload.transactionHash === 'string' ? payload.transactionHash : '';
    const transactionHash = normalizeTransactionHash(rawTransactionHash);

    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      wallet.practiceClaims ||= {};
      const claim = wallet.practiceClaims[runId];
      assertApi(claim && claim.runId === runId, 404, 'claim_record_not_found', 'No pending claim is available for that run.');
      assertApi(claim.status === 'pending', 409, 'claim_already_resolved', 'This practice claim has already been resolved.');
      assertApi(claim.expiresAt > this.now(), 409, 'practice_claim_expired', 'This practice claim has expired.');

      if (action === 'decline') {
        claim.status = 'discarded';
        claim.settledAt = this.now();
        wallet.updatedAt = this.now();
        addPlayerActivity(wallet, 'PRACTICE_CLAIM_DISCARDED', `${runId} projected ${claim.projectedNuggets}`, this.now());
        addAudit(state, session.address, 'SERVER_PRACTICE_CLAIM_DISCARDED', `${runId} nugget_reward=${claim.projectedNuggets}`, this.now());
        return {
          practiceClaim: { ...claim },
          profile: structuredClone(wallet.profile)
        };
      }

      assertApi(this.mainnetTransactionsEnabled, 503, 'practice_claims_disabled', 'Practice claims are currently blocked until verified payment integration is enabled.');
      assertMineOperationOpen(state.operations, 'practice', 'payments', 'Practice reward payments are paused.');
      assertMineOperationOpen(state.operations, 'practice', 'rewards', 'Practice reward finalization is paused.');
      assertApi(transactionHash, 400, 'invalid_transaction_hash', 'A valid payment transaction hash is required to claim practice rewards.');
      const duplicate = findPracticeClaimByTransactionHash(wallet.practiceClaims, transactionHash);
      assertApi(!duplicate || duplicate.runId === runId, 409, 'transaction_duplicate', 'This transaction hash was already used for another practice claim.');

      if (claim.projectedNuggets > 0) {
        const ledgerUpdate = applyNuggetLedgerDelta(wallet, claim.projectedNuggets, {
          type: NUGGET_LEDGER_TYPES.PRACTICE_CLAIM,
          runId,
          transactionHash,
          idempotencyKey: `practice-claim:${runId}`
        });
        assertApi(!ledgerUpdate.skipped, 409, 'practice_claim_already_processed', 'This practice claim was already finalized.');
      }

      claim.status = 'claimed';
      claim.settledAt = this.now();
      claim.transactionHash = transactionHash;
      wallet.updatedAt = this.now();
      addPlayerActivity(wallet, 'PRACTICE_CLAIM_PAID', `${runId} ${claim.projectedNuggets} nuggets`, this.now());
      addAudit(state, session.address, 'SERVER_PRACTICE_CLAIM_PAID', `${runId} ${claim.projectedNuggets} nuggets`, this.now());
      return {
        practiceClaim: { ...claim },
        profile: structuredClone(wallet.profile)
      };
    });
  }

  async abandonRun(token, payload) {
    const session = await this.authenticate(token);
    assertApi(payload && typeof payload === 'object' && !Array.isArray(payload), 400, 'invalid_run_abandonment', 'A run abandonment request is required.');
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const runToken = typeof payload.runToken === 'string' ? payload.runToken : '';
    assertApi(/^run_[a-f0-9]{24}$/.test(runId), 400, 'invalid_run_id', 'The run identifier is invalid.');
    assertApi(/^[a-f0-9]{48}$/.test(runToken), 400, 'invalid_run_token', 'The run token is invalid.');
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      const run = state.runs[runId];
      assertApi(run, 404, 'run_not_found', 'The server run was not found.');
      assertApi(run.address === session.address, 403, 'run_owner_mismatch', 'This run belongs to another wallet.');
      assertApi(run.status === 'active', 409, 'run_not_active', 'This run is no longer active.');
      assertApi(safeTokenEqual(run.tokenHash, hashToken(runToken)), 401, 'run_token_rejected', 'The run token is invalid.');
      run.status = 'expired';
      run.finishedAt = timestamp;
      run.result = null;
      await transaction?.upsertRun(run);
      addAudit(state, session.address, 'SERVER_RUN_ABANDONED', `${run.mode} ${runId}`, timestamp);
      return {
        abandoned: true,
        run: publicRun(run)
      };
    });
  }

  async leaderboard(token, mode, timestamp = this.now(), requestedWeek = '') {
    const session = await this.authenticate(token);
    const normalizedMode = String(mode || '');
    assertApi(
      [SERVER_RUN_MODES.FREE, SERVER_RUN_MODES.PAID].includes(normalizedMode),
      400,
      'invalid_leaderboard',
      'Choose the Free or Pass leaderboard.'
    );
    const currentWeek = utcWeekKey(timestamp);
    const week = normalizeWeekKey(requestedWeek, currentWeek);
    const state = await this.database.read();
    const suspended = suspendedWalletAddresses(state);
    await this.database.finalizeLeaderboards?.(currentWeek, suspended, timestamp);
    if (typeof this.database.leaderboard === 'function') {
      try {
        const leaderboard = await this.database.leaderboard(normalizedMode, week, session.address, {
          suspendedAddresses: suspended
        });
        return enrichLeaderboardAppearances(leaderboard, state);
      } catch {
        return leaderboardForState(state, normalizedMode, week, session.address);
      }
    }
    return leaderboardForState(state, normalizedMode, week, session.address);
  }

  async leaderboardFor(mode, week, viewerAddress) {
    const state = await this.database.read();
    const suspended = suspendedWalletAddresses(state);
    if (typeof this.database.leaderboard === 'function') {
      try {
        const leaderboard = await this.database.leaderboard(mode, week, viewerAddress, {
          suspendedAddresses: suspended
        });
        return enrichLeaderboardAppearances(leaderboard, state);
      } catch {
        return leaderboardForState(state, mode, week, viewerAddress);
      }
    }
    return leaderboardForState(state, mode, week, viewerAddress);
  }

  async publicMineSlots() {
    const timestamp = this.now();
    const state = await this.database.readPublicMineState?.() || await this.database.read();
    return {
      generatedAt: timestamp,
      slots: COMPETITION_SLOTS.map((definition) => {
        const snapshot = resolveCompetitionSnapshot(state.competitionStudio, definition.id, timestamp);
        return publicCompetitionSlot(definition, snapshot, state.operations);
      })
    };
  }

  async publicMineSlot(slotId, requestedPeriod = '') {
    const definition = COMPETITION_SLOTS.find((slot) => slot.id === String(slotId || ''));
    assertApi(definition, 404, 'mine_slot_unknown', 'That mine does not exist.');
    const timestamp = this.now();
    const state = definition.id === 'arena' && this.database.readPublicMineState
      ? await this.database.readPublicMineState()
      : await this.database.read();
    const snapshot = resolveCompetitionSnapshot(state.competitionStudio, definition.id, timestamp);
    let leaderboard = null;
    if (definition.id === 'daily' || definition.id === 'pass') {
      const week = normalizeWeekKey(requestedPeriod, utcWeekKey(timestamp));
      leaderboard = await this.leaderboardFor(definition.mode, week, '0x0000000000000000000000000000000000000000');
    } else if (definition.id === 'arena' && this.arenaService) {
      leaderboard = enrichLeaderboardAppearances(
        await this.arenaLeaderboard(requestedPeriod),
        state
      );
    } else if (definition.id === 'weekly') {
      const week = normalizeWeekKey(requestedPeriod, utcWeekKey(timestamp));
      const rows = weeklyLeaderboard(state.weeklyCompetition, week);
      leaderboard = {
        mode: 'weekly',
        week,
        finalized: week !== utcWeekKey(timestamp),
        participantCount: rows.length,
        rows: rows.slice(0, 100).map((row) => ({
          ...row,
          walletId: state.wallets[row.address]?.identity?.name || abbreviateAddress(row.address),
          identity: publicIdentity(state.wallets[row.address]),
          appearance: publicLeaderboardAppearance(state.wallets[row.address])
        }))
      };
    }
    return {
      slot: publicCompetitionSlot(definition, snapshot, state.operations),
      leaderboard
    };
  }

  async adminCompetitionStudio(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    return {
      definitions: COMPETITION_SLOTS,
      studio: structuredClone(state.competitionStudio),
      active: Object.fromEntries(COMPETITION_SLOTS.map((slot) => [
        slot.id,
        resolveCompetitionSnapshot(state.competitionStudio, slot.id, this.now())
      ]))
    };
  }

  async saveCompetitionDraft(adminKey, slotId, input, reason) {
    this.assertAdminKey(adminKey);
    const definition = COMPETITION_SLOTS.find((slot) => slot.id === slotId && !slot.comingSoon);
    assertApi(definition, 404, 'mine_slot_locked', 'That mine slot cannot be edited.');
    const normalizedReason = normalizeAdminReason(reason);
    let draft;
    try {
      draft = normalizeCompetitionDraft(input, slotId);
    } catch (error) {
      throw new ApiError(422, 'competition_draft_invalid', error.message);
    }
    const validation = validateCompetitionDraft(draft);
    const timestamp = this.now();
    return this.database.transact((state) => {
      state.competitionStudio.slots[slotId].draft = draft;
      state.competitionStudio.slots[slotId].updatedAt = timestamp;
      state.competitionStudio.updatedAt = timestamp;
      addAudit(
        state,
        'SERVER_ADMIN',
        'COMPETITION_DRAFT_SAVED',
        `${slotId}: ${validation.counts.rooms} rooms, ${validation.counts.objects} objects across ${validation.depths.length} depths; ${normalizedReason}`,
        timestamp
      );
      return { draft: structuredClone(draft), validation, reason: normalizedReason };
    });
  }

  async publishCompetitionSnapshot(adminKey, slotId, input = {}) {
    this.assertAdminKey(adminKey);
    const definition = COMPETITION_SLOTS.find((slot) => slot.id === slotId && !slot.comingSoon);
    assertApi(definition, 404, 'mine_slot_locked', 'That mine slot cannot be published.');
    const normalizedReason = normalizeAdminReason(input.reason);
    const timestamp = this.now();
    const effectiveAt = strictInteger(
      input.effectiveAt === undefined || input.effectiveAt === null || input.effectiveAt === ''
        ? timestamp
        : Number(input.effectiveAt),
      'effective_at',
      0,
      9_007_199_254_740_991
    );
    const expiresAt = strictInteger(Number(input.expiresAt || 0), 'expires_at', 0, 9_007_199_254_740_991);
    assertApi(!expiresAt || expiresAt > effectiveAt, 422, 'competition_window_invalid', 'The end time must be after the start time.');
    return this.database.transact((state) => {
      const draft = normalizeCompetitionDraft(state.competitionStudio.slots[slotId].draft, slotId);
      const validation = validateCompetitionDraft(draft);
      assertApi(validation.valid, 422, 'competition_map_invalid', validation.errors[0] || 'The map is not playable.');
      const id = `snapshot_${slotId}_${this.randomHex(10)}`;
      const canonical = JSON.stringify({ ...draft, effectiveAt, expiresAt });
      const fingerprint = createHash('sha256').update(canonical).digest('hex');
      const snapshot = {
        ...structuredClone(draft),
        id,
        status: effectiveAt <= timestamp ? 'live' : 'scheduled',
        effectiveAt,
        expiresAt,
        publishedAt: timestamp,
        publishedBy: 'SERVER_ADMIN',
        fingerprint
      };
      state.competitionStudio.snapshots[id] = snapshot;
      state.competitionStudio.slots[slotId].scheduledSnapshotIds = appendCompetitionSnapshotId(
        state.competitionStudio.slots[slotId].scheduledSnapshotIds,
        slotId,
        id
      );
      if (effectiveAt <= timestamp && (!expiresAt || expiresAt > timestamp)) {
        state.competitionStudio.slots[slotId].activeSnapshotId = id;
      }
      state.competitionStudio.slots[slotId].updatedAt = timestamp;
      state.competitionStudio.updatedAt = timestamp;
      addAudit(
        state,
        'SERVER_ADMIN',
        'COMPETITION_SNAPSHOT_PUBLISHED',
        `${slotId} ${id} ${fingerprint}; ${normalizedReason}`,
        timestamp
      );
      return { snapshot: structuredClone(snapshot), validation, reason: normalizedReason };
    });
  }

  async activateCompetitionSnapshot(adminKey, slotId, snapshotId, reason) {
    this.assertAdminKey(adminKey);
    const definition = COMPETITION_SLOTS.find((slot) => slot.id === slotId && !slot.comingSoon);
    assertApi(definition, 404, 'mine_slot_locked', 'That mine slot cannot be activated.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const source = state.competitionStudio.snapshots[String(snapshotId || '')];
      assertApi(source?.slotId === slotId, 404, 'competition_snapshot_missing', 'That published mine version was not found.');
      const draft = normalizeCompetitionDraft(source, slotId);
      const validation = validateCompetitionDraft(draft);
      assertApi(validation.valid, 422, 'competition_map_invalid', validation.errors[0] || 'The published map is not playable.');
      const id = `snapshot_${slotId}_${this.randomHex(10)}`;
      const canonical = JSON.stringify({ ...draft, effectiveAt: timestamp, expiresAt: 0 });
      const fingerprint = createHash('sha256').update(canonical).digest('hex');
      const snapshot = {
        ...structuredClone(draft),
        id,
        status: 'live',
        effectiveAt: timestamp,
        expiresAt: 0,
        publishedAt: timestamp,
        publishedBy: 'SERVER_ADMIN',
        fingerprint,
        restoredFrom: source.id
      };
      state.competitionStudio.snapshots[id] = snapshot;
      state.competitionStudio.slots[slotId].scheduledSnapshotIds = appendCompetitionSnapshotId(
        state.competitionStudio.slots[slotId].scheduledSnapshotIds,
        slotId,
        id
      );
      state.competitionStudio.slots[slotId].activeSnapshotId = id;
      state.competitionStudio.slots[slotId].draft = structuredClone(draft);
      state.competitionStudio.slots[slotId].updatedAt = timestamp;
      state.competitionStudio.updatedAt = timestamp;
      addAudit(
        state,
        'SERVER_ADMIN',
        'COMPETITION_SNAPSHOT_ACTIVATED',
        `${slotId} ${id} restored from ${source.id}; ${normalizedReason}`,
        timestamp
      );
      return { snapshot: structuredClone(snapshot), validation, reason: normalizedReason };
    });
  }

  async rewardClaims(token) {
    const session = await this.authenticate(token);
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'MATT reward claims are not configured.');
    return this.rewardManager.playerRewards(session.address);
  }

  async prepareRewardClaim(token, draftId) {
    const session = await this.authenticate(token);
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'MATT reward claims are not configured.');
    const state = await this.database.read();
    assertApi(!state.operations.claimsPaused, 503, 'server_claims_paused', 'MATT reward claims are temporarily paused.');
    const mine = String(draftId || '').endsWith('_paid') ? 'pass' : 'daily';
    assertMineOperationOpen(state.operations, mine, 'rewards', `${mineDisplayName(mine)} reward claims are paused.`);
    return this.rewardManager.prepareClaim(session.address, draftId);
  }

  async createRewardDraft(adminKey, input) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    const state = await this.database.read();
    const mine = String(input?.mode || '') === 'paid' ? 'pass' : 'daily';
    assertMineOperationOpen(state.operations, mine, 'rewards', `${mineDisplayName(mine)} reward processing is paused.`);
    return this.rewardManager.createDraft(adminKey, input);
  }

  async approveRewardDraft(approverKey, draftId) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    const state = await this.database.read();
    const mine = String(draftId || '').endsWith('_paid') ? 'pass' : 'daily';
    assertMineOperationOpen(state.operations, mine, 'rewards', `${mineDisplayName(mine)} reward processing is paused.`);
    return this.rewardManager.approveDraft(approverKey, draftId);
  }

  async syncRewardDraft(adminKey, draftId, transactionHash) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    const state = await this.database.read();
    const mine = String(draftId || '').endsWith('_paid') ? 'pass' : 'daily';
    assertMineOperationOpen(state.operations, mine, 'rewards', `${mineDisplayName(mine)} reward processing is paused.`);
    return this.rewardManager.syncDraft(adminKey, draftId, transactionHash);
  }

  async listRewardDrafts(adminKey) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    return this.rewardManager.listDrafts(adminKey);
  }

  async adminMineOperations(adminKey, week) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const timestamp = this.now();
    const runs = Object.values(state.runs);
    const arenaActiveRuns = await Promise.resolve(this.arenaService?.adminActiveRuns?.()).catch(() => []) || [];
    const mineCards = ['practice', 'arena', 'daily', 'pass', 'weekly'].map((mine) => {
      const mineRuns = runs.filter((run) => mineForRunMode(run.mode) === mine);
      const payments = mine === 'pass'
        ? Object.values(state.paidEntitlements)
        : mine === 'practice'
          ? Object.values(state.wallets).flatMap((wallet) => Object.values(wallet.practiceClaims || {}))
          : [];
      return {
        id: mine,
        name: mineDisplayName(mine),
        controls: structuredClone(state.operations.mines?.[mine] || {}),
        availableControls: mineOperationCapabilities(mine),
        activeRuns: mine === 'arena'
          ? arenaActiveRuns.length
          : mineRuns.filter((run) => run.status === 'active' && run.expiresAt > timestamp).length,
        finishedRuns: mineRuns.filter((run) => run.status === 'finished').length,
        pendingPayments: payments.filter((payment) =>
          mine === 'pass'
            ? !payment.consumedAt && !payment.usedRunId
            : payment.status === 'pending'
        ).length,
        paidRecords: payments.filter((payment) =>
          mine === 'pass'
            ? Boolean(payment.confirmedAt)
            : payment.status === 'claimed'
        ).length
      };
    });
    const rewardWeek = week || previousUtcWeek(timestamp);
    const rewards = this.rewardManager
      ? await this.rewardManager.operationsOverview(adminKey, rewardWeek)
      : { week: rewardWeek, available: false, boards: [] };
    return {
      generatedAt: timestamp,
      global: structuredClone(state.operations),
      mines: mineCards,
      rewards
    };
  }

  async hydratePlayerScores(player) {
    if (typeof this.database.playerScores !== 'function') return player;
    try {
      return {
        ...player,
        scores: await this.database.playerScores(player.address, player.week)
      };
    } catch {
      return player;
    }
  }

  async purchaseUpgrade(token, upgradeId) {
    const session = await this.authenticate(token);
    const upgrade = META_UPGRADES.find((entry) => entry.id === upgradeId);
    assertApi(upgrade, 400, 'unknown_upgrade', 'Unknown permanent upgrade.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      const rank = wallet.profile.meta[upgrade.id] || 0;
      assertApi(rank < upgrade.max, 409, 'upgrade_maxed', 'This permanent upgrade is already maxed.');
      const cost = metaUpgradeCost(upgrade, rank);
      assertApi(wallet.profile.bankedNuggets >= cost, 409, 'insufficient_nuggets', 'Not enough banked nuggets.');
      const ledgerUpdate = applyNuggetLedgerDelta(wallet, -cost, {
        type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
        details: `Purchase permanent upgrade ${upgrade.id}`,
        idempotencyKey: `upgrade:${wallet.address}:${upgrade.id}:${rank + 1}`
      });
      assertApi(!ledgerUpdate.skipped, 409, 'duplicate_upgrade_payment', 'This upgrade purchase was already applied.');
      wallet.profile.meta[upgrade.id] = rank + 1;
      wallet.updatedAt = timestamp;
      addAudit(state, session.address, 'SERVER_UPGRADE_PURCHASED', `${upgrade.id} rank ${rank + 1}`, timestamp);
      return { profile: structuredClone(wallet.profile), upgradeId, rank: rank + 1, cost };
    });
  }

  async setWalletSuspension(adminKey, address, suspended, reason = 'Administrative review') {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    assertApi(typeof suspended === 'boolean', 400, 'invalid_suspension', 'Suspension must be true or false.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      if (!state.wallets[normalizedAddress]) state.wallets[normalizedAddress] = defaultWalletState(normalizedAddress, timestamp);
      state.wallets[normalizedAddress].suspended = suspended;
      state.wallets[normalizedAddress].updatedAt = timestamp;
      addAudit(state, 'SERVER_ADMIN', suspended ? 'WALLET_SUSPENDED' : 'WALLET_RESTORED', `${normalizedAddress}: ${normalizedReason}`, timestamp);
      return { address: normalizedAddress, suspended, reason: normalizedReason };
    });
  }

  async adminOverview(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const timestamp = this.now();
    const wallets = Object.values(state.wallets);
    const runs = Object.values(state.runs);
    const entitlements = Object.values(state.paidEntitlements);
    const paymentStatus = await this.publicPaymentStatus().catch(() => ({ live: false, unavailable: true }));
    return {
      generatedAt: timestamp,
      operations: structuredClone(state.operations),
      immutable: {
        chainId: this.chainId,
        contracts: MATT_MINE_ADMIN_CONTRACTS,
        hardMaxBoardMatt: 5_000_000,
        publishedRewardsEditable: false,
        confirmedPaymentsEditable: false,
        finishedScoresEditable: false
      },
      counts: {
        wallets: wallets.length,
        suspendedWallets: wallets.filter((wallet) => wallet.suspended).length,
        activeSessions: Object.values(state.sessions).filter((session) => session.expiresAt > timestamp).length,
        activeRuns: runs.filter((run) => run.status === 'active' && run.expiresAt > timestamp).length,
        finishedRuns: runs.filter((run) => run.status === 'finished').length,
        expiredRuns: runs.filter((run) => run.status === 'expired' || (run.status === 'active' && run.expiresAt <= timestamp)).length,
        paidEntitlements: entitlements.length,
        unusedPaidCredits: entitlements.filter((entry) => !entry.consumedAt && !entry.usedRunId).length,
        auditEntries: state.audit.length
      },
      payments: paymentStatus,
      rewards: this.rewardManager?.publicConfig?.() || { available: false },
      bossTelemetry: aggregateBossTelemetry(runs),
      characterTelemetry: aggregateCharacterTelemetry(runs),
      contractActions: listAdminContractActions()
    };
  }

  async adminWallets(adminKey, query = '') {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const needle = String(query || '').trim().toLowerCase().slice(0, 80);
    const timestamp = this.now();
    const wallets = Object.values(state.wallets)
      .filter((wallet) => !needle || wallet.address.includes(needle) || wallet.identity?.nameKey?.includes(needle))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 250)
      .map((wallet) => adminWalletSnapshot(state, wallet, timestamp));
    return { query: needle, wallets, total: wallets.length };
  }

  async adminWallet(adminKey, address) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const state = await this.database.read();
    const wallet = requireWallet(state, normalizedAddress);
    return {
      wallet: adminWalletSnapshot(state, wallet, this.now()),
      runs: Object.values(state.runs)
        .filter((run) => run.address === normalizedAddress)
        .sort((left, right) => right.startedAt - left.startedAt)
        .slice(0, 100)
        .map(publicAdminRun),
      entitlements: Object.values(state.paidEntitlements)
        .filter((entry) => entry.address === normalizedAddress)
        .sort((left, right) => right.confirmedAt - left.confirmedAt)
        .slice(0, 100)
        .map((entry) => structuredClone(entry)),
      activity: [...(wallet.activity || []), ...state.audit
        .filter((entry) => String(entry.actor).toLowerCase() === normalizedAddress)
        .map((entry) => ({
          id: `audit-${entry.id}`,
          action: entry.action,
          details: entry.details,
          timestamp: entry.timestamp
        }))]
        .sort((left, right) => right.timestamp - left.timestamp)
        .filter((entry, index, entries) =>
          entries.findIndex((candidate) =>
            candidate.action === entry.action &&
            candidate.details === entry.details &&
            candidate.timestamp === entry.timestamp
          ) === index
        )
        .slice(0, 500)
    };
  }

  async adminGameTuning(adminKey) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    return {
      lobbies: GAMEPLAY_LOBBIES,
      schema: GAME_TUNING_SCHEMA,
      presets: structuredClone(state.gameTuning)
    };
  }

  async publicGameTuning(lobby) {
    assertApi(GAMEPLAY_LOBBIES.includes(lobby), 404, 'tuning_lobby_unknown', 'Unknown gameplay lobby.');
    const state = await this.database.read();
    return { lobby, preset: structuredClone(state.gameTuning[lobby]) };
  }

  async updateAdminGameTuning(adminKey, lobby, input, reason) {
    this.assertAdminKey(adminKey);
    assertApi(GAMEPLAY_LOBBIES.includes(lobby), 404, 'tuning_lobby_unknown', 'Unknown gameplay lobby.');
    const normalizedReason = normalizeAdminReason(reason);
    const snapshot = await this.database.read();
    let patch;
    try {
      patch = normalizeTuningPatch(input, snapshot.gameTuning?.[lobby] || {});
    } catch (error) {
      throw new ApiError(422, 'tuning_invalid', error.message);
    }
    assertApi(Object.keys(patch).length > 0, 400, 'tuning_patch_empty', 'Change at least one setting.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const before = state.gameTuning[lobby];
      state.gameTuning[lobby] = { ...before, ...patch };
      const changed = Object.keys(patch).filter((key) => before[key] !== patch[key]);
      const linkedChanges = applyTuningLinksToExpansion(state, lobby, patch, timestamp);
      addAudit(
        state,
        'SERVER_ADMIN',
        'GAME_TUNING_UPDATED',
        `${lobby}: ${changed.join(', ')}${linkedChanges.length ? `; linked: ${linkedChanges.join(', ')}` : ''}; effective immediately for new runs; ${normalizedReason}`,
        timestamp
      );
      return {
        lobby,
        preset: structuredClone(state.gameTuning[lobby]),
        changed,
        linkedChanges,
        expansionRevision: state.expansionConfig.revision,
        reason: normalizedReason,
        effectiveAt: timestamp
      };
    });
  }

  async adminAwardPlayer(adminKey, address, input, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const normalizedReason = normalizeAdminReason(reason);
    const type = String(input?.type || '');
    const timestamp = this.now();
    return this.database.transact((state) => {
      const wallet = requireWallet(state, normalizedAddress);
      let details = '';
      if (type === 'nuggets') {
        const amount = strictInteger(Number(input.amount), 'award_amount', 1, 10_000_000);
        const ledgerUpdate = applyNuggetLedgerDelta(wallet, amount, {
          type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
          adminActor: 'SERVER_ADMIN',
          details: `Admin award ${amount} nuggets`,
          idempotencyKey: `admin-award:${normalizedAddress}:${timestamp}:${type}:${amount}`
        });
        assertApi(!ledgerUpdate.skipped, 409, 'duplicate_admin_award', 'That admin nugget award was already recorded.');
        details = `${amount} banked nuggets`;
      } else if (type === 'pass_xp') {
        const amount = strictInteger(Number(input.amount), 'award_amount', 1, 1_000_000);
        wallet.passProgress.xp += amount;
        wallet.passProgress.updatedAt = timestamp;
        syncPassRewardsForWallet(wallet, timestamp);
        details = `${amount} Pass XP`;
      } else if (type === 'cosmetic') {
        const cosmeticId = String(input.cosmeticId || '');
        assertApi(PASS_COSMETICS[cosmeticId], 422, 'cosmetic_unknown', 'Choose a valid cosmetic.');
        unlockCosmetic(wallet, cosmeticId);
        details = `cosmetic ${cosmeticId}`;
      } else if (type === 'chest') {
        const amount = strictInteger(Number(input.amount), 'award_amount', 1, 25);
        wallet.passInventory.chests[PASS_CHEST_ID].available += amount;
        details = `${amount} Pass chest${amount === 1 ? '' : 's'}`;
      } else {
        throw new ApiError(422, 'award_type_unknown', 'Choose nuggets, Pass XP, a cosmetic, or a chest.');
      }
      wallet.updatedAt = timestamp;
      addPlayerActivity(wallet, 'ADMIN_AWARD', `${details}; ${normalizedReason}`, timestamp);
      addAudit(state, 'SERVER_ADMIN', 'PLAYER_AWARDED', `${normalizedAddress}: ${details}; ${normalizedReason}`, timestamp);
      return { wallet: adminWalletSnapshot(state, wallet, timestamp), type, details, reason: normalizedReason };
    });
  }

  async updateOperations(adminKey, patch, reason) {
    this.assertAdminKey(adminKey);
    assertApi(patch && typeof patch === 'object' && !Array.isArray(patch), 400, 'operations_patch_invalid', 'Operations changes must be an object.');
    const allowed = new Set(['maintenanceMode', 'freeRankedPaused', 'passRankedPaused', 'purchasesPaused', 'claimsPaused', 'announcement']);
    assertApi(Object.keys(patch).length > 0, 400, 'operations_patch_empty', 'Choose at least one operations setting.');
    assertApi(Object.keys(patch).every((key) => allowed.has(key)), 400, 'operations_field_locked', 'One or more operations fields are unknown or protected.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const next = { ...state.operations };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'announcement') {
          assertApi(typeof value === 'string', 400, 'announcement_invalid', 'Announcement must be text.');
          next.announcement = value.trim().slice(0, 280);
        } else {
          assertApi(typeof value === 'boolean', 400, 'operations_value_invalid', `${key} must be true or false.`);
          next[key] = value;
        }
      }
      next.mines ||= {};
      if (Object.hasOwn(patch, 'freeRankedPaused')) next.mines.daily.entriesPaused = patch.freeRankedPaused;
      if (Object.hasOwn(patch, 'passRankedPaused')) next.mines.pass.entriesPaused = patch.passRankedPaused;
      if (Object.hasOwn(patch, 'purchasesPaused')) {
        next.mines.practice.paymentsPaused = patch.purchasesPaused;
        next.mines.pass.paymentsPaused = patch.purchasesPaused;
      }
      if (Object.hasOwn(patch, 'claimsPaused')) {
        next.mines.daily.rewardsPaused = patch.claimsPaused;
        next.mines.pass.rewardsPaused = patch.claimsPaused;
      }
      next.updatedAt = timestamp;
      next.updatedBy = 'SERVER_ADMIN';
      state.operations = next;
      this.cachedOperations = next;
      addAudit(state, 'SERVER_ADMIN', 'OPERATIONS_UPDATED', `${normalizedReason}: ${JSON.stringify(patch)}`, timestamp);
      return { operations: structuredClone(next), reason: normalizedReason };
    });
  }

  async updateMineOperations(adminKey, mine, patch, reason) {
    this.assertAdminKey(adminKey);
    const normalizedMine = String(mine || '');
    assertApi(['practice', 'arena', 'daily', 'pass', 'weekly'].includes(normalizedMine), 404, 'mine_operation_unknown', 'Choose a playable mine.');
    assertApi(patch && typeof patch === 'object' && !Array.isArray(patch), 400, 'mine_operations_patch_invalid', 'Mine control changes must be an object.');
    const allowed = new Set(['entriesPaused', 'resultsPaused', 'paymentsPaused', 'rewardsPaused']);
    assertApi(Object.keys(patch).length > 0, 400, 'mine_operations_patch_empty', 'Choose at least one mine control.');
    assertApi(Object.keys(patch).every((key) => allowed.has(key)), 400, 'mine_operations_field_locked', 'One or more mine controls are protected.');
    const available = new Set(mineOperationCapabilities(normalizedMine).map((operation) => `${operation}Paused`));
    assertApi(
      Object.keys(patch).every((key) => available.has(key)),
      400,
      'mine_operation_not_applicable',
      'That control does not apply to this mine.'
    );
    assertApi(Object.values(patch).every((value) => typeof value === 'boolean'), 400, 'mine_operations_value_invalid', 'Mine controls must be true or false.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    return this.database.transact((state) => {
      const current = state.operations.mines[normalizedMine];
      const next = {
        ...current,
        ...patch,
        updatedAt: timestamp,
        updatedBy: 'SERVER_ADMIN'
      };
      state.operations.mines[normalizedMine] = next;
      if (normalizedMine === 'daily' && Object.hasOwn(patch, 'entriesPaused')) {
        state.operations.freeRankedPaused = patch.entriesPaused;
      }
      if (normalizedMine === 'pass' && Object.hasOwn(patch, 'entriesPaused')) {
        state.operations.passRankedPaused = patch.entriesPaused;
      }
      this.cachedOperations = state.operations;
      addAudit(
        state,
        'SERVER_ADMIN',
        'MINE_OPERATIONS_UPDATED',
        `${normalizedMine}: ${JSON.stringify(patch)}; ${normalizedReason}`,
        timestamp
      );
      return {
        mine: normalizedMine,
        controls: structuredClone(next),
        reason: normalizedReason
      };
    });
  }

  async adminTerminateMineRuns(adminKey, mine, reason) {
    this.assertAdminKey(adminKey);
    const normalizedMine = String(mine || '');
    assertApi(['practice', 'arena', 'daily', 'pass', 'weekly'].includes(normalizedMine), 404, 'mine_operation_unknown', 'Choose a playable mine.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    const arenaResult = normalizedMine === 'arena' && this.arenaService?.adminExpireActiveRuns
      ? await this.arenaService.adminExpireActiveRuns()
      : { affected: 0, runIds: [] };
    const result = await this.database.transact(async (state, transaction) => {
      const runIds = [];
      for (const run of Object.values(state.runs)) {
        if (
          mineForRunMode(run.mode) !== normalizedMine ||
          run.status !== 'active'
        ) continue;
        run.status = 'expired';
        run.expiresAt = Math.min(run.expiresAt, timestamp);
        run.finishedAt = timestamp;
        run.adminTerminatedAt = timestamp;
        run.adminTerminationReason = normalizedReason;
        await transaction?.upsertRun(run);
        runIds.push(run.id);
      }
      const affected = runIds.length + arenaResult.affected;
      addAudit(
        state,
        'SERVER_ADMIN',
        'MINE_ACTIVE_RUNS_TERMINATED',
        `${normalizedMine}: ended ${affected} active run${affected === 1 ? '' : 's'}; ${normalizedReason}`,
        timestamp
      );
      return { runIds, affected };
    });
    const allRunIds = [...result.runIds, ...arenaResult.runIds];
    for (const runId of allRunIds) {
      await this.competitiveReplayValidator?.finalize?.(runId, 'admin_terminated').catch(() => undefined);
    }
    return {
      mine: normalizedMine,
      affected: result.affected,
      runIds: allRunIds,
      reason: normalizedReason,
      effectiveAt: timestamp
    };
  }

  async adminWalletAction(adminKey, address, action, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const normalizedAction = String(action || '');
    assertApi(['revoke_sessions', 'expire_active_runs', 'restore_free_run'].includes(normalizedAction), 400, 'wallet_action_invalid', 'Unknown wallet administration action.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    const arenaResult = normalizedAction === 'expire_active_runs' && this.arenaService?.adminExpireActiveRuns
      ? await this.arenaService.adminExpireActiveRuns(normalizedAddress)
      : { affected: 0, runIds: [] };
    const result = await this.database.transact(async (state, transaction) => {
      requireWallet(state, normalizedAddress);
      let affected = arenaResult.affected;
      const runIds = [...arenaResult.runIds];
      if (normalizedAction === 'revoke_sessions') {
        for (const [key, session] of Object.entries(state.sessions)) {
          if (session.address !== normalizedAddress) continue;
          delete state.sessions[key];
          affected += 1;
        }
      }
      if (normalizedAction === 'expire_active_runs') {
        for (const run of Object.values(state.runs)) {
          if (run.address !== normalizedAddress || run.status !== 'active') continue;
          run.status = 'expired';
          run.expiresAt = Math.min(run.expiresAt, timestamp);
          run.finishedAt = timestamp;
          run.adminTerminatedAt = timestamp;
          run.adminTerminationReason = normalizedReason;
          await transaction?.upsertRun(run);
          affected += 1;
          runIds.push(run.id);
        }
      }
      if (normalizedAction === 'restore_free_run') {
        const daily = state.wallets[normalizedAddress].daily[utcDayKey(timestamp)];
        if (daily?.freeRunUsed) {
          delete state.wallets[normalizedAddress].daily[utcDayKey(timestamp)];
          affected = 1;
        }
      }
      addAudit(state, 'SERVER_ADMIN', `WALLET_${normalizedAction.toUpperCase()}`, `${normalizedAddress}: ${normalizedReason}; affected ${affected}`, timestamp);
      return { address: normalizedAddress, action: normalizedAction, affected, runIds, reason: normalizedReason };
    });
    for (const runId of result.runIds) {
      await this.competitiveReplayValidator?.finalize?.(runId, 'admin_terminated').catch(() => undefined);
    }
    return result;
  }

  async adminAudit(adminKey, options = {}) {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const action = String(options.action || '').trim().toUpperCase().slice(0, 80);
    const actor = String(options.actor || '').trim().toLowerCase().slice(0, 80);
    const limit = Math.min(500, Math.max(1, Number.parseInt(options.limit, 10) || 100));
    const entries = state.audit
      .filter((entry) => !action || String(entry.action).toUpperCase().includes(action))
      .filter((entry) => !actor || String(entry.actor).toLowerCase().includes(actor))
      .slice(-limit)
      .reverse()
      .map((entry) => structuredClone(entry));
    return { entries, limit, total: entries.length };
  }

  async prepareAdminContractAction(adminKey, input, reason) {
    this.assertAdminKey(adminKey);
    const normalizedReason = normalizeAdminReason(reason);
    const transactions = prepareAdminContractTransactions(input);
    const transaction = transactions.at(-1);
    const timestamp = this.now();
    await this.database.transact((state) => {
      addAudit(state, 'SERVER_ADMIN', 'CONTRACT_TRANSACTION_PREPARED', `${transaction.action}: ${normalizedReason}`, timestamp);
    });
    return {
      transaction,
      transactions,
      safeTransactionBuilderFile: createAdminSafeTransactionFile(transactions, timestamp),
      safeFileName: `matt-mine-${transaction.action}-${new Date(timestamp).toISOString().replace(/[:.]/g, '-')}.json`,
      reason: normalizedReason
    };
  }

  async arenaConfig(day = '') {
    this.assertArenaEnabled();
    return this.arenaService.config(day);
  }

  async quoteArenaEntry(token, input = {}) {
    const { session, wallet } = await this.arenaPlayer(token, { operation: 'payments' });
    const submittedAttestation = input.eligibility && typeof input.eligibility === 'object'
      ? input.eligibility
      : null;
    const storedAttestation = wallet.paidCompetitionEligibility?.arena || null;
    const eligibility = this.assertPaidCompetitionEligible(
      session.address,
      'arena',
      submittedAttestation || storedAttestation
    );
    if (submittedAttestation && eligibility.enforcement === 'public_attestation') {
      await this.database.transact((state) => {
        const currentWallet = requireWallet(state, session.address);
        currentWallet.paidCompetitionEligibility ||= {};
        currentWallet.paidCompetitionEligibility.arena = {
          age18OrOlder: true,
          locatedInJurisdiction: true,
          notProhibited: true,
          acceptedRules: true,
          rulesVersion: eligibility.rulesVersion,
          rulesHash: eligibility.rulesHash,
          jurisdiction: eligibility.jurisdiction,
          acceptedAt: eligibility.acceptedAt
        };
        currentWallet.updatedAt = this.now();
        addAudit(
          state,
          session.address,
          'ARENA_RULES_ACCEPTED',
          `${eligibility.rulesVersion} · ${eligibility.rulesHash} · ${eligibility.jurisdiction}`,
          eligibility.acceptedAt
        );
      });
    }
    const result = await this.arenaService.quoteEntry(session.address, input);
    return {
      ...result,
      quote: {
        ...result.quote,
        ...(eligibility.receiptToken
          ? { eligibilityReceipt: eligibility.receiptToken }
          : {}),
        eligibility: publicEligibilityRecord(eligibility)
      }
    };
  }

  async confirmArenaEntry(token, input = {}) {
    const { session } = await this.arenaPlayer(token, { operation: 'payments' });
    const transactionHash = typeof input === 'string'
      ? input
      : input.enterTransactionHash || input.transactionHash;
    const eligibility = this.verifyPaidCompetitionEligibility(
      session.address,
      'arena',
      typeof input === 'string' ? '' : input.eligibilityReceipt
    );
    return this.arenaService.confirmEntry(session.address, transactionHash, eligibility);
  }

  async startArenaRun(token, input = {}) {
    const { session, wallet } = await this.arenaPlayer(token, { operation: 'entries' });
    const paymentStatus = this.mainnetTransactionsEnabled
      ? await this.paymentVerifier.status(session.address).catch(() => null)
      : null;
    return this.arenaService.startRun(session.address, {
      ...input,
      playerProfile: structuredClone(wallet.profile),
      passActiveAtStart: paymentStatus?.pass?.active === true
    });
  }

  async appendArenaEvents(token, payload) {
    const { session, wallet } = await this.arenaPlayer(token);
    return this.arenaService.appendEvents(session.address, payload, wallet.profile);
  }

  async finishArenaRun(token, payload) {
    const { session, state, wallet } = await this.arenaPlayer(token, { operation: 'results' });
    const result = await this.arenaService.finishRun(session.address, payload, wallet.profile);
    if (result.accepted === false) {
      return result;
    }
    const progression = result.progression;
    assertApi(
      progression?.runId === payload?.runId && /^arena_run_[a-f0-9]{24}$/.test(progression.runId),
      500,
      'arena_progression_snapshot_invalid',
      'The verified Daily Arena run is missing its progression snapshot.'
    );
    const timestamp = this.now();
    const passXpMultiplier = Number(progression.passXpMultiplier);
    const passXpAwarded = progression.passActiveAtStart === true
      ? Math.round(ARENA_PASS_XP * (
          Number.isFinite(passXpMultiplier)
            ? Math.max(0, Math.min(10, passXpMultiplier))
            : 1
        ))
      : 0;
    const arenaNuggets = Math.max(
      0,
      Math.min(MAX_RUN_SCORE, Math.floor(Number(result.result?.banked || 0)))
    );
    const passAward = await this.database.transact((currentState) => {
      const currentWallet = requireWallet(currentState, session.address);
      currentState.arenaPassXpAwards ||= {};
      const existing = currentState.arenaPassXpAwards[progression.runId];
      if (existing) {
        assertApi(
          existing.address === session.address,
          409,
          'arena_pass_xp_receipt_conflict',
          'This Daily Arena progression receipt belongs to another wallet.'
        );
      } else {
        currentState.arenaPassXpAwards[progression.runId] = {
          address: session.address,
          xp: passXpAwarded,
          awardedAt: timestamp
        };
        if (passXpAwarded > 0) {
          currentWallet.passProgress.xp += passXpAwarded;
          currentWallet.passProgress.updatedAt = timestamp;
          currentWallet.updatedAt = timestamp;
        }
      }
      const awardedXp = existing ? Number(existing.xp || 0) : passXpAwarded;
      const passRewardsUnlocked = !existing && passXpAwarded > 0
        ? syncPassRewardsForWallet(currentWallet, timestamp)
        : [];
      if (!existing && passXpAwarded > 0) {
        const score = Math.max(0, Number(result.result?.score || 0));
        addPlayerActivity(
          currentWallet,
          'ARENA_PASS_XP_AWARDED',
          `${progression.runId} score ${score} +${passXpAwarded} Pass XP`,
          timestamp
        );
        addAudit(
          currentState,
          session.address,
          'ARENA_PASS_XP_AWARDED',
          `${progression.runId}: score ${score}; +${passXpAwarded} Pass XP`,
          timestamp
        );
      }
      const nuggetUpdate = applyNuggetLedgerDelta(currentWallet, arenaNuggets, {
        type: NUGGET_LEDGER_TYPES.ARENA_RUN,
        runId: progression.runId,
        idempotencyKey: `arena-run:${progression.runId}`,
        details: 'Server-replayed Daily Arena banked nuggets',
        timestamp
      });
      if (!nuggetUpdate.duplicate && arenaNuggets > 0) {
        currentWallet.updatedAt = timestamp;
        addPlayerActivity(
          currentWallet,
          'ARENA_NUGGETS_BANKED',
          `${progression.runId} +${arenaNuggets} nuggets`,
          timestamp
        );
        addAudit(
          currentState,
          session.address,
          'ARENA_NUGGETS_BANKED',
          `${progression.runId}: +${arenaNuggets} nuggets`,
          timestamp
        );
      }
      return {
        passXpAwarded: awardedXp,
        passXpAlreadyAwarded: Boolean(existing),
        passProgress: publicPassProgress(currentWallet),
        passInventory: publicPassInventory(currentWallet),
        passRewardsUnlocked,
        arenaNuggetsBanked: nuggetUpdate.entry?.amount || 0,
        arenaNuggetsAlreadyAwarded: nuggetUpdate.duplicate,
        profile: structuredClone(currentWallet.profile)
      };
    });
    wallet.passProgress.xp = passAward.passProgress.xp;
    wallet.passProgress.updatedAt = passAward.passProgress.updatedAt;
    wallet.passInventory = structuredClone(passAward.passInventory);
    wallet.profile = structuredClone(passAward.profile);
    const { progression: _progression, ...publicResult } = result;
    return {
      ...publicResult,
      ...passAward,
      leaderboard: enrichLeaderboardAppearances(result.leaderboard, state)
    };
  }

  async abandonArenaRun(token, payload) {
    const { session } = await this.arenaPlayer(token);
    return this.arenaService.abandonRun(session.address, payload);
  }

  async abandonActiveArenaRun(token) {
    const { session } = await this.arenaPlayer(token, {
      allowSuspended: true,
      allowMaintenance: true,
      allowIdentityMissing: true
    });
    return this.arenaService.abandonActiveRun(session.address);
  }

  async arenaLeaderboard(day = '') {
    this.assertArenaEnabled();
    const requestKey = String(day || 'current').slice(0, 40);
    const pending = this.arenaLeaderboardRequests.get(requestKey);
    if (pending) return structuredClone(await pending);
    const request = (async () => {
      const state = await this.database.readPublicMineState?.() || await this.database.read();
      const leaderboard = await this.arenaService.leaderboard(day, suspendedWalletAddresses(state));
      return enrichLeaderboardAppearances(leaderboard, state);
    })();
    this.arenaLeaderboardRequests.set(requestKey, request);
    try {
      return structuredClone(await request);
    } finally {
      if (this.arenaLeaderboardRequests.get(requestKey) === request) {
        this.arenaLeaderboardRequests.delete(requestKey);
      }
    }
  }

  async arenaMe(token, day = '') {
    const { session } = await this.arenaPlayer(token, {
      allowSuspended: true,
      allowMaintenance: true,
      allowIdentityMissing: true
    });
    return this.arenaService.playerStatus(session.address, day);
  }

  async prepareArenaRefund(token, day = '') {
    const { session } = await this.arenaPlayer(token, {
      allowSuspended: true,
      allowMaintenance: true,
      allowIdentityMissing: true
    });
    return this.arenaService.prepareRefund(session.address, day);
  }

  async adminArenaOverview(adminKey, day = '') {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const state = await this.database.read();
    return this.arenaService.adminOverview(day, suspendedWalletAddresses(state));
  }

  async prepareArenaDay(adminKey, day, input = {}) {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const result = await this.arenaService.prepareDay({ ...input, day });
    await this.recordArenaAdminAudit('ARENA_DAY_PREPARED', `${day}: ${input.reason}`);
    return result;
  }

  async prepareArenaSeedTopUp(adminKey, day, input = {}) {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const result = await this.arenaService.prepareSeedTopUp(day, input);
    await this.recordArenaAdminAudit('ARENA_SEED_PREPARED', `${day}: ${input.reason}`);
    return result;
  }

  async prepareArenaControl(adminKey, action, input = {}) {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const result = await this.arenaService.prepareControl(action, input.reason);
    await this.recordArenaAdminAudit('ARENA_CONTROL_PREPARED', `${action}: ${input.reason}`);
    return result;
  }

  async prepareArenaSettlement(adminKey, day, input = {}) {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const state = await this.database.read();
    assertMineOperationOpen(state.operations, 'arena', 'rewards', 'MATT Arena settlement preparation is paused.');
    const result = await this.arenaService.createSettlement(
      day,
      suspendedWalletAddresses(state),
      input.reason
    );
    await this.recordArenaAdminAudit('ARENA_SETTLEMENT_PREPARED', `${day}: ${input.reason}`);
    return result;
  }

  async prepareArenaCancellation(adminKey, day, input = {}) {
    this.assertAdminKey(adminKey);
    this.assertArenaEnabled();
    const result = await this.arenaService.prepareCancellation(day, input.reason);
    await this.recordArenaAdminAudit('ARENA_CANCELLATION_PREPARED', `${day}: ${input.reason}`);
    return result;
  }

  async recordArenaAdminAudit(action, details) {
    const timestamp = this.now();
    await this.database.transact((state) => {
      addAudit(state, 'SERVER_ADMIN', action, String(details || '').slice(0, 500), timestamp);
    });
  }

  async arenaPlayer(token, options = {}) {
    this.assertArenaEnabled();
    const { session, state } = await this.authenticateWithState(token, { arenaOnly: true });
    const wallet = requireWallet(state, session.address);
    if (!options.allowIdentityMissing) assertIdentityReady(wallet);
    if (!options.allowSuspended) {
      assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from Daily Arena play.');
    }
    if (!options.allowMaintenance) {
      assertApi(!state.operations.maintenanceMode, 503, 'maintenance_mode', state.operations.announcement || 'MATT Mine is temporarily under maintenance.');
    }
    if (options.operation) {
      assertMineOperationOpen(
        state.operations,
        'arena',
        options.operation,
        `MATT Arena ${options.operation} are paused in the Mine Operations console.`
      );
    }
    return { session, wallet, state };
  }

  async authenticate(token) {
    return (await this.authenticateWithState(token)).session;
  }

  async authenticateWithState(token, options = {}) {
    const rawToken = assertToken(token);
    const tokenHash = hashToken(rawToken);
    const state = options.arenaOnly && this.database.readArenaPlayerState
      ? await this.database.readArenaPlayerState(tokenHash)
      : await this.database.read();
    const session = state.sessions[tokenHash];
    assertApi(session, 401, 'session_missing', 'Sign in with Ronin Wallet to continue.');
    assertApi(session.type !== 'admin', 401, 'player_session_required', 'A player wallet session is required.');
    assertApi(session.expiresAt > this.now(), 401, 'session_expired', 'The wallet session expired. Sign in again.');
    requireWallet(state, session.address);
    return { session, state };
  }

  async createAdminSession(playerToken) {
    const player = await this.authenticate(playerToken);
    assertApi(this.adminWalletAllowlist.size > 0, 503, 'admin_wallets_missing', 'The exact Admin wallet allowlist is not configured.');
    assertApi(this.adminWalletAllowlist.has(player.address), 403, 'admin_wallet_not_allowed', 'This wallet is not authorized for the Admin Command Center.');
    const timestamp = this.now();
    const token = this.randomHex(32);
    const csrfToken = this.randomHex(32);
    const tokenHash = hashToken(token);
    const expiresAt = timestamp + ADMIN_SESSION_TTL_MS;
    await this.database.transact((state) => {
      pruneSecurityRecords(state, timestamp);
      state.sessions[tokenHash] = {
        tokenHash,
        address: player.address,
        type: 'admin',
        csrfHash: hashToken(csrfToken),
        createdAt: timestamp,
        expiresAt,
        revokedAt: 0,
        stepUpUntil: 0,
        lastSeenAt: timestamp
      };
      addAudit(state, player.address, 'ADMIN_SESSION_CREATED', `expires ${new Date(expiresAt).toISOString()}`, timestamp);
    });
    return { token, csrfToken, address: player.address, expiresAt };
  }

  async authenticateAdminSession(token, options = {}) {
    const tokenHash = hashToken(assertToken(token));
    const state = await this.database.read();
    const session = state.sessions[tokenHash];
    assertApi(session?.type === 'admin' && !session.revokedAt, 401, 'admin_session_missing', 'Sign in with an authorized Admin wallet.');
    assertApi(session.expiresAt > this.now(), 401, 'admin_session_expired', 'The Admin session expired. Sign again.');
    assertApi(this.adminWalletAllowlist.has(session.address), 403, 'admin_wallet_revoked', 'This Admin wallet is no longer authorized.');
    if (options.mutation) {
      assertApi(
        typeof options.csrfToken === 'string' && safeTokenEqual(hashToken(options.csrfToken), session.csrfHash),
        403,
        'admin_csrf_rejected',
        'The Admin CSRF token is missing or invalid.'
      );
    }
    if (options.stepUp) {
      assertApi(session.stepUpUntil > this.now(), 403, 'admin_step_up_required', 'Sign this sensitive Admin action with the authorized wallet.');
    }
    return { address: session.address, expiresAt: session.expiresAt, stepUpUntil: session.stepUpUntil || 0 };
  }

  async revokeAdminSession(token) {
    const tokenHash = hashToken(assertToken(token));
    const timestamp = this.now();
    await this.database.transact((state) => {
      const session = state.sessions[tokenHash];
      if (session?.type === 'admin') {
        session.revokedAt = timestamp;
        session.expiresAt = Math.min(session.expiresAt, timestamp);
        addAudit(state, session.address, 'ADMIN_SESSION_REVOKED', 'Admin logout', timestamp);
      }
    });
    return { signedOut: true };
  }

  async createAdminStepUp(token) {
    const admin = await this.authenticateAdminSession(token);
    const timestamp = this.now();
    const nonce = this.randomHex(12);
    const message = `MATT Mine Admin step-up\n\nWallet: ${admin.address}\nChain ID: ${this.chainId}\nNonce: ${nonce}\nExpires: ${new Date(timestamp + AUTH_CHALLENGE_TTL_MS).toISOString()}\n\nThis signature authorizes sensitive server-side Admin actions. It does not broadcast a transaction.`;
    await this.database.transact((state) => {
      state.challenges[nonce] = {
        nonce,
        address: admin.address,
        chainId: this.chainId,
        origin: this.publicOrigin || '',
        purpose: 'admin_step_up',
        message,
        createdAt: timestamp,
        expiresAt: timestamp + AUTH_CHALLENGE_TTL_MS
      };
    });
    return { nonce, message, expiresAt: timestamp + AUTH_CHALLENGE_TTL_MS };
  }

  async verifyAdminStepUp(token, nonce, signature) {
    const admin = await this.authenticateAdminSession(token);
    const timestamp = this.now();
    const state = await this.database.read();
    const challenge = state.challenges?.[String(nonce || '')];
    assertApi(challenge?.purpose === 'admin_step_up' && challenge.address === admin.address, 401, 'admin_step_up_challenge_missing', 'Request a new Admin step-up signature.');
    assertApi(challenge.expiresAt > timestamp, 401, 'admin_step_up_challenge_expired', 'The Admin step-up signature request expired.');
    const valid = await this.verifySignature({ address: admin.address, message: challenge.message, signature });
    assertApi(valid, 401, 'admin_step_up_signature_rejected', 'The Admin wallet signature was rejected.');
    const tokenHash = hashToken(token);
    return this.database.transact((next) => {
      const current = next.challenges?.[nonce];
      assertApi(current?.purpose === 'admin_step_up', 401, 'admin_step_up_challenge_used', 'The Admin step-up signature was already used.');
      delete next.challenges[nonce];
      const session = next.sessions[tokenHash];
      assertApi(session?.type === 'admin', 401, 'admin_session_missing', 'The Admin session is missing.');
      session.stepUpUntil = timestamp + ADMIN_STEP_UP_TTL_MS;
      addAudit(next, admin.address, 'ADMIN_STEP_UP_VERIFIED', `expires ${new Date(session.stepUpUntil).toISOString()}`, timestamp);
      return { address: admin.address, stepUpUntil: session.stepUpUntil };
    });
  }

  assertAdminKey(candidate) {
    assertApi(this.adminKey, 503, 'admin_api_disabled', 'Server admin access is not configured.');
    assertApi(typeof candidate === 'string' && safeTokenEqual(hashToken(candidate), hashToken(this.adminKey)), 401, 'admin_key_rejected', 'The server admin key is invalid.');
  }

  assertPaidCompetitionEligible(address, mode, attestation = undefined) {
    if (this.eligibilityPolicy) return this.eligibilityPolicy.assertEligible(address, { mode, attestation });
    assertApi(
      process.env.NODE_ENV !== 'production',
      503,
      'paid_competition_eligibility_unconfigured',
      'Paid competition eligibility is not configured. Practice remains available.'
    );
    return { eligible: true, developmentOnly: true };
  }

  verifyPaidCompetitionEligibility(address, mode, receiptToken = '') {
    if (this.eligibilityPolicy?.verifyReceipt) {
      return this.eligibilityPolicy.verifyReceipt(address, receiptToken, { mode });
    }
    return this.assertPaidCompetitionEligible(address, mode);
  }

  assertPaymentsEnabled() {
    assertApi(
      this.mainnetTransactionsEnabled,
      503,
      'payments_disabled',
      'Live Ronin payments are disabled on this MATT Mine server.'
    );
  }

  assertArenaEnabled() {
    assertApi(this.arenaService, 503, 'arena_disabled', 'Daily Arena is disabled until its verified contract and server secrets are configured.');
  }
}

export function validateRunResult(input, run, timestamp) {
  assertApi(input && typeof input === 'object' && !Array.isArray(input), 400, 'invalid_run_result', 'A structured run result is required.');
  const extracted = input.extracted === true;
  const projected = strictInteger(input.projected, 'projected', 0, MAX_RUN_SCORE);
  const banked = strictInteger(input.banked, 'banked', 0, projected);
  const depth = strictInteger(input.depth, 'depth', 1, run.mode === SERVER_RUN_MODES.ENDLESS ? 1_000 : 5);
  const kills = strictInteger(input.kills, 'kills', 0, 10_000);
  const oreBroken = strictInteger(input.oreBroken, 'oreBroken', 0, 10_000);
  const elapsed = strictNumber(input.elapsed, 'elapsed', 0, RUN_TTL_MS / 1000);
  const wallElapsed = Math.max(0, (timestamp - run.startedAt) / 1000);
  const verifiedReviveCount = Array.isArray(run.revives) ? run.revives.length : 0;
  const bossTelemetry = normalizeBossTelemetry(input.bossTelemetry, elapsed, verifiedReviveCount + 1);
  const expectedCompletedPhases = completedPhaseMask(depth, extracted);
  const crystalsCarried = strictInteger(input.crystalsCarried || 0, 'crystalsCarried', 0, 1_000_000);
  const completedPhases = input.completedPhases === undefined
    ? expectedCompletedPhases
    : strictInteger(input.completedPhases, 'completedPhases', 0, 0x1f);
  if (run.nftRun) {
    assertApi(
      completedPhases === expectedCompletedPhases,
      422,
      'phase_completion_mismatch',
      'Completed phases do not match the verified run depth and outcome.'
    );
  }
  const carryLimit = Number(run.tuning?.nftCrystalCarryLimit || Number.MAX_SAFE_INTEGER);
  assertApi(crystalsCarried <= carryLimit, 422, 'crystal_carry_limit', 'Carried crystals exceed the active NFT capacity.');

  assertApi(elapsed <= wallElapsed + 15, 422, 'elapsed_time_impossible', 'Reported gameplay time exceeds the server run window.');
  assertApi(kills <= 25 + Math.ceil(elapsed * 8), 422, 'kill_rate_impossible', 'Enemy count exceeds the accepted run rate.');
  assertApi(oreBroken <= 30 + Math.ceil(elapsed * 4), 422, 'ore_rate_impossible', 'Ore count exceeds the accepted run rate.');
  const telemetryScoreCap = 250_000 + depth * 250_000 + kills * 2_500 + oreBroken * 5_000;
  assertApi(projected <= telemetryScoreCap, 422, 'score_impossible', 'Run score exceeds the server telemetry limit.');

  if (extracted) {
    assertApi(banked === projected, 422, 'extraction_mismatch', 'Extracted runs must bank the complete projected score.');
  } else {
    const expectedBanked = Math.floor(projected * (run.tuning?.deathKeepFraction ?? 0.35));
    assertApi(banked === expectedBanked, 422, 'knockout_mismatch', 'Knockout loot does not match the secured-loot rule.');
  }

  return {
    extracted,
    projected,
    banked,
    score: run.mode === SERVER_RUN_MODES.PRACTICE ? projected : extracted ? projected : banked,
    depth,
    kills,
    oreBroken,
    elapsed: Math.round(elapsed * 1000) / 1000,
    bossTelemetry,
    crystalsCarried,
    completedPhases
  };
}

function completedPhaseMask(depth, extracted) {
  const completedDepths = extracted ? depth : Math.max(0, depth - 1);
  let mask = 0;
  for (let index = 0; index < completedDepths; index += 1) mask |= 1 << index;
  return mask;
}

function normalizeBossTelemetry(input, elapsed, maximumPlayerDeaths = 1) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      encounterDuration: 0,
      phaseDurations: { 1: 0, 2: 0, 3: 0 },
      damageDealt: 0,
      damageReceived: 0,
      playerDeaths: 0,
      attacksUsed: {},
      bosses: []
    };
  }
  const startedAt = strictNumber(input.encounterStartedAt || 0, 'bossTelemetry.encounterStartedAt', 0, elapsed);
  const endedAt = strictNumber(input.encounterEndedAt || 0, 'bossTelemetry.encounterEndedAt', 0, elapsed);
  const bosses = Object.values(input.bosses || {}).slice(0, 50).map((boss, index) => {
    assertApi(boss && typeof boss === 'object' && !Array.isArray(boss), 422, 'boss_telemetry_invalid', 'Boss telemetry entries must be objects.');
    const phaseDurations = Object.fromEntries([1, 2, 3].map((phase) => [
      phase,
      strictNumber(boss.phaseDurations?.[phase] || 0, `bossTelemetry.bosses.${index}.phase${phase}`, 0, elapsed)
    ]));
    assertApi(
      Object.values(phaseDurations).reduce((sum, value) => sum + value, 0) <= elapsed + 1,
      422,
      'boss_phase_time_impossible',
      'Boss phase time exceeds the run duration.'
    );
    return {
      bossId: strictInteger(Number(boss.bossId), `bossTelemetry.bosses.${index}.bossId`, 1, 1_000_000),
      phaseDurations,
      attacksUsed: normalizeAttackCounts(boss.attacksUsed, elapsed)
    };
  });
  const attacksUsed = normalizeAttackCounts(input.attacksUsed, elapsed);
  return {
    encounterDuration: startedAt > 0 ? Math.max(0, (endedAt || elapsed) - startedAt) : 0,
    phaseDurations: bosses.reduce((totals, boss) => {
      for (const phase of [1, 2, 3]) totals[phase] += boss.phaseDurations[phase];
      return totals;
    }, { 1: 0, 2: 0, 3: 0 }),
    damageDealt: strictNumber(input.damageDealt || 0, 'bossTelemetry.damageDealt', 0, 25_000_000),
    damageReceived: strictNumber(input.damageReceived || 0, 'bossTelemetry.damageReceived', 0, 1_000_000),
    playerDeaths: strictInteger(
      input.playerDeaths || 0,
      'bossTelemetry.playerDeaths',
      0,
      maximumPlayerDeaths
    ),
    attacksUsed,
    bosses
  };
}

function normalizeAttackCounts(input, elapsed) {
  const allowed = new Set(['slam', 'volley', 'radial', 'summon', 'contact']);
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const result = {};
  for (const [attack, raw] of Object.entries(source)) {
    assertApi(allowed.has(attack), 422, 'boss_attack_unknown', `Unknown boss attack telemetry: ${attack}.`);
    result[attack] = strictInteger(raw, `bossTelemetry.attacksUsed.${attack}`, 0, Math.ceil(elapsed * 10) + 10);
  }
  return result;
}

function aggregateBossTelemetry(runs) {
  const completed = runs
    .filter((run) => run.status === 'finished' && run.result?.bossTelemetry?.encounterDuration > 0)
    .slice(-5_000);
  const totals = {
    encounters: completed.length,
    encounterDuration: 0,
    damageDealt: 0,
    damageReceived: 0,
    playerDeaths: 0,
    phaseDurations: { 1: 0, 2: 0, 3: 0 },
    attacksUsed: {}
  };
  for (const run of completed) {
    const telemetry = run.result.bossTelemetry;
    totals.encounterDuration += telemetry.encounterDuration;
    totals.damageDealt += telemetry.damageDealt;
    totals.damageReceived += telemetry.damageReceived;
    totals.playerDeaths += telemetry.playerDeaths;
    for (const phase of [1, 2, 3]) totals.phaseDurations[phase] += telemetry.phaseDurations?.[phase] || 0;
    for (const [attack, count] of Object.entries(telemetry.attacksUsed || {})) {
      totals.attacksUsed[attack] = (totals.attacksUsed[attack] || 0) + count;
    }
  }
  return {
    ...totals,
    averageEncounterSeconds: completed.length
      ? Math.round((totals.encounterDuration / completed.length) * 100) / 100
      : 0,
    averageDamageDealt: completed.length ? Math.round(totals.damageDealt / completed.length) : 0,
    averageDamageReceived: completed.length ? Math.round(totals.damageReceived / completed.length) : 0
  };
}

function aggregateCharacterTelemetry(runs) {
  const rows = {};
  for (const run of runs) {
    if (run.status !== 'finished' || !run.result) continue;
    const id = run.characterId || 'matt';
    rows[id] ||= { characterId: id, runs: 0, extractions: 0, knockouts: 0, totalScore: 0, totalDepth: 0 };
    rows[id].runs += 1;
    rows[id].extractions += run.result.extracted ? 1 : 0;
    rows[id].knockouts += run.result.extracted ? 0 : 1;
    rows[id].totalScore += Number(run.result.score || 0);
    rows[id].totalDepth += Number(run.result.depth || 0);
  }
  return Object.values(rows).map((row) => ({
    ...row,
    averageScore: row.runs ? Math.round(row.totalScore / row.runs) : 0,
    averageDepth: row.runs ? Math.round(row.totalDepth / row.runs * 100) / 100 : 0,
    extractionRate: row.runs ? Math.round(row.extractions / row.runs * 10_000) / 100 : 0
  }));
}

function publicWalletSnapshot(state, address, timestamp) {
  const wallet = requireWallet(state, address);
  const day = utcDayKey(timestamp);
  const week = utcWeekKey(timestamp);
  const freeDaily = wallet.daily[day] || { freeRunUsed: false, freeRunId: '' };
  const recentRuns = Object.values(state.runs)
    .filter((run) => run.address === address && run.status === 'finished' && run.result)
    .sort((left, right) => Number(right.finishedAt || 0) - Number(left.finishedAt || 0))
    .slice(0, 20)
    .map(publicRun);
  const activeRanked = Object.values(state.runs).find((run) =>
    run.address === address &&
    ![SERVER_RUN_MODES.PRACTICE, SERVER_RUN_MODES.BETA].includes(run.mode) &&
    run.status === 'active' &&
    run.expiresAt > timestamp
  );
  return {
    address,
    identity: publicIdentity(wallet),
    profile: structuredClone(wallet.profile),
    nftCrystals: {
      banked: Math.max(0, Number(wallet.nftCrystalBalance || 0)),
      withdrawalEnabled: false,
      token: 'MATT Crystal'
    },
    passProgress: publicPassProgress(wallet),
    passInventory: publicPassInventory(wallet),
    keybindings: structuredClone(wallet.keybindings),
    paidCompetitionEligibility: publicPaidCompetitionEligibility(wallet),
    suspended: wallet.suspended,
    day,
    week,
    entitlements: {
      freeRunAvailable: Boolean(wallet.identity?.name) && !wallet.suspended && !freeDaily.freeRunUsed && !activeRanked,
      paidRunsEnabled: false,
      activeRankedRunId: activeRanked?.id || null
    },
    scores: {
      free: walletWeeklyScore(state, address, SERVER_RUN_MODES.FREE, week),
      paid: walletWeeklyScore(state, address, SERVER_RUN_MODES.PAID, week)
    },
    recentRuns
  };
}

function publicPaidCompetitionEligibility(wallet = {}) {
  return Object.fromEntries(Object.entries(wallet.paidCompetitionEligibility || {})
    .map(([mode, acceptance]) => [mode, {
      rulesVersion: acceptance.rulesVersion,
      rulesHash: acceptance.rulesHash,
      jurisdiction: acceptance.jurisdiction,
      acceptedAt: acceptance.acceptedAt
    }]));
}

function leaderboardForState(state, mode, week, viewerAddress) {
  const rows = Object.keys(state.wallets)
    .filter((address) => !state.wallets[address].suspended)
    .map((address) => ({
      address,
      score: walletWeeklyScore(state, address, mode, week)
    }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.address.localeCompare(right.address))
    .map((row, index) => ({
      rank: index + 1,
      address: row.address,
      walletId: state.wallets[row.address]?.identity?.name || abbreviateAddress(row.address),
      score: row.score,
      isPlayer: row.address === viewerAddress,
      verified: true,
      identity: publicIdentity(state.wallets[row.address]),
      appearance: publicLeaderboardAppearance(state.wallets[row.address])
    }));
  const player = rows.find((row) => row.address === viewerAddress);
  return {
    mode,
    week,
    rows: rows.slice(0, 100),
    playerRank: player?.rank || 0,
    playerScore: player?.score || 0
  };
}

function walletWeeklyScore(state, address, mode, week) {
  const override = state.leaderboardOverrides?.[`${week}:${mode}:${address}`];
  if (override && Number.isSafeInteger(override.score)) return override.score;
  const dailyBest = new Map();
  for (const run of Object.values(state.runs)) {
    if (
      run.address !== address ||
      run.mode !== mode ||
      run.week !== week ||
      run.status !== 'finished' ||
      !run.result
    ) continue;
    dailyBest.set(run.day, Math.max(dailyBest.get(run.day) || 0, run.result.score));
  }
  return [...dailyBest.values()].reduce((sum, score) => sum + score, 0);
}

function unusedPaidEntitlements(state, address) {
  return Object.values(state.paidEntitlements || {})
    .filter((entitlement) =>
      entitlement.address === address &&
      !entitlement.consumedAt &&
      !entitlement.usedRunId
    )
    .sort((left, right) => {
      if (left.confirmedAt !== right.confirmedAt) return left.confirmedAt - right.confirmedAt;
      const leftId = BigInt(left.entitlementId || '0');
      const rightId = BigInt(right.entitlementId || '0');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
}

function publicRun(run) {
  return {
    id: run.id,
    mode: run.mode,
    seed: run.seed,
    day: run.day,
    week: run.week,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    passXpAwarded: Number(run.passXpAwarded || 0),
    characterId: run.characterId || 'matt',
    result: structuredClone(run.result)
  };
}

function publicPassProgress(wallet) {
  const xp = Number(wallet?.passProgress?.xp || 0);
  const level = passLevel(xp);
  return {
    xp,
    level: level.level,
    progress: level.progress,
    currentLevelXp: level.current,
    nextLevelXp: level.next,
    maxLevel: level.maxLevel,
    updatedAt: Number(wallet?.passProgress?.updatedAt || 0)
  };
}

function publicPassInventory(wallet) {
  const inventory = wallet?.passInventory || {};
  return {
    claimedLevels: [...(inventory.claimedLevels || [])],
    cosmetics: [...(inventory.cosmetics || [])],
    equipped: structuredClone(inventory.equipped || {}),
    chests: structuredClone(inventory.chests || {})
  };
}

function syncPassRewardsForWallet(wallet, timestamp) {
  const level = passLevel(wallet.passProgress.xp).level;
  const unlocked = [];
  for (const reward of PASS_REWARD_LEVELS) {
    if (reward.level > level || wallet.passInventory.claimedLevels.includes(reward.level)) continue;
    wallet.passInventory.claimedLevels.push(reward.level);
    wallet.passInventory.claimedLevels.sort((left, right) => left - right);
    if (reward.type === 'cosmetic') {
      unlockCosmetic(wallet, reward.cosmeticId);
      const cosmetic = PASS_COSMETICS[reward.cosmeticId];
      if (cosmetic && !wallet.passInventory.equipped[cosmetic.slot]) {
        wallet.passInventory.equipped[cosmetic.slot] = cosmetic.id;
      }
    }
    if (reward.type === 'chest') {
      wallet.passInventory.chests[reward.chestId].available += 1;
    }
    unlocked.push(structuredClone(reward));
  }
  if (unlocked.length) wallet.passProgress.updatedAt = timestamp;
  return unlocked;
}

function unlockCosmetic(wallet, cosmeticId) {
  if (!PASS_COSMETICS[cosmeticId]) return false;
  if (wallet.passInventory.cosmetics.includes(cosmeticId)) return false;
  wallet.passInventory.cosmetics.push(cosmeticId);
  return true;
}

function publicLeaderboardAppearance(wallet) {
  const equipped = wallet?.passInventory?.equipped || {};
  return {
    badge: equipped.badge || '',
    frame: equipped.frame || '',
    title: equipped.title || '',
    trophy: equipped.trophy || ''
  };
}

function publicCompetitionSlot(definition, snapshot, operations = {}) {
  const mineOperations = operations.mines?.[definition.id] || {};
  const entriesPaused = definition.comingSoon
    ? false
    : operations.maintenanceMode === true
      || mineOperations.entriesPaused === true
      || (definition.id === 'daily' && operations.freeRankedPaused === true)
      || (definition.id === 'pass' && operations.passRankedPaused === true);
  return {
    ...definition,
    state: definition.comingSoon ? 'coming-soon' : snapshot?.status || 'draft',
    entriesPaused,
    snapshot: snapshot ? {
      id: snapshot.id,
      name: snapshot.name,
      subtitle: snapshot.subtitle,
      status: snapshot.status,
      effectiveAt: snapshot.effectiveAt,
      expiresAt: snapshot.expiresAt,
      fingerprint: snapshot.fingerprint,
      map: structuredClone(snapshot.map),
      depths: structuredClone(snapshot.depths),
      loadout: structuredClone(snapshot.loadout),
      rules: structuredClone(snapshot.rules)
    } : null
  };
}

function publicIdentity(wallet) {
  const identity = wallet?.identity || {};
  return {
    name: identity.name || '',
    avatarUrl: identity.avatarDataUrl && wallet?.address
      ? `/api/profiles/${wallet.address}/avatar?v=${Number(identity.avatarUpdatedAt || 0)}`
      : '',
    createdAt: Number(identity.createdAt || 0),
    avatarUpdatedAt: Number(identity.avatarUpdatedAt || 0),
    requiresSetup: !identity.name
  };
}

function enrichLeaderboardAppearances(leaderboard, state) {
  return {
    ...leaderboard,
    rows: (leaderboard.rows || []).map((row) => ({
      ...row,
      walletId: state.wallets[row.address]?.identity?.name || row.walletId || abbreviateAddress(row.address),
      identity: publicIdentity(state.wallets[row.address]),
      appearance: publicLeaderboardAppearance(state.wallets[row.address])
    }))
  };
}

function finalizationLeaderboardFallback(completed) {
  const score = Math.max(0, Number(completed?.run?.result?.score || 0));
  return {
    mode: completed.mode,
    week: completed.week,
    rows: [],
    playerScore: score,
    playerRank: 0,
    temporarilyUnavailable: true,
    message: 'Your run is saved. The leaderboard is reconnecting to PostgreSQL.'
  };
}

function publicAdminRun(run) {
  return {
    ...publicRun(run),
    expiresAt: run.expiresAt,
    address: run.address
  };
}

function adminWalletSnapshot(state, wallet, timestamp) {
  const sessions = Object.values(state.sessions).filter((session) =>
    session.address === wallet.address && session.expiresAt > timestamp
  );
  const runs = Object.values(state.runs).filter((run) => run.address === wallet.address);
  const entitlements = Object.values(state.paidEntitlements).filter((entry) => entry.address === wallet.address);
  const today = wallet.daily[utcDayKey(timestamp)] || { freeRunUsed: false };
  return {
    address: wallet.address,
    identity: publicIdentity(wallet),
    suspended: wallet.suspended,
    profile: structuredClone(wallet.profile),
    passProgress: publicPassProgress(wallet),
    passInventory: publicPassInventory(wallet),
    freeRunUsedToday: today.freeRunUsed === true,
    activeSessions: sessions.length,
    activeRuns: runs.filter((run) => run.status === 'active' && run.expiresAt > timestamp).length,
    finishedRuns: runs.filter((run) => run.status === 'finished').length,
    unusedPaidCredits: entitlements.filter((entry) => !entry.consumedAt && !entry.usedRunId).length,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt
  };
}

function awaitlessPublicOperations(operations) {
  const source = operations || {};
  return {
    maintenanceMode: source.maintenanceMode === true,
    freeRankedPaused: source.freeRankedPaused === true,
    passRankedPaused: source.passRankedPaused === true,
    purchasesPaused: source.purchasesPaused === true,
    claimsPaused: source.claimsPaused === true,
    mines: structuredClone(source.mines || {}),
    announcement: typeof source.announcement === 'string' ? source.announcement : ''
  };
}

function mineForRunMode(mode) {
  if (mode === SERVER_RUN_MODES.PRACTICE || mode === SERVER_RUN_MODES.BETA) return 'practice';
  if (mode === SERVER_RUN_MODES.FREE) return 'daily';
  if (mode === SERVER_RUN_MODES.PAID) return 'pass';
  if (mode === SERVER_RUN_MODES.WEEKLY) return 'weekly';
  return null;
}

function mineDisplayName(mine) {
  return {
    practice: 'Practice Mine',
    arena: 'MATT Arena',
    daily: 'Daily Mine',
    pass: 'Pass Mine',
    weekly: 'Seven-Day Mine'
  }[mine] || 'Mine';
}

function appendCompetitionSnapshotId(snapshotIds, slotId, snapshotId) {
  const bootstrapId = `bootstrap_${slotId}_v1`;
  return [
    bootstrapId,
    ...[...new Set([
      ...(Array.isArray(snapshotIds) ? snapshotIds : []),
      snapshotId
    ].filter((id) => id && id !== bootstrapId))].slice(-89)
  ];
}

function mineOperationCapabilities(mine) {
  return {
    practice: ['entries', 'results'],
    arena: ['entries', 'results', 'payments', 'rewards'],
    daily: ['entries', 'results', 'rewards'],
    pass: ['entries', 'results', 'payments', 'rewards'],
    weekly: ['entries', 'results']
  }[mine] || [];
}

function assertMineOperationOpen(operations, mine, operation, message) {
  const key = `${operation}Paused`;
  assertApi(
    operations?.mines?.[mine]?.[key] !== true,
    503,
    `${mine}_${operation}_paused`,
    message
  );
}

function previousUtcWeek(timestamp) {
  const current = utcWeekKey(timestamp);
  return utcWeekKey(Date.parse(`${current}T00:00:00.000Z`) - 1);
}

async function expireOldRuns(state, timestamp, transaction) {
  for (const [runId, run] of Object.entries(state.runs)) {
    if (run.status !== 'active' || run.expiresAt > timestamp) continue;
    run.status = 'expired';
    await transaction?.upsertRun(run);
  }
}

function suspendedWalletAddresses(state) {
  return Object.values(state.wallets || {})
    .filter((wallet) => wallet?.suspended === true)
    .map((wallet) => wallet.address);
}

function normalizeWeekKey(value, currentWeek) {
  if (!value) return currentWeek;
  const week = String(value);
  const parsed = Date.parse(`${week}T00:00:00.000Z`);
  assertApi(
    /^\d{4}-\d{2}-\d{2}$/.test(week) &&
      Number.isFinite(parsed) &&
      utcWeekKey(parsed) === week &&
      week <= currentWeek,
    400,
    'invalid_leaderboard_week',
    'Choose a valid current or historical leaderboard week.'
  );
  return week;
}

function pruneSecurityRecords(state, timestamp) {
  for (const [nonce, challenge] of Object.entries(state.challenges)) {
    if (!Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= timestamp) delete state.challenges[nonce];
  }
  for (const [tokenHash, session] of Object.entries(state.sessions)) {
    if (!Number.isFinite(session.expiresAt) || session.expiresAt <= timestamp) delete state.sessions[tokenHash];
  }
}

function requireWallet(state, address) {
  const wallet = state.wallets[address];
  assertApi(wallet, 401, 'wallet_missing', 'The authenticated wallet profile was not found.');
  return wallet;
}

function assertIdentityReady(wallet) {
  assertApi(
    Boolean(wallet?.identity?.name),
    409,
    'miner_identity_required',
    'Choose your permanent miner name before entering ranked play.'
  );
}

function normalizeAddress(value) {
  assertApi(typeof value === 'string', 400, 'invalid_address', 'A Ronin wallet address is required.');
  try {
    return getAddress(value).toLowerCase();
  } catch {
    throw new ApiError(400, 'invalid_address', 'The Ronin wallet address is invalid.');
  }
}

function normalizeAdminReason(value) {
  assertApi(typeof value === 'string', 400, 'admin_reason_required', 'A written reason is required for this admin action.');
  const reason = value.trim();
  assertApi(reason.length >= 5 && reason.length <= 240, 400, 'admin_reason_invalid', 'Admin reason must be 5 to 240 characters.');
  return reason;
}

function strictInteger(value, name, min, max) {
  assertApi(Number.isSafeInteger(value) && value >= min && value <= max, 422, `invalid_${name}`, `${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function strictNumber(value, name, min, max) {
  assertApi(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 422, `invalid_${name}`, `${name} must be a number from ${min} to ${max}.`);
  return value;
}

function assertToken(value) {
  assertApi(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 401, 'session_invalid', 'The wallet session is invalid.');
  return value;
}

function hashToken(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeTokenEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function findPracticeClaimByTransactionHash(practiceClaims, transactionHash) {
  if (!practiceClaims || !transactionHash) return null;
  for (const claim of Object.values(practiceClaims)) {
    if (claim.status === 'claimed' && claim.transactionHash === transactionHash) return claim;
  }
  return null;
}

function normalizeTransactionHash(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function publicEligibilityRecord(eligibility = {}) {
  return {
    enforcement: eligibility.enforcement || 'development',
    rulesVersion: eligibility.rulesVersion || null,
    rulesHash: eligibility.rulesHash || null,
    rulesUrl: eligibility.rulesUrl || null,
    jurisdiction: eligibility.jurisdiction || null,
    acceptedAt: eligibility.acceptedAt || null,
    expiresAt: eligibility.expiresAt || null
  };
}

function safeInteger(value, fallback = 0, allowNegative = false) {
  if (!Number.isSafeInteger(value)) return fallback;
  if (!allowNegative && value < 0) return fallback;
  return value;
}

function abbreviateAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function addAudit(state, actor, action, details, timestamp) {
  state.audit.push({
    id: `${timestamp}-${state.audit.length + 1}`,
    actor,
    action,
    details,
    timestamp
  });
  state.audit = state.audit.slice(-2_000);
}

function addPlayerActivity(wallet, action, details, timestamp) {
  wallet.activity ||= [];
  wallet.activity.push({
    id: `${timestamp}-${wallet.activity.length + 1}`,
    action,
    details: String(details || '').slice(0, 500),
    timestamp
  });
  wallet.activity = wallet.activity.slice(-500);
}
