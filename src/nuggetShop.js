const SESSION_STORAGE_KEY = 'matt-mine-server-session-v1';
const RONIN_CHAIN_ID = 2020;

if (typeof document !== 'undefined') mountNuggetEconomyUi();

function mountNuggetEconomyUi() {
  const app = document.querySelector('#app');
  const menuGrid = document.querySelector('.menu-nav-grid');
  if (!app || !menuGrid || document.querySelector('#nugget-shop')) return;

  const menuButton = document.createElement('button');
  menuButton.id = 'nugget-shop-button';
  menuButton.className = 'secondary-button';
  menuButton.type = 'button';
  menuButton.textContent = 'NUGGET SHOP';
  menuGrid.insertBefore(menuButton, document.querySelector('#upgrades-button'));

  const screen = document.createElement('section');
  screen.id = 'nugget-shop';
  screen.className = 'screen nugget-shop-screen';
  screen.setAttribute('aria-labelledby', 'nugget-shop-title');
  screen.innerHTML = `
    <div class="panel wide-panel economy-panel nugget-shop-panel">
      <button id="nugget-shop-close" class="close-button" type="button" aria-label="Close">×</button>
      <p class="eyebrow">SERVER-OWNED BALANCE</p>
      <h2 id="nugget-shop-title">Nugget Shop</h2>
      <p class="panel-copy">Every balance and purchase is verified by the MATT Mine server. The browser can display nuggets, but it cannot create or change them.</p>
      <div id="nugget-shop-status" class="notice">Connect Ronin Wallet to load the live economy.</div>
      <div id="nugget-shop-summary" class="leaderboard-summary"></div>
      <div id="nugget-package-grid" class="launch-tier-grid nugget-package-grid"></div>
      <div class="panel table-wrap nugget-history-panel">
        <h3>Your verified purchase history</h3>
        <table>
          <thead><tr><th>UTC time</th><th>Package</th><th>Nuggets</th><th>Paid</th><th>Transaction</th></tr></thead>
          <tbody id="nugget-history-rows"><tr><td colspan="5">No purchase history loaded.</td></tr></tbody>
        </table>
      </div>
      <p class="preview-note">USD values are informational only. Settlement uses the exact MATT or RON amount in the server-issued quote. Quotes expire and cannot be reused.</p>
    </div>
  `;
  app.appendChild(screen);
  injectStyles();

  menuButton.addEventListener('click', () => void openNuggetShop());
  screen.querySelector('#nugget-shop-close').addEventListener('click', () => showOnlyScreen('menu'));

  const practiceButton = document.querySelector('#practice-claim-button');
  practiceButton?.addEventListener('click', interceptPracticeClaim, { capture: true });
}

async function openNuggetShop() {
  showOnlyScreen('nugget-shop');
  const status = document.querySelector('#nugget-shop-status');
  status.textContent = 'Loading the server-authoritative nugget economy…';
  status.classList.remove('warning');
  try {
    if (!sessionToken()) {
      renderDisconnectedShop();
      return;
    }
    const economy = await authenticatedRequest('/api/nuggets/status');
    renderNuggetShop(economy.economy);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('warning');
    document.querySelector('#nugget-package-grid').innerHTML = '';
  }
}

function renderDisconnectedShop() {
  const status = document.querySelector('#nugget-shop-status');
  status.textContent = 'Sign in with Ronin Wallet from the main menu to view packages and purchase history.';
  status.classList.add('warning');
  document.querySelector('#nugget-shop-summary').innerHTML = '';
  document.querySelector('#nugget-package-grid').innerHTML = `
    <article class="launch-tier-card free-tier-card">
      <div class="tier-topline"><span>RONIN REQUIRED</span><b>SECURE LOGIN</b></div>
      <h3>Connect Wallet</h3>
      <p>Sign a one-time login message. Connecting does not send a transaction.</p>
      <button id="nugget-connect-button" type="button">CONNECT RONIN</button>
    </article>`;
  document.querySelector('#nugget-connect-button')?.addEventListener('click', () => {
    showOnlyScreen('menu');
    document.querySelector('#wallet-button')?.click();
  });
}

