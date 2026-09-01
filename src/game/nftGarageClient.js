export const NFT_GARAGE_CONTRACTS = Object.freeze({
  miner: '0xBbaBE35B943E3Ba911B53C2b39447cF181fE565A',
  equipment: '0x415cF1DeA47f3d4BAb830F78B82e12D6EeceD612',
  loadout: '0xb88C219C792cFa07749E0E5D939DbbbF1E62C7b5',
  chest: '0x693525e7fD76949834cad56d67D469bAAd6687F6',
  crystalBank: '0x8C640Cd91Ea6616cDD07B8323492E76e5c9ffE78',
  crystal: '0x2D2034e55900D285dc05d30a0c14846D7a30285B',
  matt: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d'
});

export const NFT_GARAGE_SELECTORS = Object.freeze({
  ownerOf: '0x6352211e',
  loadoutOf: '0x44752a35',
  isRunLocked: '0x2259acda',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  isApprovedForAll: '0xe985e9c5',
  setApprovalForAll: '0xa22cb465',
  equip: '0x28257532',
  unequip: '0xcdb6dd5c',
  chestPrice: '0xdb79e06f',
  openChest: '0x99ae54a9',
  repairPrice: '0x48d54bba',
  repairArmor: '0x9981f16d',
  maxChestsPerPurchase: '0xb4085102',
  openChests: '0x18246f38',
  bankBalance: '0x9839fa4a',
  minimumWithdrawal: '0x738b31b5',
  walletDailyLimit: '0xb4c0f7f7',
  globalDailyLimit: '0xace89f6d',
  walletWithdrawn: '0xeced2bc2',
  globalWithdrawn: '0x31a2d974',
  paused: '0x5c975abb',
  withdraw: '0x2e1a7d4d'
});

export const NFT_GARAGE_SLOTS = Object.freeze([
  Object.freeze({ key: 'armor', label: 'ARMOR' }),
  Object.freeze({ key: 'pickaxe', label: 'PICKAXE' }),
  Object.freeze({ key: 'blaster', label: 'BLASTER' }),
  Object.freeze({ key: 'dynamite', label: 'DYNAMITE' }),
  Object.freeze({ key: 'helmet', label: 'HELMET' }),
  Object.freeze({ key: 'backpack', label: 'BACKPACK' })
]);

export const NFT_GARAGE_CHESTS = Object.freeze([
  Object.freeze({ slot: 0, key: 'armor', label: 'ARMOR CHEST' }),
  Object.freeze({ slot: 1, key: 'pickaxe', label: 'PICKAXE CHEST' }),
  Object.freeze({ slot: 2, key: 'blaster', label: 'BLASTER CHEST' }),
  Object.freeze({ slot: 3, key: 'dynamite', label: 'DYNAMITE CHEST' }),
  Object.freeze({ slot: 4, key: 'helmet', label: 'HELMET CHEST' }),
  Object.freeze({ slot: 5, key: 'backpack', label: 'BACKPACK CHEST' })
]);

export const NFT_GARAGE_RARITIES = Object.freeze(['COMMON', 'UNCOMMON', 'RARE', 'MYTHIC', 'LEGENDARY']);
export const NFT_GARAGE_EQUIPMENT_PAGE_SIZE = 50;
export const NFT_GARAGE_MAX_CHESTS_PER_PURCHASE = 10;

