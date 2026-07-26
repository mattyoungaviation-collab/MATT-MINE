const state = { key: '', overview: null, actions: [] };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  state.key = $('#admin-key').value;
  try {
    await refreshOverview();
    sessionStorage.setItem('mattMineAdminKey', state.key);
    $('#unlock-panel').hidden = true;
    $('#dashboard').hidden = false;
    $('.connection').classList.add('live');
    $('#connection-label').textContent = 'Production connected';
  } catch (error) {
    showAlert(error.message, true);
  }
});

$('#lock-button').addEventListener('click', () => {
  sessionStorage.removeItem('mattMineAdminKey');
  state.key = '';
  location.reload();
});

$('#tabs').addEventListener('click', async (event) => {
  const name = event.target.dataset.tab;
  if (!name) return;
  document.querySelectorAll('#tabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.id === `tab-${name}`));
  if (name === 'players') await loadWallets();
  if (name === 'rewards') await loadRewards();
  if (name === 'audit') await loadAudit();
});

async function refreshOverview() {
  const data = await api('/api/admin/overview');
  state.overview = data;
  state.actions = data.contractActions;
  renderOverview(data);
  renderOperations(data.operations);
  renderContractActions();
}

function renderOverview(data) {
  $('#metrics').innerHTML = Object.entries(data.counts).map(([key, value]) =>
    `<div class="metric"><span class="muted">${words(key)}</span><strong>${Number(value).toLocaleString()}</strong></div>`
  ).join('');
  const pass = data.payments?.pass || {};
  const paidRuns = data.payments?.paidRuns || {};
  $('#systems').innerHTML = [
    row('Server maintenance', status(!data.operations.maintenanceMode)),
    row('Free ranked', status(!data.operations.freeRankedPaused)),
    row('Pass ranked', status(!data.operations.passRankedPaused)),
    row('Server purchases', status(!data.operations.purchasesPaused)),
    row('Server claims', status(!data.operations.claimsPaused)),
    row('Pass contract', status(!pass.paused)),
    row('Runs contract', status(!paidRuns.paused)),
    row('Reward publishing', status(data.rewards?.publicationEnabled))
  ].join('');
  $('#immutable').innerHTML = [
    row('Network', `Ronin Mainnet (${data.immutable.chainId})`),
    row('Maximum board pool', `${data.immutable.hardMaxBoardMatt.toLocaleString()} MATT`),
    row('Published rewards editable', 'No'),
    row('Confirmed payments editable', 'No'),
    row('Finished scores editable', 'No'),
    row('Treasury Safe', short(data.immutable.contracts.safe))
  ].join('');
}

const operationFields = [
  ['maintenanceMode', 'Maintenance mode'],
  ['freeRankedPaused', 'Pause Free ranked'],
  ['passRankedPaused', 'Pause Pass ranked'],
  ['purchasesPaused', 'Pause purchase confirmation'],
  ['claimsPaused', 'Pause reward claims']
];

function renderOperations(operations) {
  $('#operation-toggles').innerHTML = operationFields.map(([key, label]) =>
    `<label class="toggle">${escapeHtml(label)}<input type="checkbox" data-operation="${key}" ${operations[key] ? 'checked' : ''}></label>`
  ).join('');
  $('#announcement').value = operations.announcement || '';
}

$('#operations-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const patch = Object.fromEntries(operationFields.map(([key]) => [key, $(`[data-operation="${key}"]`).checked]));
  patch.announcement = $('#announcement').value;
  if (!await confirmAction('Apply server controls?', 'These settings take effect immediately for production players.')) return;
  await api('/api/admin/operations', {
    method: 'PUT',
    body: { patch, reason: $('#operations-reason').value }
  });
  $('#operations-reason').value = '';
  await refreshOverview();
  showAlert('Server controls updated.');
});

$('#wallet-search').addEventListener('submit', async (event) => {
  event.preventDefault();
  await loadWallets();
});

async function loadWallets() {
  const data = await api(`/api/admin/wallets?query=${encodeURIComponent($('#wallet-query').value)}`);
  $('#wallet-rows').innerHTML = data.wallets.map((wallet) => `<tr>
    <td><button class="wallet-link" data-wallet="${wallet.address}">${short(wallet.address)}</button></td>
    <td><span class="badge ${wallet.suspended ? 'suspended' : ''}">${wallet.suspended ? 'Suspended' : 'Active'}</span></td>
    <td>${wallet.profile.bankedNuggets.toLocaleString()}</td><td>${wallet.finishedRuns}</td><td>${wallet.unusedPaidCredits}</td>
    <td><button class="ghost" data-wallet="${wallet.address}">Inspect</button></td></tr>`).join('') || '<tr><td colspan="6">No wallets found.</td></tr>';
  document.querySelectorAll('[data-wallet]').forEach((button) => button.addEventListener('click', () => loadWallet(button.dataset.wallet)));
}