function renderNuggetShop(economy) {
  const config = economy.config || {};
  const status = document.querySelector('#nugget-shop-status');
  const blocked = !economy.livePaymentVerification || !config.purchasesEnabled;
  status.classList.toggle('warning', blocked);
  status.textContent = blocked
    ? economy.releaseBlocker || 'Nugget purchases are currently paused. Your existing server balance remains available.'
    : 'Exact Ronin payment verification is active. The server will issue a short-lived quote before Ronin Wallet opens.';

  const remaining = Math.max(0, Number(config.dailyPurchaseCap || 0) - Number(economy.purchasedToday || 0));
  document.querySelector('#nugget-shop-summary').innerHTML = `
    <div><span>Purchased Today</span><strong>${formatNumber(economy.purchasedToday || 0)}</strong></div>
    <div><span>UTC Daily Cap</span><strong>${formatNumber(config.dailyPurchaseCap || 0)}</strong></div>
    <div><span>Remaining Today</span><strong>${formatNumber(remaining)}</strong></div>
    <div><span>Reference Value</span><strong>$${formatMoney(config.displayedUsdPerMillion || 0)} / 1M</strong></div>`;

  const packages = Array.isArray(config.packages) ? config.packages.filter((entry) => entry.enabled) : [];
  document.querySelector('#nugget-package-grid').innerHTML = packages.length
    ? packages.map((entry) => packageMarkup(entry, config, blocked, remaining)).join('')
    : '<div class="panel">No nugget packages are currently available.</div>';
  document.querySelectorAll('[data-buy-nugget-package]').forEach((button) => {
    button.addEventListener('click', () => void purchaseNuggetPackage(button.dataset.buyNuggetPackage, button.dataset.asset));
  });
  renderPurchaseHistory(economy.purchaseHistory || []);
}

function packageMarkup(entry, config, blocked, remaining) {
  const assets = ['MATT', 'RON'].filter((asset) =>
    config.allowedAssets?.[asset] && BigInt(entry.prices?.[asset] || '0') > 0n
  );
  const disabled = blocked || entry.nuggets > remaining || assets.length === 0;
  return `<article class="launch-tier-card pass-tier-card nugget-package-card">
    <div class="tier-topline"><span>SERVER PACKAGE</span><b>${entry.enabled ? 'AVAILABLE' : 'PAUSED'}</b></div>
    <h3>${formatNumber(entry.nuggets)} NUGGETS</h3>
    <p class="tier-subtitle">${escapeHtml(entry.name)} · $${formatMoney(entry.displayedUsd || 0)} reference</p>
    <ul>
      <li>Server-issued expiring quote</li>
      <li>Exact receipt and amount validation</li>
      <li>Counts toward the UTC daily cap</li>
      <li>One transaction hash can be used once</li>
    </ul>
    <div class="nugget-package-actions">
      ${assets.map((asset) => `<button type="button" data-buy-nugget-package="${escapeHtml(entry.id)}" data-asset="${asset}" ${disabled ? 'disabled' : ''}>
        ${disabled && entry.nuggets > remaining ? 'DAILY CAP REACHED' : `BUY WITH ${asset} · ${formatAtomic(entry.prices[asset])}`}
      </button>`).join('')}
    </div>
  </article>`;
}

async function purchaseNuggetPackage(packageId, asset) {
  const status = document.querySelector('#nugget-shop-status');
  try {
    status.classList.remove('warning');
    status.textContent = 'Creating an exact server quote…';
    const quoted = await authenticatedRequest('/api/nuggets/purchases/quote', {
      method: 'POST',
      body: { packageId, asset }
    });
    const quote = quoted.quote;
    const approved = window.confirm(
      `Purchase ${formatNumber(quote.nuggets)} nuggets for exactly ${formatAtomic(quote.amountAtomic)} ${quote.asset}? ` +
      `This quote expires at ${new Date(quote.expiresAt).toLocaleTimeString('en-US')}. Ronin network gas is separate.`
    );
    if (!approved) {
      status.textContent = 'Purchase canceled before opening Ronin Wallet.';
      return;
    }
    status.textContent = 'Confirm the exact transaction in Ronin Wallet…';
    const transactionHash = await sendPreparedRoninTransaction(quote.transaction, quote.asset);
    status.textContent = 'Transaction mined. The server is checking confirmations and the exact receipt…';
    const confirmed = await authenticatedRequest('/api/nuggets/purchases/confirm', {
      method: 'POST',
      body: { quoteId: quote.id, transactionHash }
    });
    updateDisplayedBalance(confirmed.profile?.bankedNuggets);
    status.textContent = `${formatNumber(confirmed.purchase.nuggets)} nuggets credited by the server. Transaction ${shortHash(transactionHash)}.`;
    await openNuggetShop();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('warning');
  }
}

