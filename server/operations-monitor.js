import { createHash } from 'node:crypto';

export const OPERATIONS_CONTRACTS = Object.freeze([
  'settlement',
  'crystalBank',
  'chest',
  'passiveRewards'
]);

export const DEFAULT_OPERATIONS_THRESHOLDS = Object.freeze({
  databaseLatencyWarningMs: 750,
  rpcLatencyWarningMs: 2_500,
  rpcLatencyCriticalMs: 8_000,
  operatorMinimumRon: 0.10,
  keeperMinimumRon: 0.10,
  pauserMinimumRon: 0.05,
  gasCriticalRon: 0.02,
  vrfPendingWarningSeconds: 30 * 60,
  vrfPendingCriticalSeconds: 6 * 60 * 60,
  rejectedRunWarningBps: 500,
  rejectedRunCriticalBps: 1_500,
  bankedBudgetWarningBps: 8_000,
  withdrawalLimitWarningBps: 8_000
});

export const DEFAULT_OPERATIONS_CACHE_MS = 20_000;

const OPERATIONS_SIGNAL_GROUPS = Object.freeze([
  'database',
  'rpc',
  'metadata',
  'contracts',
  'roles',
  'wallets',
  'vrf',
  'runs',
  'economy'
]);

const SEVERITY_WEIGHT = Object.freeze({ critical: 0, warning: 1, info: 2 });

/**
 * Cached, single-flight operations evaluator. This intentionally stops at an
 * authenticated current report: recurring scheduling, alert delivery, and
 * on-call routing belong to the deployment platform and incident tooling.
 */
export class OperationsMonitor {
  constructor(options = {}) {
    if (typeof options.collect !== 'function') {
      throw new TypeError('OperationsMonitor requires a signal collector.');
    }
    this.collect = options.collect;
    this.stage = String(options.stage || 'public').trim();
    if (!['closed-beta', 'public'].includes(this.stage)) {
      throw new TypeError('stage must be closed-beta or public.');
    }
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.thresholds = options.thresholds || {};
    this.cacheMs = boundedCacheMilliseconds(options.cacheMs);
    this.cached = null;
    this.pending = null;
  }

