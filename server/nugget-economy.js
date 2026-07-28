import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const NUGGET_ECONOMY_VERSION = 1;
export const NUGGET_QUOTE_TTL_MS = 5 * 60 * 1000;
export const NUGGET_DAILY_PURCHASE_CAP = 1_000_000;
export const NUGGET_PURCHASE_HISTORY_LIMIT = 25_000;
export const MATT_TOKEN_ADDRESS = '0xa5450417bdca0bdfb058ffe41205400ffda1174d';
export const DEFAULT_TREASURY_ADDRESS = '0xbace355d23d378a6e1add986e53a18dd12e6eeac';

const FIVE_THOUSAND_MATT_RAW = '5000000000000000000000';

export function defaultNuggetEconomyConfig() {
  return {
    purchasesEnabled: false,
    practiceClaimsEnabled: false,
    advertisementRewardsEnabled: false,
    nuggetsPerMatt: 200,
    displayedUsdPerMillion: 5,
    dailyPurchaseCap: NUGGET_DAILY_PURCHASE_CAP,
    quoteTtlMs: NUGGET_QUOTE_TTL_MS,
    recipient: DEFAULT_TREASURY_ADDRESS,
    mattTokenAddress: MATT_TOKEN_ADDRESS,
    allowedAssets: {
      MATT: true,
      RON: false
    },
    practiceClaim: {
      asset: 'MATT',
      amountAtomic: FIVE_THOUSAND_MATT_RAW
    },
    packages: [
      {
        id: 'nuggets-1m',
        name: '1,000,000 Nuggets',
        nuggets: 1_000_000,
        displayedUsd: 5,
        enabled: true,
        prices: {
          MATT: FIVE_THOUSAND_MATT_RAW,
          RON: '0'
        }
      }
    ],
    characterUnlockPrices: {
      ronke: 400_000,
      adlDyno: 0,
      axie: 550_000,
      orc: 700_000
    },
    updatedAt: 0,
    updatedBy: ''
  };
}

export function defaultNuggetEconomyState() {
  return {
    version: NUGGET_ECONOMY_VERSION,
    config: defaultNuggetEconomyConfig(),
    quotes: {},
    purchases: {},
    usedTransactions: {},
    audit: []
  };
}

export function normalizeNuggetEconomyState(input = {}, now = Date.now()) {
  const source = isRecord(input) ? input : {};
  const state = {
    version: NUGGET_ECONOMY_VERSION,
    config: normalizeNuggetEconomyConfig(source.config),
    quotes: normalizeQuotes(source.quotes, now),
    purchases: normalizePurchases(source.purchases),
    usedTransactions: normalizeUsedTransactions(source.usedTransactions),
    audit: Array.isArray(source.audit)
      ? source.audit.filter(isRecord).slice(-2_000).map((entry) => ({
          id: safeText(entry.id, 120),
          actor: safeText(entry.actor, 100),
          action: safeText(entry.action, 100),
          details: safeText(entry.details, 500),
          timestamp: safeTimestamp(entry.timestamp)
        }))
      : []
  };
  for (const [id, quote] of Object.entries(state.quotes)) {
    if (quote.status === 'pending' && quote.expiresAt <= now) {
      state.quotes[id] = { ...quote, status: 'expired' };
    }
  }
  return state;
}

export function normalizeNuggetEconomyConfig(input = {}) {
  const source = isRecord(input) ? input : {};
  const defaults = defaultNuggetEconomyConfig();
  const allowedAssets = isRecord(source.allowedAssets) ? source.allowedAssets : {};
  const practiceClaim = isRecord(source.practiceClaim) ? source.practiceClaim : {};
  const characterUnlockPrices = isRecord(source.characterUnlockPrices) ? source.characterUnlockPrices : {};
  const packages = Array.isArray(source.packages) ? source.packages : defaults.packages;
  return {
    purchasesEnabled: source.purchasesEnabled === true,
    practiceClaimsEnabled: source.practiceClaimsEnabled === true,
    advertisementRewardsEnabled: source.advertisementRewardsEnabled === true,
    nuggetsPerMatt: boundedNumber(source.nuggetsPerMatt, defaults.nuggetsPerMatt, 0.000001, 1_000_000_000),
    displayedUsdPerMillion: boundedNumber(source.displayedUsdPerMillion, defaults.displayedUsdPerMillion, 0, 1_000_000),
    dailyPurchaseCap: boundedInteger(source.dailyPurchaseCap, defaults.dailyPurchaseCap, 0, 1_000_000_000),
    quoteTtlMs: boundedInteger(source.quoteTtlMs, defaults.quoteTtlMs, 30_000, 30 * 60 * 1000),
    recipient: normalizeAddress(source.recipient) || defaults.recipient,
    mattTokenAddress: normalizeAddress(source.mattTokenAddress) || defaults.mattTokenAddress,
    allowedAssets: {
      MATT: allowedAssets.MATT !== false,
      RON: allowedAssets.RON === true
    },
    practiceClaim: {
      asset: normalizeAsset(practiceClaim.asset) || defaults.practiceClaim.asset,
      amountAtomic: normalizeUnsignedAtomic(practiceClaim.amountAtomic, defaults.practiceClaim.amountAtomic)
    },
    packages: normalizePackages(packages, defaults.packages),
    characterUnlockPrices: {
      ronke: boundedInteger(characterUnlockPrices.ronke, 0, 0, 1_000_000_000),
      adlDyno: boundedInteger(characterUnlockPrices.adlDyno, 0, 0, 1_000_000_000),
      axie: boundedInteger(characterUnlockPrices.axie, 0, 0, 1_000_000_000),
      orc: boundedInteger(characterUnlockPrices.orc, 0, 0, 1_000_000_000)
    },
    updatedAt: safeTimestamp(source.updatedAt),
    updatedBy: safeText(source.updatedBy, 100)
  };
}

