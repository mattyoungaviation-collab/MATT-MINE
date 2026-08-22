import { defaultProfile, normalizeProfile } from '../src/game/storage.js';
import {
  COSMETIC_SLOTS,
  PASS_CHEST_ID,
  PASS_COSMETICS,
  defaultPassInventory
} from '../src/game/passRewards.js';
import { SERVER_STATE_VERSION } from './constants.js';
import { normalizeIdentity } from './identity.js';
import { defaultGameTuning, normalizeGameTuning } from '../src/game/tuning.js';
import { defaultKeybindings, normalizeKeybindings } from '../src/game/keybindings.js';
import {
  defaultExpansionConfig,
  defaultPlayerExpansion,
  normalizeExpansionConfig,
  normalizePlayerExpansion
} from '../src/game/expansionConfig.js';
import {
  defaultCompetitionStudio,
  normalizeCompetitionStudio
} from '../src/game/competitionStudio.js';

export function defaultServerState() {
  return {
    version: SERVER_STATE_VERSION,
    wallets: {},
    challenges: {},
    sessions: {},
    runs: {},
    arenaReviveRuns: {},
    revivePayments: {},
    passPurchases: {},
    paidEntitlements: {},
    leaderboardOverrides: {},
    arenaPassXpAwards: {},
    gameTuning: defaultGameTuning(),
    expansionConfig: defaultExpansionConfig(),
    weeklyCompetition: { weeks: {} },
    endlessCompetition: { seasons: {} },
    competitionStudio: defaultCompetitionStudio(),
    nftV2Protocol: defaultNftV2Protocol(),
    operations: defaultOperations(),
    audit: []
  };
}

export function defaultWalletState(address, timestamp = Date.now()) {
  return {
    address,
    identity: normalizeIdentity(),
    profile: defaultProfile(),
    nftCrystalBalance: 0,
    nftCrystalLedger: [],
    passProgress: defaultPassProgress(),
    passInventory: defaultPassInventory(),
    keybindings: defaultKeybindings(),
    expansion: defaultPlayerExpansion(),
    activity: [],
    paidCompetitionEligibility: {},
    suspended: false,
    daily: {},
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export function normalizeServerState(input = {}) {
  const source = isRecord(input) ? input : {};
  return {
    version: SERVER_STATE_VERSION,
    wallets: normalizeWallets(source.wallets),
    challenges: normalizeRecords(source.challenges, 2_000),
    sessions: normalizeRecords(source.sessions, 10_000),
    runs: normalizeRuns(source.runs),
    arenaReviveRuns: normalizeRecords(source.arenaReviveRuns, 25_000),
    revivePayments: normalizeRecords(source.revivePayments, 25_000),
    passPurchases: normalizePassPurchases(source.passPurchases),
    paidEntitlements: normalizePaidEntitlements(source.paidEntitlements),
    leaderboardOverrides: normalizeLeaderboardOverrides(source.leaderboardOverrides),
    arenaPassXpAwards: normalizeArenaPassXpAwards(source.arenaPassXpAwards),
    gameTuning: normalizeGameTuning(migrateLegacyGameTuning(source.gameTuning, source.version)),
    expansionConfig: safeExpansionConfig(source.expansionConfig),
    weeklyCompetition: normalizeCompetitionStore(source.weeklyCompetition, 'weeks'),
    endlessCompetition: normalizeCompetitionStore(source.endlessCompetition, 'seasons'),
    competitionStudio: normalizeCompetitionStudio(source.competitionStudio),
    nftV2Protocol: normalizeNftV2Protocol(source.nftV2Protocol),
    operations: normalizeOperations(source.operations),
    audit: Array.isArray(source.audit)
      ? source.audit.filter(isRecord).slice(-2_000).map((entry) => ({ ...entry }))
      : []
  };
}

function normalizeLeaderboardOverrides(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) =>
      isRecord(value) &&
      isHexAddress(value.address) &&
      ['free', 'paid'].includes(value.mode) &&
      /^\d{4}-\d{2}-\d{2}$/.test(value.week || '') &&
      Number.isSafeInteger(value.score) &&
      value.score >= 0 &&
      value.score <= 35_000_000
    )
    .slice(-2_000)
    .map(([, value]) => {
      const address = value.address.toLowerCase();
      const mode = value.mode;
      const week = value.week;
      const key = `${week}:${mode}:${address}`;
      return [key, {
        address,
        mode,
        week,
        score: value.score,
        reason: typeof value.reason === 'string' ? value.reason.slice(0, 240) : '',
        updatedAt: safeTimestamp(value.updatedAt),
        updatedBy: 'SERVER_ADMIN'
      }];
    }));
}

