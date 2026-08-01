import { getAddress } from 'viem';
import { createHash } from 'node:crypto';
import { AdminMattMineService } from './admin-service.js';
import { ApiError, assertApi } from './errors.js';
import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta
} from './nugget-ledger.js';
import {
  addEconomyAudit,
  mergeNuggetEconomyConfig,
  publicNuggetEconomyConfig,
  purchasedNuggetsForDay,
  recentPurchasesForWallet,
  utcDayKeyFromTimestamp
} from './nugget-economy.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export class ProductionMattMineService extends AdminMattMineService {
  constructor(database, options = {}) {
    super(database, options);
    this.nuggetEconomyStore = options.nuggetEconomyStore || null;
    this.nuggetEconomyStore?.setClock?.(this.now);
    this.nuggetPaymentVerifier = options.nuggetPaymentVerifier || null;
    this.nuggetPaymentsEnabled =
      options.nuggetPaymentsEnabled === true &&
      Boolean(this.nuggetEconomyStore) &&
      Boolean(this.nuggetPaymentVerifier);
  }

  async me(token) {
    const player = await super.me(token);
    if (!this.nuggetEconomyStore) return player;
    const economy = await this.nuggetEconomyStore.read();
    const day = utcDayKeyFromTimestamp(this.now());
    return {
      ...player,
      nuggetEconomy: {
        config: publicNuggetEconomyConfig(economy.config),
        livePaymentVerification: this.nuggetPaymentsEnabled,
        purchasedToday: purchasedNuggetsForDay(economy.purchases, player.address, day),
        purchaseHistory: recentPurchasesForWallet(economy.purchases, player.address, 25)
      }
    };
  }

  async nuggetEconomyStatus(token) {
    const session = await this.authenticate(token);
    this.assertNuggetEconomyConfigured();
    const economy = await this.nuggetEconomyStore.read();
    const day = utcDayKeyFromTimestamp(this.now());
    return {
      address: session.address,
      config: publicNuggetEconomyConfig(economy.config),
      livePaymentVerification: this.nuggetPaymentsEnabled,
      releaseBlocker: this.nuggetPaymentsEnabled
        ? ''
        : 'Live nugget payments are disabled until the exact Ronin verifier is explicitly enabled.',
      purchasedToday: purchasedNuggetsForDay(economy.purchases, session.address, day),
      purchaseHistory: recentPurchasesForWallet(economy.purchases, session.address, 50)
    };
  }

  async quoteNuggetPurchase(token, input = {}) {
    const session = await this.authenticate(token);
    this.assertNuggetPaymentsEnabled();
    const timestamp = this.now();
    const baseState = await this.database.read();
    const wallet = baseState.wallets[session.address];
    assertApi(wallet && !wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from nugget purchases.');
    assertApi(!baseState.operations.purchasesPaused, 503, 'server_purchases_paused', 'Nugget purchases are temporarily paused by MATT Mine.');
    const packageId = normalizeId(input.packageId, 'package_id');
    const requestedAsset = normalizeAsset(input.asset);

    return this.nuggetEconomyStore.transact((state) => {
      const config = state.config;
      assertApi(config.purchasesEnabled, 503, 'nugget_purchases_disabled', 'Nugget purchases are disabled in the Admin Command Center.');
      const purchasePackage = config.packages.find((entry) => entry.id === packageId && entry.enabled);
      assertApi(purchasePackage, 404, 'nugget_package_missing', 'That nugget package is unavailable.');
      const asset = requestedAsset || firstAvailableAsset(config, purchasePackage);
      assertApi(asset && config.allowedAssets[asset], 422, 'payment_asset_disabled', 'That payment asset is not enabled.');
      const amountAtomic = purchasePackage.prices[asset];
      assertApi(BigInt(amountAtomic) > 0n, 422, 'package_price_missing', 'That package does not have a live price in the selected asset.');
      const day = utcDayKeyFromTimestamp(timestamp);
      const confirmed = purchasedNuggetsForDay(state.purchases, session.address, day);
      const reserved = reservedPurchaseNuggets(state, session.address, day);
      assertApi(
        confirmed + reserved + purchasePackage.nuggets <= config.dailyPurchaseCap,
        409,
        'nugget_daily_cap',
        `This purchase would exceed the ${config.dailyPurchaseCap.toLocaleString()} nugget UTC daily cap.`
      );
      const quote = createQuote({
        service: this,
        address: session.address,
        purpose: 'purchase',
        packageId: purchasePackage.id,
        nuggets: purchasePackage.nuggets,
        asset,
        amountAtomic,
        config,
        timestamp
      });
      state.quotes[quote.id] = quote;
      addEconomyAudit(state, session.address, 'NUGGET_PURCHASE_QUOTED', `${quote.id} ${purchasePackage.nuggets} nuggets for ${amountAtomic} ${asset} raw`, timestamp);
      return {
        quote: publicQuote(quote, this.nuggetPaymentVerifier.transactionForQuote(quote)),
        purchasedToday: confirmed,
        dailyPurchaseCap: config.dailyPurchaseCap
      };
    });
  }

  async confirmNuggetPurchase(token, input = {}) {
    const session = await this.authenticate(token);
    this.assertNuggetPaymentsEnabled();
    const quoteId = normalizeId(input.quoteId, 'quote_id');
    const transactionHash = normalizeTransactionHash(input.transactionHash);
    const timestamp = this.now();
    const reservation = await this.reserveQuote({
      quoteId,
      transactionHash,
      address: session.address,
      purpose: 'purchase',
      timestamp
    });
    if (reservation.alreadyConfirmed) return reservation.result;
    const paymentOperation = await this.beginDurablePaymentOperation({
      quoteId, transactionHash, address: session.address, purpose: 'purchase', timestamp
    });
    if (paymentOperation?.state === 'completed') return structuredClone(paymentOperation.completed_response);

    let verified;
    try {
      verified = await this.nuggetPaymentVerifier.verifyExactTransfer(transactionHash, session.address, reservation.quote);
    } catch (error) {
      await this.releaseFailedVerification(quoteId, transactionHash, error);
      await this.recordPaymentFailure(paymentOperation, error, timestamp);
      throw error;
    }
    await this.advanceDurablePaymentOperation(paymentOperation, 'chain_verified', timestamp);

    const ledgerResult = await this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      assertApi(wallet && !wallet.suspended, 403, 'wallet_suspended', 'This wallet is suspended from nugget purchases.');
      assertApi(!state.operations.purchasesPaused, 503, 'server_purchases_paused', 'Nugget purchases are temporarily paused by MATT Mine.');
      assertNoLedgerTransactionReplay(state, transactionHash, session.address, quoteId);
      const update = applyNuggetLedgerDelta(wallet, reservation.quote.nuggets, {
        type: NUGGET_LEDGER_TYPES.NUGGET_PURCHASE,
        transactionHash,
        idempotencyKey: `nugget-purchase:${quoteId}`,
        details: `Purchased package ${reservation.quote.packageId}`
      });
      wallet.updatedAt = timestamp;
      pushPlayerActivity(wallet, 'NUGGET_PURCHASE_CONFIRMED', `${reservation.quote.nuggets} nuggets; ${transactionHash}`, timestamp);
      pushServerAudit(state, session.address, 'NUGGET_PURCHASE_CONFIRMED', `${quoteId}; ${reservation.quote.nuggets} nuggets; ${transactionHash}`, timestamp);
      return {
        profile: structuredClone(wallet.profile),
        ledgerEntry: structuredClone(update.entry)
      };
    });
    await this.advanceDurablePaymentOperation(paymentOperation, 'ledger_credited', timestamp);

    const completed = await this.nuggetEconomyStore.transact((state) => {
      const quote = state.quotes[quoteId];
      assertApi(quote && quote.address === session.address, 409, 'quote_state_missing', 'The verified quote is no longer available.');
      const existing = state.purchases[quoteId];
      if (existing?.status === 'confirmed') {
        return {
          purchase: structuredClone(existing),
          ...ledgerResult,
          alreadyConfirmed: true
        };
      }
      const purchase = {
        id: quoteId,
        quoteId,
        address: session.address,
        packageId: quote.packageId,
        nuggets: quote.nuggets,
        asset: quote.asset,
        amountAtomic: quote.amountAtomic,
        transactionHash,
        blockNumber: verified.blockNumber,
        day: quote.day,
        status: 'confirmed',
        confirmedAt: timestamp
      };
      state.purchases[quoteId] = purchase;
      quote.status = 'confirmed';
      quote.transactionHash = transactionHash;
      state.usedTransactions[transactionHash] = {
        quoteId,
        address: session.address,
        purpose: 'purchase',
        reservedAt: state.usedTransactions[transactionHash]?.reservedAt || timestamp,
        confirmedAt: timestamp
      };
      addEconomyAudit(state, session.address, 'NUGGET_PURCHASE_CREDITED', `${quoteId}; ${quote.nuggets} nuggets; ${transactionHash}`, timestamp);
      return {
        purchase: structuredClone(purchase),
        ...ledgerResult,
        alreadyConfirmed: false
      };
    });
    await this.advanceDurablePaymentOperation(paymentOperation, 'completed', timestamp, completed);
    return completed;
  }

  async quotePracticeClaim(token, input = {}) {
    const session = await this.authenticate(token);
    this.assertNuggetPaymentsEnabled();
    const runId = normalizeId(input.runId, 'run_id');
    const requestedAsset = normalizeAsset(input.asset);
    const timestamp = this.now();
    const baseState = await this.database.read();
    const wallet = baseState.wallets[session.address];
    const claim = wallet?.practiceClaims?.[runId];
    assertApi(claim && claim.status === 'pending', 404, 'claim_record_not_found', 'No pending Practice claim is available for that run.');
    assertApi(claim.expiresAt > timestamp, 409, 'practice_claim_expired', 'This Practice claim has expired.');

    return this.nuggetEconomyStore.transact((state) => {
      const config = state.config;
      assertApi(config.practiceClaimsEnabled, 503, 'practice_claims_disabled', 'Paid Practice claims are disabled in the Admin Command Center.');
      const asset = requestedAsset || config.practiceClaim.asset;
      assertApi(asset === config.practiceClaim.asset, 422, 'practice_asset_mismatch', 'Practice claims must use the configured payment asset.');
      assertApi(config.allowedAssets[asset], 422, 'payment_asset_disabled', 'The configured Practice payment asset is disabled.');
      assertApi(BigInt(config.practiceClaim.amountAtomic) > 0n, 422, 'practice_price_missing', 'The Practice claim price is not configured.');
      const existing = Object.values(state.quotes).find((entry) =>
        entry.address === session.address &&
        entry.purpose === 'practice' &&
        entry.runId === runId &&
        ['pending', 'verifying'].includes(entry.status) &&
        entry.expiresAt > timestamp
      );
      const quote = existing || createQuote({
        service: this,
        address: session.address,
        purpose: 'practice',
        runId,
        nuggets: claim.projectedNuggets,
        asset,
        amountAtomic: config.practiceClaim.amountAtomic,
        config,
        timestamp
      });
      state.quotes[quote.id] = quote;
      addEconomyAudit(state, session.address, 'PRACTICE_CLAIM_QUOTED', `${runId}; ${claim.projectedNuggets} nuggets; ${quote.amountAtomic} ${asset} raw`, timestamp);
      return {
        quote: publicQuote(quote, this.nuggetPaymentVerifier.transactionForQuote(quote)),
        practiceClaim: structuredClone(claim)
      };
    });
  }

  async practiceRunClaim(token, payload = {}) {
    if (payload?.action === 'decline') return super.practiceRunClaim(token, payload);
    const session = await this.authenticate(token);
    this.assertNuggetPaymentsEnabled();
    assertApi(payload?.action === 'claim', 400, 'invalid_claim_action', 'Claim action must be claim or decline.');
    const runId = normalizeId(payload.runId, 'run_id');
    const quoteId = normalizeId(payload.quoteId, 'quote_id');
    const transactionHash = normalizeTransactionHash(payload.transactionHash);
    const timestamp = this.now();
    const reservation = await this.reserveQuote({
      quoteId,
      transactionHash,
      address: session.address,
      purpose: 'practice',
      runId,
      timestamp
    });
    if (reservation.alreadyConfirmed) return reservation.result;
    const paymentOperation = await this.beginDurablePaymentOperation({
      quoteId, transactionHash, address: session.address, purpose: 'practice', timestamp
    });
    if (paymentOperation?.state === 'completed') return structuredClone(paymentOperation.completed_response);

    let verified;
    try {
      verified = await this.nuggetPaymentVerifier.verifyExactTransfer(transactionHash, session.address, reservation.quote);
    } catch (error) {
      await this.releaseFailedVerification(quoteId, transactionHash, error);
      await this.recordPaymentFailure(paymentOperation, error, timestamp);
      throw error;
    }
    await this.advanceDurablePaymentOperation(paymentOperation, 'chain_verified', timestamp);

    const result = await this.database.transact((state) => {
      const wallet = state.wallets[session.address];
      const claim = wallet?.practiceClaims?.[runId];
      assertApi(claim, 404, 'claim_record_not_found', 'No Practice claim is available for that run.');
      if (claim.status === 'claimed' && claim.transactionHash === transactionHash) {
        return {
          practiceClaim: structuredClone(claim),
          profile: structuredClone(wallet.profile),
          alreadyConfirmed: true
        };
      }
      assertApi(claim.status === 'pending', 409, 'claim_already_resolved', 'This Practice claim has already been resolved.');
      assertApi(claim.expiresAt > timestamp, 409, 'practice_claim_expired', 'This Practice claim has expired.');
      assertApi(claim.projectedNuggets === reservation.quote.nuggets, 409, 'practice_claim_amount_changed', 'The server-recorded Practice reward no longer matches the quote.');
      assertNoLedgerTransactionReplay(state, transactionHash, session.address, quoteId);
      const update = applyNuggetLedgerDelta(wallet, claim.projectedNuggets, {
        type: NUGGET_LEDGER_TYPES.PRACTICE_CLAIM,
        runId,
        transactionHash,
        idempotencyKey: `practice-claim:${runId}`,
        details: `Verified paid Practice claim ${quoteId}`
      });
      claim.status = 'claimed';
      claim.settledAt = timestamp;
      claim.transactionHash = transactionHash;
      claim.quoteId = quoteId;
      wallet.updatedAt = timestamp;
      pushPlayerActivity(wallet, 'PRACTICE_CLAIM_PAID', `${runId}; ${claim.projectedNuggets} nuggets; ${transactionHash}`, timestamp);
      pushServerAudit(state, session.address, 'SERVER_PRACTICE_CLAIM_PAID', `${runId}; ${claim.projectedNuggets} nuggets; ${transactionHash}`, timestamp);
      return {
        practiceClaim: structuredClone(claim),
        profile: structuredClone(wallet.profile),
        ledgerEntry: structuredClone(update.entry),
        alreadyConfirmed: false
      };
    });
    await this.advanceDurablePaymentOperation(paymentOperation, 'ledger_credited', timestamp);

    await this.nuggetEconomyStore.transact((state) => {
      const quote = state.quotes[quoteId];
      if (quote) {
        quote.status = 'confirmed';
        quote.transactionHash = transactionHash;
      }
      state.usedTransactions[transactionHash] = {
        quoteId,
        address: session.address,
        purpose: 'practice',
        reservedAt: state.usedTransactions[transactionHash]?.reservedAt || timestamp,
        confirmedAt: timestamp
      };
      addEconomyAudit(state, session.address, 'PRACTICE_CLAIM_CREDITED', `${runId}; ${reservation.quote.nuggets} nuggets; ${transactionHash}; block ${verified.blockNumber}`, timestamp);
    });
    await this.advanceDurablePaymentOperation(paymentOperation, 'completed', timestamp, result);
    return result;
  }

  async adminNuggetEconomy(adminKey) {
    this.assertAdminKey(adminKey);
    this.assertNuggetEconomyConfigured();
    const state = await this.nuggetEconomyStore.read();
    const purchases = Object.values(state.purchases)
      .sort((left, right) => right.confirmedAt - left.confirmedAt)
      .slice(0, 250);
    return {
      config: publicNuggetEconomyConfig(state.config),
      editableConfig: structuredClone(state.config),
      livePaymentVerification: this.nuggetPaymentsEnabled,
      releaseBlocker: this.nuggetPaymentsEnabled
        ? ''
        : 'Set MATT_MINE_NUGGET_PAYMENTS_ENABLED=true with the exact Ronin verifier configured before enabling live purchases or Practice claims.',
      counts: {
        quotes: Object.keys(state.quotes).length,
        confirmedPurchases: purchases.filter((entry) => entry.status === 'confirmed').length,
        usedTransactions: Object.keys(state.usedTransactions).length
      },
      purchases: purchases.map((entry) => structuredClone(entry)),
      audit: state.audit.slice(-250).reverse()
    };
  }

  async updateAdminNuggetEconomy(adminKey, patch, reason) {
    this.assertAdminKey(adminKey);
    this.assertNuggetEconomyConfigured();
    const normalizedReason = normalizeAdminReason(reason);
    const timestamp = this.now();
    const result = await this.nuggetEconomyStore.transact((state) => {
      let next;
      try {
        next = mergeNuggetEconomyConfig(state.config, patch, 'SERVER_ADMIN', timestamp);
      } catch (error) {
        throw new ApiError(422, 'nugget_economy_invalid', error.message);
      }
      if ((next.purchasesEnabled || next.practiceClaimsEnabled) && !this.nuggetPaymentsEnabled) {
        throw new ApiError(503, 'nugget_payment_verifier_disabled', 'Enable the exact Ronin nugget payment verifier before turning on paid economy features.');
      }
      state.config = next;
      addEconomyAudit(state, 'SERVER_ADMIN', 'NUGGET_ECONOMY_UPDATED', normalizedReason, timestamp);
      return { config: structuredClone(next) };
    });
    await this.database.transact((state) => {
      pushServerAudit(state, 'SERVER_ADMIN', 'NUGGET_ECONOMY_UPDATED', normalizedReason, timestamp);
    });
    return {
      config: publicNuggetEconomyConfig(result.config),
      editableConfig: result.config,
      livePaymentVerification: this.nuggetPaymentsEnabled
    };
  }

  async adminWallet(adminKey, address) {
    const detail = await super.adminWallet(adminKey, address);
    if (!this.nuggetEconomyStore) return detail;
    const normalizedAddress = getAddress(address).toLowerCase();
    const economy = await this.nuggetEconomyStore.read();
    return {
      ...detail,
      nuggetEconomy: {
        purchasedToday: purchasedNuggetsForDay(economy.purchases, normalizedAddress, utcDayKeyFromTimestamp(this.now())),
        purchaseHistory: recentPurchasesForWallet(economy.purchases, normalizedAddress, 100),
        ledger: [...(detail.wallet?.nuggetLedger || [])]
      }
    };
  }

  async reserveQuote({ quoteId, transactionHash, address, purpose, runId = '', timestamp }) {
    return this.nuggetEconomyStore.transact((state) => {
      const quote = state.quotes[quoteId];
      assertApi(quote, 404, 'quote_not_found', 'The payment quote was not found.');
      assertApi(quote.address === address, 403, 'quote_wallet_mismatch', 'This quote belongs to another wallet.');
      assertApi(quote.purpose === purpose, 409, 'quote_purpose_mismatch', 'This quote cannot be used for that action.');
      if (runId) assertApi(quote.runId === runId, 409, 'quote_run_mismatch', 'This quote belongs to another Practice run.');
      if (quote.status === 'confirmed') {
        const purchase = state.purchases[quoteId];
        return {
          alreadyConfirmed: true,
          result: purpose === 'purchase'
            ? { purchase: structuredClone(purchase), alreadyConfirmed: true }
            : { practiceClaim: { runId: quote.runId, status: 'claimed', transactionHash: quote.transactionHash }, alreadyConfirmed: true }
        };
      }
      assertApi(quote.expiresAt > timestamp, 409, 'quote_expired', 'The payment quote expired. Request a new quote.');
      assertApi(['pending', 'verifying'].includes(quote.status), 409, 'quote_unavailable', 'The payment quote is no longer available.');
      const used = state.usedTransactions[transactionHash];
      assertApi(!used || used.quoteId === quoteId, 409, 'transaction_duplicate', 'This transaction hash is already reserved or confirmed for another payment.');
      if (purpose === 'purchase') {
        const confirmed = purchasedNuggetsForDay(state.purchases, address, quote.day);
        const reserved = reservedPurchaseNuggets(state, address, quote.day, quoteId);
        assertApi(
          confirmed + reserved + quote.nuggets <= state.config.dailyPurchaseCap,
          409,
          'nugget_daily_cap',
          `This purchase would exceed the ${state.config.dailyPurchaseCap.toLocaleString()} nugget UTC daily cap.`
        );
      }
      quote.status = 'verifying';
      quote.transactionHash = transactionHash;
      state.usedTransactions[transactionHash] = {
        quoteId,
        address,
        purpose,
        reservedAt: timestamp,
        confirmedAt: 0
      };
      return { quote: structuredClone(quote), alreadyConfirmed: false };
    });
  }

  async releaseFailedVerification(quoteId, transactionHash, error) {
    if (!this.nuggetEconomyStore) return;
    await this.nuggetEconomyStore.transact((state) => {
      const quote = state.quotes[quoteId];
      if (!quote || quote.status === 'confirmed') return;
      if (isInfrastructureFailure(error)) {
        quote.status = 'verifying';
        quote.failureCode = error.code;
        return;
      }
      quote.status = quote.expiresAt > this.now() ? 'pending' : 'expired';
      quote.transactionHash = '';
      quote.failureCode = String(error?.code || 'verification_failed').slice(0, 100);
      if (state.usedTransactions[transactionHash]?.quoteId === quoteId) {
        delete state.usedTransactions[transactionHash];
      }
      addEconomyAudit(state, quote.address, 'PAYMENT_VERIFICATION_REJECTED', `${quoteId}; ${quote.failureCode}`, this.now());
    });
  }

  async beginDurablePaymentOperation({ quoteId, transactionHash, address, purpose, timestamp }) {
    if (typeof this.database.beginPaymentOperation !== 'function') return null;
    const idempotencyKey = `${purpose}:${quoteId}`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ address, purpose, quoteId, transactionHash }))
      .digest('hex');
    const operation = await this.database.beginPaymentOperation({
      idempotencyKey, requestHash, address, purpose, quoteId, transactionHash, timestamp
    });
    assertApi(operation, 503, 'payment_reconciliation_unavailable', 'The durable payment operation could not be loaded. Retry without sending another transaction.');
    assertApi(operation.idempotency_key === idempotencyKey && operation.request_hash === requestHash,
      409, 'payment_idempotency_conflict', 'That payment key or transaction hash belongs to a different request.');
    return operation;
  }

  async advanceDurablePaymentOperation(operation, state, timestamp, response) {
    if (!operation || typeof this.database.advancePaymentOperation !== 'function') return null;
    return this.database.advancePaymentOperation(operation.idempotency_key, state, { timestamp, response });
  }

  async recordPaymentFailure(operation, error, timestamp) {
    if (!operation || typeof this.database.advancePaymentOperation !== 'function') return;
    const state = isInfrastructureFailure(error) ? 'needs_reconciliation' : 'invalid';
    await this.database.advancePaymentOperation(operation.idempotency_key, state, {
      timestamp,
      errorCode: String(error?.code || 'verification_failed').slice(0, 100)
    }).catch(() => undefined);
  }

  assertNuggetEconomyConfigured() {
    assertApi(this.nuggetEconomyStore, 503, 'nugget_economy_disabled', 'The server nugget economy store is not configured.');
  }

  assertNuggetPaymentsEnabled() {
    this.assertNuggetEconomyConfigured();
    assertApi(
      this.nuggetPaymentsEnabled,
      503,
      'nugget_payments_disabled',
      'Live nugget payments are disabled until exact Ronin verification is explicitly enabled.'
    );
  }
}