export function mergeNuggetEconomyConfig(current, patch, actor, timestamp = Date.now()) {
  if (!isRecord(patch)) throw new Error('Nugget economy changes must be an object.');
  const allowed = new Set([
    'purchasesEnabled',
    'practiceClaimsEnabled',
    'advertisementRewardsEnabled',
    'nuggetsPerMatt',
    'mattPerNugget',
    'displayedUsdPerMillion',
    'dailyPurchaseCap',
    'quoteTtlMs',
    'recipient',
    'mattTokenAddress',
    'allowedAssets',
    'practiceClaim',
    'packages',
    'characterUnlockPrices'
  ]);
  for (const key of Object.keys(patch)) {
    if (!allowed.has(key)) throw new Error(`Unknown nugget economy setting: ${key}`);
  }
  const source = structuredClone(current || defaultNuggetEconomyConfig());
  const nextPatch = structuredClone(patch);
  if (Object.hasOwn(nextPatch, 'mattPerNugget')) {
    const mattPerNugget = Number(nextPatch.mattPerNugget);
    if (!Number.isFinite(mattPerNugget) || mattPerNugget <= 0) {
      throw new Error('MATT per nugget must be greater than zero.');
    }
    nextPatch.nuggetsPerMatt = 1 / mattPerNugget;
    delete nextPatch.mattPerNugget;
  }
  const merged = {
    ...source,
    ...nextPatch,
    allowedAssets: {
      ...source.allowedAssets,
      ...(isRecord(nextPatch.allowedAssets) ? nextPatch.allowedAssets : {})
    },
    practiceClaim: {
      ...source.practiceClaim,
      ...(isRecord(nextPatch.practiceClaim) ? nextPatch.practiceClaim : {})
    },
    characterUnlockPrices: {
      ...source.characterUnlockPrices,
      ...(isRecord(nextPatch.characterUnlockPrices) ? nextPatch.characterUnlockPrices : {})
    },
    packages: Object.hasOwn(nextPatch, 'packages') ? nextPatch.packages : source.packages,
    updatedAt: timestamp,
    updatedBy: safeText(actor, 100)
  };
  const normalized = normalizeNuggetEconomyConfig(merged);
  validateLiveConfiguration(normalized);
  return normalized;
}

export function publicNuggetEconomyConfig(config) {
  const normalized = normalizeNuggetEconomyConfig(config);
  return {
    purchasesEnabled: normalized.purchasesEnabled,
    practiceClaimsEnabled: normalized.practiceClaimsEnabled,
    advertisementRewardsEnabled: normalized.advertisementRewardsEnabled,
    nuggetsPerMatt: normalized.nuggetsPerMatt,
    mattPerNugget: normalized.nuggetsPerMatt > 0 ? 1 / normalized.nuggetsPerMatt : 0,
    displayedUsdPerMillion: normalized.displayedUsdPerMillion,
    dailyPurchaseCap: normalized.dailyPurchaseCap,
    quoteTtlMs: normalized.quoteTtlMs,
    allowedAssets: { ...normalized.allowedAssets },
    practiceClaim: { ...normalized.practiceClaim },
    packages: normalized.packages.map((entry) => structuredClone(entry)),
    characterUnlockPrices: { ...normalized.characterUnlockPrices },
    updatedAt: normalized.updatedAt
  };
}

export function utcDayKeyFromTimestamp(timestamp = Date.now()) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function purchasedNuggetsForDay(purchases, address, day) {
  return Object.values(purchases || {}).reduce((sum, purchase) => {
    if (
      purchase.status === 'confirmed' &&
      purchase.address === address &&
      purchase.day === day
    ) return sum + purchase.nuggets;
    return sum;
  }, 0);
}

