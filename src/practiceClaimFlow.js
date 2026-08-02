import { resolveRoninProvider } from './game/walletProvider.js';

const SESSION_STORAGE_KEY = 'matt-mine-server-session-v1';
const RONIN_CHAIN_ID = 2020;

if (typeof document !== 'undefined') {
  document.querySelector('#practice-claim-button')?.addEventListener('click', handlePracticeClaim, { capture: true });
}

async function handlePracticeClaim(event) {
  const token = sessionToken();
  if (!token) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const button = document.querySelector('#practice-claim-button');
  const decline = document.querySelector('#practice-decline-button');
  setBusy(button, decline, 'CHECKING SERVER…');

  try {
    const status = await request('/api/nuggets/status', token);
    const economy = status.economy;
    if (!economy?.livePaymentVerification || !economy.config?.practiceClaimsEnabled) {
      throw new Error(economy?.releaseBlocker || 'Paid Practice claims are currently disabled. You may decline the reward without paying.');
    }

    const me = await request('/api/me', token);
    const claim = (me.player?.nuggetEconomy?.pendingPracticeClaims || [])
      .filter((entry) => entry.status === 'pending' && entry.expiresAt > Date.now())
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!claim) throw new Error('No pending server Practice claim was found for this run.');

    if (button) button.textContent = 'CREATING EXACT QUOTE…';
    const quoted = await request('/api/nuggets/practice/quote', token, {
      method: 'POST',
      body: { runId: claim.runId }
    });
    const quote = quoted.quote;
    const approved = window.confirm(
      `Claim ${formatNumber(quote.nuggets)} Practice nuggets for exactly ${formatAtomic(quote.amountAtomic)} ${quote.asset}? ` +
      `The quote expires at ${new Date(quote.expiresAt).toLocaleTimeString('en-US')}. A successful verified payment is final.`
    );
    if (!approved) {
      restore(button, decline);
      return;
    }

    if (button) button.textContent = 'CONFIRM IN RONIN WALLET';
    const transactionHash = await sendTransaction(quote.transaction, quote.asset, me.player.address);
    if (button) button.textContent = 'VERIFYING EXACT RECEIPT…';
    const accepted = await request('/api/runs/practice/claim', token, {
      method: 'POST',
      body: {
        runId: claim.runId,
        action: 'claim',
        quoteId: quote.id,
        transactionHash
      }
    });

    const balance = accepted.profile?.bankedNuggets;
    if (Number.isSafeInteger(Number(balance))) {
      const menuBalance = document.querySelector('#menu-nuggets');
      if (menuBalance) menuBalance.textContent = Number(balance).toLocaleString('en-US');
    }
    const info = document.querySelector('#practice-claim-info');
    if (info) {
      info.innerHTML = `<strong>Practice rewards claimed.</strong><span>${formatNumber(claim.projectedNuggets)} nuggets were credited by the server.</span><small>${escapeHtml(shortHash(transactionHash))} · exact Ronin receipt verified</small>`;
    }
    const hashWrap = document.querySelector('#practice-claim-hash')?.closest('label');
    if (hashWrap) hashWrap.hidden = true;
    if (button) {
      button.textContent = 'PRACTICE REWARDS CLAIMED';
      button.disabled = true;
    }
    if (decline) decline.disabled = true;
    toast('Practice nuggets credited by the server.');
  } catch (error) {
    toast(error.message);
    restore(button, decline);
  }
}

async function sendTransaction(transaction, asset, expectedAddress) {
  validateTransaction(transaction, asset);
  const { provider } = await resolveRoninProvider({ windowObject: globalThis.window });
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = Array.isArray(accounts) ? accounts[0] : '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) throw new Error('Ronin Wallet did not return a valid account.');
  if (address.toLowerCase() !== String(expectedAddress || '').toLowerCase()) {
    throw new Error('Ronin Wallet is on a different account from the wallet signed in to MATT Mine.');
  }
  let chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
  if (chainId !== RONIN_CHAIN_ID) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${RONIN_CHAIN_ID.toString(16)}` }]
    });
    chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
  }
  if (chainId !== RONIN_CHAIN_ID) throw new Error('Switch Ronin Wallet to Ronin Mainnet.');

  let hash;
  try {
    hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: address, to: transaction.to, value: transaction.value, data: transaction.data }]
    });
  } catch (error) {
    if (Number(error?.code) === 4001) throw new Error('The transaction was canceled in Ronin Wallet.');
    throw new Error(String(error?.message || 'Ronin Wallet could not send the transaction.').replace(/^Error:\s*/i, ''));
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(hash || '')) throw new Error('Ronin Wallet did not return a valid transaction hash.');
  await waitForReceipt(provider, hash);
  return hash.toLowerCase();
}

function validateTransaction(transaction, asset) {
  if (
    !transaction ||
    !/^0x[a-fA-F0-9]{40}$/.test(transaction.to || '') ||
    !/^0x[a-fA-F0-9]+$/.test(transaction.value || '') ||
    !/^0x[a-fA-F0-9]*$/.test(transaction.data || '')
  ) throw new Error('The server did not provide a valid Practice payment transaction.');
  if (asset === 'RON' && (BigInt(transaction.value) <= 0n || transaction.data !== '0x')) {
    throw new Error('The server RON quote is not a safe direct payment.');
  }
  if (asset === 'MATT' && (BigInt(transaction.value) !== 0n || !transaction.data.toLowerCase().startsWith('0xa9059cbb'))) {
    throw new Error('The server MATT quote is not a safe token transfer.');
  }
}

async function waitForReceipt(provider, hash) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The Ronin transaction reverted.');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('The transaction is still pending. Check Ronin Wallet, then refresh shortly.');
}

async function request(path, token, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.error?.message || `Server request failed (${response.status}).`);
  return payload;
}

function sessionToken() {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function setBusy(button, decline, text) {
  if (button) {
    button.disabled = true;
    button.textContent = text;
  }
  if (decline) decline.disabled = true;
}

function restore(button, decline) {
  if (button) {
    button.disabled = false;
    button.textContent = 'CLAIM PRACTICE REWARDS';
  }
  if (decline) decline.disabled = false;
}

function toast(message) {
  const element = document.querySelector('#toast');
  if (!element) return;
  element.textContent = message;
  element.classList.add('active');
  setTimeout(() => element.classList.remove('active'), 3_500);
}

function parseChainId(value) {
  if (typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value)) return Number.parseInt(value, 16);
  return Number(value);
}

function formatAtomic(value) {
  const raw = String(value || '0').padStart(19, '0');
  const whole = raw.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
  const fraction = raw.slice(-18).replace(/0+$/, '').slice(0, 6);
  return fraction ? `${whole}.${fraction}` : whole;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function shortHash(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 10)}…${text.slice(-6)}` : text;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));
}