async function interceptPracticeClaim(event) {
  if (!sessionToken()) return;
  let status;
  try {
    status = await authenticatedRequest('/api/nuggets/status');
  } catch {
    return;
  }
  const economy = status.economy;
  if (!economy?.livePaymentVerification || !economy.config?.practiceClaimsEnabled) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  const button = document.querySelector('#practice-claim-button');
  const decline = document.querySelector('#practice-decline-button');
  if (button) {
    button.disabled = true;
    button.textContent = 'CREATING EXACT QUOTE…';
  }
  if (decline) decline.disabled = true;

  try {
    const me = await authenticatedRequest('/api/me');
    const claims = me.player?.nuggetEconomy?.pendingPracticeClaims || [];
    const claim = claims
      .filter((entry) => entry.status === 'pending' && entry.expiresAt > Date.now())
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!claim) throw new Error('No pending server Practice claim was found for this run.');
    const quoted = await authenticatedRequest('/api/nuggets/practice/quote', {
      method: 'POST',
      body: { runId: claim.runId }
    });
    const quote = quoted.quote;
    const approved = window.confirm(
      `Claim ${formatNumber(quote.nuggets)} Practice nuggets for exactly ${formatAtomic(quote.amountAtomic)} ${quote.asset}? ` +
      'Declining remains free. A successful verified payment is final.'
    );
    if (!approved) return;
    if (button) button.textContent = 'CONFIRM IN RONIN WALLET';
    const transactionHash = await sendPreparedRoninTransaction(quote.transaction, quote.asset);
    if (button) button.textContent = 'VERIFYING PAYMENT…';
    const accepted = await authenticatedRequest('/api/runs/practice/claim', {
      method: 'POST',
      body: {
        runId: claim.runId,
        action: 'claim',
        quoteId: quote.id,
        transactionHash
      }
    });
    updateDisplayedBalance(accepted.profile?.bankedNuggets);
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
  } catch (error) {
    showToast(error.message);
    if (button) {
      button.textContent = 'CLAIM PRACTICE REWARDS';
      button.disabled = false;
    }
    if (decline) decline.disabled = false;
  }
}

