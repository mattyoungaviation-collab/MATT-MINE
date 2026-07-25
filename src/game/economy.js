export const ECONOMY_STORAGE_KEY = 'matt-mine-economy-v1';
const DAY_MS = 86_400_000;
const WEEK_MS = DAY_MS * 7;
const MAX_SAFE_VALUE = Number.MAX_SAFE_INTEGER;

export const RUN_MODES = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  PRACTICE: 'practice'
});

export const ADMIN_ROLES = Object.freeze({
  TREASURY: 'TREASURY_ADMIN',
  GAME: 'GAME_ADMIN',
  REWARD: 'REWARD_PUBLISHER',
  MODERATOR: 'COMPETITION_MODERATOR',
  PRICE: 'PRICE_MANAGER',
  PAUSER: 'EMERGENCY_PAUSER'
});

export function utcDayKey(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function utcWeekKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const utcDay = date.getUTCDay();
  const daysFromMonday = (utcDay + 6) % 7;
  const monday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysFromMonday);
  return new Date(monday).toISOString().slice(0, 10);
}

export function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function defaultEconomyState() {
  return {
    version: 1,
    walletId: 'TEST-WALLET-01',
    player: {
      passPurchasedAt: 0,
      passExpiresAt: 0,
      paidRunCredits: 0,
      passXp: 0,
      banned: false
    },
    settings: {
      passPriceRon: 88,
      paidRunPriceRon: 10,
      maxPaidRunsPerDay: 10,
      mattPerRonQuote: 13_788,
      freeWeeklyPoolMatt: 2_500_000,
      passBaseWeeklyPoolMatt: 5_000_000,
      paidSplitCurrentPercent: 70,
      paidSplitFuturePercent: 20,
      paidSplitReservePercent: 10,
      rankedPaused: false,
      passSalesPaused: false,
      paidRunsPaused: false,
      claimsPaused: false
    },
    accounting: {
      ronFromPasses: 0,
      ronFromPaidRuns: 0,
      developmentRon: 0,
      marketingRon: 0,
      mattBoughtTotal: 0,
      currentPassPoolMatt: 0,
      futureRewardsMatt: 0,
      reserveMatt: 0,
      passRewardMatt: 0
    },
    daily: {},
    runs: [],
    publishedRewards: [],
    audit: []
  };
}

