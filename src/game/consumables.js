export const MATT_CRYSTAL_TOKEN_ADDRESS = '0x2D2034e55900D285dc05d30a0c14846D7a30285B';
export const CONSUMABLE_TREASURY_ADDRESS = '0xF79913cB83Cc9CABD95D0ba9250103fbb939f984';
export const CONSUMABLE_PRICE_CRYSTALS = 500_000;
export const CONSUMABLE_MAX_PURCHASE_QUANTITY = 10;
export const CONSUMABLE_MAX_WALLET_QUANTITY = Number.MAX_SAFE_INTEGER;
export const CONSUMABLE_MAX_LOADOUT_SIZE = 3;

export const CONSUMABLE_IDS = Object.freeze({
  MEDIC_PACK: 'medic-pack',
  MYTHICAL_FORCE_FIELD: 'mythical-force-field',
  HEAVY_CRYSTAL_HAULER: 'heavy-crystal-hauler'
});

export const CONSUMABLE_DEFINITIONS = Object.freeze({
  [CONSUMABLE_IDS.MEDIC_PACK]: Object.freeze({
    id: CONSUMABLE_IDS.MEDIC_PACK,
    name: 'MEDIC PACK',
    shortName: 'MEDIC PACK',
    description: 'Restores 25 HP after the Miner has taken health-bar damage. Using it consumes the charge.',
    defaultKey: 'Digit4',
    activation: 'manual',
    effect: Object.freeze({ healHp: 25 })
  }),
  [CONSUMABLE_IDS.MYTHICAL_FORCE_FIELD]: Object.freeze({
    id: CONSUMABLE_IDS.MYTHICAL_FORCE_FIELD,
    name: "MATT'S MYTHICAL FORCE FIELD",
    shortName: 'FORCE FIELD',
    description: 'Blocks all incoming damage for three seconds with a visible countdown.',
    defaultKey: 'Digit5',
    activation: 'manual',
    effect: Object.freeze({ invulnerabilitySeconds: 3 })
  }),
  [CONSUMABLE_IDS.HEAVY_CRYSTAL_HAULER]: Object.freeze({
    id: CONSUMABLE_IDS.HEAVY_CRYSTAL_HAULER,
    name: 'HEAVY CRYSTAL HAULER',
    shortName: 'HEAVY HAULER',
    description: 'Activates at run start. Each mined Crystal becomes five carried units and uses five units of capacity.',
    defaultKey: '',
    activation: 'run-start',
    effect: Object.freeze({ minedCrystalMultiplier: 5 })
  })
});

export const CONSUMABLE_ID_LIST = Object.freeze(Object.keys(CONSUMABLE_DEFINITIONS));

export function defaultConsumablesEconomy() {
  return {
    version: 1,
    purchasesPaused: false,
    maximumPurchaseQuantity: CONSUMABLE_MAX_PURCHASE_QUANTITY,
    maximumLoadoutSize: CONSUMABLE_MAX_LOADOUT_SIZE,
    treasuryBps: 10_000,
    items: Object.fromEntries(CONSUMABLE_ID_LIST.map((id) => [id, {
      enabled: true,
      priceCrystals: CONSUMABLE_PRICE_CRYSTALS,
      maximumPerRun: 1
    }])),
    updatedAt: 0,
    updatedBy: ''
  };
}

export function normalizeConsumablesEconomy(input = {}) {
  const defaults = defaultConsumablesEconomy();
  const source = record(input);
  const itemSource = record(source.items);
  return {
    version: boundedInteger(source.version, 1, 1_000_000_000, defaults.version),
    purchasesPaused: source.purchasesPaused === true,
    maximumPurchaseQuantity: boundedInteger(
      source.maximumPurchaseQuantity,
      1,
      CONSUMABLE_MAX_PURCHASE_QUANTITY,
      defaults.maximumPurchaseQuantity
    ),
    maximumLoadoutSize: boundedInteger(
      source.maximumLoadoutSize,
      1,
      CONSUMABLE_MAX_LOADOUT_SIZE,
      defaults.maximumLoadoutSize
    ),
    treasuryBps: 10_000,
    items: Object.fromEntries(CONSUMABLE_ID_LIST.map((id) => {
      const item = record(itemSource[id]);
      return [id, {
        enabled: item.enabled !== false,
        priceCrystals: boundedInteger(item.priceCrystals, 1, 1_000_000_000, defaults.items[id].priceCrystals),
        maximumPerRun: boundedInteger(item.maximumPerRun, 0, CONSUMABLE_MAX_LOADOUT_SIZE, defaults.items[id].maximumPerRun)
      }];
    })),
    updatedAt: timestamp(source.updatedAt),
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 100) : ''
  };
}

