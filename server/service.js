import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { META_UPGRADES } from '../src/game/config.js';
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
import { MATT_MINE_LAUNCH_PRICES } from './payment-verifier.js';
import { defaultWalletState } from './state.js';
import {
  createAdminSafeTransactionFile,
  listAdminContractActions,
  MATT_MINE_ADMIN_CONTRACTS,
  prepareAdminContractTransactions
} from './admin-controls.js';

const FREE_PASS_XP = 25;
const PAID_PASS_XP = 100;

export class MattMineService {
  constructor(database, options = {}) {
    this.database = database;
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || ((bytes) => randomBytes(bytes).toString('hex'));
    this.verifySignature = options.verifySignature || verifyMessage;
    this.paymentVerifier = options.paymentVerifier || null;
    this.rewardManager = options.rewardManager || null;
    this.mainnetTransactionsEnabled =
      options.mainnetTransactionsEnabled === true && Boolean(this.paymentVerifier);
    const configuredChainId = Number(options.chainId ?? RONIN_CHAINS.MAINNET);
    this.publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : null;
    this.adminKey = options.adminKey || '';
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
      walletMode: 'ronin-injected-provider',
      rankedServerEnabled: true,
      paidRunsEnabled: this.mainnetTransactionsEnabled,
      realPaymentsEnabled: this.mainnetTransactionsEnabled,
      mattClaimsEnabled: Boolean(this.rewardManager),
      mainnetTransactionsEnabled: this.mainnetTransactionsEnabled,
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
    const database = await this.database.healthCheck();
    const state = await this.database.read();
    this.cachedOperations = state.operations;
    return {
      database,
      chainId: this.chainId,
      paymentsEnabled: this.mainnetTransactionsEnabled,
      rewardsEnabled: Boolean(this.rewardManager),
      rewardPublishingEnabled: this.rewardManager?.publicationEnabled === true
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
    return this.hydratePlayerScores(player);
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
      wallet.profile.bankedNuggets += PASS_CHEST_BONUS_NUGGETS;
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
    const wallet = requireWallet(state, session.address);
    assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from paid-run purchases.');
    return this.paymentVerifier.quotePaidRun(session.address);
  }

  async confirmPaidRunPurchase(token, transactionHash) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const before = await this.database.read();
    assertApi(!before.operations.purchasesPaused, 503, 'server_purchases_paused', 'Paid-run purchases are temporarily paused by MATT Mine.');
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
    let passActiveAtStart = false;
    if (normalizedMode === SERVER_RUN_MODES.PAID) {
      assertApi(
        this.mainnetTransactionsEnabled,
        403,
        'paid_runs_disabled',
        'Paid ranked runs remain disabled until live payment verification is enabled.'
      );
      const paymentStatus = await this.paymentVerifier.status(session.address);
      assertApi(paymentStatus.pass.active, 403, 'active_pass_required', 'An active MATT Mine Pass is required.');
      assertApi(!paymentStatus.paidRuns.paused, 503, 'paid_runs_paused', 'Paid ranked runs are currently paused.');
      passActiveAtStart = true;
    } else if (normalizedMode === SERVER_RUN_MODES.FREE && this.mainnetTransactionsEnabled) {
      const paymentStatus = await this.paymentVerifier.status(session.address).catch(() => null);
      passActiveAtStart = paymentStatus?.pass?.active === true;
    }
    const timestamp = this.now();
    const runId = `run_${this.randomHex(12)}`;
    const runToken = this.randomHex(24);
    const runTokenHash = hashToken(runToken);

    return this.database.transact(async (state, transaction) => {
      const wallet = requireWallet(state, session.address);
      await expireOldRuns(state, timestamp, transaction);
      if (normalizedMode !== SERVER_RUN_MODES.PRACTICE) {
        assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from ranked play.');
        const activeRanked = Object.values(state.runs).find((run) =>
          run.address === session.address &&
          run.mode !== SERVER_RUN_MODES.PRACTICE &&
          run.status === 'active'
        );
        assertApi(!activeRanked, 409, 'ranked_run_active', 'Finish or expire the current ranked run before starting another.');
      }

      const day = utcDayKey(timestamp);
      const week = utcWeekKey(timestamp);
      const weekEndsAt = Date.parse(`${week}T00:00:00.000Z`) + 7 * 24 * 60 * 60 * 1000;
      if (normalizedMode !== SERVER_RUN_MODES.PRACTICE) {
        assertApi(
          weekEndsAt - timestamp >= MIN_RANKED_RUN_WINDOW_MS,
          409,
          'ranked_window_closing',
          'Ranked entries are closed for the final five minutes so the leaderboard can finalize exactly at zero.'
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

      const seed = normalizedMode === SERVER_RUN_MODES.FREE
        ? `MATT-MINE-${day}-FREE`
        : normalizedMode === SERVER_RUN_MODES.PAID
          ? `MATT-MINE-${day}-PAID`
          : `MATT-PRACTICE-${day}-${this.randomHex(10)}`;
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
        expiresAt: normalizedMode === SERVER_RUN_MODES.PRACTICE
          ? timestamp + RUN_TTL_MS
          : Math.min(timestamp + RUN_TTL_MS, weekEndsAt),
        finishedAt: 0,
        passActiveAtStart,
        passXpAwarded: 0,
        result: null
      };
      state.runs[runId] = serverRun;
      await transaction?.upsertRun(serverRun);
      wallet.updatedAt = timestamp;
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
        expiresAt: serverRun.expiresAt
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
      assertApi(run.status === 'active', 409, 'run_already_finished', 'This run was already submitted.');
      assertApi(run.expiresAt > timestamp, 410, 'run_expired', 'The run expired before it was submitted.');
      assertApi(safeTokenEqual(run.tokenHash, hashToken(runToken)), 401, 'run_token_rejected', 'The run token is invalid.');
      if (run.mode !== SERVER_RUN_MODES.PRACTICE) {
        assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from ranked score submission.');
      }

      const result = validateRunResult(payload.result, run, timestamp);
      run.status = 'finished';
      run.finishedAt = timestamp;
      run.result = result;
      wallet.profile.bankedNuggets += result.banked;
      wallet.profile.bestDepth = Math.max(wallet.profile.bestDepth, result.depth);
      wallet.profile.bestScore = Math.max(wallet.profile.bestScore, result.score);
      wallet.profile.totalRuns += 1;
      const passXpAwarded = run.passActiveAtStart
        ? run.mode === SERVER_RUN_MODES.PAID
          ? PAID_PASS_XP
          : run.mode === SERVER_RUN_MODES.FREE
            ? FREE_PASS_XP
            : 0
        : 0;
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
      addAudit(state, session.address, 'SERVER_RUN_VERIFIED', `${run.mode} score ${result.score}`, timestamp);
      return {
        accepted: true,
        run: publicRun(run),
        profile: structuredClone(wallet.profile),
        passProgress: publicPassProgress(wallet),
        passInventory: publicPassInventory(wallet),
        passRewardsUnlocked,
        mode: run.mode,
        week: run.week
      };
    });
    const leaderboard = await this.leaderboardFor(
      completed.mode,
      completed.week,
      session.address
    );
    return {
      accepted: completed.accepted,
      run: completed.run,
      profile: completed.profile,
      passProgress: completed.passProgress,
      passInventory: completed.passInventory,
      passRewardsUnlocked: completed.passRewardsUnlocked,
      leaderboard
    };
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
    return this.rewardManager.prepareClaim(session.address, draftId);
  }

  async createRewardDraft(adminKey, input) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    return this.rewardManager.createDraft(adminKey, input);
  }

