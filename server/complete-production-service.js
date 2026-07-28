import { ProductionMattMineService } from './production-service.js';
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
}