export function normalizeEconomyState(input = {}) {
  const base = defaultEconomyState();
  const source = isRecord(input) ? input : {};
  const player = isRecord(source.player) ? source.player : {};
  const settings = isRecord(source.settings) ? source.settings : {};
  const accounting = isRecord(source.accounting) ? source.accounting : {};
  const split = [
    safeInteger(settings.paidSplitCurrentPercent, base.settings.paidSplitCurrentPercent, 100),
    safeInteger(settings.paidSplitFuturePercent, base.settings.paidSplitFuturePercent, 100),
    safeInteger(settings.paidSplitReservePercent, base.settings.paidSplitReservePercent, 100)
  ];
  const validSplit = split.reduce((sum, value) => sum + value, 0) === 100;
  return {
    version: 1,
    walletId: safeString(source.walletId, base.walletId, 80),
    player: {
      passPurchasedAt: safeInteger(player.passPurchasedAt, base.player.passPurchasedAt),
      passExpiresAt: safeInteger(player.passExpiresAt, base.player.passExpiresAt),
      paidRunCredits: safeInteger(player.paidRunCredits, base.player.paidRunCredits, 10_000),
      passXp: safeInteger(player.passXp, base.player.passXp),
      banned: safeBoolean(player.banned, base.player.banned)
    },
    settings: {
      passPriceRon: safeNumber(settings.passPriceRon, base.settings.passPriceRon, 1, 500),
      paidRunPriceRon: safeNumber(settings.paidRunPriceRon, base.settings.paidRunPriceRon, 1, 100),
      maxPaidRunsPerDay: safeInteger(settings.maxPaidRunsPerDay, base.settings.maxPaidRunsPerDay, 50, 1),
      mattPerRonQuote: safeNumber(settings.mattPerRonQuote, base.settings.mattPerRonQuote, 1),
      freeWeeklyPoolMatt: safeInteger(settings.freeWeeklyPoolMatt, base.settings.freeWeeklyPoolMatt),
      passBaseWeeklyPoolMatt: safeInteger(settings.passBaseWeeklyPoolMatt, base.settings.passBaseWeeklyPoolMatt),
      paidSplitCurrentPercent: validSplit ? split[0] : base.settings.paidSplitCurrentPercent,
      paidSplitFuturePercent: validSplit ? split[1] : base.settings.paidSplitFuturePercent,
      paidSplitReservePercent: validSplit ? split[2] : base.settings.paidSplitReservePercent,
      rankedPaused: safeBoolean(settings.rankedPaused, base.settings.rankedPaused),
      passSalesPaused: safeBoolean(settings.passSalesPaused, base.settings.passSalesPaused),
      paidRunsPaused: safeBoolean(settings.paidRunsPaused, base.settings.paidRunsPaused),
      claimsPaused: safeBoolean(settings.claimsPaused, base.settings.claimsPaused)
    },
    accounting: {
      ronFromPasses: safeNumber(accounting.ronFromPasses, base.accounting.ronFromPasses, 0),
      ronFromPaidRuns: safeNumber(accounting.ronFromPaidRuns, base.accounting.ronFromPaidRuns, 0),
      developmentRon: safeNumber(accounting.developmentRon, base.accounting.developmentRon, 0),
      marketingRon: safeNumber(accounting.marketingRon, base.accounting.marketingRon, 0),
      mattBoughtTotal: safeInteger(accounting.mattBoughtTotal, base.accounting.mattBoughtTotal),
      currentPassPoolMatt: safeInteger(accounting.currentPassPoolMatt, base.accounting.currentPassPoolMatt),
      futureRewardsMatt: safeInteger(accounting.futureRewardsMatt, base.accounting.futureRewardsMatt),
      reserveMatt: safeInteger(accounting.reserveMatt, base.accounting.reserveMatt),
      passRewardMatt: safeInteger(accounting.passRewardMatt, base.accounting.passRewardMatt)
    },
    daily: normalizeDaily(source.daily),
    runs: normalizeRuns(source.runs),
    publishedRewards: normalizePublishedRewards(source.publishedRewards),
    audit: normalizeAudit(source.audit)
  };
}

export function passIsActive(state, timestamp = Date.now()) {
  return safeInteger(state?.player?.passExpiresAt, 0) > timestamp;
}

export function passDaysRemaining(state, timestamp = Date.now()) {
  if (!passIsActive(state, timestamp)) return 0;
  return Math.max(1, Math.ceil((state.player.passExpiresAt - timestamp) / DAY_MS));
}

export function dailyRecord(state, timestamp = Date.now()) {
  const key = utcDayKey(timestamp);
  const record = isRecord(state?.daily?.[key]) ? state.daily[key] : null;
  return record || {
    freeRunUsed: false,
    paidRunsPurchased: 0,
    paidRunsUsed: 0
  };
}

export function runAccess(state, mode, timestamp = Date.now()) {
  const daily = dailyRecord(state, timestamp);
  if (state.player.banned && mode !== RUN_MODES.PRACTICE) {
    return { allowed: false, reason: 'This test wallet is suspended from ranked play.' };
  }
  if (mode === RUN_MODES.PRACTICE) return { allowed: true, reason: 'Practice is unlimited.' };
  if (state.settings.rankedPaused) return { allowed: false, reason: 'Ranked runs are currently paused.' };
  if (mode === RUN_MODES.FREE) {
    return daily.freeRunUsed
      ? { allowed: false, reason: 'Today’s free ranked run has already been used.' }
      : { allowed: true, reason: 'Free ranked run available.' };
  }
  if (mode === RUN_MODES.PAID) {
    if (!passIsActive(state, timestamp)) return { allowed: false, reason: 'An active MATT Mine Pass is required.' };
    if (state.settings.paidRunsPaused) return { allowed: false, reason: 'Paid runs are currently paused.' };
    if (daily.paidRunsUsed >= state.settings.maxPaidRunsPerDay) {
      return { allowed: false, reason: 'The daily paid-run limit has been reached.' };
    }
    if (state.player.paidRunCredits < 1) return { allowed: false, reason: 'Purchase a paid-run credit first.' };
    return { allowed: true, reason: 'Paid ranked run available.' };
  }
  return { allowed: false, reason: 'Unknown run mode.' };
}