function createQuote({ service, address, purpose, packageId = '', runId = '', nuggets, asset, amountAtomic, config, timestamp }) {
  const id = `nugget-quote-${timestamp}-${service.randomHex(12)}`;
  return {
    id,
    address,
    purpose,
    packageId,
    runId,
    nuggets,
    asset,
    amountAtomic,
    recipient: config.recipient,
    mattTokenAddress: config.mattTokenAddress,
    day: utcDayKeyFromTimestamp(timestamp),
    createdAt: timestamp,
    expiresAt: timestamp + config.quoteTtlMs,
    status: 'pending',
    transactionHash: '',
    failureCode: ''
  };
}

function publicQuote(quote, transaction) {
  return {
    id: quote.id,
    purpose: quote.purpose,
    packageId: quote.packageId,
    runId: quote.runId,
    nuggets: quote.nuggets,
    asset: quote.asset,
    amountAtomic: quote.amountAtomic,
    recipient: quote.recipient,
    createdAt: quote.createdAt,
    expiresAt: quote.expiresAt,
    transaction
  };
}

function firstAvailableAsset(config, purchasePackage) {
  for (const asset of ['MATT', 'RON']) {
    if (config.allowedAssets[asset] && BigInt(purchasePackage.prices[asset] || '0') > 0n) return asset;
  }
  return '';
}

