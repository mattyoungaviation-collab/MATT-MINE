export const NFT_LAB_CHAIN = Object.freeze({
  id: 2020,
  hexId: '0x7e4',
  name: 'Ronin Mainnet',
  rpcUrl: 'https://api.roninchain.com/rpc',
  explorerUrl: 'https://explorer.roninchain.com'
});

export const SELECTED_MINER_STORAGE_KEY = 'matt-mine:selected-nft-miner';

export const NFT_LAB_CONTRACTS = Object.freeze({
  miner: '0xBbaBE35B943E3Ba911B53C2b39447cF181fE565A',
  equipment: '0x415cF1DeA47f3d4BAb830F78B82e12D6EeceD612',
  loadout: '0xb88C219C792cFa07749E0E5D939DbbbF1E62C7b5',
  chest: '0x693525e7fD76949834cad56d67D469bAAd6687F6',
  settlement: '0x21BEe81AdC4c87e3Ea4686DD8a38a64c8Ea5b95c',
  matt: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d'
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
  unequip: '0xcdb6dd5c',
  isRunLocked: '0x2259acda',
  bonusFor: '0x213b4056',
  allowance: '0xdd62ed3e',
  balanceOf: '0x70a08231',
  openChest: '0x99ae54a9',
  chestPrice: '0xdb79e06f',
  repairPrice: '0x48d54bba',
  repairArmor: '0x9981f16d'
});

export const CHEST_PRODUCTS = Object.freeze([
  Object.freeze({ slot: 0, key: 'armor', label: 'Armor Chest', fallbackPrice: 2_500_000n * 10n ** 18n }),
  Object.freeze({ slot: 1, key: 'pickaxe', label: 'Pickaxe Chest', fallbackPrice: 1_000_000n * 10n ** 18n }),
  Object.freeze({ slot: 2, key: 'blaster', label: 'Blaster Chest', fallbackPrice: 1_000_000n * 10n ** 18n }),
  Object.freeze({ slot: 3, key: 'dynamite', label: 'Dynamite Chest', fallbackPrice: 1_000_000n * 10n ** 18n }),
  Object.freeze({ slot: 4, key: 'helmet', label: 'Helmet Chest', fallbackPrice: 1_000_000n * 10n ** 18n }),
  Object.freeze({ slot: 5, key: 'backpack', label: 'Backpack Chest', fallbackPrice: 2_500_000n * 10n ** 18n })
]);

