export const NFT_LAB_CHAIN = Object.freeze({
  id: 202601,
  hexId: '0x31769',
  name: 'Saigon Testnet',
  rpcUrl: 'https://saigon-testnet.roninchain.com/rpc',
  explorerUrl: 'https://saigon-app.roninchain.com'
});

export const NFT_LAB_CONTRACTS = Object.freeze({
  miner: '0x545d5d4c714eB4d2242BBFE82C31fe9a1E5Cff29',
  equipment: '0x73A4Ad9a2b4bfeeE1b98F5D99AaB24B702dEb093',
  loadout: '0x6cf168cdD198D0d111faE2286aE6dcD86FA960d8',
  chest: '0x52f66358ae951638a794777F3cc3448513d5be37',
  settlement: '0x08d6FE054A75a59b7Abd4942D890f56f8e1896B2',
  matt: '0x108AFAaDB3EDD4Cb10206B297Db0f3C9f9611769'
});

export const ABI_SELECTORS = Object.freeze({
  nextTokenId: '0x75794a3c',
  ownerOf: '0x6352211e',
  tokenURI: '0xc87b56dd',
  loadoutOf: '0x44752a35',
  equipmentData: '0xc6452e13',
  getApproved: '0x081812fc',
  approve: '0x095ea7b3',
  equip: '0x28257532',
  unequip: '0xdcef5b44',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
  purchaseBackpack: '0x409f3250',
  backpackPrice: '0x847a4b43',
  nextBackpack: '0xdd02da77',
  openChest: '0x99ae54a9',
  chestPrice: '0xdb79e06f',
  repairPrice: '0x48d54bba',
  repairArmor: '0x9981f16d',
  effectiveHitPoints: '0xd45da70f'
});

export const CHEST_PRODUCTS = Object.freeze([
  Object.freeze({ type: 0, key: 'weapon', label: 'Pickaxe Chest', fallbackPrice: 2n * 10n ** 18n }),
  Object.freeze({ type: 1, key: 'helmet', label: 'Helmet Chest', fallbackPrice: 2n * 10n ** 18n }),
  Object.freeze({ type: 2, key: 'armor-common', label: 'Common Armor', fallbackPrice: 2n * 10n ** 18n }),
  Object.freeze({ type: 3, key: 'armor-rare', label: 'Rare Armor', fallbackPrice: 5n * 10n ** 18n }),
  Object.freeze({ type: 4, key: 'armor-mythic', label: 'Mythic Armor', fallbackPrice: 15n * 10n ** 18n })
]);