export function defaultWalletConsumables() {
  return {
    inventory: emptyConsumableCounts(),
    selected: emptyConsumableCounts(),
    lifetimePurchased: emptyConsumableCounts(),
    lifetimeGranted: emptyConsumableCounts(),
    lifetimeConsumed: emptyConsumableCounts(),
    updatedAt: 0
  };
}

export function normalizeWalletConsumables(input = {}) {
  const source = record(input);
  return {
    inventory: normalizeConsumableCounts(source.inventory),
    selected: normalizeConsumableCounts(source.selected, CONSUMABLE_MAX_LOADOUT_SIZE),
    lifetimePurchased: normalizeConsumableCounts(source.lifetimePurchased),
    lifetimeGranted: normalizeConsumableCounts(source.lifetimeGranted),
    lifetimeConsumed: normalizeConsumableCounts(source.lifetimeConsumed),
    updatedAt: timestamp(source.updatedAt)
  };
}

export function normalizeConsumableCounts(input = {}, maximum = CONSUMABLE_MAX_WALLET_QUANTITY) {
  const source = record(input);
  return Object.fromEntries(CONSUMABLE_ID_LIST.map((id) => [
    id,
    boundedInteger(source[id], 0, maximum, 0)
  ]));
}

export function emptyConsumableCounts() {
  return Object.fromEntries(CONSUMABLE_ID_LIST.map((id) => [id, 0]));
}

export function consumableCountTotal(counts = {}) {
  return CONSUMABLE_ID_LIST.reduce((total, id) => total + Number(counts[id] || 0), 0);
}

export function consumablesCatalog(economyInput, walletInput = null) {
  const economy = normalizeConsumablesEconomy(economyInput);
  const wallet = walletInput ? normalizeWalletConsumables(walletInput) : null;
  return {
    token: MATT_CRYSTAL_TOKEN_ADDRESS,
    treasury: CONSUMABLE_TREASURY_ADDRESS,
    decimals: 18,
    routing: '100% Treasury',
    economy,
    items: CONSUMABLE_ID_LIST.map((id) => ({
      ...CONSUMABLE_DEFINITIONS[id],
      ...economy.items[id],
      ...(wallet ? {
        owned: wallet.inventory[id],
        selected: wallet.selected[id]
      } : {})
    })),
    ...(wallet ? { wallet } : {})
  };
}

export function validateConsumableLoadout(input, economyInput, walletInput) {
  const economy = normalizeConsumablesEconomy(economyInput);
  const wallet = normalizeWalletConsumables(walletInput);
  const source = record(input);
  for (const id of CONSUMABLE_ID_LIST) {
    const quantity = Number(source[id] ?? 0);
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > CONSUMABLE_MAX_LOADOUT_SIZE) {
      throw new Error(`${CONSUMABLE_DEFINITIONS[id].name} quantity is invalid.`);
    }
  }
  const selected = normalizeConsumableCounts(input, CONSUMABLE_MAX_LOADOUT_SIZE);
  if (consumableCountTotal(selected) > economy.maximumLoadoutSize) {
    throw new Error(`Choose no more than ${economy.maximumLoadoutSize} consumables for this run.`);
  }
  for (const id of CONSUMABLE_ID_LIST) {
    if (selected[id] > economy.items[id].maximumPerRun) {
      throw new Error(`${CONSUMABLE_DEFINITIONS[id].name} is limited to ${economy.items[id].maximumPerRun} per run.`);
    }
    if (selected[id] > 0 && !economy.items[id].enabled) {
      throw new Error(`${CONSUMABLE_DEFINITIONS[id].name} is currently unavailable.`);
    }
    if (selected[id] > wallet.inventory[id]) {
      throw new Error(`This wallet does not hold enough ${CONSUMABLE_DEFINITIONS[id].name}.`);
    }
  }
  return selected;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function timestamp(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}