const ITEM_TYPES = ['Armor', 'Pickaxe', 'Blaster', 'Dynamite', 'Helmet', 'Backpack'];
const RARITIES = ['Common', 'Uncommon', 'Rare', 'Mythic', 'Legendary'];
const SLOT_KEYS = [
  { key: 'armor', label: 'ARMOR' },
  { key: 'pickaxe', label: 'PICKAXE' },
  { key: 'blaster', label: 'BLASTER' },
  { key: 'dynamite', label: 'DYNAMITE' },
  { key: 'helmet', label: 'HELMET' },
  { key: 'backpack', label: 'BACKPACK' }
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
  const response = await fetch('/api/nft-lab/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcRequestId, method, params })
  });
  if (!response.ok) throw new Error(`MATT Mine Mainnet RPC returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || `Ronin Mainnet RPC ${method} failed.`);
  return payload.result;
}

async function sendTransaction(to, data, label) {
  setStatus(`Approve ${label} in Ronin Wallet.`, 'busy');
  const hash = await state.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: state.account, to, data, value: '0x0' }]
  });
  if (!/^0x[0-9a-f]{64}$/i.test(hash || '')) throw new Error('Ronin Wallet did not return a transaction hash.');
  setStatus(`${label} submitted. Waiting for Ronin Mainnet confirmation…`, 'busy');
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

async function switchToMainnet() {
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
    await switchToMainnet();
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
  setStatus('Reading the activated Miner and Equipment contracts from Ronin Mainnet…', 'busy');
  try {
    await switchToMainnet();
    const [miners, mattBalance] = await Promise.all([
      loadOwnedMiners(),
      callContract(NFT_LAB_CONTRACTS.matt, encodeCall(ABI_SELECTORS.balanceOf, addressWord(state.account)))
        .then(decodeAbiUint)
    ]);
    const equipment = await loadRelevantEquipment(miners);
    state.miners = miners;
    state.equipment = equipment;
    state.mattBalance = mattBalance;
    if (!miners.some((miner) => miner.id === state.selectedMinerId)) {
      const requestedMinerId = preferredMinerId();
      state.selectedMinerId = miners.find((miner) => miner.id === requestedMinerId)?.id || miners[0]?.id || null;
    }
    renderAll();
    setStatus(
      miners.length
        ? `Loaded ${miners.length} Miner NFT${miners.length === 1 ? '' : 's'} and ${equipment.length} equipment item${equipment.length === 1 ? '' : 's'} directly from chain.`
        : `No Miner NFTs found for ${shortAddress(state.account)} on Ronin Mainnet.`,
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
  const requestedMinerId = preferredMinerId();
  const candidates = requestedMinerId
    ? [requestedMinerId].filter((id) => id < nextId)
    : Array.from({ length: Math.max(0, nextId - 1) }, (_, index) => index + 1);
  const scanErrors = [];
  const miners = await Promise.all(candidates.map(async (id) => {
    try {
      const owner = decodeAbiAddress(await callContract(
        NFT_LAB_CONTRACTS.miner,
        encodeCall(ABI_SELECTORS.ownerOf, uintWord(id))
      ));
      if (!sameAddress(owner, state.account)) return null;
      const [uriValue, loadoutValue, runLockedValue] = await Promise.all([
        callContract(NFT_LAB_CONTRACTS.miner, encodeCall(ABI_SELECTORS.tokenURI, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.loadout, encodeCall(ABI_SELECTORS.loadoutOf, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.miner, encodeCall(ABI_SELECTORS.isRunLocked, uintWord(id)))
      ]);
      const metadata = await fetchMetadata(decodeAbiString(uriValue));
      const loadoutWords = splitAbiWords(loadoutValue);
      const miner = {
        id,
        owner,
        tokenUri: decodeAbiString(uriValue),
        metadata,
        loadout: {
          armor: Number(BigInt(`0x${loadoutWords[0]}`)),
          pickaxe: Number(BigInt(`0x${loadoutWords[1]}`)),
          blaster: Number(BigInt(`0x${loadoutWords[2]}`)),
          dynamite: Number(BigInt(`0x${loadoutWords[3]}`)),
          helmet: Number(BigInt(`0x${loadoutWords[4]}`)),
          backpack: Number(BigInt(`0x${loadoutWords[5]}`)),
          runLocked: decodeAbiUint(runLockedValue) !== 0n
        }
      };
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

async function loadRelevantEquipment(ownedMiners) {
  const nextId = Number(decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.equipment, ABI_SELECTORS.nextTokenId)));
  const ownedMinerIds = new Set(ownedMiners.map((miner) => miner.id));
  const candidates = Array.from({ length: Math.max(0, nextId - 1) }, (_, index) => index + 1);
  const scanErrors = [];
  const equipment = await Promise.all(candidates.map(async (id) => {
    try {
      const [ownerValue, dataValue, uriValue, bonusValue] = await Promise.all([
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.ownerOf, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.equipmentData, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.tokenURI, uintWord(id))),
        callContract(NFT_LAB_CONTRACTS.equipment, encodeCall(ABI_SELECTORS.bonusFor, uintWord(id)))
      ]);
      const owner = decodeAbiAddress(ownerValue);
      const words = splitAbiWords(dataValue);
      const data = {
        definitionId: Number(BigInt(`0x${words[0]}`)),
        equippedToMiner: Number(BigInt(`0x${words[1]}`)),
        slot: Number(BigInt(`0x${words[2]}`)),
        rarity: Number(BigInt(`0x${words[3]}`)),
        damaged: BigInt(`0x${words[4]}`) !== 0n,
        bonus: Number(decodeAbiUint(bonusValue))
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
  dom('matt-balance').textContent = state.account ? `${formatTokenUnits(state.mattBalance)} MATT` : 'MATT --';
  dom('connect-button').textContent = state.account ? shortAddress(state.account) : 'CONNECT RONIN';
  dom('refresh-button').disabled = state.busy || !state.account;
}

function renderDisconnected() {
  state.miners = [];
  state.equipment = [];
  state.mattBalance = 0n;
  renderAll();
  renderConnection();
  setStatus('Connect the Ronin Mainnet wallet that owns your Miner NFT.');
}

function renderAll() {
  renderMinerList();
  renderSelectedMiner();
  renderEquipment();
  void renderStorePrices();
  void renderArmorService();
  renderSettlementState();
  renderConfirmLoadout();
}

export function preferredMinerId(search = globalThis.location?.search || '') {
  const value = new URLSearchParams(search).get('miner');
  const minerId = Number(value || 0);
  return Number.isSafeInteger(minerId) && minerId > 0 && minerId <= 1_000 ? minerId : 0;
}

function selectedMiner() {
  return state.miners.find((miner) => miner.id === state.selectedMinerId) || null;
}

function renderConfirmLoadout() {
  const miner = selectedMiner();
  const button = dom('confirm-loadout-button');
  const copy = dom('confirm-loadout-copy');
  const enabled = Boolean(state.account && miner && !miner.loadout.runLocked);
  button.disabled = state.busy || !enabled;
  button.dataset.locked = String(!enabled);
  button.textContent = miner ? `CONFIRM MINER #${miner.id} LOADOUT` : 'CONFIRM LOADOUT';
  copy.textContent = !miner
    ? 'Select a Miner and finish equipping its gear.'
    : miner.loadout.runLocked
      ? `Miner #${miner.id} is locked in a run and cannot change loadout.`
      : `Return Miner #${miner.id} to the main game with this on-chain loadout.`;
}