const ITEM_TYPES = ['Weapon', 'Backpack', 'Helmet', 'Armor'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Mythic', 'Legendary'];
const SLOT_KEYS = [
  { key: 'weapon', label: 'WEAPON' },
  { key: 'backpackHead', label: 'ACTIVE BACKPACK' },
  { key: 'helmet', label: 'HELMET' },
  { key: 'armor', label: 'ARMOR' }
];

const state = {
  provider: null,
  account: '',
  miners: [],
  equipment: [],
  selectedMinerId: null,
  mattBalance: 0n,
  busy: false
};
let rpcRequestId = 0;

export function uintWord(value) {
  const number = BigInt(value);
  if (number < 0n) throw new Error('ABI integers must be unsigned.');
  return number.toString(16).padStart(64, '0');
}

export function addressWord(value) {
  const address = normalizeAddress(value);
  return address.slice(2).padStart(64, '0');
}

export function encodeCall(selector, ...words) {
  if (!/^0x[0-9a-f]{8}$/i.test(selector)) throw new Error('Invalid ABI selector.');
  return `${selector}${words.join('')}`;
}

export function splitAbiWords(value) {
  const body = String(value || '').replace(/^0x/, '');
  if (body.length % 64 !== 0) throw new Error('Malformed ABI response.');
  return body.match(/.{64}/g) || [];
}

export function decodeAbiUint(value, index = 0) {
  const word = splitAbiWords(value)[index];
  if (!word) throw new Error('Missing ABI integer word.');
  return BigInt(`0x${word}`);
}

export function decodeAbiAddress(value, index = 0) {
  const word = splitAbiWords(value)[index];
  if (!word) throw new Error('Missing ABI address word.');
  return normalizeAddress(`0x${word.slice(24)}`);
}

export function decodeAbiString(value) {
  const body = String(value || '').replace(/^0x/, '');
  if (body.length < 128) throw new Error('Malformed ABI string response.');
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`));
  const dataStart = offset + 64;
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(dataStart + index * 2, dataStart + index * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

export function formatTokenUnits(value, decimals = 18, maximumFractionDigits = 4) {
  const amount = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, '0').slice(0, maximumFractionDigits).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function waitForTokenIdIncrease(readNextTokenId, baseline, options = {}) {
  const attempts = Number(options.attempts || 12);
  const delayMs = Number(options.delayMs || 2_500);
  const delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const nextTokenId = BigInt(await readNextTokenId());
    if (nextTokenId > BigInt(baseline)) return nextTokenId;
    if (attempt + 1 < attempts) await delay(delayMs);
  }
  return BigInt(baseline);
}

function normalizeAddress(value) {
  const address = String(value || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`Invalid EVM address: ${value || 'empty'}`);
  return address;
}

function sameAddress(left, right) {
  return String(left || '').toLowerCase() === String(right || '').toLowerCase();
}

function shortAddress(value) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : 'NOT CONNECTED';
}

function dom(id) {
  return document.getElementById(id);
}

function setStatus(message, kind = '') {
  dom('status-copy').textContent = message;
  dom('status-panel').className = `status-panel${kind ? ` ${kind}` : ''}`;
}

function setBusy(busy) {
  state.busy = busy;
  dom('connect-button').disabled = busy;
  dom('refresh-button').disabled = busy || !state.account;
  document.querySelectorAll('.transaction-action, .item-action').forEach((button) => {
    const walletRequired = button.classList.contains('transaction-action') && !state.account;
    button.disabled = busy || walletRequired || button.dataset.locked === 'true';
  });
}

async function callContract(to, data) {
  return publicRpc('eth_call', [{ to, data }, 'latest']);
}

async function publicRpc(method, params) {
  const response = await fetch(NFT_LAB_CHAIN.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcRequestId, method, params })
  });
  if (!response.ok) throw new Error(`Saigon RPC returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `Saigon RPC ${method} failed.`);
  return payload.result;
}

async function sendTransaction(to, data, label) {
  setStatus(`Approve ${label} in Ronin Wallet.`, 'busy');
  const hash = await state.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: state.account, to, data, value: '0x0' }]
  });
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Ronin Wallet did not return a transaction hash.');
  setStatus(`${label} submitted. Waiting for Saigon confirmation…`, 'busy');
  await waitForReceipt(hash);
  return hash;
}