export function runSeed(mode, timestamp = Date.now()) {
  const day = utcDayKey(timestamp);
  if (mode === RUN_MODES.PRACTICE) return `MATT-PRACTICE-${timestamp}-${Math.random()}`;
  return `MATT-MINE-${day}-${mode.toUpperCase()}`;
}

export function purchasePass(state, timestamp = Date.now(), actor = 'PLAYER') {
  const next = normalizeEconomyState(state);
  if (next.settings.passSalesPaused) return fail(next, 'Pass sales are paused.');
  if (next.player.banned) return fail(next, 'Suspended wallets cannot purchase a pass.');
  const price = next.settings.passPriceRon;
  const start = Math.max(timestamp, next.player.passExpiresAt || 0);
  next.player.passPurchasedAt = timestamp;
  next.player.passExpiresAt = start + 30 * DAY_MS;
  next.accounting.ronFromPasses += price;
  next.accounting.developmentRon += price * 0.5;
  next.accounting.marketingRon += price * 0.2;
  const rewardRon = price * 0.3;
  const rewardMatt = Math.floor(rewardRon * next.settings.mattPerRonQuote);
  next.accounting.mattBoughtTotal += rewardMatt;
  next.accounting.passRewardMatt += rewardMatt;
  addAudit(next, actor, 'PASS_PURCHASED', `${price} RON · expires ${new Date(next.player.passExpiresAt).toISOString()}`, timestamp);
  return success(next, { priceRon: price, rewardMatt });
}

export function purchasePaidRun(state, timestamp = Date.now(), actor = 'PLAYER') {
  const next = normalizeEconomyState(state);
  const day = utcDayKey(timestamp);
  const daily = dailyRecord(next, timestamp);
  if (next.player.banned) return fail(next, 'Suspended wallets cannot purchase paid runs.');
  if (!passIsActive(next, timestamp)) return fail(next, 'An active MATT Mine Pass is required.');
  if (next.settings.paidRunsPaused) return fail(next, 'Paid-run purchases are paused.');
  if (daily.paidRunsPurchased >= next.settings.maxPaidRunsPerDay) {
    return fail(next, 'The daily paid-run purchase limit has been reached.');
  }
  const price = next.settings.paidRunPriceRon;
  const mattBought = Math.floor(price * next.settings.mattPerRonQuote);
  const current = Math.floor(mattBought * next.settings.paidSplitCurrentPercent / 100);
  const future = Math.floor(mattBought * next.settings.paidSplitFuturePercent / 100);
  const reserve = mattBought - current - future;
  next.player.paidRunCredits += 1;
  next.daily[day] = {
    ...daily,
    paidRunsPurchased: daily.paidRunsPurchased + 1
  };
  next.accounting.ronFromPaidRuns += price;
  next.accounting.mattBoughtTotal += mattBought;
  next.accounting.currentPassPoolMatt += current;
  next.accounting.futureRewardsMatt += future;
  next.accounting.reserveMatt += reserve;
  addAudit(next, actor, 'PAID_RUN_PURCHASED', `${price} RON → ${mattBought} MATT · 0 burned`, timestamp);
  return success(next, { priceRon: price, mattBought, current, future, reserve });
}

export function consumeRun(state, mode, timestamp = Date.now()) {
  const access = runAccess(state, mode, timestamp);
  const next = normalizeEconomyState(state);
  if (!access.allowed) return fail(next, access.reason);
  const day = utcDayKey(timestamp);
  const daily = dailyRecord(next, timestamp);
  if (mode === RUN_MODES.FREE) next.daily[day] = { ...daily, freeRunUsed: true };
  if (mode === RUN_MODES.PAID) {
    next.player.paidRunCredits -= 1;
    next.daily[day] = { ...daily, paidRunsUsed: daily.paidRunsUsed + 1 };
  }
  addAudit(next, next.walletId, 'RUN_STARTED', `${mode} · ${day}`, timestamp);
  return success(next, {
    mode,
    seed: runSeed(mode, timestamp),
    day,
    week: utcWeekKey(timestamp),
    rewardWeight: mode === RUN_MODES.PAID ? 2 : mode === RUN_MODES.FREE ? 1 : 0
  });
}

