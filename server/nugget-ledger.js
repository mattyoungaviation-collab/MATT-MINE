const LEDGER_ID_PREFIX = 'ledger';
const MIGRATION_ID_PREFIX = 'migration';
const MAX_ID_LENGTH = 120;
const MAX_DETAILS_LENGTH = 500;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

// Retained as a compatibility export. Production ledgers are no longer truncated.
export const NUGGET_LEDGER_LIMIT = Number.MAX_SAFE_INTEGER;

export const NUGGET_LEDGER_TYPES = Object.freeze({
  RUN_EXTRACTION: 'RUN_EXTRACTION',
  RUN_DEATH_RETENTION: 'RUN_DEATH_RETENTION',
  PRACTICE_CLAIM: 'PRACTICE_CLAIM',
  CHEST_REWARD: 'CHEST_REWARD',
  ADMIN_ADJUSTMENT: 'ADMIN_ADJUSTMENT',
  NUGGET_PURCHASE: 'NUGGET_PURCHASE',
  ADVERTISEMENT_BONUS: 'ADVERTISEMENT_BONUS',
  PASS_REWARD: 'PASS_REWARD',
  CHARACTER_PURCHASE: 'CHARACTER_PURCHASE',
  MIGRATION: 'MIGRATION'
});

const DIRECTION = Object.freeze({
  CREDIT: 'credit',
  DEBIT: 'debit'
});

const DIRECTION_SIGN = Object.freeze({
  [DIRECTION.CREDIT]: 1,
  [DIRECTION.DEBIT]: -1
});

const KNOWN_TYPES = new Set(Object.values(NUGGET_LEDGER_TYPES));

export function normalizeNuggetLedger(rawLedger, walletAddress = '', defaultTimestamp = Date.now()) {
  const source = Array.isArray(rawLedger) ? rawLedger : [];
  const normalizedAddress = normalizeWalletAddress(walletAddress);
  const safeDefaultTs = safeTimestamp(defaultTimestamp);

  const ledger = source
    .filter(isRecord)
    .map((entry) => normalizeLedgerEntry(entry, normalizedAddress, safeDefaultTs))
    .filter(Boolean);

  return dedupeByIdOrCompositeKey(ledger);
}

export function nuggetBalanceFromLedger(ledger = []) {
  let balance = 0;
  for (const entry of normalizeNuggetLedger(ledger)) {
    balance = applyDirection(entry.direction, balance, entry.amount);
  }
  return Number.isSafeInteger(balance) ? balance : 0;
}

export function hasLedgerIdempotencyConflict(ledger = [], idempotencyKey = '') {
  const normalizedKey = sanitizeIdempotencyKey(idempotencyKey);
  if (!normalizedKey) return false;
  for (const entry of normalizeNuggetLedger(ledger)) {
    if (entry.idempotencyKey === normalizedKey) return true;
  }
  return false;
}

export function findLedgerEntryByIdempotency(ledger = [], idempotencyKey = '') {
  const normalizedKey = sanitizeIdempotencyKey(idempotencyKey);
  if (!normalizedKey) return null;
  const normalized = normalizeNuggetLedger(ledger);
  return normalized.find((entry) => entry.idempotencyKey === normalizedKey) || null;
}