async function sendPreparedRoninTransaction(transaction, asset) {
  validatePreparedTransaction(transaction, asset);
  const provider = globalThis.window?.ronin?.provider;
  if (!provider?.request) throw new Error('Ronin Wallet was not detected.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = Array.isArray(accounts) ? accounts[0] : '';
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) throw new Error('Ronin Wallet did not return a valid account.');
  const player = await authenticatedRequest('/api/me');
  if (address.toLowerCase() !== player.player.address?.toLowerCase()) {
    throw new Error('Ronin Wallet is on a different account from the wallet signed in to MATT Mine.');
  }
  const chainIdRaw = await provider.request({ method: 'eth_chainId' });
  const chainId = typeof chainIdRaw === 'string' ? Number.parseInt(chainIdRaw, 16) : Number(chainIdRaw);
  if (chainId !== RONIN_CHAIN_ID) {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${RONIN_CHAIN_ID.toString(16)}` }]
    });
  }
  let transactionHash;
  try {
    transactionHash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{
        from: address,
        to: transaction.to,
        value: transaction.value,
        data: transaction.data
      }]
    });
  } catch (error) {
    if (Number(error?.code) === 4001) throw new Error('The transaction was canceled in Ronin Wallet.');
    throw new Error(String(error?.message || 'Ronin Wallet could not send the transaction.').replace(/^Error:\s*/i, ''));
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash || '')) {
    throw new Error('Ronin Wallet did not return a valid transaction hash.');
  }
  await waitForReceipt(provider, transactionHash);
  return transactionHash.toLowerCase();
}

function validatePreparedTransaction(transaction, asset) {
  if (
    !transaction ||
    !/^0x[a-fA-F0-9]{40}$/.test(transaction.to || '') ||
    !/^0x[a-fA-F0-9]+$/.test(transaction.value || '') ||
    !/^0x[a-fA-F0-9]*$/.test(transaction.data || '')
  ) throw new Error('The server did not provide a valid nugget payment transaction.');
  if (asset === 'RON' && (BigInt(transaction.value) <= 0n || transaction.data !== '0x')) {
    throw new Error('The server RON quote is not a safe direct payment.');
  }
  if (asset === 'MATT' && (BigInt(transaction.value) !== 0n || !transaction.data.toLowerCase().startsWith('0xa9059cbb'))) {
    throw new Error('The server MATT quote is not a safe token transfer.');
  }
}

async function waitForReceipt(provider, transactionHash) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 120_000) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The Ronin transaction reverted.');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('The transaction is still pending. Check Ronin Wallet, then refresh shortly.');
}

async function authenticatedRequest(path, options = {}) {
  const token = sessionToken();
  if (!token) throw new Error('Sign in with Ronin Wallet to continue.');
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

function renderPurchaseHistory(history) {
  document.querySelector('#nugget-history-rows').innerHTML = history.length
    ? history.map((entry) => `<tr>
        <td>${escapeHtml(new Date(entry.confirmedAt).toLocaleString('en-US', { timeZone: 'UTC' }))}</td>
        <td>${escapeHtml(entry.packageId)}</td>
        <td>${formatNumber(entry.nuggets)}</td>
        <td>${escapeHtml(formatAtomic(entry.amountAtomic))} ${escapeHtml(entry.asset)}</td>
        <td><a href="https://explorer.roninchain.com/tx/${encodeURIComponent(entry.transactionHash)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortHash(entry.transactionHash))}</a></td>
      </tr>`).join('')
    : '<tr><td colspan="5">No verified nugget purchases yet.</td></tr>';
}

function updateDisplayedBalance(value) {
  if (!Number.isSafeInteger(Number(value))) return;
  const element = document.querySelector('#menu-nuggets');
  if (element) element.textContent = formatNumber(Number(value));
}

function showOnlyScreen(id) {
  document.querySelectorAll('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === id));
  document.body.classList.toggle('launch-active', id === 'launch');
}

function sessionToken() {
  try {
    return sessionStorage.getItem(SESSION_STORAGE_KEY) || '';
  } catch {
    return '';
  }
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('active');
  setTimeout(() => toast.classList.remove('active'), 3_500);
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

function formatMoney(value) {
  return Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

function injectStyles() {
  if (document.querySelector('#nugget-shop-styles')) return;
  const style = document.createElement('style');
  style.id = 'nugget-shop-styles';
  style.textContent = `
    .nugget-shop-panel {
      width: min(1040px, calc(100vw - 42px));
      max-height: min(90dvh, 820px);
      padding: 20px;
      overflow: auto;
    }
    .nugget-shop-panel h2 { margin-top: 0; font-size: clamp(30px, 3vw, 40px); }
    .nugget-shop-panel .panel-copy {
      max-width: 820px;
      margin: 0 auto 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .nugget-shop-panel .notice { margin: 8px 0; padding: 9px 12px; }
    .nugget-shop-panel .leaderboard-summary { margin-top: 8px; gap: 8px; }
    .nugget-shop-panel .leaderboard-summary > div { min-height: 58px; padding: 10px; }
    .nugget-package-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-top: 12px;
    }
    .nugget-package-card { min-height: 0; padding: 18px; }
    .nugget-package-card h3 { margin: 13px 0 2px; font-size: clamp(26px, 3vw, 34px); }
    .nugget-package-card ul {
      min-height: 0;
      margin: 14px 0;
      gap: 7px;
    }
    .nugget-package-card li { font-size: 10px; line-height: 1.35; }
    .nugget-package-actions { display: grid; gap: .5rem; margin-top: .75rem; }
    .nugget-package-actions button:disabled { opacity: .55; cursor: not-allowed; }
    .nugget-history-panel { margin-top: 12px; padding: 12px; }
    .nugget-history-panel h3 { margin: 0 0 8px; }
    .nugget-history-panel a { color: inherit; text-decoration: underline; }
    @media (max-width: 760px) {
      .nugget-shop-panel { width: calc(100vw - 16px); max-height: 96dvh; padding: 15px; }
      .nugget-package-grid { grid-template-columns: 1fr; }
    }
  `;
  document.head.appendChild(style);
}
