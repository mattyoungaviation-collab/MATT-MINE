import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, verifyMessage } from 'viem';
import { META_UPGRADES } from '../src/game/config.js';
import { utcDayKey, utcWeekKey } from '../src/game/economy.js';
import {
  AUTH_CHALLENGE_TTL_MS,
  MAX_RUN_SCORE,
  RONIN_CHAINS,
  RUN_TTL_MS,
  SERVER_RUN_MODES,
  SESSION_TTL_MS
} from './constants.js';
import { buildSignInMessage, normalizeOrigin } from './auth-message.js';
import { ApiError, assertApi } from './errors.js';
import { MATT_MINE_LAUNCH_PRICES } from './payment-verifier.js';
import { defaultWalletState } from './state.js';

export class MattMineService {
  constructor(database, options = {}) {
    this.database = database;
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || ((bytes) => randomBytes(bytes).toString('hex'));
    this.verifySignature = options.verifySignature || verifyMessage;
    this.paymentVerifier = options.paymentVerifier || null;
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
      mattClaimsEnabled: false,
      mainnetTransactionsEnabled: this.mainnetTransactionsEnabled,
      ...(this.mainnetTransactionsEnabled
        ? { payments: this.paymentVerifier.publicConfig() }
        : {})
    };
  }

  async health() {
    const database = await this.database.healthCheck();
    return {
      database,
      chainId: this.chainId,
      paymentsEnabled: this.mainnetTransactionsEnabled
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
    return { token, expiresAt, ...result };
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
    return player;
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
      ...chain
    };
  }

  async quotePaidRun(token) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const state = await this.database.read();
    const wallet = requireWallet(state, session.address);
    assertApi(!wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from paid-run purchases.');
    return this.paymentVerifier.quotePaidRun(session.address);
  }

  async confirmPaidRunPurchase(token, transactionHash) {
    const session = await this.authenticate(token);
    this.assertPaymentsEnabled();
    const before = await this.database.read();
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
    }
    const timestamp = this.now();
    const runId = `run_${this.randomHex(12)}`;
    const runToken = this.randomHex(24);
    const runTokenHash = hashToken(runToken);

    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      expireOldRuns(state, timestamp);
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
      state.runs[runId] = {
        id: runId,
        tokenHash: runTokenHash,
        address: session.address,
        mode: normalizedMode,
        seed,
        day,
        week,
        status: 'active',
        startedAt: timestamp,
        expiresAt: timestamp + RUN_TTL_MS,
        finishedAt: 0,
        result: null
      };
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
        expiresAt: timestamp + RUN_TTL_MS
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

    return this.database.transact((state) => {
      const wallet = requireWallet(state, session.address);
      const run = state.runs[runId];
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
      wallet.updatedAt = timestamp;
      addAudit(state, session.address, 'SERVER_RUN_VERIFIED', `${run.mode} score ${result.score}`, timestamp);
      return {
        accepted: true,
        run: publicRun(run),
        profile: structuredClone(wallet.profile),
        leaderboard: leaderboardForState(state, run.mode, run.week, session.address)
      };
    });
  }

  async leaderboard(token, mode, timestamp = this.now()) {
    const session = await this.authenticate(token);
    const normalizedMode = String(mode || '');
    assertApi(
      [SERVER_RUN_MODES.FREE, SERVER_RUN_MODES.PAID].includes(normalizedMode),
      400,
      'invalid_leaderboard',
      'Choose the Free or Pass leaderboard.'
    );
    const state = await this.database.read();
    return leaderboardForState(state, normalizedMode, utcWeekKey(timestamp), session.address);
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

  async setWalletSuspension(adminKey, address, suspended) {
    this.assertAdminKey(adminKey);
    const normalizedAddress = normalizeAddress(address);
    assertApi(typeof suspended === 'boolean', 400, 'invalid_suspension', 'Suspension must be true or false.');
    const timestamp = this.now();
    return this.database.transact((state) => {
      if (!state.wallets[normalizedAddress]) state.wallets[normalizedAddress] = defaultWalletState(normalizedAddress, timestamp);
      state.wallets[normalizedAddress].suspended = suspended;
      state.wallets[normalizedAddress].updatedAt = timestamp;
      addAudit(state, 'SERVER_ADMIN', suspended ? 'WALLET_SUSPENDED' : 'WALLET_RESTORED', normalizedAddress, timestamp);
      return { address: normalizedAddress, suspended };
    });
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
      verified: true
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
    result: structuredClone(run.result)
  };
}

function expireOldRuns(state, timestamp) {
  for (const run of Object.values(state.runs)) {
    if (run.status === 'active' && run.expiresAt <= timestamp) run.status = 'expired';
  }
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