const NFT_GARAGE_RARITY_ODDS_BPS = Object.freeze([6_800, 1_800, 800, 500, 100]);
const NFT_GARAGE_ITEM_NAMES = Object.freeze([
  Object.freeze(['Common Prospector Armor', 'Uncommon Copperguard Armor', 'Rare Crystalbreaker Armor', 'Mythic Voidvault Armor', 'Legendary Mineheart Armor']),
  Object.freeze(['Common Riveted Pickaxe', 'Uncommon Coppercoil Pickaxe', 'Rare Crystal Fang Pickaxe', 'Mythic Voidcore Pickaxe', 'Legendary Sunforge Pickaxe']),
  Object.freeze(['Common Ore Blaster', 'Uncommon Coppercoil Blaster', 'Rare Crystal Blaster', 'Mythic Voidcore Blaster', 'Legendary Sunforge Blaster']),
  Object.freeze(['Common Mining Charge', 'Uncommon Copper Charge', 'Rare Crystal Charge', 'Mythic Void Charge', 'Legendary Sunforge Charge']),
  Object.freeze(['Common Riveted Pit Cap', 'Uncommon Coppercoil Cap', 'Rare Crystal Surveyor Helm', 'Mythic Voidglass Deepseer', 'Legendary Sunforge Helm']),
  Object.freeze(['Common Crystal Hauler', 'Uncommon Crystal Hauler', 'Rare Crystal Hauler', 'Mythic Crystal Hauler', 'Legendary Crystal Hauler'])
]);

export function garageEquipmentBonus(slotInput, rarityInput) {
  const slot = nonnegativeInteger(slotInput, 'Equipment slot');
  const rarity = nonnegativeInteger(rarityInput, 'Equipment rarity');
  if (slot >= NFT_GARAGE_SLOTS.length || rarity >= NFT_GARAGE_RARITIES.length) {
    throw new Error('The Equipment chest outcome is invalid.');
  }
  const tier = rarity + 1;
  if (slot === 0) return tier === 5 ? 150 : 25 * tier;
  if (slot === 1 || slot === 2) return 2 * tier;
  if (slot === 3 || slot === 4) return 5 * tier;
  return tier === 5 ? 15_000 : 2_500 * tier;
}

export function garageChestOutcomes(productInput = {}) {
  const slot = nonnegativeInteger(productInput.slot, 'Equipment chest slot');
  if (slot >= NFT_GARAGE_CHESTS.length) throw new Error('The Equipment chest slot is invalid.');
  return Object.freeze(NFT_GARAGE_RARITIES.map((rarity, rarityIndex) => {
    const bonus = garageEquipmentBonus(slot, rarityIndex);
    const stat = slot === 0
      ? `+${bonus} SHIELD`
      : slot === 1
        ? `+${bonus} PICKAXE ATTACK`
        : slot === 2
          ? `+${bonus} BLASTER ATTACK`
          : slot === 3
            ? `+${bonus} DYNAMITE ATTACK`
            : slot === 4
              ? `+${bonus} MAX HEALTH`
              : `+${bonus / 100}% CARRY CAPACITY`;
    return Object.freeze({
      rarity,
      rarityIndex,
      chanceBps: NFT_GARAGE_RARITY_ODDS_BPS[rarityIndex],
      chance: `${NFT_GARAGE_RARITY_ODDS_BPS[rarityIndex] / 100}%`,
      name: NFT_GARAGE_ITEM_NAMES[slot][rarityIndex],
      bonus,
      stat
    });
  }));
}

const EQUIPMENT_INVENTORY_DRIFT_CODES = new Set([
  'nft_equipment_inventory_changed',
  'nft_equipment_index_changed'
]);

export class NftGarageClient {
  constructor(options = {}) {
    this.wallet = options.wallet;
    this.api = options.api || options.apiClient || null;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.now = options.now || (() => Date.now());
    this.rpcRequestId = 0;
    if (!this.wallet) throw new Error('NFT Garage requires the connected MATT Mine wallet.');
    if (!this.fetch) throw new Error('NFT Garage requires browser fetch support.');
  }