export function defaultOperations() {
  return {
    maintenanceMode: false,
    freeRankedPaused: false,
    passRankedPaused: false,
    purchasesPaused: false,
    claimsPaused: false,
    mines: defaultMineOperations(),
    announcement: '',
    updatedAt: 0,
    updatedBy: ''
  };
}

function normalizeOperations(input) {
  const source = isRecord(input) ? input : {};
  return {
    maintenanceMode: source.maintenanceMode === true,
    freeRankedPaused: source.freeRankedPaused === true,
    passRankedPaused: source.passRankedPaused === true,
    purchasesPaused: source.purchasesPaused === true,
    claimsPaused: source.claimsPaused === true,
    mines: normalizeMineOperations(source.mines, source),
    announcement: typeof source.announcement === 'string'
      ? source.announcement.trim().slice(0, 280)
      : '',
    updatedAt: safeTimestamp(source.updatedAt),
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 80) : ''
  };
}

export function defaultMineOperations() {
  return Object.fromEntries(['practice', 'arena', 'daily', 'pass', 'weekly'].map((mine) => [mine, {
    entriesPaused: false,
    resultsPaused: false,
    paymentsPaused: false,
    rewardsPaused: false,
    updatedAt: 0,
    updatedBy: ''
  }]));
}

function normalizeMineOperations(input, legacy = {}) {
  const source = isRecord(input) ? input : {};
  const defaults = defaultMineOperations();
  return Object.fromEntries(Object.entries(defaults).map(([mine, fallback]) => {
    const value = isRecord(source[mine]) ? source[mine] : {};
    const legacyEntriesPaused =
      mine === 'daily' ? legacy.freeRankedPaused === true :
      mine === 'pass' ? legacy.passRankedPaused === true :
      false;
    const legacyPaymentsPaused =
      mine === 'pass' || mine === 'practice' ? legacy.purchasesPaused === true : false;
    const legacyRewardsPaused =
      mine === 'daily' || mine === 'pass' ? legacy.claimsPaused === true : false;
    return [mine, {
      entriesPaused: value.entriesPaused === true || legacyEntriesPaused,
      resultsPaused: value.resultsPaused === true,
      paymentsPaused: value.paymentsPaused === true || legacyPaymentsPaused,
      rewardsPaused: value.rewardsPaused === true || legacyRewardsPaused,
      updatedAt: safeTimestamp(value.updatedAt),
      updatedBy: typeof value.updatedBy === 'string' ? value.updatedBy.slice(0, 80) : fallback.updatedBy
    }];
  }));
}