async function waitForReceipt(hash, attempts = 60) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const receipt = await publicRpc('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (BigInt(receipt.status || '0x0') !== 1n) throw new Error(`Transaction failed: ${hash}`);
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Transaction is still pending: ${hash}`);
}

async function switchToSaigon() {
  try {
    await state.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: NFT_LAB_CHAIN.hexId }] });
  } catch (error) {
    if (Number(error?.code) !== 4902 && !/unrecognized|unknown chain/i.test(String(error?.message || ''))) throw error;
    await state.provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: NFT_LAB_CHAIN.hexId,
        chainName: NFT_LAB_CHAIN.name,
        nativeCurrency: { name: 'RON', symbol: 'RON', decimals: 18 },
        rpcUrls: [NFT_LAB_CHAIN.rpcUrl],
        blockExplorerUrls: [NFT_LAB_CHAIN.explorerUrl]
      }]
    });
  }
  const chainId = await state.provider.request({ method: 'eth_chainId' });
  if (BigInt(chainId) !== BigInt(NFT_LAB_CHAIN.id)) throw new Error(`Switch Ronin Wallet to ${NFT_LAB_CHAIN.name}.`);
}

async function connectWallet() {
  if (state.busy) return;
  setBusy(true);
  setStatus('Opening Ronin Wallet…', 'busy');
  try {
    state.provider = globalThis.ronin?.provider || null;
    if (!state.provider?.request) throw new Error('Ronin Wallet is not available in this browser. Open this page in the Ronin Wallet browser or install the Ronin extension.');
    const accounts = await state.provider.request({ method: 'eth_requestAccounts' });
    if (!Array.isArray(accounts) || !accounts[0]) throw new Error('Ronin Wallet did not provide an account.');
    state.account = normalizeAddress(accounts[0]);
    await switchToSaigon();
    bindProviderEvents();
    await refreshAll();
  } catch (error) {
    setStatus(error?.message || 'Ronin Wallet connection failed.', 'error');
  } finally {
    setBusy(false);
    renderConnection();
  }
}

let providerEventsBound = false;
function bindProviderEvents() {
  if (providerEventsBound || typeof state.provider?.on !== 'function') return;
  providerEventsBound = true;
  state.provider.on('accountsChanged', (accounts) => {
    state.account = Array.isArray(accounts) && accounts[0] ? normalizeAddress(accounts[0]) : '';
    state.selectedMinerId = null;
    if (state.account) void refreshAll();
    else renderDisconnected();
  });
  state.provider.on('chainChanged', () => { if (state.account) void refreshAll(); });
}

async function refreshAll() {
  if (!state.provider || !state.account) return;
  setBusy(true);
  setStatus('Reading Miner and Equipment contracts directly from Saigon…', 'busy');
  try {
    await switchToSaigon();
    const [miners, mattBalance] = await Promise.all([
      loadOwnedMiners(),
      callContract(NFT_LAB_CONTRACTS.matt, encodeCall(ABI_SELECTORS.balanceOf, addressWord(state.account)))
        .then(decodeAbiUint)
    ]);
    const equipment = await loadRelevantEquipment(miners);
    state.miners = miners;
    state.equipment = equipment;
    state.mattBalance = mattBalance;
    if (!miners.some((miner) => miner.id === state.selectedMinerId)) state.selectedMinerId = miners[0]?.id || null;
    renderAll();
    setStatus(
      miners.length
        ? `Loaded ${miners.length} Miner NFT${miners.length === 1 ? '' : 's'} and ${equipment.length} equipment item${equipment.length === 1 ? '' : 's'} directly from chain.`
        : `No Miner NFTs found for ${shortAddress(state.account)}. Switch Ronin Wallet to the 0x1DAb…4be6 test-player account.`,
      miners.length ? 'success' : 'error'
    );
  } catch (error) {
    setStatus(error?.message || 'Could not load the NFT contracts.', 'error');
  } finally {
    setBusy(false);
    renderConnection();
  }
}

async function loadOwnedMiners() {
  const nextId = Number(decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.miner, ABI_SELECTORS.nextTokenId)));
  const candidates = Array.from({ length: Math.max(0, nextId - 1) }, (_, index) => index + 1);
  const scanErrors = [];
  const miners = await Promise.all(candidates.map(async (id) => {
    try {
      const owner = decodeAbiAddress(await callContract(
        NFT_LAB_CONTRACTS.miner,
        encodeCall(ABI_SELECTORS.ownerOf, uintWord(id))
      ));
      if (!sameAddress(owner, state.account)) return null;
      const [uriValue, loadoutValue] = await Promise.all([
        callContract(NFT_LAB_CONTRACTS.miner, encodeCall(ABI_SELECTORS.tokenURI, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.loadout, encodeCall(ABI_SELECTORS.loadoutOf, uintWord(id)))
      ]);
      const metadata = await fetchMetadata(decodeAbiString(uriValue));
      const loadoutWords = splitAbiWords(loadoutValue);
      const miner = {
        id,
        owner,
        tokenUri: decodeAbiString(uriValue),
        metadata,
        loadout: {
          weapon: Number(BigInt(`0x${loadoutWords[0]}`)),
          backpackHead: Number(BigInt(`0x${loadoutWords[1]}`)),
          backpackTail: Number(BigInt(`0x${loadoutWords[2]}`)),
          helmet: Number(BigInt(`0x${loadoutWords[3]}`)),
          armor: Number(BigInt(`0x${loadoutWords[4]}`)),
          backpackCount: Number(BigInt(`0x${loadoutWords[5]}`)),
          runLocked: BigInt(`0x${loadoutWords[6]}`) !== 0n,
          backpackOrder: []
        }
      };
      miner.loadout.backpackOrder = await loadBackpackOrder(miner.loadout.backpackHead, miner.loadout.backpackCount);
      return miner;
    } catch (error) {
      scanErrors.push(`Miner #${id}: ${error?.message || error}`);
      return null;
    }
  }));
  const owned = miners.filter(Boolean).sort((left, right) => left.id - right.id);
  if (!owned.length && scanErrors.length) throw new Error(`Miner scan failed — ${scanErrors[0]}`);
  return owned;
}