  async snapshot({ address, minerId, ownedMinerIds = [] }) {
    const player = normalizedAddress(address);
    const selectedMinerId = positiveInteger(minerId, 'Miner number');
    const owner = decodeAbiAddress(await this.call(
      NFT_GARAGE_CONTRACTS.miner,
      encodeCall(NFT_GARAGE_SELECTORS.ownerOf, uintWord(selectedMinerId))
    ));
    if (!sameAddress(owner, player)) throw new Error(`Miner #${selectedMinerId} is not owned by the signed-in wallet.`);

    const [loadoutValue, runLockedValue, equipmentApprovalValue, wallet] = await Promise.all([
      this.call(NFT_GARAGE_CONTRACTS.loadout, encodeCall(NFT_GARAGE_SELECTORS.loadoutOf, uintWord(selectedMinerId))),
      this.call(NFT_GARAGE_CONTRACTS.miner, encodeCall(NFT_GARAGE_SELECTORS.isRunLocked, uintWord(selectedMinerId))),
      this.call(
        NFT_GARAGE_CONTRACTS.equipment,
        encodeCall(NFT_GARAGE_SELECTORS.isApprovedForAll, addressWord(player), addressWord(NFT_GARAGE_CONTRACTS.loadout))
      ),
      this.walletSnapshot({ address: player })
    ]);
    const loadoutWords = splitAbiWords(loadoutValue);
    const loadout = Object.fromEntries(NFT_GARAGE_SLOTS.map((slot, index) => [slot.key, Number(BigInt(`0x${loadoutWords[index]}`))]));
    const equipmentPage = await this.loadEquipment(player, {
      priorityTokenIds: Object.values(loadout).filter((tokenId) => tokenId > 0)
    });
    const [chestPrices, repairPriceRaw, chestBatchLimit] = await Promise.all([
      Promise.all(NFT_GARAGE_CHESTS.map(async (product) => ({
        ...product,
        priceRaw: decodeAbiUint(await this.call(
          NFT_GARAGE_CONTRACTS.chest,
          encodeCall(NFT_GARAGE_SELECTORS.chestPrice, uintWord(product.slot))
        ))
      }))),
      this.call(NFT_GARAGE_CONTRACTS.loadout, NFT_GARAGE_SELECTORS.repairPrice).then(decodeAbiUint),
      this.chestBatchLimit()
    ]);

    return {
      address: player,
      minerId: selectedMinerId,
      runLocked: decodeAbiUint(runLockedValue) !== 0n,
      loadout,
      equipment: equipmentPage.items,
      equipmentNextCursor: equipmentPage.nextCursor,
      equipmentTotal: equipmentPage.total,
      equipmentIndexedToBlock: equipmentPage.indexedToBlock,
      ...wallet,
      equipmentOperatorApproved: decodeAbiUint(equipmentApprovalValue) !== 0n,
      repairPriceRaw,
      chestPrices,
      chestBatchLimit
    };
  }