function normalizePaidEntitlements(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) =>
      isRecord(value) &&
      /^0x[a-fA-F0-9]{64}$/.test(value.transactionHash || '') &&
      isHexAddress(value.address) &&
      Number.isSafeInteger(value.logIndex) &&
      value.logIndex >= 0
    )
    .slice(-25_000)
    .map(([key, value]) => [String(key).slice(0, 200).toLowerCase(), {
      key: String(value.key || key).slice(0, 200).toLowerCase(),
      transactionHash: value.transactionHash.toLowerCase(),
      logIndex: value.logIndex,
      blockNumber: safeUnsignedString(value.blockNumber),
      address: value.address.toLowerCase(),
      entitlementId: safeUnsignedString(value.entitlementId),
      ronPaid: safeUnsignedString(value.ronPaid),
      mattBought: safeUnsignedString(value.mattBought),
      currentPoolMatt: safeUnsignedString(value.currentPoolMatt),
      futureRewardsMatt: safeUnsignedString(value.futureRewardsMatt),
      reserveMatt: safeUnsignedString(value.reserveMatt),
      confirmedAt: safeTimestamp(value.confirmedAt),
      consumedAt: safeTimestamp(value.consumedAt),
      usedRunId: typeof value.usedRunId === 'string' ? value.usedRunId.slice(0, 120) : ''
    }]));
}

function normalizePassPurchases(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) =>
      isRecord(value) &&
      /^0x[a-fA-F0-9]{64}$/.test(value.transactionHash || '') &&
      isHexAddress(value.address) &&
      Number.isSafeInteger(value.logIndex) &&
      value.logIndex >= 0
    )
    .slice(-20_000)
    .map(([key, value]) => [String(key).slice(0, 200).toLowerCase(), {
      key: String(value.key || key).slice(0, 200).toLowerCase(),
      transactionHash: value.transactionHash.toLowerCase(),
      logIndex: value.logIndex,
      blockNumber: safeUnsignedString(value.blockNumber),
      address: value.address.toLowerCase(),
      priceRon: safeUnsignedString(value.priceRon),
      expiresAt: safeTimestamp(value.expiresAt),
      confirmedAt: safeTimestamp(value.confirmedAt)
    }]));
}

function normalizeWallets(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([address, wallet]) => isRecord(wallet) && isHexAddress(address))
    .slice(-20_000)
    .map(([address, wallet]) => {
      const normalizedAddress = address.toLowerCase();
      const profile = normalizeProfile(wallet.profile);
      return [normalizedAddress, {
        address: normalizedAddress,
        identity: normalizeIdentity(wallet.identity),
        profile,
        nftCrystalBalance: safeBoundedInteger(wallet.nftCrystalBalance, Number.MAX_SAFE_INTEGER),
        nftCrystalLedger: normalizeNftCrystalLedger(wallet.nftCrystalLedger, normalizedAddress),
        passProgress: normalizePassProgress(wallet.passProgress),
        passInventory: normalizePassInventory(wallet.passInventory),
        keybindings: safeKeybindings(wallet.keybindings),
        expansion: safePlayerExpansion(wallet.expansion),
        activity: normalizeActivity(wallet.activity),
        paidCompetitionEligibility: normalizePaidCompetitionEligibility(wallet.paidCompetitionEligibility),
        suspended: wallet.suspended === true,
        daily: normalizeDaily(wallet.daily),
        createdAt: safeTimestamp(wallet.createdAt),
        updatedAt: safeTimestamp(wallet.updatedAt)
      }];
    }));
}

function normalizePaidCompetitionEligibility(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(['arena', 'paid']
    .filter((mode) => {
      const value = input[mode];
      return isRecord(value) &&
        value.age18OrOlder === true &&
        value.locatedInJurisdiction === true &&
        value.notProhibited === true &&
        value.acceptedRules === true &&
        typeof value.rulesVersion === 'string' &&
        /^[a-fA-F0-9]{64}$/.test(value.rulesHash || '') &&
        /^[A-Z]{2}$/.test(value.jurisdiction || '') &&
        Number.isSafeInteger(value.acceptedAt) &&
        value.acceptedAt > 0;
    })
    .map((mode) => {
      const value = input[mode];
      return [mode, {
        age18OrOlder: true,
        locatedInJurisdiction: true,
        notProhibited: true,
        acceptedRules: true,
        rulesVersion: value.rulesVersion.slice(0, 120),
        rulesHash: value.rulesHash.toLowerCase(),
        jurisdiction: value.jurisdiction,
        acceptedAt: value.acceptedAt
      }];
    }));
}

