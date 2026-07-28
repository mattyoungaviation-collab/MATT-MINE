import { ProductionMattMineService } from './production-service.js';
import { ApiError } from './errors.js';
import {
  NUGGET_LEDGER_TYPES,
  applyNuggetLedgerDelta,
  findLedgerEntryByIdempotency
} from './nugget-ledger.js';

export class CompleteProductionMattMineService extends ProductionMattMineService {
  async me(token) {
    const player = await super.me(token);
    const state = await this.database.read();
    const wallet = state.wallets[player.address];
    if (!player.nuggetEconomy) return player;
    return {
      ...player,
      nuggetEconomy: {
        ...player.nuggetEconomy,
        pendingPracticeClaims: Object.values(wallet?.practiceClaims || {})
          .filter((claim) => claim?.status === 'pending')
          .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
          .map((claim) => structuredClone(claim))
      }
    };
  }

  async adminWallet(adminKey, address) {
    const detail = await super.adminWallet(adminKey, address);
    const state = await this.database.read();
    const normalizedAddress = String(address || '').toLowerCase();
    const wallet = state.wallets[normalizedAddress];
    return {
      ...detail,
      nuggetEconomy: {
        ...(detail.nuggetEconomy || {}),
        ledger: structuredClone(wallet?.nuggetLedger || []),
        pendingPracticeClaims: structuredClone(wallet?.practiceClaims || {})
      }
    };
  }

  async updateAdminNuggetEconomy(adminKey, patch, reason) {
    this.assertAdminKey(adminKey);
    if (patch?.advertisementRewardsEnabled === true) {
      throw new ApiError(
        503,
        'advertisement_provider_disabled',
        'Advertisement rewards cannot be enabled until a signed provider or server-to-server completion verifier is configured.'
      );
    }
    return super.updateAdminNuggetEconomy(adminKey, patch, reason);
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
    const result = await super.finishRun(token, payload);
    const runId = String(payload?.runId || '');
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