export function recordRun(state, result, timestamp = Date.now()) {
  const next = normalizeEconomyState(state);
  const source = isRecord(result) ? result : {};
  const mode = Object.values(RUN_MODES).includes(source.mode) ? source.mode : RUN_MODES.PRACTICE;
  if (next.player.banned && mode !== RUN_MODES.PRACTICE) {
    return fail(next, 'Suspended wallets cannot submit ranked scores.');
  }
  const extracted = Boolean(source.extracted);
  const projected = safeInteger(source.projected, 0);
  const banked = safeInteger(source.banked, extracted ? projected : 0);
  const score = mode === RUN_MODES.PRACTICE ? projected : extracted ? projected : Math.min(projected, banked);
  const entry = {
    id: `${timestamp}-${next.runs.length + 1}`,
    walletId: next.walletId,
    mode,
    day: safeDateKey(source.day, utcDayKey(timestamp)),
    week: safeDateKey(source.week, utcWeekKey(timestamp)),
    seed: safeString(source.seed, runSeed(mode, timestamp), 200),
    score,
    extracted,
    depth: safeInteger(source.depth, 1, 100, 1),
    kills: safeInteger(source.kills, 0),
    oreBroken: safeInteger(source.oreBroken, 0),
    elapsed: safeNumber(source.elapsed, 0, 0, DAY_MS / 1000),
    rewardWeight: mode === RUN_MODES.PAID ? 2 : mode === RUN_MODES.FREE ? 1 : 0,
    createdAt: timestamp
  };
  next.runs.push(entry);
  if (mode === RUN_MODES.PAID) next.player.passXp += 100;
  else if (mode === RUN_MODES.FREE && passIsActive(next, timestamp)) next.player.passXp += 25;
  addAudit(next, next.walletId, 'RUN_RECORDED', `${mode} · score ${score}`, timestamp);
  return success(next, { entry, passXp: next.player.passXp });
}

export function weeklyUserScore(state, mode, timestamp = Date.now()) {
  if (![RUN_MODES.FREE, RUN_MODES.PAID].includes(mode)) return 0;
  const safeState = normalizeEconomyState(state);
  const week = utcWeekKey(timestamp);
  const runs = safeState.runs.filter((run) => run.week === week && run.mode === mode);
  const dailyBest = new Map();
  for (const run of runs) dailyBest.set(run.day, Math.max(dailyBest.get(run.day) || 0, run.score));
  return [...dailyBest.values()].reduce((sum, score) => sum + score, 0);
}

export function previewLeaderboard(state, mode, timestamp = Date.now()) {
  const week = utcWeekKey(timestamp);
  const userScore = weeklyUserScore(state, mode, timestamp);
  const seed = hashSeed(`${week}:${mode}`);
  const names = ['0xCRYS…91A', '0xD1GG…420', '0xR0N…777', '0xM1NE…008', '0xP1CK…313', '0xDEEP…505', '0xORE…222'];
  const base = mode === RUN_MODES.PAID ? 8200 : 4700;
  const rivals = names.map((name, index) => ({
    walletId: name,
    score: Math.max(250, base - index * 570 + ((seed >>> (index % 16)) & 511)),
    isPreview: true
  }));
  const rows = [...rivals, { walletId: state.walletId, score: userScore, isPlayer: true }]
    .sort((a, b) => b.score - a.score)
    .map((row, index) => ({ ...row, rank: index + 1 }));
  return rows;
}

export function passPoolMatt(state) {
  return Math.floor(state.settings.passBaseWeeklyPoolMatt + state.accounting.currentPassPoolMatt);
}

