const tabs = document.querySelector('#tabs');
const dashboard = document.querySelector('#dashboard');

if (tabs && dashboard && !document.querySelector('[data-tab="nugget-economy"]')) {
  const button = document.createElement('button');
  button.dataset.tab = 'nugget-economy';
  button.textContent = 'Nugget Economy';
  tabs.insertBefore(button, document.querySelector('#lock-button'));

  const section = document.createElement('section');
  section.id = 'tab-nugget-economy';
  section.className = 'tab';
  section.innerHTML = `
    <div class="section-heading">
      <div><p class="eyebrow">SERVER-AUTHORITATIVE ECONOMY</p><h2>Nugget economy</h2></div>
      <button id="refresh-nugget-economy" class="ghost" type="button">Refresh</button>
    </div>
    <div id="nugget-economy-blocker" class="notice warning" hidden></div>
    <div id="nugget-economy-metrics" class="metrics"></div>
    <form id="nugget-economy-form">
      <article class="panel">
        <h2>Release controls</h2>
        <div class="toggle-grid">
          <label class="toggle">Enable nugget purchases<input id="economy-purchases-enabled" type="checkbox"></label>
          <label class="toggle">Enable paid Practice claims<input id="economy-practice-enabled" type="checkbox"></label>
          <label class="toggle">Enable advertisement rewards<input id="economy-ads-enabled" type="checkbox"></label>
          <label class="toggle">Allow MATT payments<input id="economy-asset-matt" type="checkbox"></label>
          <label class="toggle">Allow RON payments<input id="economy-asset-ron" type="checkbox"></label>
        </div>
        <p class="muted">Paid features cannot be enabled unless the server was launched with the exact Ronin receipt verifier. Advertisement rewards remain a separate provider integration.</p>
      </article>

      <article class="panel">
        <h2>Canonical value and limits</h2>
        <div class="grid two">
          <label>Nuggets per MATT<input id="economy-nuggets-per-matt" type="number" min="0.000001" max="1000000000" step="0.000001"></label>
          <label>MATT per nugget<input id="economy-matt-per-nugget" type="number" step="0.000000001" readonly></label>
          <label>Displayed USD reference per 1,000,000 nuggets<input id="economy-usd-reference" type="number" min="0" max="1000000" step="0.01"></label>
          <label>UTC daily purchase cap<input id="economy-daily-cap" type="number" min="0" max="1000000000" step="1"></label>
          <label>Quote lifetime in seconds<input id="economy-quote-seconds" type="number" min="30" max="1800" step="1"></label>
          <label>Approved payment recipient<input id="economy-recipient" maxlength="42" spellcheck="false"></label>
        </div>
      </article>

      <article class="panel">
        <h2>Practice claim price</h2>
        <div class="grid two">
          <label>Payment asset<select id="economy-practice-asset"><option value="MATT">MATT</option><option value="RON">RON</option></select></label>
          <label>Token amount<input id="economy-practice-amount" type="number" min="0" step="0.000000000000000001"></label>
        </div>
        <p class="muted">Default target is 5,000 MATT. The server converts this display value into exact 18-decimal atomic units.</p>
      </article>

      <article class="panel">
        <div class="section-heading"><div><h2>Purchase packages</h2><p>Every package is exact, expires with its quote, and counts toward the UTC cap.</p></div><button id="economy-add-package" class="ghost" type="button">Add package</button></div>
        <div id="economy-package-list" class="cards"></div>
      </article>

      <article class="panel">
        <h2>Character unlock prices</h2>
        <div class="grid two">
          <label>Ronke nuggets<input id="economy-character-ronke" type="number" min="0" max="1000000000" step="1"></label>
          <label>ADL Dyno nuggets<input id="economy-character-adl" type="number" min="0" max="1000000000" step="1"></label>
          <label>Axie nuggets<input id="economy-character-axie" type="number" min="0" max="1000000000" step="1"></label>
          <label>Orc nuggets<input id="economy-character-orc" type="number" min="0" max="1000000000" step="1"></label>
        </div>
      </article>

      <article class="panel">
        <label>Required reason<input id="economy-reason" maxlength="240" placeholder="Why are these economy rules changing?" required></label>
        <button type="submit">Save nugget economy</button>
      </article>
    </form>

    <div class="panel table-wrap">
      <h2>Recent verified purchases</h2>
      <table><thead><tr><th>UTC time</th><th>Wallet</th><th>Package</th><th>Nuggets</th><th>Paid</th><th>Transaction</th></tr></thead><tbody id="economy-purchase-rows"></tbody></table>
    </div>
    <div class="panel"><h2>Economy audit</h2><div id="economy-audit-list" class="timeline"></div></div>
  `;
  dashboard.append(section);

  button.addEventListener('click', loadEconomy);
  section.querySelector('#refresh-nugget-economy').addEventListener('click', loadEconomy);
  section.querySelector('#economy-nuggets-per-matt').addEventListener('input', updateDerivedConversion);
  section.querySelector('#economy-add-package').addEventListener('click', () => {
    const list = section.querySelector('#economy-package-list');
    list.insertAdjacentHTML('beforeend', packageCard({
      id: `package-${list.children.length + 1}`,
      name: 'New Nugget Package',
      nuggets: 1,
      displayedUsd: 0,
      enabled: false,
      prices: { MATT: '0', RON: '0' }
    }));
    bindPackageButtons();
  });
  section.querySelector('#nugget-economy-form').addEventListener('submit', saveEconomy);
}