async function loadBackpackOrder(head, count) {
  const order = [];
  let tokenId = head;
  while (tokenId && order.length < count && order.length < 1_000) {
    order.push(tokenId);
    tokenId = Number(decodeAbiUint(await callContract(
      NFT_LAB_CONTRACTS.loadout,
      encodeCall(ABI_SELECTORS.nextBackpack, uintWord(tokenId))
    )));
  }
  return order;
}

async function loadRelevantEquipment(ownedMiners) {
  const nextId = Number(decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.equipment, ABI_SELECTORS.nextTokenId)));
  const ownedMinerIds = new Set(ownedMiners.map((miner) => miner.id));
  const candidates = Array.from({ length: Math.max(0, nextId - 1) }, (_, index) => index + 1);
  const scanErrors = [];
  const equipment = await Promise.all(candidates.map(async (id) => {
    try {
      const [ownerValue, dataValue, uriValue] = await Promise.all([
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.ownerOf, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.equipmentData, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.tokenURI, uintWord(id)))
      ]);
      const owner = decodeAbiAddress(ownerValue);
      const words = splitAbiWords(dataValue);
      const data = {
        definitionId: Number(BigInt(`0x${words[0]}`)),
        armorHp: Number(BigInt(`0x${words[1]}`)),
        itemType: Number(BigInt(`0x${words[2]}`)),
        rarity: Number(BigInt(`0x${words[3]}`)),
        damaged: BigInt(`0x${words[4]}`) !== 0n,
        equippedToMiner: Number(BigInt(`0x${words[5]}`))
      };
      if (!sameAddress(owner, state.account) && !ownedMinerIds.has(data.equippedToMiner)) return null;
      return {
        id,
        owner,
        tokenUri: decodeAbiString(uriValue),
        metadata: await fetchMetadata(decodeAbiString(uriValue)),
        ...data
      };
    } catch (error) {
      scanErrors.push(`Equipment #${id}: ${error?.message || error}`);
      return null;
    }
  }));
  const relevant = equipment.filter(Boolean).sort((left, right) => left.id - right.id);
  if (!relevant.length && candidates.length && scanErrors.length === candidates.length) {
    throw new Error(`Equipment scan failed — ${scanErrors[0]}`);
  }
  return relevant;
}

async function fetchMetadata(uri) {
  const url = uri.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${uri.slice(7)}` : uri;
  let requestUrl = withCacheBuster(url);
  if (typeof location !== 'undefined') {
    const parsed = new URL(url, location.href);
    if (parsed.origin === 'https://matt-mine.onrender.com' && parsed.origin !== location.origin) {
      requestUrl = `/api/nft-lab/metadata?url=${encodeURIComponent(url)}&_matt=${Date.now()}`;
    }
  }
  const response = await fetch(requestUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Metadata returned HTTP ${response.status}: ${url}`);
  const metadata = await response.json();
  if (!metadata?.name || !metadata?.image) throw new Error(`Metadata is missing name or image: ${url}`);
  return metadata;
}

function withCacheBuster(url) {
  const separator = String(url).includes('?') ? '&' : '?';
  return `${url}${separator}_matt=${Date.now()}`;
}

function displayImageUrl(url) {
  if (typeof location !== 'undefined') {
    const parsed = new URL(url, location.href);
    if (parsed.origin === 'https://matt-mine.onrender.com' && parsed.origin !== location.origin) {
      return `/api/nft-lab/image?url=${encodeURIComponent(url)}&_matt=${Date.now()}`;
    }
  }
  return withCacheBuster(url);
}

function renderConnection() {
  dom('wallet-address').textContent = state.account || 'NOT CONNECTED';
  dom('wallet-network').textContent = state.account ? `${NFT_LAB_CHAIN.name} · ${NFT_LAB_CHAIN.id}` : 'Waiting for Ronin Wallet';
  dom('matt-balance').textContent = state.account ? `${formatTokenUnits(state.mattBalance)} TEST MATT` : 'TEST MATT --';
  dom('connect-button').textContent = state.account ? shortAddress(state.account) : 'CONNECT RONIN';
  dom('refresh-button').disabled = state.busy || !state.account;
}

function renderDisconnected() {
  state.miners = [];
  state.equipment = [];
  state.mattBalance = 0n;
  renderAll();
  renderConnection();
  setStatus('Connect the test-player wallet to load Miner #1 and Miner #2.');
}

function renderAll() {
  renderMinerList();
  renderSelectedMiner();
  renderEquipment();
  void renderStorePrices();
  void renderArmorService();
  renderSettlementState();
}

