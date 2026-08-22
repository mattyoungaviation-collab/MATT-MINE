export function createPendingRevive(run, config, timestamp) {
  if (!run || run.status !== 'awaiting-revive') throw new Error('revive_run_not_pending');
  if (run.finishedAt) throw new Error('revive_run_finalized');
  const used = Array.isArray(run.revives) ? run.revives.length : 0;
  if (used >= config.reviveLimitPerRun) throw new Error('revive_limit_reached');
  if (config.paidRevivesEnabled !== true) throw new Error('paid_revives_disabled');
  if (!/^\d+$/.test(String(config.revivePriceRonWei))) throw new Error('revive_price_invalid');
  run.pendingRevive ||= {
    id: `revive:${run.id}:${used + 1}`,
    priceRonWei: String(config.revivePriceRonWei),
    createdAt: timestamp,
    expiresAt: timestamp + 15 * 60_000,
    status: 'pending'
  };
  return structuredClone(run.pendingRevive);
}

export function confirmRevive(run, verifiedPayment, config, timestamp) {
  const pending = run?.pendingRevive;
  if (!pending || pending.status !== 'pending') throw new Error('revive_not_pending');
  if (run.finishedAt) throw new Error('revive_run_finalized');
  const graceMs = Number.isSafeInteger(config.reviveQuoteBlockGraceMs)
    ? Math.max(0, Math.min(config.reviveQuoteBlockGraceMs, 10 * 60_000))
    : 2 * 60_000;
  const paidAt = Number.isSafeInteger(Number(verifiedPayment.transactionBlockAt))
    ? Number(verifiedPayment.transactionBlockAt)
    : timestamp;
  if (!Number.isSafeInteger(paidAt) || paidAt < pending.createdAt - graceMs || paidAt > pending.expiresAt + graceMs) {
    throw new Error('revive_transaction_outside_quote_window');
  }
  if (verifiedPayment.amountWei !== pending.priceRonWei) throw new Error('revive_payment_amount_mismatch');
  if (!/^0x[a-fA-F0-9]{64}$/.test(verifiedPayment.transactionHash || '')) throw new Error('revive_transaction_invalid');
  if (!Number.isFinite(run.playerState?.maximumHealth) || run.playerState.maximumHealth <= 0) throw new Error('revive_player_state_invalid');
  run.revives ||= [];
  if (run.revives.some((entry) => entry.transactionHash.toLowerCase() === verifiedPayment.transactionHash.toLowerCase())) throw new Error('revive_transaction_duplicate');
  run.revives.push({ transactionHash: verifiedPayment.transactionHash.toLowerCase(), confirmedAt: timestamp });
  pending.status = 'confirmed';
  pending.transactionHash = verifiedPayment.transactionHash.toLowerCase();
  pending.transactionBlockAt = paidAt;
  run.status = 'active';
  run.playerState ||= {};
  run.playerState.health = run.playerState.maximumHealth;
  run.playerState.invulnerableUntil = timestamp + config.reviveInvulnerabilitySeconds * 1000;
  return {
    runId: run.id,
    reviveCount: run.revives.length,
    playerState: structuredClone(run.playerState),
    authoritativeCheckpoint: structuredClone(pending.authoritativeCheckpoint || {}),
    invulnerabilitySeconds: config.reviveInvulnerabilitySeconds,
    warning: 'Verified payment is final and non-refundable.'
  };
}