  async approveRewardDraft(approverKey, draftId) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    return this.rewardManager.approveDraft(approverKey, draftId);
  }

  async syncRewardDraft(adminKey, draftId, transactionHash) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    return this.rewardManager.syncDraft(adminKey, draftId, transactionHash);
  }

  async listRewardDrafts(adminKey) {
    assertApi(this.rewardManager, 503, 'reward_pipeline_unavailable', 'The reward pipeline is not configured.');
    return this.rewardManager.listDrafts(adminKey);
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
      const cost = Math.floor(upgrade.baseCost * Math.pow(1.55, rank));
      assertApi(wallet.profile.bankedNuggets >= cost, 409, 'insufficient_nuggets', 'Not enough banked nuggets.');
      wallet.profile.bankedNuggets -= cost;
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
      contractActions: listAdminContractActions()
    };
  }

  async adminWallets(adminKey, query = '') {
    this.assertAdminKey(adminKey);
    const state = await this.database.read();
    const needle = String(query || '').trim().toLowerCase().slice(0, 80);
    const timestamp = this.now();
    const wallets = Object.values(state.wallets)
      .filter((wallet) => !needle || wallet.address.includes(needle))
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
        .map((entry) => structuredClone(entry))
    };
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
      next.updatedAt = timestamp;
      next.updatedBy = 'SERVER_ADMIN';
      state.operations = next;
      this.cachedOperations = next;
      addAudit(state, 'SERVER_ADMIN', 'OPERATIONS_UPDATED', `${normalizedReason}: ${JSON.stringify(patch)}`, timestamp);
      return { operations: structuredClone(next), reason: normalizedReason };
    });
  }

  async adminWalletAction(adminKey, address, action, reason) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    const normalizedAction = String(action || '');
    assertApi(['revoke_sessions', 'expire_active_runs', 'restore_free_run'].includes(normalizedAction), 400, 'wallet_action_invalid', 'Unknown wallet administration action.');
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    return this.database.transact(async (state, transaction) => {
      requireWallet(state, normalizedAddress);
      let affected = 0;
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
          await transaction?.upsertRun(run);
          affected += 1;
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
      return { address: normalizedAddress, action: normalizedAction, affected, reason: normalizedReason };
    });
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

  async authenticate(token) {
    const rawToken = assertToken(token);
    const tokenHash = hashToken(rawToken);
    const state = await this.database.read();
    const session = state.sessions[tokenHash];
    assertApi(session, 401, 'session_missing', 'Sign in with Ronin Wallet to continue.');
    assertApi(session.expiresAt > this.now(), 401, 'session_expired', 'The wallet session expired. Sign in again.');
    requireWallet(state, session.address);
    return session;
  }

  assertAdminKey(candidate) {
    assertApi(this.adminKey, 503, 'admin_api_disabled', 'Server admin access is not configured.');
    assertApi(typeof candidate === 'string' && safeTokenEqual(hashToken(candidate), hashToken(this.adminKey)), 401, 'admin_key_rejected', 'The server admin key is invalid.');
  }

  assertPaymentsEnabled() {
    assertApi(
      this.mainnetTransactionsEnabled,
      503,
      'payments_disabled',
      'Live Ronin payments are disabled on this MATT Mine server.'
    );
  }
}