function selectedMiner() {
  return state.miners.find((miner) => miner.id === state.selectedMinerId) || null;
}

export function equippedTokenForItem(miner, itemType) {
  if (!miner?.loadout) return 0;
  if (Number(itemType) === 0) return miner.loadout.weapon || 0;
  if (Number(itemType) === 1) return 0;
  if (Number(itemType) === 2) return miner.loadout.helmet || 0;
  if (Number(itemType) === 3) return miner.loadout.armor || 0;
  throw new Error(`Unknown equipment item type: ${itemType}`);
}

function renderMinerList() {
  const list = dom('miner-list');
  list.replaceChildren();
  for (const miner of state.miners) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `miner-option${miner.id === state.selectedMinerId ? ' active' : ''}`;
    const image = document.createElement('img');
    image.src = displayImageUrl(miner.metadata.image);
    image.alt = '';
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = miner.metadata.name;
    const level = document.createElement('small');
    level.textContent = `LEVEL ${metadataTrait(miner.metadata, 'Level') || 1}`;
    copy.append(name, level);
    button.append(image, copy);
    button.addEventListener('click', () => {
      state.selectedMinerId = miner.id;
      renderMinerList();
      renderSelectedMiner();
      renderEquipment();
      void renderArmorService();
      renderSettlementState();
    });
    list.append(button);
  }
}

function renderSelectedMiner() {
  const miner = selectedMiner();
  const image = dom('active-miner-image');
  const empty = dom('active-miner-empty');
  const traits = dom('active-miner-traits');
  traits.replaceChildren();
  if (!miner) {
    dom('active-miner-name').textContent = 'NO MINER SELECTED';
    dom('active-miner-level').textContent = 'LEVEL --';
    dom('run-lock-chip').textContent = 'UNLOCKED';
    image.hidden = true;
    empty.hidden = false;
    renderLoadout(null);
    return;
  }
  dom('active-miner-name').textContent = miner.metadata.name;
  dom('active-miner-level').textContent = `LEVEL ${metadataTrait(miner.metadata, 'Level') || 1}`;
  dom('run-lock-chip').textContent = miner.loadout.runLocked ? 'RUN LOCKED' : 'UNLOCKED';
  dom('run-lock-chip').style.color = miner.loadout.runLocked ? 'var(--danger)' : 'var(--cyan)';
  image.src = displayImageUrl(miner.metadata.image);
  image.hidden = false;
  empty.hidden = true;
  for (const traitName of ['Evolution', 'Banked XP', 'Maximum Health', 'Crystal Carry', 'Armor State']) {
    const row = document.createElement('div');
    row.className = 'trait-row';
    const term = document.createElement('dt');
    term.textContent = traitName.toUpperCase();
    const value = document.createElement('dd');
    value.textContent = String(metadataTrait(miner.metadata, traitName) ?? '—');
    row.append(term, value);
    traits.append(row);
  }
  renderLoadout(miner);
}

function renderLoadout(miner) {
  const container = dom('loadout-slots');
  container.replaceChildren();
  for (const slot of SLOT_KEYS) {
    const tokenId = miner?.loadout?.[slot.key] || 0;
    const equipment = state.equipment.find((item) => item.id === tokenId);
    const card = document.createElement('div');
    card.className = `loadout-slot${tokenId ? ' filled' : ''}`;
    const label = document.createElement('span');
    label.textContent = slot.label;
    const name = document.createElement('strong');
    name.textContent = equipment?.metadata?.name || (tokenId ? `EQUIPMENT #${tokenId}` : 'EMPTY');
    const detail = document.createElement('small');
    detail.textContent = tokenId
      ? `${RARITIES[equipment?.rarity] || 'Unknown'} · TOKEN #${tokenId}${equipment?.damaged ? ' · DAMAGED' : ''}${slot.key === 'backpackHead' && miner.loadout.backpackCount > 1 ? ` · ${miner.loadout.backpackCount - 1} QUEUED` : ''}`
      : slot.key === 'weapon' ? 'Starter pickaxe remains active' : 'No NFT equipped';
    card.append(label, name, detail);
    container.append(card);
  }
}