function reservedPurchaseNuggets(state, address, day, excludedQuoteId = '') {
  return Object.values(state.quotes || {}).reduce((sum, quote) => {
    if (
      quote.id !== excludedQuoteId &&
      quote.address === address &&
      quote.day === day &&
      quote.purpose === 'purchase' &&
      quote.status === 'verifying'
    ) return sum + quote.nuggets;
    return sum;
  }, 0);
}

function assertNoLedgerTransactionReplay(state, transactionHash, address, quoteId) {
  for (const wallet of Object.values(state.wallets || {})) {
    for (const entry of wallet.nuggetLedger || []) {
      if (entry.transactionHash !== transactionHash) continue;
      const sameOwner = wallet.address === address;
      const sameQuote = entry.idempotencyKey === `nugget-purchase:${quoteId}` || entry.details?.includes(quoteId);
      assertApi(sameOwner && sameQuote, 409, 'transaction_duplicate', 'This transaction hash has already been used for another nugget mutation.');
    }
  }
}

function pushPlayerActivity(wallet, action, details, timestamp) {
  wallet.activity ||= [];
  wallet.activity.push({
    id: `activity-${timestamp}-${wallet.activity.length + 1}`,
    action: String(action).slice(0, 80),
    details: String(details).slice(0, 500),
    timestamp
  });
  wallet.activity = wallet.activity.slice(-500);
}