function safeKeybindings(input) {
  try {
    return normalizeKeybindings(input);
  } catch {
    return defaultKeybindings();
  }
}

function safeExpansionConfig(input) {
  try {
    return normalizeExpansionConfig(input);
  } catch {
    return defaultExpansionConfig();
  }
}

function safePlayerExpansion(input) {
  try {
    return normalizePlayerExpansion(input);
  } catch {
    return defaultPlayerExpansion();
  }
}

function normalizeCompetitionStore(input, bucket) {
  const source = isRecord(input) ? input : {};
  const records = isRecord(source[bucket]) ? source[bucket] : {};
  return {
    [bucket]: Object.fromEntries(Object.entries(records)
      .filter(([key, value]) => key.length <= 40 && isRecord(value))
      .slice(-250)
      .map(([key, value]) => [key, structuredClone(value)]))
  };
}

function normalizeActivity(input) {
  if (!Array.isArray(input)) return [];
  return input.filter(isRecord).slice(-500).map((entry) => ({
    id: typeof entry.id === 'string' ? entry.id.slice(0, 100) : '',
    action: typeof entry.action === 'string' ? entry.action.slice(0, 80) : 'UNKNOWN',
    details: typeof entry.details === 'string' ? entry.details.slice(0, 500) : '',
    timestamp: safeTimestamp(entry.timestamp)
  }));
}

export function defaultNftV2Protocol() {
  return { mapVersions: {}, updatedAt: 0 };
}

function normalizeNftV2Protocol(input) {
  const source = isRecord(input) ? input : {};
  const mapVersions = isRecord(source.mapVersions) ? source.mapVersions : {};
  return {
    mapVersions: Object.fromEntries(['arena', 'paid']
      .filter((mode) => /^0x[a-fA-F0-9]{64}$/.test(String(mapVersions[mode] || '')))
      .map((mode) => [mode, String(mapVersions[mode]).toLowerCase()])),
    updatedAt: safeTimestamp(source.updatedAt)
  };
}

function normalizeNftCrystalLedger(input, walletAddress) {
  if (!Array.isArray(input)) return [];
  return input.filter(isRecord).slice(-10_000).map((entry) => ({
    id: typeof entry.id === 'string' ? entry.id.slice(0, 120) : '',
    walletAddress,
    runId: typeof entry.runId === 'string' ? entry.runId.slice(0, 120) : '',
    type: entry.type === 'REDEMPTION' ? 'REDEMPTION' : 'RUN_BANK',
    amount: safeBoundedInteger(entry.amount, Number.MAX_SAFE_INTEGER),
    balance: safeBoundedInteger(entry.balance, Number.MAX_SAFE_INTEGER),
    transactionHash: typeof entry.transactionHash === 'string' && /^0x[a-fA-F0-9]{64}$/.test(entry.transactionHash)
      ? entry.transactionHash.toLowerCase()
      : '',
    timestamp: safeTimestamp(entry.timestamp)
  }));
}

function defaultPassProgress() {
  return {
    xp: 0,
    updatedAt: 0
  };
}

function normalizePassProgress(input) {
  const source = isRecord(input) ? input : {};
  return {
    xp: safeBoundedInteger(source.xp, 1_000_000_000),
    updatedAt: safeTimestamp(source.updatedAt)
  };
}