function renderEquipment() {
  const list = dom('equipment-list');
  list.replaceChildren();
  dom('equipment-count').textContent = `${state.equipment.length} ITEM${state.equipment.length === 1 ? '' : 'S'}`;
  if (!state.equipment.length) {
    const empty = document.createElement('p');
    empty.className = 'inventory-empty';
    empty.textContent = state.account ? 'No equipment NFTs yet. Buy the first backpack to test the complete loadout flow.' : 'Connect Ronin Wallet to scan the Equipment contract.';
    list.append(empty);
    return;
  }
  const miner = selectedMiner();
  for (const item of state.equipment) {
    const card = document.createElement('article');
    card.className = `equipment-card${item.equippedToMiner ? ' equipped' : ''}`;
    const image = document.createElement('img');
    image.src = displayImageUrl(item.metadata.image);
    image.alt = '';
    const copy = document.createElement('div');
    copy.className = 'equipment-copy';
    const name = document.createElement('strong');
    name.textContent = item.metadata.name;
    const details = document.createElement('small');
    details.textContent = `${RARITIES[item.rarity] || 'Unknown'} ${ITEM_TYPES[item.itemType] || 'Equipment'} · TOKEN #${item.id}${item.damaged ? ' · DAMAGED' : ''}`;
    const stateCopy = document.createElement('small');
    stateCopy.textContent = item.equippedToMiner ? `EQUIPPED TO MINER #${item.equippedToMiner}` : `OWNED BY ${shortAddress(item.owner)}`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = `item-action${item.equippedToMiner ? ' unequip' : ''}`;
    const locked = item.equippedToMiner
      ? !state.miners.some((owned) => owned.id === item.equippedToMiner)
      : !miner || miner.loadout.runLocked;
    action.dataset.locked = String(locked);
    action.disabled = state.busy || locked;
    const occupiedTokenId = !item.equippedToMiner && miner ? equippedTokenForItem(miner, item.itemType) : 0;
    action.textContent = item.equippedToMiner
      ? 'UNEQUIP'
      : miner
        ? occupiedTokenId ? `REPLACE ON #${miner.id}` : `EQUIP TO #${miner.id}`
        : 'SELECT MINER';
    action.addEventListener('click', () => void mutateLoadout(item));
    copy.append(name, details, stateCopy, action);
    card.append(image, copy);
    list.append(card);
  }
}

function metadataTrait(metadata, name) {
  return Array.isArray(metadata?.attributes)
    ? metadata.attributes.find((attribute) => attribute?.trait_type === name)?.value
    : undefined;
}

async function mutateLoadout(item) {
  if (state.busy) return;
  const miner = item.equippedToMiner
    ? state.miners.find((owned) => owned.id === item.equippedToMiner)
    : selectedMiner();
  if (!miner) return setStatus('Select an owned Miner first.', 'error');
  setBusy(true);
  try {
    if (item.equippedToMiner) {
      const previousBackpack = item.itemType === 1 ? backpackPredecessor(miner, item.id) : 0;
      await sendTransaction(
        NFT_LAB_CONTRACTS.loadout,
        encodeCall(ABI_SELECTORS.unequip, uintWord(miner.id), uintWord(item.id), uintWord(previousBackpack)),
        `unequip Equipment #${item.id}`
      );
    } else {
      const occupiedTokenId = equippedTokenForItem(miner, item.itemType);
      if (occupiedTokenId) {
        await sendTransaction(
          NFT_LAB_CONTRACTS.loadout,
          encodeCall(ABI_SELECTORS.unequip, uintWord(miner.id), uintWord(occupiedTokenId), uintWord(0)),
          `unequip Equipment #${occupiedTokenId} before replacement`
        );
      }
      const approved = decodeAbiAddress(await callContract(
        NFT_LAB_CONTRACTS.equipment,
        encodeCall(ABI_SELECTORS.getApproved, uintWord(item.id))
      ));
      if (!sameAddress(approved, NFT_LAB_CONTRACTS.loadout)) {
        await sendTransaction(
          NFT_LAB_CONTRACTS.equipment,
          encodeCall(ABI_SELECTORS.approve, addressWord(NFT_LAB_CONTRACTS.loadout), uintWord(item.id)),
          `approve Equipment #${item.id}`
        );
      }
      await sendTransaction(
        NFT_LAB_CONTRACTS.loadout,
        encodeCall(ABI_SELECTORS.equip, uintWord(miner.id), uintWord(item.id)),
        `equip Equipment #${item.id} to Miner #${miner.id}`
      );
    }
    await refreshAll();
    setStatus(`Loadout updated. Miner #${miner.id} artwork was refreshed from the live metadata service.`, 'success');
  } catch (error) {
    setStatus(error?.message || 'Loadout transaction failed.', 'error');
  } finally {
    setBusy(false);
  }
}