export function applyNuggetLedgerDelta(wallet, amount, options = {}) {
  if (!wallet || typeof wallet !== 'object') {
    throw new Error('A wallet is required for nugget ledger updates.');
  }

  const rawType = options.type;
  const type = normalizeLedgerType(rawType);
  if (!type) {
    throw new Error('ledger_type_required_or_invalid');
  }

  const signedAmount = safeInteger(amount, 0, true);
  const previousBalance = currentWalletBalance(wallet);
  const timestamp = safeTimestamp(options.timestamp, Date.now());
  const runId = sanitizeText(options.runId);
  const transactionHash = normalizeTransactionHash(options.transactionHash);
  const adminActor = sanitizeText(options.adminActor);
  const details = sanitizeText(options.details, MAX_DETAILS_LENGTH);
  const idempotencyKey = sanitizeIdempotencyKey(options.idempotencyKey);

  wallet.nuggetLedger = normalizeNuggetLedger(wallet.nuggetLedger || [], wallet.address, timestamp);
  const duplicateEntry = idempotencyKey
    ? findLedgerEntryByIdempotency(wallet.nuggetLedger, idempotencyKey)
    : null;

  if (duplicateEntry) {
    return {
      entry: duplicateEntry,
      duplicate: true,
      skipped: true,
      previousBalance,
      newBalance: duplicateEntry.newBalance
    };
  }

  if (signedAmount === 0) {
    return {
      entry: null,
      duplicate: false,
      skipped: true,
      previousBalance,
      newBalance: previousBalance
    };
  }

  const newBalance = applyDirection(signedAmount > 0 ? DIRECTION.CREDIT : DIRECTION.DEBIT, previousBalance, Math.abs(signedAmount));
  if (newBalance < 0) {
    throw new Error('Nugget ledger balance cannot become negative.');
  }

  const entry = {
    id: makeLedgerEntryId(wallet.nuggetLedger.length, timestamp, type),
    walletAddress: normalizeWalletAddress(wallet.address || ''),
    direction: signedAmount > 0 ? DIRECTION.CREDIT : DIRECTION.DEBIT,
    type,
    amount: Math.abs(signedAmount),
    previousBalance,
    newBalance,
    runId,
    transactionHash,
    idempotencyKey,
    adminActor,
    details,
    timestamp
  };

  wallet.nuggetLedger.push(entry);
  wallet.profile ||= {};
  wallet.profile.bankedNuggets = newBalance;

  return {
    entry,
    duplicate: false,
    skipped: false,
    previousBalance,
    newBalance
  };
}

export function setNuggetLedgerBalance(wallet, nextBalance, options = {}) {
  const target = safeInteger(nextBalance, 0, true);
  const current = currentWalletBalance(wallet);
  if (target === current) {
    return {
      entry: null,
      duplicate: false,
      skipped: true,
      previousBalance: current,
      newBalance: target
    };
  }
  const delta = target - current;
  return applyNuggetLedgerDelta(wallet, delta, {
    ...options,
    type: options.type
  });
}

export function normalizeMigrationWalletState(walletAddress, profileBalance, rawLedger, timestamp = Date.now()) {
  const normalizedAddress = normalizeWalletAddress(walletAddress);
  const safeTimestampValue = safeTimestamp(timestamp);
  const ledger = normalizeNuggetLedger(rawLedger, normalizedAddress, safeTimestampValue);
  const profileBalanceNormalized = safeInteger(profileBalance, 0, true);
  const ledgerBalance = nuggetBalanceFromLedger(ledger);

  if (!ledger.some((entry) => entry.type === NUGGET_LEDGER_TYPES.MIGRATION)) {
    if (ledger.length === 0 && profileBalanceNormalized > 0) {
      const migrationEntry = {
        id: `${MIGRATION_ID_PREFIX}-${safeTimestampValue}-${normalizedAddress}`,
        walletAddress: normalizedAddress,
        direction: DIRECTION.CREDIT,
        type: NUGGET_LEDGER_TYPES.MIGRATION,
        amount: profileBalanceNormalized,
        previousBalance: 0,
        newBalance: profileBalanceNormalized,
        runId: '',
        transactionHash: '',
        idempotencyKey: `migration-${normalizedAddress}`,
        adminActor: 'SYSTEM_MIGRATION',
        details: 'Migrated legacy nugget balance',
        timestamp: safeTimestampValue
      };
      return {
        ledger: [migrationEntry],
        balance: profileBalanceNormalized,
        migrated: true
      };
    }

    if (ledger.length > 0 && ledgerBalance !== profileBalanceNormalized) {
      return {
        ledger,
        balance: ledgerBalance,
        migrated: false,
        warning: 'wallet_profile_and_ledger_balance_mismatch'
      };
    }
  }

  return {
    ledger,
    balance: ledgerBalance,
    migrated: false
  };
}