export function estimatedLeaderboardReward(state, mode, rank) {
  const pool = mode === RUN_MODES.PAID ? passPoolMatt(state) : state.settings.freeWeeklyPoolMatt;
  let share = 0;
  if (rank === 1) share = 0.20;
  else if (rank === 2) share = 0.12;
  else if (rank === 3) share = 0.08;
  else if (rank >= 4 && rank <= 10) share = 0.20 / 7;
  return Math.floor(pool * share);
}

export function passLevel(passXp) {
  const thresholds = [0, 200, 500, 900, 1400, 2000, 2800, 3800];
  let level = 1;
  for (let index = 0; index < thresholds.length; index += 1) {
    if (passXp >= thresholds[index]) level = index + 1;
  }
  const current = thresholds[level - 1] || 0;
  const next = thresholds[level] ?? thresholds.at(-1);
  return {
    level,
    current,
    next,
    progress: next === current ? 1 : Math.min(1, (passXp - current) / (next - current)),
    maxLevel: thresholds.length
  };
}

export function updateAdminSettings(state, patch, role, timestamp = Date.now()) {
  const next = normalizeEconomyState(state);
  if (!isRecord(patch)) return fail(next, 'Settings patch must be an object.');
  const keys = Object.keys(patch);
  const priceKeys = ['passPriceRon', 'paidRunPriceRon', 'mattPerRonQuote'];
  const treasuryKeys = ['freeWeeklyPoolMatt', 'passBaseWeeklyPoolMatt'];
  const pauseKeys = ['rankedPaused', 'passSalesPaused', 'paidRunsPaused', 'claimsPaused'];
  const gameKeys = ['maxPaidRunsPerDay'];
  const allowedKeys = [...priceKeys, ...treasuryKeys, ...pauseKeys, ...gameKeys];
  if (keys.some((key) => !allowedKeys.includes(key))) return fail(next, 'Unknown or locked setting.');
  if (keys.some((key) => priceKeys.includes(key)) && role !== ADMIN_ROLES.PRICE) return fail(next, 'PRICE_MANAGER role required.');
  if (keys.some((key) => treasuryKeys.includes(key)) && role !== ADMIN_ROLES.TREASURY) return fail(next, 'TREASURY_ADMIN role required.');
  if (keys.some((key) => pauseKeys.includes(key)) && ![ADMIN_ROLES.PAUSER, ADMIN_ROLES.GAME].includes(role)) {
    return fail(next, 'EMERGENCY_PAUSER or GAME_ADMIN role required.');
  }
  if (keys.some((key) => gameKeys.includes(key)) && role !== ADMIN_ROLES.GAME) return fail(next, 'GAME_ADMIN role required.');
  if ('passPriceRon' in patch && safeNumber(patch.passPriceRon, null, 1, 500) === null) return fail(next, 'Pass price must be 1-500 RON.');
  if ('paidRunPriceRon' in patch && safeNumber(patch.paidRunPriceRon, null, 1, 100) === null) return fail(next, 'Paid-run price must be 1-100 RON.');
  if ('mattPerRonQuote' in patch && safeNumber(patch.mattPerRonQuote, null, 1) === null) return fail(next, 'MATT quote must be positive.');
  if ('maxPaidRunsPerDay' in patch && (!Number.isSafeInteger(patch.maxPaidRunsPerDay) || patch.maxPaidRunsPerDay < 1 || patch.maxPaidRunsPerDay > 50)) {
    return fail(next, 'Daily paid-run cap must be an integer from 1-50.');
  }
  if ('freeWeeklyPoolMatt' in patch && (!Number.isSafeInteger(patch.freeWeeklyPoolMatt) || patch.freeWeeklyPoolMatt < 0)) {
    return fail(next, 'Free reward pool must be a non-negative integer.');
  }
  if ('passBaseWeeklyPoolMatt' in patch && (!Number.isSafeInteger(patch.passBaseWeeklyPoolMatt) || patch.passBaseWeeklyPoolMatt < 0)) {
    return fail(next, 'Pass reward pool must be a non-negative integer.');
  }
  if (keys.some((key) => pauseKeys.includes(key) && typeof patch[key] !== 'boolean')) return fail(next, 'Pause settings must be true or false.');
  Object.assign(next.settings, patch);
  addAudit(next, role, 'ADMIN_SETTINGS_UPDATED', JSON.stringify(patch), timestamp);
  return success(next, { patch });
}