function backpackPredecessor(miner, tokenId) {
  const index = miner.loadout.backpackOrder.indexOf(tokenId);
  if (index < 0) throw new Error(`Backpack #${tokenId} is not in Miner #${miner.id}'s queue.`);
  return index === 0 ? 0 : miner.loadout.backpackOrder[index - 1];
}

async function renderStorePrices() {
  const chestButtons = [...document.querySelectorAll('[data-chest-type]')];
  await Promise.all(chestButtons.map(async (button) => {
    const chestType = Number(button.dataset.chestType);
    const product = CHEST_PRODUCTS.find((candidate) => candidate.type === chestType);
    let price = product?.fallbackPrice || 0n;
    try {
      price = decodeAbiUint(await callContract(
        NFT_LAB_CONTRACTS.chest,
        encodeCall(ABI_SELECTORS.chestPrice, uintWord(chestType))
      ));
    } catch {}
    button.textContent = `OPEN · ${formatTokenUnits(price)} TEST MATT`;
    button.dataset.locked = String(!state.account);
    button.disabled = state.busy || !state.account;
  }));
  const backpackButton = dom('buy-backpack-button');
  let backpackPrice = 5n * 10n ** 18n;
  try {
    backpackPrice = decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.chest, ABI_SELECTORS.backpackPrice));
  } catch {}
  backpackButton.textContent = `BUY · ${formatTokenUnits(backpackPrice)} TEST MATT`;
  backpackButton.dataset.locked = String(!state.account);
  backpackButton.disabled = state.busy || !state.account;
}

async function ensureMattApproval(spender, price, label) {
  const [allowanceValue, balanceValue] = await Promise.all([
    callContract(
      NFT_LAB_CONTRACTS.matt,
      encodeCall(ABI_SELECTORS.allowance, addressWord(state.account), addressWord(spender))
    ),
    callContract(NFT_LAB_CONTRACTS.matt, encodeCall(ABI_SELECTORS.balanceOf, addressWord(state.account)))
  ]);
  const allowance = decodeAbiUint(allowanceValue);
  const balance = decodeAbiUint(balanceValue);
  if (balance < price) {
    throw new Error(`This wallet needs ${formatTokenUnits(price)} test MATT but has ${formatTokenUnits(balance)}.`);
  }
  if (allowance < price) {
    await sendTransaction(
      NFT_LAB_CONTRACTS.matt,
      encodeCall(ABI_SELECTORS.approve, addressWord(spender), uintWord(price)),
      `${formatTokenUnits(price)} test MATT for ${label}`
    );
  }
}

async function openChest(chestType) {
  if (state.busy || !state.account) return;
  const product = CHEST_PRODUCTS.find((candidate) => candidate.type === Number(chestType));
  if (!product) return setStatus(`Unknown chest type ${chestType}.`, 'error');
  setBusy(true);
  try {
    const [priceValue, nextTokenValue] = await Promise.all([
      callContract(NFT_LAB_CONTRACTS.chest, encodeCall(ABI_SELECTORS.chestPrice, uintWord(product.type))),
      callContract(NFT_LAB_CONTRACTS.equipment, ABI_SELECTORS.nextTokenId)
    ]);
    const price = decodeAbiUint(priceValue);
    const beforeNextTokenId = decodeAbiUint(nextTokenValue);
    await ensureMattApproval(NFT_LAB_CONTRACTS.chest, price, product.label);
    const hash = await sendTransaction(
      NFT_LAB_CONTRACTS.chest,
      encodeCall(ABI_SELECTORS.openChest, uintWord(product.type)),
      `open ${product.label}`
    );
    setStatus(`${product.label} paid. Waiting for the Saigon mint...`, 'busy');
    const afterNextTokenId = await waitForTokenIdIncrease(
      async () => decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.equipment, ABI_SELECTORS.nextTokenId)),
      beforeNextTokenId
    );
    await refreshAll();
    setStatus(
      afterNextTokenId > beforeNextTokenId
        ? `${product.label} fulfilled. The new equipment NFT is now in inventory.`
        : `${product.label} randomness request ${hash.slice(0, 10)}… is still queued. It will appear automatically when fulfilled.`,
      'success'
    );
  } catch (error) {
    setStatus(error?.message || `${product.label} transaction failed.`, 'error');
  } finally {
    setBusy(false);
  }
}