let loadedEconomy = null;

async function loadEconomy() {
  try {
    const data = await adminApi('/api/admin/nugget-economy');
    loadedEconomy = data.economy;
    renderEconomy(loadedEconomy);
  } catch (error) {
    showEconomyMessage(error.message, true);
  }
}

function renderEconomy(economy) {
  const config = economy.editableConfig;
  const blocker = document.querySelector('#nugget-economy-blocker');
  blocker.hidden = !economy.releaseBlocker;
  blocker.textContent = economy.releaseBlocker || '';
  document.querySelector('#nugget-economy-metrics').innerHTML = [
    metric('Verifier', economy.livePaymentVerification ? 'Ready' : 'Blocked'),
    metric('Quotes', economy.counts.quotes),
    metric('Confirmed purchases', economy.counts.confirmedPurchases),
    metric('Used transactions', economy.counts.usedTransactions)
  ].join('');

  setChecked('#economy-purchases-enabled', config.purchasesEnabled);
  setChecked('#economy-practice-enabled', config.practiceClaimsEnabled);
  setChecked('#economy-ads-enabled', config.advertisementRewardsEnabled);
  setChecked('#economy-asset-matt', config.allowedAssets.MATT);
  setChecked('#economy-asset-ron', config.allowedAssets.RON);
  setValue('#economy-nuggets-per-matt', config.nuggetsPerMatt);
  setValue('#economy-usd-reference', config.displayedUsdPerMillion);
  setValue('#economy-daily-cap', config.dailyPurchaseCap);
  setValue('#economy-quote-seconds', Math.round(config.quoteTtlMs / 1000));
  setValue('#economy-recipient', config.recipient);
  setValue('#economy-practice-asset', config.practiceClaim.asset);
  setValue('#economy-practice-amount', fromAtomic(config.practiceClaim.amountAtomic));
  setValue('#economy-character-ronke', config.characterUnlockPrices.ronke);
  setValue('#economy-character-adl', config.characterUnlockPrices.adlDyno);
  setValue('#economy-character-axie', config.characterUnlockPrices.axie);
  setValue('#economy-character-orc', config.characterUnlockPrices.orc);
  updateDerivedConversion();

  document.querySelector('#economy-package-list').innerHTML = config.packages.map(packageCard).join('');
  bindPackageButtons();
  document.querySelector('#economy-purchase-rows').innerHTML = economy.purchases.map((purchase) => `<tr>
    <td>${escapeHtml(new Date(purchase.confirmedAt).toLocaleString())}</td>
    <td>${escapeHtml(short(purchase.address))}</td>
    <td>${escapeHtml(purchase.packageId)}</td>
    <td>${Number(purchase.nuggets).toLocaleString()}</td>
    <td>${escapeHtml(fromAtomic(purchase.amountAtomic))} ${escapeHtml(purchase.asset)}</td>
    <td><a href="https://explorer.roninchain.com/tx/${encodeURIComponent(purchase.transactionHash)}" target="_blank" rel="noopener noreferrer">${escapeHtml(short(purchase.transactionHash))}</a></td>
  </tr>`).join('') || '<tr><td colspan="6">No verified nugget purchases yet.</td></tr>';
  document.querySelector('#economy-audit-list').innerHTML = economy.audit.map((entry) => `<article>
    <strong>${escapeHtml(words(entry.action))}</strong><p>${escapeHtml(entry.details)}</p><time>${escapeHtml(new Date(entry.timestamp).toLocaleString())} · ${escapeHtml(entry.actor)}</time>
  </article>`).join('') || '<p>No economy audit entries yet.</p>';
}

