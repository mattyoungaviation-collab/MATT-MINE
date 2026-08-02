export const ARENA_PAYOUT_BPS = Object.freeze([
  3_000,
  1_800,
  1_200,
  800,
  700,
  600,
  550,
  500,
  450,
  400
]);

export const ARENA_SEED_CAP_MATT = 10_000_000;
export const ARENA_MIN_ENTRY_MATT = 25_000;
export const ARENA_MAX_ENTRY_MATT = 1_000_000;
export const MATT_DECIMALS = 18n;
export const MATT_SCALE = 10n ** MATT_DECIMALS;

export function normalizeArenaConfig(value = {}) {
  const status = String(value.status || 'disabled').toLowerCase();
  const parsedChainStatus = Number(value.chainStatus);
  const chainStatus = Number.isInteger(parsedChainStatus) &&
    parsedChainStatus >= 0 &&
    parsedChainStatus <= 3
    ? parsedChainStatus
    : 0;
  const feeRaw = rawToken(value.fee?.raw ?? value.feeRaw ?? 0);
  const seedRaw = rawToken(value.seed?.raw ?? value.seedRaw ?? 0);
  const entryPoolRaw = rawToken(value.entryPoolRaw ?? value.entryPool?.raw ?? 0);
  const prizePoolRaw = rawToken(
    value.prizePoolRaw ??
    value.totalPoolRaw ??
    entryPoolRaw + seedRaw
  );
  const snapshotAt = safeTimestamp(value.snapshotAt);
  const entryCutoffAt = safeTimestamp(value.entryCutoffAt);
  return {
    day: /^\d{4}-\d{2}-\d{2}$/.test(String(value.day || '')) ? String(value.day) : utcDay(),
    status,
    chainStatus,
    configured: value.configured === true,
    previewAvailable: value.previewAvailable === true,
    replayReady: value.replayReady === true,
    enabled: value.enabled !== false && status !== 'disabled',
    paused: Boolean(value.paused) || status === 'paused',
    entriesPaused: Boolean(value.entriesPaused ?? value.paused),
    settlementPaused: Boolean(value.settlementPaused),
    verificationMode: String(value.verificationMode || ''),
    liveBlocker: String(value.liveBlocker || ''),
    roundDurationSeconds: safeInteger(value.roundDurationSeconds),
    runTtlSeconds: safeInteger(value.runTtlSeconds),
    finalizationGraceSeconds: safeInteger(value.finalizationGraceSeconds),
    snapshotAt,
    entryCutoffAt,
    feeRaw,
    feeMatt: Number(value.fee?.matt ?? value.feeMatt ?? rawToMatt(feeRaw)),
    seedRaw,
    seedMatt: Number(value.seed?.matt ?? value.seedMatt ?? rawToMatt(seedRaw)),
    seedCapMatt: Number(value.seed?.capMatt ?? value.seedCapMatt ?? ARENA_SEED_CAP_MATT),
    entryPoolRaw,
    entryPoolMatt: Number(value.entryPoolMatt ?? rawToMatt(entryPoolRaw)),
    prizePoolRaw,
    prizePoolMatt: Number(value.prizePoolMatt ?? rawToMatt(prizePoolRaw)),
    entryCount: safeInteger(value.entryCount),
    uniquePlayers: safeInteger(value.uniquePlayers),
    settledAt: safeTimestamp(value.settledAt),
    canceledAt: safeTimestamp(value.canceledAt),
    transactionHash: validHash(value.transactionHash) ? value.transactionHash : '',
    deterministicSeed: String(value.deterministicSeed || ''),
    transcriptVersion: String(value.transcriptVersion || '')
  };
}

export function normalizeArenaPlayer(value = {}) {
  return {
    entries: safeInteger(value.entries ?? value.entryCount),
    unusedAttempts: safeInteger(value.unusedAttempts),
    bestScore: safeInteger(value.bestScore),
    rank: safeInteger(value.rank),
    refundRaw: rawToken(value.refundRaw ?? 0),
    refundable: Boolean(value.refundable),
    activeRunId: String(value.activeRunId || '')
  };
}