async function buyBackpack() {
  if (state.busy || !state.account) return;
  setBusy(true);
  try {
    const priceValue = await callContract(NFT_LAB_CONTRACTS.chest, ABI_SELECTORS.backpackPrice);
    const price = decodeAbiUint(priceValue);
    await ensureMattApproval(NFT_LAB_CONTRACTS.chest, price, 'one backpack');
    await sendTransaction(NFT_LAB_CONTRACTS.chest, ABI_SELECTORS.purchaseBackpack, 'purchase one backpack');
    await refreshAll();
    setStatus('Backpack minted directly to the connected wallet. It is ready to equip.', 'success');
  } catch (error) {
    setStatus(error?.message || 'Backpack purchase failed.', 'error');
  } finally {
    setBusy(false);
  }
}

async function renderArmorService() {
  const miner = selectedMiner();
  const armor = miner?.loadout?.armor
    ? state.equipment.find((item) => item.id === miner.loadout.armor)
    : null;
  const button = dom('repair-armor-button');
  let price = 35n * 10n ** 16n;
  try {
    price = decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.loadout, ABI_SELECTORS.repairPrice));
  } catch {}
  button.textContent = `REPAIR · ${formatTokenUnits(price)} TEST MATT`;
  const enabled = Boolean(state.account && miner && armor?.damaged && !miner.loadout.runLocked);
  button.dataset.locked = String(!enabled);
  button.disabled = state.busy || !enabled;
  dom('armor-service-copy').textContent = !miner
    ? 'Select a Miner to inspect its armor.'
    : !armor
      ? 'No armor equipped. Equip an armor NFT first.'
      : armor.damaged
        ? `${armor.metadata.name} is damaged and currently provides no extra health.`
        : `${armor.metadata.name} is healthy at ${armor.armorHp} maximum HP.`;
}

async function repairSelectedArmor() {
  if (state.busy || !state.account) return;
  const miner = selectedMiner();
  const armor = miner?.loadout?.armor
    ? state.equipment.find((item) => item.id === miner.loadout.armor)
    : null;
  if (!miner || !armor) return setStatus('Select a Miner with equipped armor first.', 'error');
  if (!armor.damaged) return setStatus(`Armor #${armor.id} is already healthy.`, 'error');
  setBusy(true);
  try {
    const price = decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.loadout, ABI_SELECTORS.repairPrice));
    await ensureMattApproval(NFT_LAB_CONTRACTS.loadout, price, `repair Armor #${armor.id}`);
    await sendTransaction(
      NFT_LAB_CONTRACTS.loadout,
      encodeCall(ABI_SELECTORS.repairArmor, uintWord(miner.id)),
      `repair Armor #${armor.id}`
    );
    await refreshAll();
    setStatus(`Armor #${armor.id} repaired. Miner #${miner.id} has its full armor health again.`, 'success');
  } catch (error) {
    setStatus(error?.message || 'Armor repair failed.', 'error');
  } finally {
    setBusy(false);
  }
}

function renderSettlementState() {
  const miner = selectedMiner();
  const copy = dom('settlement-miner-copy');
  if (!miner) {
    copy.textContent = 'SELECT A MINER';
    return;
  }
  const armor = miner.loadout.armor ? state.equipment.find((item) => item.id === miner.loadout.armor) : null;
  copy.textContent = `MINER #${miner.id} · ${miner.loadout.runLocked ? 'RUN LOCKED' : 'READY'} · ${miner.loadout.backpackCount} BACKPACK${miner.loadout.backpackCount === 1 ? '' : 'S'} · ARMOR ${armor ? armor.damaged ? 'DAMAGED' : 'HEALTHY' : 'NONE'}`;
}

function initialize() {
  dom('connect-button').addEventListener('click', connectWallet);
  dom('refresh-button').addEventListener('click', () => void refreshAll());
  dom('buy-backpack-button').addEventListener('click', () => void buyBackpack());
  dom('repair-armor-button').addEventListener('click', () => void repairSelectedArmor());
  document.querySelectorAll('[data-chest-type]').forEach((button) => {
    button.addEventListener('click', () => void openChest(Number(button.dataset.chestType)));
  });
  renderAll();
  renderConnection();
}

if (typeof document !== 'undefined') initialize();