function normalizePassInventory(input) {
  const source = isRecord(input) ? input : {};
  const defaults = defaultPassInventory();
  const cosmetics = Array.isArray(source.cosmetics)
    ? [...new Set(source.cosmetics.filter((id) => typeof id === 'string' && PASS_COSMETICS[id]))]
    : [];
  const equippedSource = isRecord(source.equipped) ? source.equipped : {};
  const equipped = Object.fromEntries(COSMETIC_SLOTS.map((slot) => {
    const cosmeticId = typeof equippedSource[slot] === 'string' ? equippedSource[slot] : '';
    const cosmetic = PASS_COSMETICS[cosmeticId];
    return [slot, cosmetic && cosmetic.slot === slot && cosmetics.includes(cosmeticId) ? cosmeticId : ''];
  }));
  const claimedLevels = Array.isArray(source.claimedLevels)
    ? [...new Set(source.claimedLevels
      .filter((level) => Number.isSafeInteger(level) && level >= 1 && level <= 8))]
      .sort((left, right) => left - right)
    : [];
  const chestSource = isRecord(source.chests?.[PASS_CHEST_ID])
    ? source.chests[PASS_CHEST_ID]
    : defaults.chests[PASS_CHEST_ID];
  return {
    claimedLevels,
    cosmetics,
    equipped,
    chests: {
      [PASS_CHEST_ID]: {
        available: safeBoundedInteger(chestSource.available, 100),
        opened: safeBoundedInteger(chestSource.opened, 100),
        lastOpenedAt: safeTimestamp(chestSource.lastOpenedAt)
      }
    }
  };
}

function normalizeDaily(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key, value]) => /^\d{4}-\d{2}-\d{2}$/.test(key) && isRecord(value))
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-45)
    .map(([key, value]) => [key, {
      freeRunUsed: value.freeRunUsed === true,
      freeRunId: typeof value.freeRunId === 'string' ? value.freeRunId.slice(0, 120) : ''
    }]));
}

function normalizeRecords(input, limit) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) => isRecord(value))
    .slice(-limit)
    .map(([key, value]) => [String(key).slice(0, 200), { ...value }]));
}

function normalizeRuns(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([, value]) => isRecord(value))
    .slice(-25_000)
    .map(([key, value]) => {
      const runId = String(key).slice(0, 200);
      // A knocked-out run waiting on a paid revive is still a live gameplay
      // record. Preserve its authoritative checkpoint, NFT lock, pending quote,
      // and any administrative termination reservation exactly as we do for an
      // active run. Treating it as archival data here silently discarded those
      // fields at every database transaction boundary.
      if (value.status === 'active' || value.status === 'awaiting-revive') {
        return [runId, { ...value }];
      }
      const nftSettlement = normalizeNftSettlementContext(value.nftSettlement)
        || normalizeNftSettlementContext(value.nftRun);
      const pendingRevive = normalizeArchivedPendingRevive(value.pendingRevive);
      return [runId, {
        id: String(value.id || runId).slice(0, 200),
        tokenHash: typeof value.tokenHash === 'string' ? value.tokenHash : '',
        address: typeof value.address === 'string' ? value.address.toLowerCase() : '',
        mode: typeof value.mode === 'string' ? value.mode : '',
        seed: typeof value.seed === 'string' ? value.seed : '',
        day: typeof value.day === 'string' ? value.day : '',
        week: typeof value.week === 'string' ? value.week : '',
        status: typeof value.status === 'string' ? value.status : '',
        startedAt: safeTimestamp(value.startedAt),
        expiresAt: safeTimestamp(value.expiresAt),
        finishedAt: safeTimestamp(value.finishedAt),
        passActiveAtStart: value.passActiveAtStart === true,
        passXpAwarded: safeBoundedInteger(value.passXpAwarded, 1_000_000),
        result: isRecord(value.result) ? { ...value.result } : null,
        characterId: typeof value.characterId === 'string' ? value.characterId.slice(0, 80) : 'matt',
        competitionSlotId: typeof value.competitionSlotId === 'string'
          ? value.competitionSlotId.slice(0, 80)
          : null,
        competitionSnapshot: typeof value.competitionSnapshot?.id === 'string'
          ? { id: value.competitionSnapshot.id.slice(0, 200) }
          : null,
        ...(nftSettlement ? { nftSettlement } : {}),
        ...(isRecord(value.pendingNftRun) ? { pendingNftRun: { ...value.pendingNftRun } } : {}),
        ...(pendingRevive ? { pendingRevive } : {}),
        adminTerminatedAt: safeTimestamp(value.adminTerminatedAt),
        adminTerminationReason: typeof value.adminTerminationReason === 'string'
          ? value.adminTerminationReason.slice(0, 500)
          : ''
      }];
    }));
}

