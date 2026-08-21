export const NFT_GARAGE_CONTRACTS = Object.freeze({
  miner: '0xBbaBE35B943E3Ba911B53C2b39447cF181fE565A',
  equipment: '0x415cF1DeA47f3d4BAb830F78B82e12D6EeceD612',
  loadout: '0xb88C219C792cFa07749E0E5D939DbbbF1E62C7b5',
  chest: '0x693525e7fD76949834cad56d67D469bAAd6687F6',
  crystalBank: '0x8C640Cd91Ea6616cDD07B8323492E76e5c9ffE78',
  matt: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d'
});

export const NFT_GARAGE_SELECTORS = Object.freeze({
  nextTokenId: '0x75794a3c',
  ownerOf: '0x6352211e',
  tokenURI: '0xc87b56dd',
  loadoutOf: '0x44752a35',
  equipmentData: '0xc6452e13',
  isRunLocked: '0x2259acda',
  bonusFor: '0x213b4056',
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
  bankBalance: '0x9839fa4a',
  minimumWithdrawal: '0x738b31b5',
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

export class NftGarageClient {
  constructor(options = {}) {
    this.wallet = options.wallet;
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
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

    const [loadoutValue, runLockedValue, mattBalanceValue, crystalBalanceValue, minimumWithdrawalValue, equipmentApprovalValue] = await Promise.all([
      this.call(NFT_GARAGE_CONTRACTS.loadout, encodeCall(NFT_GARAGE_SELECTORS.loadoutOf, uintWord(selectedMinerId))),
      this.call(NFT_GARAGE_CONTRACTS.miner, encodeCall(NFT_GARAGE_SELECTORS.isRunLocked, uintWord(selectedMinerId))),
      this.call(NFT_GARAGE_CONTRACTS.matt, encodeCall(NFT_GARAGE_SELECTORS.balanceOf, addressWord(player))),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, encodeCall(NFT_GARAGE_SELECTORS.bankBalance, addressWord(player))),
      this.call(NFT_GARAGE_CONTRACTS.crystalBank, NFT_GARAGE_SELECTORS.minimumWithdrawal),
      this.call(
        NFT_GARAGE_CONTRACTS.equipment,
        encodeCall(NFT_GARAGE_SELECTORS.isApprovedForAll, addressWord(player), addressWord(NFT_GARAGE_CONTRACTS.loadout))
      )
    ]);
    const loadoutWords = splitAbiWords(loadoutValue);
    const loadout = Object.fromEntries(NFT_GARAGE_SLOTS.map((slot, index) => [slot.key, Number(BigInt(`0x${loadoutWords[index]}`))]));
    const allOwnedMinerIds = new Set(ownedMinerIds.map(Number).filter(Number.isSafeInteger));
    allOwnedMinerIds.add(selectedMinerId);
    const equipment = await this.loadEquipment(player, allOwnedMinerIds);
    const chestPrices = await Promise.all(NFT_GARAGE_CHESTS.map(async (product) => ({
      ...product,
      priceRaw: decodeAbiUint(await this.call(
        NFT_GARAGE_CONTRACTS.chest,
        encodeCall(NFT_GARAGE_SELECTORS.chestPrice, uintWord(product.slot))
      ))
    })));
    const repairPriceRaw = decodeAbiUint(await this.call(NFT_GARAGE_CONTRACTS.loadout, NFT_GARAGE_SELECTORS.repairPrice));

    return {
      address: player,
      minerId: selectedMinerId,
      runLocked: decodeAbiUint(runLockedValue) !== 0n,
      loadout,
      equipment,
      mattBalanceRaw: decodeAbiUint(mattBalanceValue),
      crystalBalanceRaw: decodeAbiUint(crystalBalanceValue),
      minimumWithdrawalRaw: decodeAbiUint(minimumWithdrawalValue),
      equipmentOperatorApproved: decodeAbiUint(equipmentApprovalValue) !== 0n,
      repairPriceRaw,
      chestPrices
    };
  }

  async loadEquipment(player, ownedMinerIds) {
    const nextTokenId = Number(decodeAbiUint(await this.call(
      NFT_GARAGE_CONTRACTS.equipment,
      NFT_GARAGE_SELECTORS.nextTokenId
    )));
    const candidates = Array.from({ length: Math.max(0, nextTokenId - 1) }, (_, index) => index + 1);
    const equipment = await Promise.all(candidates.map(async (tokenId) => {
      try {
        const [ownerValue, dataValue, uriValue, bonusValue] = await Promise.all([
          this.call(NFT_GARAGE_CONTRACTS.equipment, encodeCall(NFT_GARAGE_SELECTORS.ownerOf, uintWord(tokenId))),
          this.call(NFT_GARAGE_CONTRACTS.equipment, encodeCall(NFT_GARAGE_SELECTORS.equipmentData, uintWord(tokenId))),
          this.call(NFT_GARAGE_CONTRACTS.equipment, encodeCall(NFT_GARAGE_SELECTORS.tokenURI, uintWord(tokenId))),
          this.call(NFT_GARAGE_CONTRACTS.equipment, encodeCall(NFT_GARAGE_SELECTORS.bonusFor, uintWord(tokenId)))
        ]);
        const owner = decodeAbiAddress(ownerValue);
        const words = splitAbiWords(dataValue);
        const equippedToMiner = Number(BigInt(`0x${words[1]}`));
        if (!sameAddress(owner, player) && !ownedMinerIds.has(equippedToMiner)) return null;
        const tokenUri = decodeAbiString(uriValue);
        return {
          tokenId,
          owner,
          definitionId: Number(BigInt(`0x${words[0]}`)),
          equippedToMiner,
          slot: Number(BigInt(`0x${words[2]}`)),
          rarity: Number(BigInt(`0x${words[3]}`)),
          damaged: BigInt(`0x${words[4]}`) !== 0n,
          bonus: Number(decodeAbiUint(bonusValue)),
          tokenUri,
          metadata: await this.metadata(tokenUri)
        };
      } catch {
        return null;
      }
    }));
    return equipment.filter(Boolean).sort((left, right) => left.tokenId - right.tokenId);
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

  async openChest(snapshot, product) {
    const priceRaw = BigInt(product.priceRaw);
    await this.ensureMattAllowance(snapshot.address, NFT_GARAGE_CONTRACTS.chest, priceRaw, 'chest-approval');
    await this.send(
      NFT_GARAGE_CONTRACTS.chest,
      encodeCall(NFT_GARAGE_SELECTORS.openChest, uintWord(product.slot)),
      'chest-purchase'
    );
  }

  async withdrawCrystals(snapshot, amountRaw) {
    const amount = BigInt(amountRaw);
    if (amount < snapshot.minimumWithdrawalRaw) throw new Error(`Minimum withdrawal is ${formatTokenUnits(snapshot.minimumWithdrawalRaw)} MATT Crystals.`);
    if (amount > snapshot.crystalBalanceRaw) throw new Error('Withdrawal exceeds the banked MATT Crystal balance.');
    await this.send(
      NFT_GARAGE_CONTRACTS.crystalBank,
      encodeCall(NFT_GARAGE_SELECTORS.withdraw, uintWord(amount)),
      'crystal-withdrawal'
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

  async send(to, data, kind) {
    return this.wallet.sendPreparedTransaction(
      { to, value: '0x0', data, kind },
      { allowZeroValue: true }
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

function sameAddress(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}
