export function buildAdminReadiness(input = {}) {
  const database = input.database || {};
  const payments = input.payments || {};
  const rewards = input.rewards || {};
  const arena = input.arena || {};
  const replay = input.replay || {};
  const revive = input.revive || {};
  const controlLinks = input.controlLinks || {};
  const nft = input.nft || {};
  const monitors = [
    monitor(
      'database',
      'Production database',
      database.ok && database.kind === 'postgresql' ? 'ready' : database.ok ? 'warning' : 'blocked',
      database.ok
        ? database.kind === 'postgresql'
          ? `PostgreSQL connected${Number.isFinite(database.latencyMs) ? ` · ${database.latencyMs} ms` : ''}`
          : `${database.kind || 'unknown'} storage is not production persistence`
        : 'Database health check failed',
      true,
      'Data'
    ),
    monitor(
      'control-links',
      'Control consistency',
      controlLinks.consistent ? 'ready' : 'blocked',
      controlLinks.consistent
        ? `${Number(controlLinks.synchronizedCount || 0)} linked controls agree`
        : `${Number(controlLinks.conflictCount || 0)} linked controls conflict`,
      true,
      'Controls'
    ),
    monitor(
      'ronin-payments',
      'Ronin payment contracts',
      payments.live ? contractsOpen(payments) ? 'ready' : 'warning' : 'blocked',
      payments.live
        ? contractsOpen(payments)
          ? 'Pass and paid-run contracts responding'
          : 'Connected; one or more purchase contracts are paused'
        : 'Exact Ronin payment verification unavailable',
      true,
      'Chain'
    ),
    monitor(
      'reward-pipeline',
      'MATT reward pipeline',
      rewards.available && rewards.publicationEnabled ? 'ready' : rewards.available ? 'warning' : 'blocked',
      rewards.available
        ? rewards.publicationEnabled
          ? `Publication enabled · ${Number(rewards.maxBoardMatt || 0).toLocaleString()} MATT board cap`
          : 'Configured in dry-run mode'
        : 'Reward store or chain integration unavailable',
      true,
      'Rewards'
    ),
    monitor(
      'competitive-replay',
      'Competitive replay',
      replay.configured && replay.enabled ? 'ready' : 'blocked',
      replay.configured
        ? `${replay.verification || 'server replay'} · ${(replay.modes || []).join(', ')}`
        : 'Deterministic score verification unavailable',
      true,
      'Competition'
    ),
    monitor(
      'daily-arena',
      'Daily Arena',
      arena.configured && arena.deploymentPinned && arena.replayReady
        ? arena.enabled ? 'ready' : 'warning'
        : 'blocked',
      arena.configured
        ? arena.enabled
          ? 'Live contract, deployment pin, and replay gate ready'
          : 'Verified and pinned; live entries are not enabled'
        : 'Arena service is not configured',
      false,
      'Competition'
    ),
    monitor(
      'paid-revives',
      'Paid revives',
      revive.configured && revive.eligibilityReady ? revive.enabled ? 'ready' : 'warning' : 'blocked',
      revive.configured
        ? revive.eligibilityReady
          ? 'Exact payment and death replay verification ready'
          : 'Payment verifier ready; death replay gate missing'
        : 'Exact revive-payment verifier unavailable',
      false,
      'Features'
    ),
    ...(nft.enabled ? [
      monitor(
        'nft-metadata-chain',
        'Miner metadata chain reads',
        nft.metadata?.ok === true ? 'ready' : 'blocked',
        nft.metadata?.ok === true
          ? `Ronin chain ${Number(nft.metadata.chainId || 0)} responding${Number.isFinite(nft.metadata.latencyMs) ? ` · ${nft.metadata.latencyMs} ms` : ''}`
          : `Metadata/RPC validation failed${nft.metadata?.error ? ` · ${nft.metadata.error}` : ''}`,
        true,
        'NFT V2'
      ),
      monitor(
        'nft-gameplay-settlement',
        'NFT gameplay settlement',
        nft.gameplay?.ok === true ? 'ready' : 'blocked',
        nft.gameplay?.ok === true
          ? `Settlement, roles, signer, and active maps verified${Number.isFinite(nft.gameplay.latencyMs) ? ` · ${nft.gameplay.latencyMs} ms` : ''}`
          : `Settlement operator health failed${nft.gameplay?.error ? ` · ${nft.gameplay.error}` : ''}`,
        true,
        'NFT V2'
      )
    ] : []),
    monitor(
      'treasury-safe',
      'Treasury Safe',
      (input.treasurySafe?.verified === true || (input.treasurySafe?.address && input.treasurySafe?.owners === 3 && input.treasurySafe?.threshold === 2)) ? 'ready' : 'blocked',
      (input.treasurySafe?.verified === true || (input.treasurySafe?.address && input.treasurySafe?.owners === 3 && input.treasurySafe?.threshold === 2))
        ? `${input.treasurySafe.threshold}-of-${input.treasurySafe.owners} signer policy · ${shortAddress(input.treasurySafe.address)}`
        : 'Live getOwners/getThreshold verification is unavailable or not exactly 2-of-3',
      true,
      'Chain'
    )
  ];

  const required = monitors.filter((entry) => entry.required);
  const readyRequired = required.filter((entry) => entry.status === 'ready').length;
  const blockedRequired = required.filter((entry) => entry.status === 'blocked').length;
  const warningRequired = required.filter((entry) => entry.status === 'warning').length;
  const score = Math.round((monitors.reduce((sum, entry) => sum + statusWeight(entry.status), 0) / monitors.length) * 100);
  return {
    status: blockedRequired ? 'blocked' : warningRequired ? 'attention' : 'ready',
    label: blockedRequired ? 'Action required' : warningRequired ? 'Ready with warnings' : 'Core systems ready',
    score,
    readyRequired,
    requiredCount: required.length,
    blockedRequired,
    warningRequired,
    checkedAt: Number(input.checkedAt || Date.now()),
    monitors
  };
}

function monitor(id, label, status, detail, required, group) {
  return { id, label, status, detail, required, group };
}

function contractsOpen(payments) {
  return payments.pass?.paused === false && payments.paidRuns?.paused === false;
}

function statusWeight(status) {
  if (status === 'ready') return 1;
  if (status === 'warning') return 0.6;
  return 0;
}

function shortAddress(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}
