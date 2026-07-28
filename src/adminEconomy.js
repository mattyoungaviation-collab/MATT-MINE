const section = document.querySelector('#tab-nugget-economy');

if (section) {
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
  section.querySelectorAll('[data-linked-control]').forEach((input) => {
    input.addEventListener('input', () => {
      document.dispatchEvent(new CustomEvent('admin-linked-control-change', {
        detail: {
          id: input.dataset.linkedControl,
          value: input.type === 'checkbox' ? input.checked : Number(input.value),
          source: 'nugget-economy'
        }
      }));
    });
  });
}

let loadedEconomy = null;

export async function loadEconomy() {
  try {
    const data = await adminApi('/api/admin/nugget-economy');
    loadedEconomy = data.economy;
    renderEconomy(loadedEconomy);
  } catch (error) {
    showEconomyMessage(error.message, true);
  }
}

export function currentEconomyConfig() {
  return loadedEconomy?.editableConfig ? structuredClone(loadedEconomy.editableConfig) : null;
}

window.mattMineAdminEconomy = { load: loadEconomy, current: currentEconomyConfig };

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
    document.dispatchEvent(new CustomEvent('admin-linked-controls-saved', {
      detail: { source: 'nugget-economy', linkedChanges: result.economy.linkedChanges || [] }
    }));
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