export function validateRunResult(input, run, timestamp) {
  assertApi(input && typeof input === 'object' && !Array.isArray(input), 400, 'invalid_run_result', 'A structured run result is required.');
  const extracted = input.extracted === true;
  const projected = strictInteger(input.projected, 'projected', 0, MAX_RUN_SCORE);
  const banked = strictInteger(input.banked, 'banked', 0, projected);
  const depth = strictInteger(input.depth, 'depth', 1, 5);
  const kills = strictInteger(input.kills, 'kills', 0, 10_000);
  const oreBroken = strictInteger(input.oreBroken, 'oreBroken', 0, 10_000);
  const elapsed = strictNumber(input.elapsed, 'elapsed', 0, RUN_TTL_MS / 1000);
  const wallElapsed = Math.max(0, (timestamp - run.startedAt) / 1000);

  assertApi(elapsed <= wallElapsed + 15, 422, 'elapsed_time_impossible', 'Reported gameplay time exceeds the server run window.');
  assertApi(kills <= 25 + Math.ceil(elapsed * 8), 422, 'kill_rate_impossible', 'Enemy count exceeds the accepted run rate.');
  assertApi(oreBroken <= 30 + Math.ceil(elapsed * 4), 422, 'ore_rate_impossible', 'Ore count exceeds the accepted run rate.');
  const telemetryScoreCap = 250_000 + depth * 250_000 + kills * 2_500 + oreBroken * 5_000;
  assertApi(projected <= telemetryScoreCap, 422, 'score_impossible', 'Run score exceeds the server telemetry limit.');

  if (extracted) {
    assertApi(banked === projected, 422, 'extraction_mismatch', 'Extracted runs must bank the complete projected score.');
  } else {
    const expectedBanked = Math.floor(projected * 0.35);
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
    elapsed: Math.round(elapsed * 1000) / 1000
  };
}

function publicWalletSnapshot(state, address, timestamp) {
  const wallet = requireWallet(state, address);
  const day = utcDayKey(timestamp);
  const week = utcWeekKey(timestamp);
  const freeDaily = wallet.daily[day] || { freeRunUsed: false, freeRunId: '' };
  const activeRanked = Object.values(state.runs).find((run) =>
    run.address === address &&
    run.mode !== SERVER_RUN_MODES.PRACTICE &&
    run.status === 'active' &&
    run.expiresAt > timestamp
  );
  return {
    address,
    profile: structuredClone(wallet.profile),
    passProgress: publicPassProgress(wallet),
    passInventory: publicPassInventory(wallet),
    suspended: wallet.suspended,
    day,
    week,
    entitlements: {
      freeRunAvailable: !wallet.suspended && !freeDaily.freeRunUsed && !activeRanked,
      paidRunsEnabled: false,
      activeRankedRunId: activeRanked?.id || null
    },
    scores: {
      free: walletWeeklyScore(state, address, SERVER_RUN_MODES.FREE, week),
      paid: walletWeeklyScore(state, address, SERVER_RUN_MODES.PAID, week)
    }
  };
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
      walletId: abbreviateAddress(row.address),
      score: row.score,
      isPlayer: row.address === viewerAddress,
      verified: true,
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

function enrichLeaderboardAppearances(leaderboard, state) {
  return {
    ...leaderboard,
    rows: (leaderboard.rows || []).map((row) => ({
      ...row,
      appearance: publicLeaderboardAppearance(state.wallets[row.address])
    }))
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
    announcement: typeof source.announcement === 'string' ? source.announcement : ''
  };
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