async function loadWallet(address) {
  const data = await api(`/api/admin/wallets/${address}`);
  const wallet = data.wallet;
  const panel = $('#wallet-detail');
  panel.hidden = false;
  panel.innerHTML = `<h2>${escapeHtml(wallet.address)}</h2>
    <div class="grid two">${row('Status', wallet.suspended ? 'Suspended' : 'Active')}${row('Free run used today', wallet.freeRunUsedToday ? 'Yes' : 'No')}${row('Active sessions', wallet.activeSessions)}${row('Active runs', wallet.activeRuns)}</div>
    <label>Required action reason<input id="wallet-reason" maxlength="240" placeholder="Document why this action is needed"></label>
    <div class="action-row">
      <button data-wallet-action="suspension">${wallet.suspended ? 'Restore wallet' : 'Suspend wallet'}</button>
      <button class="ghost" data-wallet-action="revoke_sessions">Sign out all sessions</button>
      <button class="ghost" data-wallet-action="expire_active_runs">Expire active runs</button>
      <button class="ghost" data-wallet-action="restore_free_run">Restore today’s free run</button>
    </div>`;
  panel.querySelectorAll('[data-wallet-action]').forEach((button) => button.addEventListener('click', async () => {
    const reason = $('#wallet-reason').value;
    if (!await confirmAction('Confirm player action?', `${button.textContent} for ${short(address)}. This is audit logged.`)) return;
    if (button.dataset.walletAction === 'suspension') {
      await api(`/api/admin/wallets/${address}/suspension`, { method: 'PUT', body: { suspended: !wallet.suspended, reason } });
    } else {
      await api(`/api/admin/wallets/${address}/actions`, { method: 'POST', body: { action: button.dataset.walletAction, reason } });
    }
    await loadWallet(address);
    await loadWallets();
    showAlert('Player action completed.');
  }));
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#refresh-rewards').addEventListener('click', loadRewards);
$('#reward-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!await confirmAction('Create reward draft?', 'The finalized leaderboard snapshot and allocations become immutable once the draft is created.')) return;
  await api('/api/admin/rewards/drafts', {
    method: 'POST',
    body: {
      mode: $('#reward-mode').value,
      week: $('#reward-week').value,
      poolMatt: Number($('#reward-pool').value),
      claimDays: Number($('#reward-claim-days').value)
    }
  });
  await loadRewards();
  showAlert('Reward draft created from the finalized leaderboard.');
});
async function loadRewards() {
  try {
    const data = await api('/api/admin/rewards/drafts');
    $('#reward-drafts').innerHTML = data.drafts.map((draft) => `<article class="card">
      <div class="action-row"><span class="badge">${escapeHtml(draft.status)}</span><strong>${escapeHtml(draft.id)}</strong></div>
      <p>${Number(draft.totalMatt).toLocaleString()} MATT · ${draft.allocations?.length || 0} players</p>
      <div class="code">Merkle root: ${escapeHtml(draft.merkleRoot)}</div>
      <div class="action-row">
        ${draft.status === 'draft' ? `<button data-reward-approve="${draft.id}">Independent approve</button>` : ''}
        ${['approved', 'published'].includes(draft.status) ? `<button class="ghost" data-reward-sync="${draft.id}">Sync Ronin publication</button>` : ''}
      </div>
    </article>`).join('') || '<div class="panel">No reward drafts yet.</div>';
    document.querySelectorAll('[data-reward-approve]').forEach((button) => button.addEventListener('click', () => approveReward(button.dataset.rewardApprove)));
    document.querySelectorAll('[data-reward-sync]').forEach((button) => button.addEventListener('click', () => syncReward(button.dataset.rewardSync)));
  } catch (error) {
    $('#reward-drafts').innerHTML = `<div class="panel">${escapeHtml(error.message)}</div>`;
  }
}

async function approveReward(id) {
  const approverKey = prompt('Enter the independent reward approver key. It will not be stored.');
  if (!approverKey) return;
  if (!await confirmAction('Approve this exact reward root?', 'Approval creates the Safe transaction package. Verify the pool, root, deadline, and player count before continuing.')) return;
  const result = await api(`/api/admin/rewards/drafts/${id}/approve`, {
    method: 'POST',
    body: {},
    headers: { 'x-matt-reward-approver-key': approverKey }
  });
  const transactions = result.safeTransactions || result.safeTransactionPreview || [];
  const vault = result.vault || {};
  $('#reward-transaction-result').hidden = false;
  $('#reward-transaction-result').innerHTML = `<h2>Reward Safe package</h2><p>${escapeHtml(result.safety)}</p>
    ${row('Preflight', vault.paused === false && vault.epochAvailable === true ? 'Passed' : 'Unavailable')}
    ${row('Vault available (raw)', vault.availableRaw || 'Unavailable')}
    ${row('Funding shortfall (raw)', vault.fundingShortfallRaw || '0')}
    ${row('Ordered transactions', transactions.length)}
    <p>Download this file, then drag it into the Ronin Safe Transaction Builder.</p>
    <div class="action-row"><button id="download-reward-safe-json">Download Safe JSON</button><button class="ghost" id="copy-reward-safe-json">Copy JSON</button></div>
    <div class="code">${escapeHtml(JSON.stringify(transactions, null, 2))}</div>`;
  $('#download-reward-safe-json').addEventListener('click', () => downloadJson(result.safeFileName, result.safeTransactionBuilderFile));
  $('#copy-reward-safe-json').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(result.safeTransactionBuilderFile, null, 2)));
  await loadRewards();
}