export function recentPurchasesForWallet(purchases, address, limit = 50) {
  return Object.values(purchases || {})
    .filter((entry) => entry.address === address)
    .sort((left, right) => right.confirmedAt - left.confirmedAt)
    .slice(0, limit)
    .map((entry) => structuredClone(entry));
}

export function addEconomyAudit(state, actor, action, details, timestamp = Date.now()) {
  state.audit ||= [];
  state.audit.push({
    id: `economy-audit-${timestamp}-${state.audit.length + 1}`,
    actor: safeText(actor, 100),
    action: safeText(action, 100),
    details: safeText(details, 500),
    timestamp
  });
  state.audit = state.audit.slice(-2_000);
}

export class MemoryNuggetEconomyStore {
  constructor(initialState = defaultNuggetEconomyState(), options = {}) {
    this.kind = 'memory';
    this.now = options.now || Date.now;
    this.state = normalizeNuggetEconomyState(initialState, this.now());
    this.queue = Promise.resolve();
  }

  setClock(now) {
    if (typeof now === 'function') this.now = now;
  }

  async init() {
    return this;
  }

  async read() {
    await this.queue;
    return structuredClone(this.state);
  }

  async transact(mutator) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      this.state = normalizeNuggetEconomyState(draft, this.now());
      await this.persist();
      return structuredClone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persist() {}
  async close() {}
}

export class JsonNuggetEconomyStore extends MemoryNuggetEconomyStore {
  constructor(filePath, options = {}) {
    super(options.initialState, options);
    this.kind = 'json-file';
    this.filePath = filePath;
    this.now = options.now || Date.now;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      this.state = normalizeNuggetEconomyState(JSON.parse(await readFile(this.filePath, 'utf8')), this.now());
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await rename(this.filePath, `${this.filePath}.corrupt-${this.now()}`).catch(() => undefined);
      }
      this.state = defaultNuggetEconomyState();
      await this.persist();
    }
    this.initialized = true;
    return this;
  }

  async read() {
    await this.init();
    return super.read();
  }

  async transact(mutator) {
    await this.init();
    return super.transact(mutator);
  }

  async persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class PostgresNuggetEconomyStore {
  constructor(database, options = {}) {
    if (!database?.pool) throw new TypeError('The PostgreSQL nugget economy store requires the main database pool.');
    this.kind = 'postgresql';
    this.pool = database.pool;
    this.now = options.now || Date.now;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matt_mine_nugget_economy (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `INSERT INTO matt_mine_nugget_economy (id, data)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(defaultNuggetEconomyState())]
    );
    this.initialized = true;
    return this;
  }

  async read() {
    await this.init();
    const result = await this.pool.query('SELECT data FROM matt_mine_nugget_economy WHERE id = 1');
    return normalizeNuggetEconomyState(parseJson(result.rows[0]?.data), this.now());
  }

  async transact(mutator) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT data FROM matt_mine_nugget_economy WHERE id = 1 FOR UPDATE');
      const draft = normalizeNuggetEconomyState(parseJson(selected.rows[0]?.data), this.now());
      const result = await mutator(draft);
      const normalized = normalizeNuggetEconomyState(draft, this.now());
      await client.query(
        `UPDATE matt_mine_nugget_economy
         SET data = $1::jsonb, updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify(normalized)]
      );
      await client.query('COMMIT');
      return structuredClone(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {}
}

function normalizePackages(input, fallback) {
  const source = Array.isArray(input) ? input : fallback;
  const seen = new Set();
  const packages = [];
  for (const raw of source.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const id = safeText(raw.id, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,59}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const prices = isRecord(raw.prices) ? raw.prices : {};
    packages.push({
      id,
      name: safeText(raw.name, 80) || id,
      nuggets: boundedInteger(raw.nuggets, 0, 1, 1_000_000_000),
      displayedUsd: boundedNumber(raw.displayedUsd, 0, 0, 1_000_000),
      enabled: raw.enabled !== false,
      prices: {
        MATT: normalizeUnsignedAtomic(prices.MATT, '0'),
        RON: normalizeUnsignedAtomic(prices.RON, '0')
      }
    });
  }
  if (!packages.length) return normalizePackages(fallback, []);
  return packages;
}

function normalizeQuotes(input, now) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input).slice(-5_000).flatMap(([key, raw]) => {
    if (!isRecord(raw)) return [];
    const id = safeText(raw.id || key, 120);
    const address = normalizeAddress(raw.address);
    const asset = normalizeAsset(raw.asset);
    const purpose = ['purchase', 'practice'].includes(raw.purpose) ? raw.purpose : '';
    if (!id || !address || !asset || !purpose) return [];
    const createdAt = safeTimestamp(raw.createdAt);
    const expiresAt = safeTimestamp(raw.expiresAt);
    const status = ['pending', 'verifying', 'confirmed', 'failed', 'expired'].includes(raw.status)
      ? raw.status
      : expiresAt <= now ? 'expired' : 'pending';
    return [[id, {
      id,
      address,
      purpose,
      packageId: safeText(raw.packageId, 60),
      runId: safeText(raw.runId, 120),
      nuggets: boundedInteger(raw.nuggets, 0, 0, 1_000_000_000),
      asset,
      amountAtomic: normalizeUnsignedAtomic(raw.amountAtomic, '0'),
      recipient: normalizeAddress(raw.recipient),
      mattTokenAddress: normalizeAddress(raw.mattTokenAddress) || MATT_TOKEN_ADDRESS,
      day: /^\d{4}-\d{2}-\d{2}$/.test(raw.day || '') ? raw.day : utcDayKeyFromTimestamp(createdAt),
      createdAt,
      expiresAt,
      status,
      transactionHash: normalizeTransactionHash(raw.transactionHash),
      failureCode: safeText(raw.failureCode, 100)
    }]];
  }));
}