export function setWalletBan(state, banned, role, timestamp = Date.now()) {
  const next = normalizeEconomyState(state);
  if (role !== ADMIN_ROLES.MODERATOR) return fail(next, 'COMPETITION_MODERATOR role required.');
  next.player.banned = Boolean(banned);
  addAudit(next, role, banned ? 'WALLET_SUSPENDED' : 'WALLET_RESTORED', next.walletId, timestamp);
  return success(next, { banned: next.player.banned });
}

export function publishRewardEpoch(state, role, timestamp = Date.now()) {
  const next = normalizeEconomyState(state);
  if (role !== ADMIN_ROLES.REWARD) return fail(next, 'REWARD_PUBLISHER role required.');
  const week = utcWeekKey(timestamp);
  if (next.publishedRewards.some((epoch) => epoch.week === week)) return fail(next, 'This weekly reward epoch is already published.');
  const freeRow = previewLeaderboard(next, RUN_MODES.FREE, timestamp).find((row) => row.isPlayer);
  const paidRow = previewLeaderboard(next, RUN_MODES.PAID, timestamp).find((row) => row.isPlayer);
  const freeRewardMatt = estimatedLeaderboardReward(next, RUN_MODES.FREE, freeRow?.rank || 0);
  const paidRewardMatt = estimatedLeaderboardReward(next, RUN_MODES.PAID, paidRow?.rank || 0);
  const epoch = {
    id: `EPOCH-${week}`,
    week,
    walletId: next.walletId,
    freeRank: freeRow?.rank || 0,
    paidRank: paidRow?.rank || 0,
    freeRewardMatt,
    paidRewardMatt,
    totalRewardMatt: freeRewardMatt + paidRewardMatt,
    publishedAt: timestamp,
    claimedAt: 0
  };
  next.publishedRewards.push(epoch);
  addAudit(next, role, 'REWARD_EPOCH_PUBLISHED', `${epoch.id} · ${epoch.totalRewardMatt} MATT`, timestamp);
  return success(next, { epoch });
}

export function claimLatestReward(state, timestamp = Date.now()) {
  const next = normalizeEconomyState(state);
  if (next.settings.claimsPaused) return fail(next, 'Reward claims are paused.');
  const epoch = [...next.publishedRewards].reverse().find((entry) => entry.walletId === next.walletId && !entry.claimedAt);
  if (!epoch) return fail(next, 'No published reward is ready to claim.');
  epoch.claimedAt = timestamp;
  addAudit(next, next.walletId, 'TEST_REWARD_CLAIMED', `${epoch.id} · ${epoch.totalRewardMatt} MATT`, timestamp);
  return success(next, { epoch });
}

export function latestReward(state) {
  return [...state.publishedRewards].reverse().find((entry) => entry.walletId === state.walletId) || null;
}

export function resetEconomyForTesting(state, role, timestamp = Date.now()) {
  if (role !== ADMIN_ROLES.GAME) return fail(normalizeEconomyState(state), 'GAME_ADMIN role required.');
  const next = defaultEconomyState();
  addAudit(next, role, 'TEST_ECONOMY_RESET', 'Local test state reset', timestamp);
  return success(next, {});
}

export class LocalEconomyStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.state = this.load();
  }

  load() {
    try {
      const raw = this.storage?.getItem(ECONOMY_STORAGE_KEY);
      const normalized = raw ? normalizeEconomyState(JSON.parse(raw)) : defaultEconomyState();
      this.persist(normalized);
      return normalized;
    } catch {
      const recovered = defaultEconomyState();
      this.persist(recovered);
      return recovered;
    }
  }

  save(nextState) {
    this.state = normalizeEconomyState(nextState);
    this.persist(this.state);
    return this.state;
  }

  apply(result) {
    if (result.ok) this.save(result.state);
    return result;
  }

  reset() {
    this.state = defaultEconomyState();
    this.persist(this.state);
    return this.state;
  }

  persist(state) {
    try {
      this.storage?.setItem(ECONOMY_STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      return false;
    }
  }
}