function pushServerAudit(state, actor, action, details, timestamp) {
  state.audit ||= [];
  state.audit.push({
    id: `audit-${timestamp}-${state.audit.length + 1}`,
    actor: String(actor).slice(0, 100),
    action: String(action).slice(0, 100),
    details: String(details).slice(0, 500),
    timestamp
  });
  state.audit = state.audit.slice(-2_000);
}

function normalizeTransactionHash(value) {
  assertApi(typeof value === 'string' && TRANSACTION_HASH_PATTERN.test(value), 400, 'invalid_transaction_hash', 'A valid Ronin transaction hash is required.');
  return value.toLowerCase();
}

function normalizeAsset(value) {
  if (value === undefined || value === null || value === '') return '';
  const asset = String(value).toUpperCase();
  assertApi(asset === 'MATT' || asset === 'RON', 422, 'payment_asset_invalid', 'Choose MATT or RON as the payment asset.');
  return asset;
}

function normalizeId(value, name) {
  assertApi(typeof value === 'string' && /^[A-Za-z0-9:_-]{2,160}$/.test(value), 400, `invalid_${name}`, `${name} is invalid.`);
  return value;
}

function normalizeAdminReason(value) {
  assertApi(typeof value === 'string', 400, 'admin_reason_required', 'A written reason is required for this admin action.');
  const reason = value.trim();
  assertApi(reason.length >= 5 && reason.length <= 240, 400, 'admin_reason_invalid', 'Admin reason must be 5 to 240 characters.');
  return reason;
}

function isInfrastructureFailure(error) {
  if (error?.infrastructureUnavailable === true) return true;
  const code = String(error?.code || '').toLowerCase();
  return code === 'transaction_confirming' ||
    code.includes('unavailable') ||
    code.includes('timeout') ||
    code.startsWith('08') ||
    ['57p01', '57p02', '57p03', '53300', '53400'].includes(code);
}