export function equippedTokenForItem(miner, itemType) {
  if (!miner?.loadout) return 0;
  const slot = SLOT_KEYS[Number(itemType)];
  if (!slot) throw new Error(`Unknown equipment slot: ${itemType}`);
  return miner.loadout[slot.key] || 0;
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
      renderConfirmLoadout();
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
  for (const traitName of ['Evolution', 'Banked XP', 'Maximum Health', 'Crystal Carry Capacity', 'Armor State']) {
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
      ? `${RARITIES[equipment?.rarity] || 'Unknown'} · TOKEN #${tokenId} · BONUS +${equipment?.bonus || 0}${equipment?.damaged ? ' · DAMAGED' : ''}`
      : slot.key === 'pickaxe' ? 'Base pickaxe attack remains active' : 'No NFT equipped';
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
    details.textContent = `${RARITIES[item.rarity] || 'Unknown'} ${ITEM_TYPES[item.slot] || 'Equipment'} · TOKEN #${item.id} · BONUS +${item.bonus}${item.damaged ? ' · DAMAGED' : ''}`;
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
    const occupiedTokenId = !item.equippedToMiner && miner ? equippedTokenForItem(miner, item.slot) : 0;
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
      await sendTransaction(
        NFT_LAB_CONTRACTS.loadout,
        encodeCall(ABI_SELECTORS.unequip, uintWord(miner.id), uintWord(item.slot)),
        `unequip Equipment #${item.id}`
      );
    } else {
      const occupiedTokenId = equippedTokenForItem(miner, item.slot);
      if (occupiedTokenId) {
        await sendTransaction(
          NFT_LAB_CONTRACTS.loadout,
          encodeCall(ABI_SELECTORS.unequip, uintWord(miner.id), uintWord(item.slot)),
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

async function renderStorePrices() {
  const chestButtons = [...document.querySelectorAll('[data-chest-slot]')];
  await Promise.all(chestButtons.map(async (button) => {
    const chestSlot = Number(button.dataset.chestSlot);
    const product = CHEST_PRODUCTS.find((candidate) => candidate.slot === chestSlot);
    let price = product?.fallbackPrice || 0n;
    try {
      price = decodeAbiUint(await callContract(
        NFT_LAB_CONTRACTS.chest,
        encodeCall(ABI_SELECTORS.chestPrice, uintWord(chestSlot))
      ));
    } catch {}
    button.textContent = `OPEN · ${formatTokenUnits(price)} MATT`;
    button.dataset.locked = String(!state.account);
    button.disabled = state.busy || !state.account;
  }));
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
    throw new Error(`This wallet needs ${formatTokenUnits(price)} MATT but has ${formatTokenUnits(balance)}.`);
  }
  if (allowance < price) {
    await sendTransaction(
      NFT_LAB_CONTRACTS.matt,
      encodeCall(ABI_SELECTORS.approve, addressWord(spender), uintWord(price)),
      `${formatTokenUnits(price)} MATT for ${label}`
    );
  }
}

async function openChest(chestSlot) {
  if (state.busy || !state.account) return;
  const product = CHEST_PRODUCTS.find((candidate) => candidate.slot === Number(chestSlot));
  if (!product) return setStatus(`Unknown chest slot ${chestSlot}.`, 'error');
  setBusy(true);
  try {
    const [priceValue, nextTokenValue] = await Promise.all([
      callContract(NFT_LAB_CONTRACTS.chest, encodeCall(ABI_SELECTORS.chestPrice, uintWord(product.slot))),
      callContract(NFT_LAB_CONTRACTS.equipment, ABI_SELECTORS.nextTokenId)
    ]);
    const price = decodeAbiUint(priceValue);
    const beforeNextTokenId = decodeAbiUint(nextTokenValue);
    await ensureMattApproval(NFT_LAB_CONTRACTS.chest, price, product.label);
    const hash = await sendTransaction(
      NFT_LAB_CONTRACTS.chest,
      encodeCall(ABI_SELECTORS.openChest, uintWord(product.slot)),
      `open ${product.label}`
    );
    setStatus(`${product.label} paid. Waiting for Ronin VRF to mint the equipment…`, 'busy');
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

async function renderArmorService() {
  const miner = selectedMiner();
  const armor = miner?.loadout?.armor
    ? state.equipment.find((item) => item.id === miner.loadout.armor)
    : null;
  const button = dom('repair-armor-button');
  let price = 500_000n * 10n ** 18n;
  try {
    price = decodeAbiUint(await callContract(NFT_LAB_CONTRACTS.loadout, ABI_SELECTORS.repairPrice));
  } catch {}
  button.textContent = `REPAIR · ${formatTokenUnits(price)} MATT`;
  const enabled = Boolean(state.account && miner && armor?.damaged && !miner.loadout.runLocked);
  button.dataset.locked = String(!enabled);
  button.disabled = state.busy || !enabled;
  dom('armor-service-copy').textContent = !miner
    ? 'Select a Miner to inspect its armor.'
    : !armor
      ? 'No armor equipped. Equip an armor NFT first.'
      : armor.damaged
        ? `${armor.metadata.name} is damaged and currently provides no shield.`
        : `${armor.metadata.name} is healthy and provides +${armor.bonus} shield HP.`;
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
    setStatus(`Armor #${armor.id} repaired. Miner #${miner.id} has its armor shield again.`, 'success');
  } catch (error) {
    setStatus(error?.message || 'Armor repair failed.', 'error');
  } finally {
    setBusy(false);
  }
}

async function confirmSelectedLoadout() {
  if (state.busy || !state.provider || !state.account) return;
  const miner = selectedMiner();
  if (!miner) return setStatus('Select a Miner before confirming its loadout.', 'error');
  if (miner.loadout.runLocked) return setStatus(`Miner #${miner.id} is currently locked in a run.`, 'error');
  setBusy(true);
  setStatus(`Saving Miner #${miner.id} as the active Mainnet loadout…`, 'busy');
  try {
    sessionStorage.setItem(SELECTED_MINER_STORAGE_KEY, String(miner.id));
    location.assign(`/?loadout=confirmed&miner=${miner.id}`);
  } catch (error) {
    setStatus(error?.message || 'Could not save the selected Mainnet loadout.', 'error');
    setBusy(false);
    renderConfirmLoadout();
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
  copy.textContent = `MINER #${miner.id} · ${miner.loadout.runLocked ? 'RUN LOCKED' : 'READY'} · BACKPACK ${miner.loadout.backpack ? 'EQUIPPED' : 'NONE'} · ARMOR ${armor ? armor.damaged ? 'DAMAGED' : 'HEALTHY' : 'NONE'}`;
}

function initialize() {
  dom('connect-button').addEventListener('click', connectWallet);
  dom('refresh-button').addEventListener('click', () => void refreshAll());
  dom('repair-armor-button').addEventListener('click', () => void repairSelectedArmor());
  dom('confirm-loadout-button').addEventListener('click', () => void confirmSelectedLoadout());
  document.querySelectorAll('[data-chest-slot]').forEach((button) => {
    button.addEventListener('click', () => void openChest(Number(button.dataset.chestSlot)));
  });
  renderAll();
  renderConnection();
}

if (typeof document !== 'undefined') initialize();