async function syncReward(id) {
  const transactionHash = prompt('Paste the Ronin publication transaction hash (optional if the exact epoch is already on-chain).') || '';
  await api(`/api/admin/rewards/drafts/${id}/sync`, { method: 'POST', body: { transactionHash } });
  await loadRewards();
  showAlert('Reward draft synchronized with Ronin.');
}

function renderContractActions() {
  $('#contract-action').innerHTML = state.actions.map((entry) =>
    `<option value="${entry.id}">${words(entry.id)} — ${escapeHtml(entry.requiredSigner)}</option>`
  ).join('');
  renderContractArguments();
}
$('#contract-action').addEventListener('change', renderContractArguments);
function renderContractArguments() {
  const selected = state.actions.find((entry) => entry.id === $('#contract-action').value);
  $('#contract-arguments').innerHTML = (selected?.argumentTypes || []).map((type, index) =>
    `<label>Argument ${index + 1} (${escapeHtml(type)})<input data-contract-argument="${index}" placeholder="${argumentHint(type)}" required></label>`
  ).join('');
}
$('#contract-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!await confirmAction('Prepare on-chain transaction?', 'No transaction will be signed or broadcast. The preparation will be audit logged.')) return;
  const result = await api('/api/admin/contracts/prepare', {
    method: 'POST',
    body: {
      action: $('#contract-action').value,
      arguments: [...document.querySelectorAll('[data-contract-argument]')].map((input) => input.value),
      reason: $('#contract-reason').value
    }
  });
  const transaction = result.transaction;
  const transactions = result.transactions || [transaction];
  const safeFile = result.safeTransactionBuilderFile;
  $('#transaction-result').hidden = false;
  $('#transaction-result').innerHTML = `<h2>Prepared — not broadcast</h2>
    ${row('Required signer', transaction.requiredSigner)}${row('Ordered transactions', transactions.length)}
    ${transactions.map((entry, index) => `<h3>${index + 1}. ${escapeHtml(entry.purpose || words(entry.functionName))}</h3>
      ${row('To', entry.to)}${row('Value', entry.value)}
      <p>Calldata</p><div class="code">${escapeHtml(entry.data)}</div>`).join('')}
    ${safeFile
      ? '<p>Download this file, then drag it into the Ronin Safe Transaction Builder.</p><div class="action-row"><button id="download-safe-json">Download Safe JSON</button><button class="ghost" id="copy-transaction">Copy JSON</button></div>'
      : '<p class="muted">This action requires the named role wallet directly, not the Treasury Safe.</p><button id="copy-transaction">Copy transaction JSON</button>'}`;
  $('#copy-transaction').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(safeFile || transactions, null, 2)));
  if (safeFile) $('#download-safe-json').addEventListener('click', () => downloadJson(result.safeFileName, safeFile));
});

$('#audit-filter').addEventListener('submit', async (event) => { event.preventDefault(); await loadAudit(); });
async function loadAudit() {
  const data = await api(`/api/admin/audit?limit=200&action=${encodeURIComponent($('#audit-action').value)}`);
  $('#audit-list').innerHTML = data.entries.map((entry) => `<article><strong>${escapeHtml(entry.action)}</strong>
    <p>${escapeHtml(entry.details)}</p><time>${new Date(entry.timestamp).toLocaleString()} · ${escapeHtml(entry.actor)}</time></article>`).join('') || '<div class="panel">No matching audit entries.</div>';
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'x-matt-admin-key': state.key, ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}

function confirmAction(title, copy) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-copy').textContent = copy;
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }));
}
function downloadJson(fileName, value) {
  if (!value) {
    showAlert('No Safe file was created for this action.', true);
    return;
  }
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName || 'matt-mine-safe-transactions.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
function showAlert(message, error = false) {
  const alert = $('#alert');
  alert.hidden = false;
  alert.className = `alert${error ? ' error' : ''}`;
  alert.textContent = message;
}
function row(label, value) { return `<div class="kv"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`; }
function status(enabled) { return enabled ? 'Enabled' : 'Paused'; }
function short(value) { const text = String(value || ''); return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text; }
function words(value) { return String(value).replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (char) => char.toUpperCase()); }
function argumentHint(type) { return type === 'address' ? '0x…' : type === 'board' ? 'free or paid' : type === 'ron' ? 'RON amount' : type === 'matt' ? 'MATT amount' : 'Whole number'; }

const savedKey = sessionStorage.getItem('mattMineAdminKey');
if (savedKey) {
  state.key = savedKey;
  $('#admin-key').value = savedKey;
  $('#unlock-form').requestSubmit();
}