function normalizeArchivedPendingRevive(input) {
  if (!isRecord(input)) return null;
  const status = String(input.status || '');
  if (!['pending', 'confirmed', 'cancelled'].includes(status)) return null;
  const transactionHash = String(input.transactionHash || '').toLowerCase();
  return {
    id: String(input.id || '').slice(0, 240),
    status,
    priceRonWei: /^\d+$/.test(String(input.priceRonWei || ''))
      ? String(input.priceRonWei)
      : '0',
    createdAt: safeTimestamp(input.createdAt),
    expiresAt: safeTimestamp(input.expiresAt),
    cancelledAt: safeTimestamp(input.cancelledAt),
    transactionBlockAt: safeTimestamp(input.transactionBlockAt),
    ...(/^0x[a-f0-9]{64}$/.test(transactionHash) ? { transactionHash } : {})
  };
}

function normalizeNftSettlementContext(input) {
  if (!isRecord(input)) return null;
  const minerId = Number(input.minerId);
  const runId = String(input.runId || '').toLowerCase();
  if (!Number.isSafeInteger(minerId) || minerId < 1 || minerId > 1_000) return null;
  if (!/^0x[a-f0-9]{64}$/.test(runId)) return null;
  const phaseXp = Array.isArray(input.phaseXp) && input.phaseXp.length === 5
    ? input.phaseXp.map(Number)
    : null;
  const validPhaseXp = phaseXp &&
    phaseXp.every((entry) => Number.isSafeInteger(entry) && entry > 0 && entry <= 250) &&
    phaseXp.reduce((total, entry) => total + entry, 0) <= 500;
  return {
    minerId,
    runId,
    ...(validPhaseXp ? { phaseXp } : {})
  };
}

function normalizeArenaPassXpAwards(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input)
    .filter(([runId, award]) =>
      /^arena_run_[a-f0-9]{24}$/.test(runId) &&
      isRecord(award) &&
      isHexAddress(award.address)
    )
    .slice(-25_000)
    .map(([runId, award]) => [runId, {
      address: award.address.toLowerCase(),
      xp: safeBoundedInteger(award.xp, 1_000),
      awardedAt: safeTimestamp(award.awardedAt)
    }]));
}

function migrateLegacyGameTuning(input, version) {
  const source = isRecord(input) ? structuredClone(input) : {};
  for (const lobby of ['practice', 'free', 'paid']) {
    const preset = isRecord(source[lobby]) ? source[lobby] : {};
    const blasterDamage = Number(preset.blasterDamageMultiplier);
    const bossHealth = Number(preset.bossHealthMultiplier);
    source[lobby] = {
      ...preset,
      ...(Number(version) < 9 && (!Number.isFinite(blasterDamage) || Math.abs(blasterDamage - .56) < .000001)
        ? { blasterDamageMultiplier: .60 }
        : {}),
      ...(Number(version) < 11 && (!Number.isFinite(bossHealth) || Math.abs(bossHealth - 1) < .000001)
        ? { bossHealthMultiplier: 2.25 }
        : {})
    };
  }
  return source;
}

function safeTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeBoundedInteger(value, max) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, max) : 0;
}

function safeInteger(value, fallback = 0, allowNegative = false) {
  if (!Number.isSafeInteger(value)) return fallback;
  if (!allowNegative && value < 0) return fallback;
  return value;
}

function safeUnsignedString(value) {
  return typeof value === 'string' && /^\d+$/.test(value) ? value : '0';
}

function normalizeTransactionHash(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(normalized) ? normalized : '';
}

function isHexAddress(value) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