function normalizePurchases(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input).slice(-NUGGET_PURCHASE_HISTORY_LIMIT).flatMap(([key, raw]) => {
    if (!isRecord(raw)) return [];
    const id = safeText(raw.id || key, 120);
    const address = normalizeAddress(raw.address);
    const transactionHash = normalizeTransactionHash(raw.transactionHash);
    if (!id || !address || !transactionHash) return [];
    return [[id, {
      id,
      quoteId: safeText(raw.quoteId, 120),
      address,
      packageId: safeText(raw.packageId, 60),
      nuggets: boundedInteger(raw.nuggets, 0, 0, 1_000_000_000),
      asset: normalizeAsset(raw.asset) || 'MATT',
      amountAtomic: normalizeUnsignedAtomic(raw.amountAtomic, '0'),
      transactionHash,
      blockNumber: normalizeUnsignedAtomic(raw.blockNumber, '0'),
      day: /^\d{4}-\d{2}-\d{2}$/.test(raw.day || '') ? raw.day : utcDayKeyFromTimestamp(raw.confirmedAt),
      status: raw.status === 'confirmed' ? 'confirmed' : 'failed',
      confirmedAt: safeTimestamp(raw.confirmedAt)
    }]];
  }));
}

function normalizeUsedTransactions(input) {
  if (!isRecord(input)) return {};
  return Object.fromEntries(Object.entries(input).slice(-NUGGET_PURCHASE_HISTORY_LIMIT).flatMap(([hash, raw]) => {
    const normalizedHash = normalizeTransactionHash(hash);
    if (!normalizedHash || !isRecord(raw)) return [];
    return [[normalizedHash, {
      quoteId: safeText(raw.quoteId, 120),
      address: normalizeAddress(raw.address),
      purpose: ['purchase', 'practice'].includes(raw.purpose) ? raw.purpose : '',
      reservedAt: safeTimestamp(raw.reservedAt),
      confirmedAt: safeTimestamp(raw.confirmedAt)
    }]];
  }));
}

function validateLiveConfiguration(config) {
  if (!config.purchasesEnabled && !config.practiceClaimsEnabled) return;
  if (!normalizeAddress(config.recipient)) throw new Error('A valid Ronin payment recipient is required before enabling payments.');
  if (!config.allowedAssets.MATT && !config.allowedAssets.RON) {
    throw new Error('Enable at least one exact payment asset before enabling nugget payments.');
  }
  if (config.practiceClaimsEnabled) {
    if (!config.allowedAssets[config.practiceClaim.asset]) throw new Error('The Practice claim payment asset is disabled.');
    if (BigInt(config.practiceClaim.amountAtomic) <= 0n) throw new Error('Practice claim price must be greater than zero.');
  }
  if (config.purchasesEnabled) {
    const purchasable = config.packages.some((entry) =>
      entry.enabled && Object.entries(entry.prices).some(([asset, value]) => config.allowedAssets[asset] && BigInt(value) > 0n)
    );
    if (!purchasable) throw new Error('At least one enabled package needs a positive price in an enabled asset.');
  }
}

function normalizeAsset(value) {
  const asset = String(value || '').toUpperCase();
  return asset === 'MATT' || asset === 'RON' ? asset : '';
}

function normalizeAddress(value) {
  const address = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{40}$/.test(address) ? address : '';
}

function normalizeTransactionHash(value) {
  const hash = String(value || '').toLowerCase();
  return /^0x[a-f0-9]{64}$/.test(hash) ? hash : '';
}

function normalizeUnsignedAtomic(value, fallback = '0') {
  const text = String(value ?? '');
  return /^\d+$/.test(text) ? text.replace(/^0+(?=\d)/, '') : fallback;
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function safeTimestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}