  async current(options = {}) {
    const force = options.force === true;
    const timestamp = this.now();
    if (!force && this.cached && this.cached.expiresAt > timestamp) {
      return structuredClone(this.cached.report);
    }
    if (this.pending) return structuredClone(await this.pending);
    const pending = this.#refresh();
    this.pending = pending;
    try {
      const report = await pending;
      this.cached = {
        expiresAt: this.now() + this.cacheMs,
        report: structuredClone(report)
      };
      return report;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  invalidate() {
    this.cached = null;
  }

  async #refresh() {
    const checkedAt = this.now();
    let signals = {};
    let collectionFailed = false;
    try {
      const collected = await this.collect({ checkedAt, stage: this.stage });
      if (isRecord(collected)) signals = collected;
      else collectionFailed = true;
    } catch {
      collectionFailed = true;
    }
    const report = evaluateOperationsHealth({
      ...signals,
      checkedAt,
      stage: this.stage
    }, this.thresholds);
    return {
      ...report,
      collectionFailed,
      signals: Object.fromEntries(OPERATIONS_SIGNAL_GROUPS.map((group) => [
        group,
        isRecord(signals[group]) ? 'available' : 'missing'
      ])),
      probeCacheMs: this.cacheMs,
      externalAutomation: {
        status: 'external_setup_required',
        scheduler: false,
        alertDelivery: false,
        onCallRouting: false,
        note: 'Configure a deployment scheduler, alert destination, and on-call route outside this application.'
      }
    };
  }
}

/**
 * Collects only facts already present in the running server. Unknown release
 * evidence stays absent so a public-stage report fails closed instead of
 * turning an unmeasured condition into a false green check.
 */
export async function collectInProcessOperationsSignals(input = {}) {
  const checkedAt = positiveTimestamp(input.checkedAt) || Date.now();
  const [database, state, nft, protocol, metadata, vrf] = await Promise.all([
    safeProbe(input.database?.healthCheck?.bind(input.database)),
    safeProbe(input.database?.read?.bind(input.database)),
    safeProbe(input.getNftHealth),
    safeProbe(input.getProtocolSnapshot),
    safeProbe(input.getMetadataEvidence),
    safeProbe(input.getVrfSignal)
  ]);
  const result = {};
  if (isRecord(database)) {
    result.database = {
      ok: database.ok === true,
      ...(finiteNumber(database.latencyMs) !== null ? { latencyMs: Number(database.latencyMs) } : {})
    };
  }
  const rpc = rpcSignal(nft);
  if (rpc) result.rpc = rpc;
  if (isRecord(metadata)) result.metadata = structuredClone(metadata);
  const contracts = contractSignals(protocol, input.expectedContractPauses);
  if (contracts) result.contracts = contracts;
  const roles = roleSignals(nft, input.authoritySignals);
  if (roles) result.roles = roles;
  const wallets = walletSignals(nft, input.walletSignals);
  if (wallets) result.wallets = wallets;
  if (isRecord(vrf)) result.vrf = structuredClone(vrf);
  if (isRecord(state)) {
    result.runs = runSignals(state, checkedAt);
    result.economy = economySignals(state, protocol, checkedAt);
  }
  return result;
}

export function evaluateOperationsHealth(input = {}, thresholdOverrides = {}) {
  const thresholds = {
    ...DEFAULT_OPERATIONS_THRESHOLDS,
    ...thresholdOverrides
  };
  const stage = String(input.stage || '').trim();
  if (!['closed-beta', 'public'].includes(stage)) {
    throw new TypeError('stage must be closed-beta or public.');
  }
  const alerts = [];
  const checkedAt = positiveTimestamp(input.checkedAt) || Date.now();

  inspectDatabase(input.database, thresholds, alerts, stage);
  inspectRpc(input.rpc, thresholds, alerts, stage);
  inspectMetadata(input.metadata, alerts, stage, checkedAt);
  inspectContracts(input.contracts, alerts, stage);
  inspectRoles(input.roles, alerts, stage);
  inspectWallets(input.wallets, thresholds, alerts, stage);
  inspectVrf(input.vrf, thresholds, alerts, stage);
  inspectRuns(input.runs, thresholds, alerts, stage);
  inspectEconomy(input.economy, thresholds, alerts, stage);

  alerts.sort((left, right) =>
    SEVERITY_WEIGHT[left.severity] - SEVERITY_WEIGHT[right.severity]
    || left.group.localeCompare(right.group)
    || left.code.localeCompare(right.code)
  );
  const counts = {
    critical: alerts.filter((entry) => entry.severity === 'critical').length,
    warning: alerts.filter((entry) => entry.severity === 'warning').length,
    info: alerts.filter((entry) => entry.severity === 'info').length
  };
  const status = counts.critical > 0 ? 'critical' : counts.warning > 0 ? 'degraded' : 'healthy';
  return {
    schemaVersion: 1,
    checkedAt,
    stage,
    status,
    counts,
    alerts: alerts.map((entry) => ({
      ...entry,
      fingerprint: operationsAlertFingerprint(entry)
    }))
  };
}

export function operationsAlertFingerprint(alert) {
  return createHash('sha256')
    .update([
      String(alert?.severity || ''),
      String(alert?.group || ''),
      String(alert?.code || ''),
      String(alert?.message || '')
    ].join('|'))
    .digest('hex')
    .slice(0, 24);
}

export function formatOperationsReport(report) {
  const lines = [
    'MATT Mine operations: ' + String(report.status || 'unknown').toUpperCase(),
    'Stage: ' + String(report.stage || 'unknown'),
    'Checked: ' + new Date(Number(report.checkedAt || Date.now())).toISOString(),
    'Critical: ' + Number(report.counts?.critical || 0)
      + ' | Warning: ' + Number(report.counts?.warning || 0)
      + ' | Info: ' + Number(report.counts?.info || 0)
  ];
  for (const alert of report.alerts || []) {
    lines.push('[' + alert.severity.toUpperCase() + '] ' + alert.code + ': ' + alert.message);
  }
  return lines.join('\n');
}

async function safeProbe(probe) {
  if (typeof probe !== 'function') return undefined;
  try {
    return await probe();
  } catch {
    return undefined;
  }
}

function rpcSignal(nft) {
  if (!isRecord(nft) || nft.enabled !== true) return null;
  const probes = [nft.metadata, nft.gameplay].filter((entry) =>
    isRecord(entry) && entry.enabled !== false
  );
  if (!probes.length) return null;
  const latencies = probes.map((entry) => finiteNumber(entry.latencyMs)).filter((value) => value !== null);
  return {
    ok: probes.every((entry) => entry.ok === true),
    ...(latencies.length ? { latencyMs: Math.max(...latencies) } : {})
  };
}

function contractSignals(protocol, expectedPauses) {
  const paused = isRecord(protocol?.paused) ? protocol.paused : null;
  const expectations = isRecord(expectedPauses) ? expectedPauses : {};
  if (!paused && !Object.keys(expectations).length) return null;
  const mapping = {
    settlement: 'settlement',
    crystalBank: 'bank',
    chest: 'chest',
    passiveRewards: 'passiveRewards'
  };
  return Object.fromEntries(Object.entries(mapping).flatMap(([name, protocolName]) => {
    const current = paused?.[protocolName];
    const expected = expectations[name];
    if (typeof current !== 'boolean' && typeof expected !== 'boolean') return [];
    return [[name, {
      reachable: typeof current === 'boolean',
      ...(typeof current === 'boolean' ? { paused: current } : {}),
      ...(typeof expected === 'boolean' ? { expectedPaused: expected } : {})
    }]];
  }));
}

function roleSignals(nft, supplied) {
  const result = isRecord(supplied) ? { ...supplied } : {};
  const gameplay = isRecord(nft?.gameplay) ? nft.gameplay : {};
  if (typeof gameplay.operator?.authorized === 'boolean') {
    result.operatorAuthorized = gameplay.operator.authorized;
  }
  if (typeof gameplay.rewardSigner?.matches === 'boolean') {
    result.rewardSignerMatches = gameplay.rewardSigner.matches;
  }
  const operator = String(gameplay.operator?.address || '').toLowerCase();
  const signer = String(
    gameplay.rewardSigner?.configuredAddress
    || gameplay.rewardSigner?.onchainAddress
    || ''
  ).toLowerCase();
  if (/^0x[a-f0-9]{40}$/.test(operator) && /^0x[a-f0-9]{40}$/.test(signer)) {
    result.operatorSignerSeparated = operator !== signer;
  }
  return Object.keys(result).length ? result : null;
}

function walletSignals(nft, supplied) {
  const result = isRecord(supplied) ? { ...supplied } : {};
  const operatorRaw = nft?.gameplay?.nativeBalancesRaw?.operator;
  const operatorRon = ronFromRaw(operatorRaw);
  if (operatorRon !== null) result.operatorRon = operatorRon;
  return Object.keys(result).length ? result : null;
}

function runSignals(state, checkedAt) {
  const cutoff = checkedAt - 60 * 60 * 1_000;
  const runs = Object.values(isRecord(state.runs) ? state.runs : {}).filter(isRecord);
  return {
    stuck: runs.filter((run) =>
      ['active', 'awaiting-revive'].includes(run.status) && Number(run.expiresAt || 0) <= checkedAt
    ).length,
    settlementFailuresLastHour: runs.filter((run) =>
      run.status === 'finished'
      && Number(run.finishedAt || 0) >= cutoff
      && isRecord(run.nftSettlement)
    ).length,
    acceptedLastHour: runs.filter((run) =>
      run.status === 'finished'
      && Number(run.finishedAt || 0) >= cutoff
      && isRecord(run.result)
    ).length,
    startsLastHour: runs.filter((run) => Number(run.startedAt || 0) >= cutoff).length
    // Rejected browser submissions are not durably counted by the current
    // server. Leaving rejectedLastHour absent makes public readiness fail
    // closed instead of reporting a fabricated zero.
  };
}

function economySignals(state, protocol, checkedAt) {
  const cutoff = checkedAt - 24 * 60 * 60 * 1_000;
  let banked = 0n;
  for (const wallet of Object.values(isRecord(state.wallets) ? state.wallets : {})) {
    for (const entry of Array.isArray(wallet?.nftCrystalLedger) ? wallet.nftCrystalLedger : []) {
      if (entry?.type !== 'RUN_BANK' || Number(entry.timestamp || 0) < cutoff) continue;
      const amount = unsignedBigInt(entry.amount);
      if (amount !== null) banked += amount * 10n ** 18n;
    }
  }
  const result = { banked24hRaw: banked.toString() };
  const globalLimit = unsignedBigInt(protocol?.withdrawal?.globalDailyRaw);
  if (globalLimit !== null) result.globalWithdrawalLimitRaw = globalLimit.toString();
  // The server does not currently index Crystal withdrawals or own a versioned
  // daily emissions budget. Those values deliberately remain absent.
  return result;
}

function ronFromRaw(value) {
  const raw = unsignedBigInt(value);
  if (raw === null) return null;
  const whole = raw / 10n ** 18n;
  const fraction = raw % 10n ** 18n;
  return Number(whole) + Number(fraction) / 1e18;
}

function boundedCacheMilliseconds(value) {
  if (value === 0) return 0;
  const number = Number(value ?? DEFAULT_OPERATIONS_CACHE_MS);
  if (!Number.isFinite(number)) return DEFAULT_OPERATIONS_CACHE_MS;
  return Math.max(1_000, Math.min(60_000, Math.floor(number)));
}

function inspectDatabase(database, thresholds, alerts, stage) {
  if (!isRecord(database)) return missing(alerts, stage, 'data', 'database_signal_missing', 'Database health is unavailable.');
  if (database.ok !== true) {
    add(alerts, 'critical', 'data', 'database_unavailable', 'Production database health check failed.', database.ok, true, 'Pause new paid entries; preserve reconciliation.');
    return;
  }
  const latency = finiteNumber(database.latencyMs);
  if (latency === null) {
    missing(alerts, stage, 'data', 'database_latency_missing', 'Database latency was not measured.');
  } else if (latency > thresholds.databaseLatencyWarningMs) {
    add(alerts, 'warning', 'data', 'database_latency_high', 'Database latency is above the operations threshold.', latency, thresholds.databaseLatencyWarningMs, 'Inspect PostgreSQL saturation and slow queries.');
  }
}

function inspectRpc(rpc, thresholds, alerts, stage) {
  if (!isRecord(rpc)) return missing(alerts, stage, 'chain', 'rpc_signal_missing', 'NFT Ronin RPC health is unavailable.');
  if (rpc.ok !== true) {
    add(alerts, 'critical', 'chain', 'rpc_unavailable', 'NFT Ronin RPC reads are unavailable.', rpc.ok, true, 'Pause reward-bearing run starts until reads recover.');
    return;
  }
  const latency = finiteNumber(rpc.latencyMs);
  if (latency === null) return missing(alerts, stage, 'chain', 'rpc_latency_missing', 'NFT RPC latency was not measured.');
  if (latency >= thresholds.rpcLatencyCriticalMs) {
    add(alerts, 'critical', 'chain', 'rpc_latency_critical', 'NFT RPC latency is too high for safe settlement.', latency, thresholds.rpcLatencyCriticalMs, 'Fail over RPC and pause new reward-bearing runs.');
  } else if (latency >= thresholds.rpcLatencyWarningMs) {
    add(alerts, 'warning', 'chain', 'rpc_latency_high', 'NFT RPC latency is elevated.', latency, thresholds.rpcLatencyWarningMs, 'Inspect the RPC pool before increasing traffic.');
  }
}

function inspectMetadata(metadata, alerts, stage, checkedAt) {
  if (!isRecord(metadata)) return missing(alerts, stage, 'metadata', 'metadata_signal_missing', 'Marketplace metadata validation is unavailable.');
  if (metadata.ok !== true) {
    add(alerts, 'critical', 'metadata', 'metadata_validation_failed', 'NFT metadata or image validation failed.', metadata.errors ?? null, 0, 'Keep listings paused and run the 1,000-token validator.');
  }
  const completedAt = positiveTimestamp(metadata.completedAt);
  if (!completedAt) {
    missing(alerts, stage, 'metadata', 'metadata_timestamp_missing', 'Metadata validation has no completion timestamp.');
  } else {
    const ageSeconds = Math.max(0, Math.floor((checkedAt - completedAt) / 1_000));
    if (ageSeconds > 86_400) {
      add(alerts, 'warning', 'metadata', 'metadata_validation_stale', 'The complete marketplace validation is older than 24 hours.', ageSeconds, 86_400, 'Re-run validation before listings or metadata changes.');
    }
  }
  if (stage === 'public' && Number(metadata.tokensValidated) !== 1_000) {
    add(alerts, 'critical', 'metadata', 'metadata_inventory_incomplete', 'Public release requires validation of all 1,000 Miner records.', Number(metadata.tokensValidated || 0), 1_000, 'Validate the entire collection, including images.');
  }
  if (stage === 'public' && Number(metadata.collectionsValidated) !== 2) {
    add(alerts, 'critical', 'metadata', 'metadata_collections_incomplete', 'Public release requires both collection metadata documents.', Number(metadata.collectionsValidated || 0), 2, 'Validate Miner and Equipment collection metadata.');
  }
  if (stage === 'public' && (metadata.validationScope?.images !== true || Number(metadata.imagesValidated) < 1_002)) {
    add(alerts, 'critical', 'metadata', 'metadata_images_incomplete', 'Public release requires image validation for all 1,000 Miners and both collections.', Number(metadata.imagesValidated || 0), 1_002, 'Re-run without --skip-images.');
  }
  if (stage === 'public' && (metadata.validationScope?.chain !== true || Number(metadata.chainTokensValidated) !== 1_000)) {
    add(alerts, 'critical', 'metadata', 'metadata_chain_inventory_incomplete', 'Public release requires Ronin Mainnet validation of all 1,000 Miner records.', Number(metadata.chainTokensValidated || 0), 1_000, 'Re-run with the Mainnet RPC and Miner contract address.');
  }
  if (stage === 'public' && Number(metadata.chainMetadataValidated) !== 1_000) {
    add(alerts, 'critical', 'metadata', 'metadata_chain_parity_incomplete', 'Public release requires exact tokenURI metadata and traitsOf parity for all 1,000 Miners.', Number(metadata.chainMetadataValidated || 0), 1_000, 'Re-run the complete Mainnet validator and resolve every metadata mismatch.');
  }
  if (stage === 'public' && Number(metadata.chainId) !== 2_020) {
    add(alerts, 'critical', 'metadata', 'metadata_chain_id_mismatch', 'Marketplace validation did not prove Ronin Mainnet chain ID 2020.', Number(metadata.chainId || 0), 2_020, 'Verify the RPC network before performing any contract reads.');
  }
  if (stage === 'public' && (Number(metadata.tokenRange?.from) !== 1 || Number(metadata.tokenRange?.to) !== 1_000)) {
    add(alerts, 'critical', 'metadata', 'metadata_token_range_incomplete', 'Public release requires the exact Miner token range 1 through 1,000.', metadata.tokenRange || null, { from: 1, to: 1_000 }, 'Re-run the validator with --from 1 --to 1000.');
  }
  if (stage === 'public' && metadata.validationScope?.initialState === true && metadata.validationScope?.salesWallet !== true) {
    add(alerts, 'critical', 'metadata', 'metadata_sales_wallet_unchecked', 'Initial inventory validation did not verify ownership against the approved sales wallet.', false, true, 'Supply the protected expected sales-wallet address and re-run validation.');
  }
}

function inspectContracts(contracts, alerts, stage) {
  if (!isRecord(contracts)) return missing(alerts, stage, 'contracts', 'contract_signals_missing', 'NFT module health is unavailable.');
  for (const name of OPERATIONS_CONTRACTS) {
    const contract = contracts[name];
    if (!isRecord(contract)) {
      missing(alerts, stage, 'contracts', name + '_signal_missing', name + ' state is unavailable.');
      continue;
    }
    if (contract.reachable !== true) {
      add(alerts, 'critical', 'contracts', name + '_unreachable', name + ' cannot be read on Ronin.', contract.reachable, true, 'Pause dependent player actions and verify the proxy.');
      continue;
    }
    if (typeof contract.expectedPaused !== 'boolean') {
      missing(alerts, stage, 'contracts', name + '_expected_state_missing', name + ' has no approved expected pause state.');
    } else if (contract.paused !== contract.expectedPaused) {
      add(alerts, 'critical', 'contracts', name + '_pause_mismatch', name + ' pause state differs from the approved release plan.', contract.paused, contract.expectedPaused, 'Stop rollout and reconcile Admin and on-chain state.');
    }
  }
}

function inspectRoles(roles, alerts, stage) {
  if (!isRecord(roles)) return missing(alerts, stage, 'authority', 'role_signals_missing', 'On-chain role verification is unavailable.');
  const required = {
    operatorAuthorized: 'Game Operator lacks its required on-chain role.',
    configOperatorAuthorized: 'Config Operator lacks CONFIG_ROLE.',
    rewardSignerMatches: 'Settlement Reward Signer does not match the approved signer.',
    operatorSignerSeparated: 'Game Operator and Reward Signer are not separated.',
    keeperAuthorized: 'Keeper lacks its required on-chain role.',
    pauserAuthorized: 'Emergency Pauser lacks its required on-chain role.'
  };
  for (const [name, message] of Object.entries(required)) {
    if (roles[name] === true) continue;
    if (roles[name] === undefined || roles[name] === null) {
      missing(alerts, stage, 'authority', name + '_missing', message);
    } else {
      add(alerts, 'critical', 'authority', name, message, roles[name] ?? null, true, 'Do not open public economic actions.');
    }
  }
}

function inspectWallets(wallets, thresholds, alerts, stage) {
  if (!isRecord(wallets)) return missing(alerts, stage, 'balances', 'wallet_balance_signals_missing', 'Operational RON balances are unavailable.');
  inspectRonBalance('operator', wallets.operatorRon, thresholds.operatorMinimumRon, thresholds, alerts, stage);
  inspectRonBalance('keeper', wallets.keeperRon, thresholds.keeperMinimumRon, thresholds, alerts, stage);
  inspectRonBalance('pauser', wallets.pauserRon, thresholds.pauserMinimumRon, thresholds, alerts, stage);
}

function inspectRonBalance(name, value, minimum, thresholds, alerts, stage) {
  const balance = finiteNumber(value);
  if (balance === null) return missing(alerts, stage, 'balances', name + '_ron_missing', name + ' RON balance is unavailable.');
  if (balance < thresholds.gasCriticalRon) {
    add(alerts, 'critical', 'balances', name + '_ron_critical', name + ' wallet may be unable to submit an emergency transaction.', balance, thresholds.gasCriticalRon, 'Fund only the approved operational wallet and re-check.');
  } else if (balance < minimum) {
    add(alerts, 'warning', 'balances', name + '_ron_low', name + ' RON balance is below the operating reserve.', balance, minimum, 'Top up through the approved treasury procedure.');
  }
}

function inspectVrf(vrf, thresholds, alerts, stage) {
  if (!isRecord(vrf)) return missing(alerts, stage, 'vrf', 'vrf_signals_missing', 'VRF health is unavailable.');
  const checks = {
    subscriptionFunded: 'Ronin VRF subscription is not confirmed funded.',
    chestConsumerRegistered: 'Chest VRF adapter is not a registered consumer.',
    passiveConsumerRegistered: 'Passive Rewards VRF adapter is not a registered consumer.'
  };
  for (const [name, message] of Object.entries(checks)) {
    if (vrf[name] === true) continue;
    if (vrf[name] === undefined || vrf[name] === null) {
      missing(alerts, stage, 'vrf', name + '_missing', message);
    } else {
      add(alerts, 'critical', 'vrf', name, message, vrf[name] ?? null, true, 'Pause new randomness requests and repair VRF configuration.');
    }
  }
  const pending = nonnegativeInteger(vrf.pendingRequests);
  const oldest = nonnegativeInteger(vrf.oldestPendingSeconds);
  if (pending === null || oldest === null) {
    missing(alerts, stage, 'vrf', 'vrf_pending_signal_missing', 'Pending VRF request age is unavailable.');
    return;
  }
  if (pending > 0 && oldest >= thresholds.vrfPendingCriticalSeconds) {
    add(alerts, 'critical', 'vrf', 'vrf_request_stuck', 'A VRF request has exceeded the critical age.', oldest, thresholds.vrfPendingCriticalSeconds, 'Pause purchases, inspect the original request, and use only its approved retry/refund path.');
  } else if (pending > 0 && oldest >= thresholds.vrfPendingWarningSeconds) {
    add(alerts, 'warning', 'vrf', 'vrf_request_delayed', 'A VRF request is delayed.', oldest, thresholds.vrfPendingWarningSeconds, 'Inspect subscription funding and adapter delivery.');
  }
}

function inspectRuns(runs, thresholds, alerts, stage) {
  if (!isRecord(runs)) return missing(alerts, stage, 'runs', 'run_signals_missing', 'Run lifecycle metrics are unavailable.');
  const stuck = nonnegativeInteger(runs.stuck);
  const failures = nonnegativeInteger(runs.settlementFailuresLastHour);
  const rejected = nonnegativeInteger(runs.rejectedLastHour);
  const accepted = nonnegativeInteger(runs.acceptedLastHour);
  const starts = nonnegativeInteger(runs.startsLastHour);
  if ([stuck, failures, rejected, accepted, starts].some((value) => value === null)) {
    missing(alerts, stage, 'runs', 'run_metric_invalid', 'One or more run lifecycle metrics are missing or invalid.');
  }
  if (stuck !== null && stuck > 0) {
    add(alerts, 'critical', 'runs', 'stuck_runs_present', 'One or more runs exceeded their approved recovery age.', stuck, 0, 'Pause the affected mine and reconcile server plus on-chain locks.');
  }
  if (failures !== null && failures > 0) {
    add(alerts, 'critical', 'runs', 'settlement_failures_present', 'Confirmed run settlements failed during the last hour.', failures, 0, 'Pause new reward-bearing starts and reconcile every run ID.');
  }
  if (accepted !== null && rejected !== null) {
    const denominator = Math.max(1, accepted + rejected);
    const rejectionBps = Math.floor(rejected * 10_000 / denominator);
    if (rejected > 0 && rejectionBps >= thresholds.rejectedRunCriticalBps) {
      add(alerts, 'critical', 'runs', 'run_rejection_rate_critical', 'Run rejection rate is above the critical threshold.', rejectionBps, thresholds.rejectedRunCriticalBps, 'Pause the affected mine and inspect replay rejection codes.');
    } else if (rejected > 0 && rejectionBps >= thresholds.rejectedRunWarningBps) {
      add(alerts, 'warning', 'runs', 'run_rejection_rate_high', 'Run rejection rate is elevated.', rejectionBps, thresholds.rejectedRunWarningBps, 'Review replay and client-version distribution.');
    }
  }
}

function inspectEconomy(economy, thresholds, alerts, stage) {
  if (!isRecord(economy)) return missing(alerts, stage, 'economy', 'economy_signals_missing', 'Crystal economy metrics are unavailable.');
  const banked = unsignedBigInt(economy.banked24hRaw);
  const bankCap = unsignedBigInt(economy.expectedDailyBankCapRaw);
  const withdrawn = unsignedBigInt(economy.withdrawn24hRaw);
  const withdrawalLimit = unsignedBigInt(economy.globalWithdrawalLimitRaw);
  if ([banked, bankCap, withdrawn, withdrawalLimit].some((value) => value === null)) {
    missing(alerts, stage, 'economy', 'economy_metric_invalid', 'Crystal bank or withdrawal totals are missing or invalid.');
  }
  if (bankCap === 0n || withdrawalLimit === 0n) {
    add(alerts, 'critical', 'economy', 'economy_limit_invalid', 'Economy monitoring limits must be positive.', '0', '>0', 'Approve a versioned launch budget before opening rewards.');
  }
  if (banked !== null && bankCap !== null && bankCap > 0n) {
    const bankedBps = ratioBps(banked, bankCap);
    if (banked > bankCap) {
      add(alerts, 'critical', 'economy', 'crystal_banking_budget_exceeded', '24-hour Crystal banking exceeded the approved launch budget.', banked.toString(), bankCap.toString(), 'Pause reward settlements and reconcile every payout.');
    } else if (bankedBps >= thresholds.bankedBudgetWarningBps) {
      add(alerts, 'warning', 'economy', 'crystal_banking_budget_high', '24-hour Crystal banking is near the approved launch budget.', bankedBps, thresholds.bankedBudgetWarningBps, 'Hold rollout expansion and review run volume.');
    }
  }
  if (withdrawn !== null && withdrawalLimit !== null && withdrawalLimit > 0n) {
    const withdrawalBps = ratioBps(withdrawn, withdrawalLimit);
    if (withdrawn > withdrawalLimit) {
      add(alerts, 'critical', 'economy', 'withdrawal_limit_exceeded', 'Observed withdrawals exceed the configured global limit.', withdrawn.toString(), withdrawalLimit.toString(), 'Pause Crystal Bank and reconcile mint events.');
    } else if (withdrawalBps >= thresholds.withdrawalLimitWarningBps) {
      add(alerts, 'warning', 'economy', 'withdrawal_limit_high', 'Global withdrawal capacity is at least 80% consumed.', withdrawalBps, thresholds.withdrawalLimitWarningBps, 'Do not raise the limit until emissions are reconciled.');
    }
  }
}

function missing(alerts, stage, group, code, message) {
  add(
    alerts,
    stage === 'public' ? 'critical' : 'warning',
    group,
    code,
    message,
    null,
    'required',
    'Restore the signal before the next release gate.'
  );
}

function add(alerts, severity, group, code, message, observed, threshold, runbook) {
  alerts.push({ severity, group, code, message, observed, threshold, runbook });
}

function ratioBps(numerator, denominator) {
  return Number(numerator * 10_000n / denominator);
}

function unsignedBigInt(value) {
  try {
    const result = BigInt(value);
    return result >= 0n ? result : null;
  } catch {
    return null;
  }
}

function finiteNumber(value) {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : null;
}

function nonnegativeInteger(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function positiveTimestamp(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  }
  const text = String(value || '').trim();
  if (/^\d+$/.test(text)) {
    const result = Number(text);
    return Number.isSafeInteger(result) && result > 0 ? result : 0;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return 0;
  const result = Date.parse(text);
  return Number.isSafeInteger(result) && result > 0 ? result : 0;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