function addAudit(state, actor, action, details, timestamp) {
  state.audit.push({ id: `${timestamp}-${state.audit.length + 1}`, actor, action, details, timestamp });
  state.audit = state.audit.slice(-300);
}

function success(state, data) {
  return { ok: true, state, ...data };
}

function fail(state, error) {
  return { ok: false, state, error };
}

export const ECONOMY_DAY_MS = DAY_MS;
export const ECONOMY_WEEK_MS = WEEK_MS;

function normalizeDaily(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key, value]) => isDateKey(key) && isRecord(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-45)
    .map(([key, value]) => [key, {
      freeRunUsed: safeBoolean(value.freeRunUsed, false),
      paidRunsPurchased: safeInteger(value.paidRunsPurchased, 0, 50),
      paidRunsUsed: safeInteger(value.paidRunsUsed, 0, 50)
    }]));
}

function normalizeRuns(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isRecord)
    .slice(-1000)
    .map((run, index) => {
      const mode = Object.values(RUN_MODES).includes(run.mode) ? run.mode : RUN_MODES.PRACTICE;
      return {
        id: safeString(run.id, `RECOVERED-RUN-${index + 1}`, 120),
        walletId: safeString(run.walletId, 'UNKNOWN-WALLET', 80),
        mode,
        day: safeDateKey(run.day, '1970-01-01'),
        week: safeDateKey(run.week, '1970-01-01'),
        seed: safeString(run.seed, 'RECOVERED-SEED', 200),
        score: safeInteger(run.score, 0),
        extracted: safeBoolean(run.extracted, false),
        depth: safeInteger(run.depth, 1, 100, 1),
        kills: safeInteger(run.kills, 0),
        oreBroken: safeInteger(run.oreBroken, 0),
        elapsed: safeNumber(run.elapsed, 0, 0, DAY_MS / 1000),
        rewardWeight: mode === RUN_MODES.PAID ? 2 : mode === RUN_MODES.FREE ? 1 : 0,
        createdAt: safeInteger(run.createdAt, 0)
      };
    });
}

function normalizePublishedRewards(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isRecord)
    .slice(-100)
    .map((epoch, index) => ({
      id: safeString(epoch.id, `RECOVERED-EPOCH-${index + 1}`, 120),
      week: safeDateKey(epoch.week, '1970-01-01'),
      walletId: safeString(epoch.walletId, 'UNKNOWN-WALLET', 80),
      freeRank: safeInteger(epoch.freeRank, 0),
      paidRank: safeInteger(epoch.paidRank, 0),
      freeRewardMatt: safeInteger(epoch.freeRewardMatt, 0),
      paidRewardMatt: safeInteger(epoch.paidRewardMatt, 0),
      totalRewardMatt: safeInteger(epoch.totalRewardMatt, 0),
      publishedAt: safeInteger(epoch.publishedAt, 0),
      claimedAt: safeInteger(epoch.claimedAt, 0)
    }));
}

function normalizeAudit(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter(isRecord)
    .slice(-300)
    .map((entry, index) => ({
      id: safeString(entry.id, `RECOVERED-AUDIT-${index + 1}`, 120),
      actor: safeString(entry.actor, 'UNKNOWN', 80),
      action: safeString(entry.action, 'RECOVERED_ENTRY', 100),
      details: safeString(entry.details, '', 500),
      timestamp: safeInteger(entry.timestamp, 0)
    }));
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function safeNumber(value, fallback, min = 0, max = MAX_SAFE_VALUE) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function safeInteger(value, fallback, max = MAX_SAFE_VALUE, min = 0) {
  const number = safeNumber(value, Number.NaN, min, max);
  return Number.isFinite(number) ? Math.floor(number) : fallback;
}

function safeString(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : fallback;
}

function isDateKey(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function safeDateKey(value, fallback) {
  return isDateKey(value) ? value : fallback;
}