export function clearAllNuggetBalanceForMigrationReset(wallet, reason = 'Administrative balance reset') {
  return applyNuggetLedgerDelta(wallet, -currentWalletBalance(wallet), {
    type: NUGGET_LEDGER_TYPES.ADMIN_ADJUSTMENT,
    adminActor: 'SYSTEM_ADMIN',
    details: String(reason).slice(0, MAX_DETAILS_LENGTH),
    idempotencyKey: `migration-reset-${safeTimestamp(Date.now())}-${normalizeWalletAddress(wallet.address || '')}`
  });
}

export function validateNuggetLedgerType(value) {
  return KNOWN_TYPES.has(value) ? value : '';
}

function normalizeLedgerEntry(input, normalizedAddress, defaultTimestamp) {
  if (!isRecord(input)) return null;

  const type = normalizeLedgerType(input.type);
  if (!type) return null;
  const amount = safeInteger(input.amount, 0, true);
  if (amount <= 0) return null;
  const direction = normalizeDirection(input.direction);
  if (!direction) return null;

  const id = sanitizeText(input.id);
  if (!id) return null;

  const timestamp = safeTimestamp(input.timestamp, defaultTimestamp);
  const previousBalance = safeInteger(input.previousBalance, 0, true);
  const newBalance = safeInteger(input.newBalance, 0, true);
  const walletAddress = normalizeWalletAddress(input.walletAddress) || normalizedAddress;

  return {
    id: id.slice(0, MAX_ID_LENGTH),
    walletAddress,
    direction,
    type,
    amount,
    previousBalance,
    newBalance,
    runId: sanitizeText(input.runId),
    transactionHash: normalizeTransactionHash(input.transactionHash),
    idempotencyKey: sanitizeIdempotencyKey(input.idempotencyKey),
    adminActor: sanitizeText(input.adminActor),
    details: sanitizeText(input.details, MAX_DETAILS_LENGTH),
    timestamp
  };
}

function makeLedgerEntryId(length, timestamp, type) {
  const safeType = sanitizeText(type);
  const suffix = String(length + 1).padStart(6, '0');
  return `${LEDGER_ID_PREFIX}-${safeType}-${timestamp}-${suffix}`.slice(0, MAX_ID_LENGTH);
}

function normalizeDirection(input) {
  return input === DIRECTION.DEBIT ? DIRECTION.DEBIT : DIRECTION.CREDIT;
}

function normalizeLedgerType(value) {
  const maybeType = sanitizeText(value);
  return KNOWN_TYPES.has(maybeType) ? maybeType : '';
}

function currentWalletBalance(wallet) {
  if (!wallet) return 0;
  if (Array.isArray(wallet.nuggetLedger) && wallet.nuggetLedger.length > 0) {
    return safeInteger(wallet.nuggetLedger.at(-1)?.newBalance, 0, true);
  }
  if (wallet.profile && Number.isSafeInteger(wallet.profile.bankedNuggets)) {
    return Math.max(0, wallet.profile.bankedNuggets);
  }
  return 0;
}

function applyDirection(direction, balance, amount) {
  if (direction === DIRECTION.DEBIT) {
    return balance - amount;
  }
  return balance + amount;
}

function dedupeByIdOrCompositeKey(ledger) {
  const seen = new Set();
  const normalized = [];
  for (const entry of ledger) {
    const key = [
      entry.id,
      entry.walletAddress,
      entry.type,
      entry.direction,
      entry.amount,
      entry.timestamp,
      entry.runId,
      entry.transactionHash,
      entry.idempotencyKey
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(entry);
  }
  return normalized;
}

function normalizeWalletAddress(value) {
  const address = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : '';
}

function normalizeTransactionHash(value) {
  const hash = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function sanitizeIdempotencyKey(value) {
  const text = sanitizeText(value);
  return text.length <= MAX_IDEMPOTENCY_KEY_LENGTH ? text : text.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

function sanitizeText(value, max = 100) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max);
}

function safeInteger(value, fallback, allowNegative = false) {
  if (Number.isSafeInteger(value)) {
    if (!allowNegative && value < 0) return fallback;
    return value;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (!allowNegative && parsed < 0) return fallback;
  const integer = Math.floor(parsed);
  if (!Number.isSafeInteger(integer)) return fallback;
  return integer;
}

function safeTimestamp(value, fallback = Date.now()) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