export function normalizeArenaLeaderboard(value = {}) {
  const totalPoolRaw = rawToken(value.totalPoolRaw ?? value.prizePoolRaw ?? 0);
  const rows = Array.isArray(value.rows)
    ? value.rows.slice(0, 10).map((row, index) => ({
        rank: safeInteger(row.rank) || index + 1,
        address: String(row.address || ''),
        walletId: String(row.walletId || ''),
        identity: normalizeArenaIdentity(row.identity),
        appearance: row.appearance && typeof row.appearance === 'object' ? { ...row.appearance } : {},
        score: safeInteger(row.score),
        entries: safeInteger(row.entries ?? row.entryCount),
        projectedRaw: rawToken(row.projectedRaw ?? row.payoutRaw ?? 0),
        payoutRaw: rawToken(row.payoutRaw ?? 0),
        isPlayer: Boolean(row.isPlayer),
        status: String(row.status || (value.finalized ? 'FINAL' : 'VERIFIED'))
      }))
    : [];
  const projections = projectedArenaPayouts(totalPoolRaw, rows.length);
  return {
    day: String(value.day || utcDay()),
    status: String(value.status || 'open').toLowerCase(),
    finalized: Boolean(value.finalized),
    participantCount: safeInteger(value.participantCount),
    entryCount: safeInteger(value.entryCount),
    totalPoolRaw,
    rows: rows.map((row, index) => ({
      ...row,
      projectedRaw: row.projectedRaw || projections[index] || 0n
    }))
  };
}

function normalizeArenaIdentity(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  const avatarUrl = String(source.avatarUrl || '');
  return {
    name: String(source.name || '').slice(0, 16),
    avatarUrl: /^\/api\/profiles\/0x[a-fA-F0-9]{40}\/avatar\?v=\d+$/.test(avatarUrl)
      ? avatarUrl
      : ''
  };
}

export function arenaTimeRemaining(snapshotAt, now = Date.now()) {
  const remainingMs = Math.max(0, safeTimestamp(snapshotAt) - now);
  const totalSeconds = Math.floor(remainingMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return {
    remainingMs,
    complete: remainingMs === 0,
    label: [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
  };
}

export function formatArenaRoundTime(remainingMs) {
  const milliseconds = Number(remainingMs);
  const totalSeconds = Math.max(
    0,
    Math.ceil((Number.isFinite(milliseconds) ? milliseconds : 0) / 1_000)
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function projectedArenaPayouts(poolRaw, playerCount) {
  const count = Math.max(0, Math.min(10, safeInteger(playerCount)));
  const pool = rawToken(poolRaw);
  if (!count || pool === 0n) return [];
  const weights = ARENA_PAYOUT_BPS.slice(0, count);
  const denominator = BigInt(weights.reduce((total, weight) => total + weight, 0));
  const payouts = new Array(count).fill(0n);
  let allocated = 0n;
  for (let index = 1; index < count; index += 1) {
    payouts[index] = (pool * BigInt(weights[index])) / denominator;
    allocated += payouts[index];
  }
  payouts[0] = pool - allocated;
  return payouts;
}

export function formatMattRaw(value, options = {}) {
  const raw = rawToken(value);
  const whole = raw / MATT_SCALE;
  const fraction = raw % MATT_SCALE;
  const maximumFractionDigits = Math.max(0, Math.min(6, safeInteger(options.maximumFractionDigits ?? 2)));
  const fractionText = maximumFractionDigits
    ? fraction.toString().padStart(Number(MATT_DECIMALS), '0').slice(0, maximumFractionDigits).replace(/0+$/, '')
    : '';
  const wholeText = Number(whole <= BigInt(Number.MAX_SAFE_INTEGER) ? whole : 0n).toLocaleString('en-US');
  return fractionText ? `${wholeText}.${fractionText} MATT` : `${wholeText} MATT`;
}

export function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function rawToMatt(raw) {
  const whole = raw / MATT_SCALE;
  const fraction = raw % MATT_SCALE;
  return Number(whole) + Number(fraction) / Number(MATT_SCALE);
}

function rawToken(value) {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value || 0));
    return parsed > 0n ? parsed : 0n;
  } catch {
    return 0n;
  }
}

function safeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function safeTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function validHash(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || ''));
}