  async walletSnapshot({ address }) {
    const player = normalizedAddress(address);
    const utcDay = Math.floor(this.now() / 86_400_000);
    const [
      mattBalanceValue,
      walletCrystalBalanceValue,
      crystalBalanceValue,
      minimumWithdrawalValue,
      walletDailyLimitValue,
      globalDailyLimitValue,
      walletWithdrawnValue,
      globalWithdrawnValue,
      pausedValue
    ] = await Promise.all([
      this.call(NFT_GARAGE_CONTRACTS.matt, encodeCall(NFT_GARAGE_SELECTORS.balanceOf, addressWord(player))),
      this.call(NFT_GARAGE_CONTRACTS.crystal, encodeCall(NFT_GARAGE_SELECTORS.balanceOf, addressWord(player))),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, encodeCall(NFT_GARAGE_SELECTORS.bankBalance, addressWord(player))),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, NFT_GARAGE_SELECTORS.minimumWithdrawal),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, NFT_GARAGE_SELECTORS.walletDailyLimit),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, NFT_GARAGE_SELECTORS.globalDailyLimit),
      this.call(
        NFT_GARAGE_CONTRACTS.crystalBank,
        encodeCall(NFT_GARAGE_SELECTORS.walletWithdrawn, uintWord(utcDay), addressWord(player))
      ),
      this.call(
        NFT_GARAGE_CONTRACTS.crystalBank,
        encodeCall(NFT_GARAGE_SELECTORS.globalWithdrawn, uintWord(utcDay))
      ),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, NFT_GARAGE_SELECTORS.paused)
    ]);
    return crystalWithdrawalAvailability({
      address: player,
      utcDay,
      nextUtcResetAt: (utcDay + 1) * 86_400_000,
      mattBalanceRaw: decodeAbiUint(mattBalanceValue),
      walletCrystalBalanceRaw: decodeAbiUint(walletCrystalBalanceValue),
      crystalBalanceRaw: decodeAbiUint(crystalBalanceValue),
      minimumWithdrawalRaw: decodeAbiUint(minimumWithdrawalValue),
      walletDailyLimitRaw: decodeAbiUint(walletDailyLimitValue),
      globalDailyLimitRaw: decodeAbiUint(globalDailyLimitValue),
      walletWithdrawnRaw: decodeAbiUint(walletWithdrawnValue),
      globalWithdrawnRaw: decodeAbiUint(globalWithdrawnValue),
      crystalBankPaused: decodeAbiUint(pausedValue) !== 0n
    });
  }

  async loadEquipment(playerInput = '', options = {}) {
    if (typeof this.api?.equipmentInventory !== 'function') {
      throw new Error('Sign in to MATT Mine to load the server-indexed Equipment inventory.');
    }
    const player = playerInput ? normalizedAddress(playerInput) : '';
    const cursor = String(options.cursor || '');
    const limit = Math.min(
      NFT_GARAGE_EQUIPMENT_PAGE_SIZE,
      positiveInteger(options.limit || NFT_GARAGE_EQUIPMENT_PAGE_SIZE, 'Equipment page size')
    );
    const priorityTokenIds = uniquePositiveIntegers(options.priorityTokenIds || []);
    const attempts = cursor ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const page = await this.api.equipmentInventory(cursor, limit, priorityTokenIds);
        if (player && !sameAddress(page?.owner, player)) {
          throw new Error('The signed-in server session does not match the connected Ronin wallet. Sign in again.');
        }
        const items = (page?.items || []).map((item) => ({
          ...item,
          tokenId: positiveInteger(item?.tokenId, 'Equipment token number')
        }));
        const total = nonnegativeInteger(page?.total ?? items.length, 'Equipment inventory total');
        return {
          items: dedupeEquipment(items),
          nextCursor: String(page?.nextCursor || ''),
          total: Math.max(total, items.length),
          indexedToBlock: page?.indexedToBlock ?? null
        };
      } catch (error) {
        if (attempt === 0 && EQUIPMENT_INVENTORY_DRIFT_CODES.has(error?.code)) continue;
        throw error;
      }
    }
    throw new Error('The Equipment inventory could not be loaded.');
  }

  async loadMoreEquipment(snapshot) {
    if (!snapshot?.equipmentNextCursor) return snapshot;
    const priorityTokenIds = Object.values(snapshot.loadout || {}).filter((tokenId) => Number(tokenId) > 0);
    let page;
    let reset = false;
    try {
      page = await this.loadEquipment(snapshot.address, {
        cursor: snapshot.equipmentNextCursor
      });
    } catch (error) {
      if (!EQUIPMENT_INVENTORY_DRIFT_CODES.has(error?.code)) throw error;
      reset = true;
      page = await this.loadEquipment(snapshot.address, { priorityTokenIds });
    }
    const equipment = reset
      ? page.items
      : dedupeEquipment([...(snapshot.equipment || []), ...page.items]);
    return {
      ...snapshot,
      equipment,
      equipmentNextCursor: page.nextCursor,
      equipmentTotal: Math.max(page.total, equipment.length),
      equipmentIndexedToBlock: page.indexedToBlock,
      equipmentInventoryReset: reset
    };
  }

  async equip(snapshot, item) {
    if (snapshot.runLocked) throw new Error(`Miner #${snapshot.minerId} is locked in a run.`);
    const slot = NFT_GARAGE_SLOTS[item.slot];
    if (!slot) throw new Error('This Equipment NFT has an invalid slot.');
    const occupiedTokenId = Number(snapshot.loadout[slot.key] || 0);
    if (occupiedTokenId && occupiedTokenId !== item.tokenId) {
      await this.send(
        NFT_GARAGE_CONTRACTS.loadout,
        encodeCall(NFT_GARAGE_SELECTORS.unequip, uintWord(snapshot.minerId), uintWord(item.slot)),
        'unequip'
      );
    }
    if (!snapshot.equipmentOperatorApproved) {
      await this.send(
        NFT_GARAGE_CONTRACTS.equipment,
        encodeCall(NFT_GARAGE_SELECTORS.setApprovalForAll, addressWord(NFT_GARAGE_CONTRACTS.loadout), uintWord(1)),
        'equipment-approval'
      );
    }
    await this.send(
      NFT_GARAGE_CONTRACTS.loadout,
      encodeCall(NFT_GARAGE_SELECTORS.equip, uintWord(snapshot.minerId), uintWord(item.tokenId)),
      'equip'
    );
  }

  async unequip(snapshot, item) {
    if (snapshot.runLocked) throw new Error(`Miner #${snapshot.minerId} is locked in a run.`);
    await this.send(
      NFT_GARAGE_CONTRACTS.loadout,
      encodeCall(NFT_GARAGE_SELECTORS.unequip, uintWord(snapshot.minerId), uintWord(item.slot)),
      'unequip'
    );
  }

  async repairArmor(snapshot) {
    if (snapshot.runLocked) throw new Error(`Miner #${snapshot.minerId} is locked in a run.`);
    await this.ensureMattAllowance(snapshot.address, NFT_GARAGE_CONTRACTS.loadout, snapshot.repairPriceRaw, 'armor-repair-approval');
    await this.send(
      NFT_GARAGE_CONTRACTS.loadout,
      encodeCall(NFT_GARAGE_SELECTORS.repairArmor, uintWord(snapshot.minerId)),
      'armor-repair'
    );
  }

  async chestBatchLimit() {
    try {
      const value = Number(decodeAbiUint(await this.call(
        NFT_GARAGE_CONTRACTS.chest,
        NFT_GARAGE_SELECTORS.maxChestsPerPurchase
      )));
      return Number.isSafeInteger(value) && value > 1
        ? Math.min(value, NFT_GARAGE_MAX_CHESTS_PER_PURCHASE)
        : 1;
    } catch {
      return 1;
    }
  }

  async openChest(snapshot, product) {
    return this.openChests(snapshot, product, 1);
  }

  async openChests(snapshot, product, quantityInput, options = {}) {
    const quantity = positiveInteger(quantityInput, 'Equipment chest quantity');
    if (quantity > NFT_GARAGE_MAX_CHESTS_PER_PURCHASE) {
      throw new Error(`Choose no more than ${NFT_GARAGE_MAX_CHESTS_PER_PURCHASE} Equipment chests per purchase.`);
    }
    const priceRaw = BigInt(product.priceRaw);
    const totalPriceRaw = priceRaw * BigInt(quantity);
    await this.ensureMattAllowance(snapshot.address, NFT_GARAGE_CONTRACTS.chest, totalPriceRaw, 'chest-approval');
    const batchLimit = Math.max(1, Math.min(
      NFT_GARAGE_MAX_CHESTS_PER_PURCHASE,
      Number(snapshot.chestBatchLimit || 1)
    ));
    if (quantity > 1 && batchLimit >= quantity) {
      await this.send(
        NFT_GARAGE_CONTRACTS.chest,
        encodeCall(NFT_GARAGE_SELECTORS.openChests, uintWord(product.slot), uintWord(quantity)),
        'chest-purchase'
      );
      return { quantity, totalPriceRaw, batched: true, transactionCount: 1 };
    }
    for (let index = 0; index < quantity; index += 1) {
      options.onProgress?.({ completed: index, quantity });
      try {
        await this.send(
          NFT_GARAGE_CONTRACTS.chest,
          encodeCall(NFT_GARAGE_SELECTORS.openChest, uintWord(product.slot)),
          'chest-purchase'
        );
      } catch (error) {
        const purchaseError = error instanceof Error && Object.isExtensible(error)
          ? error
          : new Error(error?.message || 'The chest purchase sequence stopped.', { cause: error });
        purchaseError.completedChestPurchases = index;
        purchaseError.requestedChestPurchases = quantity;
        throw purchaseError;
      }
      options.onProgress?.({ completed: index + 1, quantity });
    }
    return { quantity, totalPriceRaw, batched: false, transactionCount: quantity };
  }

  async withdrawCrystals(snapshot, amountRaw, options = {}) {
    const amount = BigInt(amountRaw);
    const availability = crystalWithdrawalAvailability(snapshot);
    if (availability.crystalBankPaused) throw new Error('MATT Crystal withdrawals are temporarily paused. Banked Crystals remain safe.');
    if (amount < snapshot.minimumWithdrawalRaw) throw new Error(`Minimum withdrawal is ${formatTokenUnits(snapshot.minimumWithdrawalRaw)} MATT Crystals.`);
    if (amount > availability.withdrawableRaw) {
      throw new Error(`Only ${formatTokenUnits(availability.withdrawableRaw)} MATT Crystals are currently withdrawable before the UTC daily reset.`);
    }
    await this.send(
      NFT_GARAGE_CONTRACTS.crystalBank,
      encodeCall(NFT_GARAGE_SELECTORS.withdraw, uintWord(amount)),
      'crystal-withdrawal',
      options
    );
  }

  async ensureMattAllowance(owner, spender, amount, kind) {
    const [allowanceValue, balanceValue] = await Promise.all([
      this.call(NFT_GARAGE_CONTRACTS.matt, encodeCall(NFT_GARAGE_SELECTORS.allowance, addressWord(owner), addressWord(spender))),
      this.call(NFT_GARAGE_CONTRACTS.matt, encodeCall(NFT_GARAGE_SELECTORS.balanceOf, addressWord(owner)))
    ]);
    const allowance = decodeAbiUint(allowanceValue);
    const balance = decodeAbiUint(balanceValue);
    if (balance < amount) throw new Error(`This wallet needs ${formatTokenUnits(amount)} MATT but has ${formatTokenUnits(balance)}.`);
    if (allowance >= amount) return;
    await this.send(
      NFT_GARAGE_CONTRACTS.matt,
      encodeCall(NFT_GARAGE_SELECTORS.approve, addressWord(spender), uintWord(amount)),
      kind
    );
  }

  async send(to, data, kind, options = {}) {
    return this.wallet.sendPreparedTransaction(
      { to, value: '0x0', data, kind },
      { allowZeroValue: true, ...options }
    );
  }

  async call(to, data) {
    return this.rpc('eth_call', [{ to, data }, 'latest']);
  }

  async rpc(method, params) {
    const response = await this.fetch('/api/nft-lab/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.rpcRequestId, method, params })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Ronin Mainnet read failed (${response.status}).`);
    return payload.result;
  }

  async metadata(uri) {
    const url = String(uri || '').startsWith('ipfs://') ? `https://ipfs.io/ipfs/${String(uri).slice(7)}` : String(uri || '');
    const parsed = new URL(url, globalThis.location?.href);
    const requestUrl = parsed.origin === 'https://matt-mine.onrender.com' && parsed.origin !== globalThis.location?.origin
      ? `/api/nft-lab/metadata?url=${encodeURIComponent(url)}&_matt=${Date.now()}`
      : `${url}${url.includes('?') ? '&' : '?'}_matt=${Date.now()}`;
    const response = await this.fetch(requestUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Equipment metadata returned HTTP ${response.status}.`);
    return response.json();
  }
}

export function garageImageUrl(url) {
  const value = String(url || '');
  if (!value) return '';
  const parsed = new URL(value, globalThis.location?.href);
  if (parsed.origin === 'https://matt-mine.onrender.com' && parsed.origin !== globalThis.location?.origin) {
    return `/api/nft-lab/image?url=${encodeURIComponent(value)}&_matt=${Date.now()}`;
  }
  return `${value}${value.includes('?') ? '&' : '?'}_matt=${Date.now()}`;
}

export function formatTokenUnits(value, decimals = 18, maximumFractionDigits = 4) {
  const amount = BigInt(value || 0);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, '0').slice(0, maximumFractionDigits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function crystalWithdrawalAvailability(snapshot = {}) {
  const banked = nonNegativeBigInt(snapshot.crystalBalanceRaw);
  const walletBalance = nonNegativeBigInt(snapshot.walletCrystalBalanceRaw);
  const minimum = nonNegativeBigInt(snapshot.minimumWithdrawalRaw);
  const walletLimit = nonNegativeBigInt(snapshot.walletDailyLimitRaw);
  const globalLimit = nonNegativeBigInt(snapshot.globalDailyLimitRaw);
  const walletUsed = nonNegativeBigInt(snapshot.walletWithdrawnRaw);
  const globalUsed = nonNegativeBigInt(snapshot.globalWithdrawnRaw);
  const walletRemainingRaw = walletLimit > walletUsed ? walletLimit - walletUsed : 0n;
  const globalRemainingRaw = globalLimit > globalUsed ? globalLimit - globalUsed : 0n;
  const withdrawableRaw = snapshot.crystalBankPaused
    ? 0n
    : [banked, walletRemainingRaw, globalRemainingRaw].reduce(
        (smallest, value) => value < smallest ? value : smallest,
        banked
      );
  return {
    ...snapshot,
    walletCrystalBalanceRaw: walletBalance,
    crystalBalanceRaw: banked,
    minimumWithdrawalRaw: minimum,
    walletDailyLimitRaw: walletLimit,
    globalDailyLimitRaw: globalLimit,
    walletWithdrawnRaw: walletUsed,
    globalWithdrawnRaw: globalUsed,
    walletRemainingRaw,
    globalRemainingRaw,
    withdrawableRaw,
    withdrawalAvailable: !snapshot.crystalBankPaused && withdrawableRaw >= minimum && minimum > 0n
  };
}

export function parseTokenUnits(value, decimals = 18) {
  const input = String(value || '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(input)) throw new Error('Enter a valid MATT Crystal amount.');
  const [whole, fraction = ''] = input.split('.');
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

export function encodeCall(selector, ...words) {
  if (!/^0x[0-9a-f]{8}$/i.test(selector)) throw new Error('Invalid contract selector.');
  return `${selector}${words.join('')}`;
}

export function uintWord(value) {
  const number = BigInt(value);
  if (number < 0n) throw new Error('Contract integers must be unsigned.');
  return number.toString(16).padStart(64, '0');
}

export function addressWord(value) {
  return normalizedAddress(value).slice(2).padStart(64, '0');
}

export function splitAbiWords(value) {
  const body = String(value || '').replace(/^0x/, '');
  if (body.length % 64 !== 0) throw new Error('Malformed contract response.');
  return body.match(/.{64}/g) || [];
}

export function decodeAbiUint(value, index = 0) {
  const word = splitAbiWords(value)[index];
  if (!word) throw new Error('Missing contract integer.');
  return BigInt(`0x${word}`);
}

export function decodeAbiAddress(value, index = 0) {
  const word = splitAbiWords(value)[index];
  if (!word) throw new Error('Missing contract address.');
  return normalizedAddress(`0x${word.slice(24)}`);
}

export function decodeAbiString(value) {
  const body = String(value || '').replace(/^0x/, '');
  if (body.length < 128) throw new Error('Malformed contract string.');
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  const bytes = new Uint8Array(length);
  const start = offset + 64;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(start + index * 2, start + index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

function normalizedAddress(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('The wallet address is invalid.');
  return address;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${label} is invalid.`);
  return number;
}

function nonnegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid.`);
  return number;
}

function uniquePositiveIntegers(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))];
}

function dedupeEquipment(items) {
  return [...new Map(items.map((item) => [item.tokenId, item])).values()]
    .sort((left, right) => left.tokenId - right.tokenId);
}

function nonNegativeBigInt(value) {
  try {
    const number = BigInt(value || 0);
    return number > 0n ? number : 0n;
  } catch {
    return 0n;
  }
}

function sameAddress(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}