async function saveEconomy(event) {
  event.preventDefault();
  const packages = [...document.querySelectorAll('[data-economy-package]')].map((card) => ({
    id: card.querySelector('[data-package-field="id"]').value.trim(),
    name: card.querySelector('[data-package-field="name"]').value.trim(),
    nuggets: Number(card.querySelector('[data-package-field="nuggets"]').value),
    displayedUsd: Number(card.querySelector('[data-package-field="usd"]').value),
    enabled: card.querySelector('[data-package-field="enabled"]').checked,
    prices: {
      MATT: toAtomic(card.querySelector('[data-package-field="matt"]').value),
      RON: toAtomic(card.querySelector('[data-package-field="ron"]').value)
    }
  }));
  const patch = {
    purchasesEnabled: document.querySelector('#economy-purchases-enabled').checked,
    practiceClaimsEnabled: document.querySelector('#economy-practice-enabled').checked,
    advertisementRewardsEnabled: document.querySelector('#economy-ads-enabled').checked,
    nuggetsPerMatt: Number(document.querySelector('#economy-nuggets-per-matt').value),
    displayedUsdPerMillion: Number(document.querySelector('#economy-usd-reference').value),
    dailyPurchaseCap: Number(document.querySelector('#economy-daily-cap').value),
    quoteTtlMs: Number(document.querySelector('#economy-quote-seconds').value) * 1000,
    recipient: document.querySelector('#economy-recipient').value.trim(),
    allowedAssets: {
      MATT: document.querySelector('#economy-asset-matt').checked,
      RON: document.querySelector('#economy-asset-ron').checked
    },
    practiceClaim: {
      asset: document.querySelector('#economy-practice-asset').value,
      amountAtomic: toAtomic(document.querySelector('#economy-practice-amount').value)
    },
    packages,
    characterUnlockPrices: {
      ronke: Number(document.querySelector('#economy-character-ronke').value),
      adlDyno: Number(document.querySelector('#economy-character-adl').value),
      axie: Number(document.querySelector('#economy-character-axie').value),
      orc: Number(document.querySelector('#economy-character-orc').value)
    }
  };
  try {
    const result = await adminApi('/api/admin/nugget-economy', {
      method: 'PUT',
      body: { patch, reason: document.querySelector('#economy-reason').value }
    });
    document.querySelector('#economy-reason').value = '';
    loadedEconomy = { ...loadedEconomy, ...result.economy, editableConfig: result.economy.editableConfig };
    await loadEconomy();
    showEconomyMessage('Nugget economy settings saved and audit logged.');
  } catch (error) {
    showEconomyMessage(error.message, true);
  }
}

function packageCard(entry) {
  return `<article class="card" data-economy-package>
    <div class="grid two">
      <label>Package ID<input data-package-field="id" value="${escapeHtml(entry.id)}" pattern="[a-z0-9][a-z0-9-]{1,59}" required></label>
      <label>Display name<input data-package-field="name" value="${escapeHtml(entry.name)}" maxlength="80" required></label>
      <label>Nuggets<input data-package-field="nuggets" type="number" min="1" max="1000000000" step="1" value="${Number(entry.nuggets)}" required></label>
      <label>Displayed USD reference<input data-package-field="usd" type="number" min="0" step="0.01" value="${Number(entry.displayedUsd)}"></label>
      <label>MATT price<input data-package-field="matt" type="number" min="0" step="0.000000000000000001" value="${escapeHtml(fromAtomic(entry.prices.MATT))}"></label>
      <label>RON price<input data-package-field="ron" type="number" min="0" step="0.000000000000000001" value="${escapeHtml(fromAtomic(entry.prices.RON))}"></label>
    </div>
    <div class="action-row"><label class="toggle">Enabled<input data-package-field="enabled" type="checkbox" ${entry.enabled ? 'checked' : ''}></label><button class="ghost" type="button" data-remove-package>Remove</button></div>
  </article>`;
}

function bindPackageButtons() {
  document.querySelectorAll('[data-remove-package]').forEach((button) => {
    button.onclick = () => button.closest('[data-economy-package]').remove();
  });
}

function updateDerivedConversion() {
  const value = Number(document.querySelector('#economy-nuggets-per-matt')?.value || 0);
  setValue('#economy-matt-per-nugget', value > 0 ? 1 / value : 0);
}

async function adminApi(path, options = {}) {
  const key = sessionStorage.getItem('mattMineAdminKey') || '';
  if (!key) throw new Error('Unlock the Admin Command Center first.');
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      'x-matt-admin-key': key
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error?.message || `Admin request failed (${response.status}).`);
  return data;
}

function toAtomic(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{0,18})?$/.test(text)) throw new Error('Token prices must use no more than 18 decimal places.');
  const [whole, fraction = ''] = text.split('.');
  return `${whole}${fraction.padEnd(18, '0')}`.replace(/^0+(?=\d)/, '') || '0';
}

function fromAtomic(value) {
  const raw = String(value || '0').padStart(19, '0');
  const whole = raw.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
  const fraction = raw.slice(-18).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function showEconomyMessage(message, error = false) {
  const alert = document.querySelector('#alert');
  if (!alert) return;
  alert.hidden = false;
  alert.classList.toggle('error', error);
  alert.textContent = message;
  alert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function metric(label, value) {
  return `<div class="metric"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function setValue(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.value = value ?? '';
}

function setChecked(selector, value) {
  const element = document.querySelector(selector);
  if (element) element.checked = value === true;
}

function short(value) {
  const text = String(value || '');
  return text.length > 14 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function words(value) {
  return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[character]));
}
