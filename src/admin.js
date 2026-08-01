import {
  CHARACTER_PRICE_CONTROL_LINKS,
  RETENTION_CONTROL_LINKS,
  buildAdminControlIndex,
  linkedControlForCharacter,
  linkedControlForExpansion,
  linkedControlForTuning,
  searchAdminControls
} from './adminControlRegistry.js';

const state = {
  csrfToken: '',
  adminAddress: '',
  provider: null,
  overview: null,
  actions: [],
  tuning: null,
  tuningDrafts: {},
  expansion: null,
  expansionDraft: null,
  mineOperations: null,
  controlIndex: [],
  activeTab: 'overview',
  overviewTimer: null
};
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

$('#unlock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await connectAdminWallet();
    await refreshOverview();
    $('#unlock-panel').hidden = true;
    $('#dashboard').hidden = false;
    $('.connection').classList.add('live');
    $('#connection-label').textContent = 'Production connected';
    await hydrateControlIndex();
    startOverviewMonitor();
  } catch (error) {
    showAlert(error.message, true);
  }
});

$('#lock-button').addEventListener('click', async () => {
  if (state.overviewTimer) clearInterval(state.overviewTimer);
  await api('/api/admin/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
  state.csrfToken = '';
  location.reload();
});

$('#tabs').addEventListener('click', async (event) => {
  const name = event.target.closest('[data-tab]')?.dataset.tab;
  if (!name) return;
  resetTabFilters(name);
  await activateTab(name);
});

function resetTabFilters(name) {
  if (name === 'tuning') {
    $('#tuning-category').value = '';
    $('#tuning-search').value = '';
  }
  if (name === 'expansion') $('#expansion-search').value = '';
}

async function activateTab(name) {
  state.activeTab = name;
  document.querySelectorAll('#tabs [data-tab]').forEach((button) => button.classList.toggle('active', button.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('active', tab.id === `tab-${name}`));
  if (name === 'players') await loadWallets();
  if (name === 'studio') await window.mattMineCompetitionStudio?.load?.();
  if (name === 'tuning') await loadTuning();
  if (name === 'expansion') await loadExpansion();
  if (name === 'nugget-economy') await window.mattMineAdminEconomy?.load?.();
  if (name === 'operations') await loadMineOperations();
  if (name === 'arena') await loadArenaAdmin();
  if (name === 'audit') await loadAudit();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function refreshOverview() {
  const data = await api('/api/admin/overview');
  state.overview = data;
  state.actions = data.contractActions;
  renderOverview(data);
  renderOperations(data.operations);
  renderContractActions();
}

function renderOverview(data) {
  renderReadiness(data.readiness);
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
  const boss = data.bossTelemetry || {};
  if ($('#boss-telemetry')) $('#boss-telemetry').innerHTML = [
    row('Completed encounters', Number(boss.completedEncounters || 0).toLocaleString()),
    row('Average duration', `${Number(boss.averageEncounterSeconds || 0).toFixed(2)} seconds`),
    row('Average boss damage', Number(boss.averageDamageDealt || 0).toLocaleString()),
    row('Average damage received', Number(boss.averageDamageReceived || 0).toLocaleString()),
    row('Player deaths', Number(boss.playerDeaths || 0).toLocaleString()),
    row('Attacks', Object.entries(boss.attacksUsed || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || 'No data')
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
    <td><button class="wallet-link" data-wallet="${wallet.address}">${escapeHtml(wallet.identity?.name || 'Unnamed')}<br><small>${short(wallet.address)}</small></button></td>
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
  panel.insertAdjacentHTML('beforeend', `
    <h3>Award this player</h3>
    <div class="grid two">
      <label>Award<select id="award-type"><option value="nuggets">Banked nuggets</option><option value="pass_xp">Pass XP</option><option value="chest">Pass chest</option><option value="cosmetic">Cosmetic ID</option></select></label>
      <label>Amount<input id="award-amount" type="number" min="1" value="1"></label>
      <label>Cosmetic ID<input id="award-cosmetic" placeholder="gold_pickaxe"></label>
      <label>Required reason<input id="award-reason" maxlength="240" placeholder="Why is this award being granted?"></label>
    </div>
    <button id="grant-award">Grant audited award</button>
    <h3>Player activity</h3>
    <div class="timeline activity-list">${(data.activity || []).map((entry) => `<article><strong>${escapeHtml(words(entry.action))}</strong><p>${escapeHtml(entry.details)}</p><time>${new Date(entry.timestamp).toLocaleString()}</time></article>`).join('') || '<p>No activity recorded yet.</p>'}</div>
  `);
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
  $('#grant-award').addEventListener('click', async () => {
    if (!await confirmAction('Grant player award?', 'This immediately changes the player profile and creates an audit entry.')) return;
    await api(`/api/admin/wallets/${address}/awards`, {
      method: 'POST',
      body: {
        type: $('#award-type').value,
        amount: Number($('#award-amount').value),
        cosmeticId: $('#award-cosmetic').value,
        reason: $('#award-reason').value
      }
    });
    await loadWallet(address);
    showAlert('Player award granted and audited.');
  });
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadTuning(force = false) {
  if (!state.tuning || force) {
    state.tuning = await api('/api/admin/game-tuning');
    state.tuningDrafts = Object.fromEntries(
      Object.entries(state.tuning.presets).map(([lobby, preset]) => [lobby, structuredClone(preset)])
    );
    const categories = [...new Set(state.tuning.schema.map((entry) => entry.category))];
    $('#tuning-category').innerHTML = '<option value="">All categories</option>' +
      categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    rebuildControlIndex();
  }
  renderTuning();
}

function renderTuning() {
  if (!state.tuning) return;
  const lobby = $('#tuning-lobby').value;
  const preset = state.tuningDrafts[lobby] || state.tuning.presets[lobby];
  const needle = $('#tuning-search').value.trim().toLowerCase();
  const categoryFilter = $('#tuning-category').value;
  const visible = state.tuning.schema.filter((entry) =>
    (!categoryFilter || entry.category === categoryFilter) &&
    (!needle || `${entry.id} ${entry.category} ${entry.label} ${entry.description || ''}`.toLowerCase().includes(needle))
  );
  const groups = visible.reduce((map, entry) => {
    if (!map.has(entry.category)) map.set(entry.category, []);
    map.get(entry.category).push(entry);
    return map;
  }, new Map());
  $('#tuning-result-count').textContent = `${visible.length.toLocaleString()} of ${state.tuning.schema.length.toLocaleString()} settings · ${words(lobby)} lobby`;
  $('#tuning-fields').innerHTML = [...groups].map(([category, entries], index) => `<details class="panel structured-card" ${needle || categoryFilter || index < 2 ? 'open' : ''}>
    <summary><strong>${escapeHtml(category)}</strong><span>${entries.length} controls</span></summary>
    <div class="tuning-grid">${entries.map((entry) => {
      const linked = linkedControlForTuning(lobby, entry.id);
      return `<label class="tuning-field ${linked ? 'linked-field' : ''}">${escapeHtml(entry.label)}
      ${linked ? `<span class="link-chip">Linked · ${escapeHtml(linked.linkedTo)}</span>` : ''}
      ${entry.type === 'boolean'
        ? `<input data-tuning="${entry.id}" ${linked ? `data-linked-control="${linked.id}"` : ''} type="checkbox" ${preset[entry.id] ? 'checked' : ''}>`
        : `<input data-tuning="${entry.id}" ${linked ? `data-linked-control="${linked.id}"` : ''} type="number" min="${entry.min}" max="${entry.max}" step="${entry.step || 'any'}" value="${preset[entry.id]}">`}
      ${entry.description ? `<small>${escapeHtml(entry.description)}</small>` : ''}</label>`;
    }).join('')}</div>
  </details>`).join('');
}

$('#tuning-lobby').addEventListener('change', renderTuning);
$('#tuning-category').addEventListener('change', renderTuning);
$('#tuning-search').addEventListener('input', renderTuning);
$('#tuning-fields').addEventListener('input', (event) => {
  const input = event.target.closest('[data-tuning]');
  if (!input) return;
  const lobby = $('#tuning-lobby').value;
  state.tuningDrafts[lobby][input.dataset.tuning] = input.type === 'checkbox' ? input.checked : Number(input.value);
  if (input.dataset.linkedControl) {
    syncLinkedDraft(input.dataset.linkedControl, state.tuningDrafts[lobby][input.dataset.tuning], 'tuning');
  }
});
$('#tuning-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const lobby = $('#tuning-lobby').value;
  const original = state.tuning.presets[lobby];
  const draft = state.tuningDrafts[lobby];
  const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => original[key] !== value));
  if (!Object.keys(patch).length) {
    showAlert('No Game Balance values changed.');
    return;
  }
  if (!await confirmAction(
    `Apply ${words(lobby)} tuning now?`,
    'Every new run will use these values immediately. Runs already in progress keep the exact settings they started with.'
  )) return;
  const result = await api(`/api/admin/game-tuning/${lobby}`, {
    method: 'PUT',
    body: { patch, reason: $('#tuning-reason').value }
  });
  state.tuning.presets[lobby] = result.preset;
  state.tuningDrafts[lobby] = structuredClone(result.preset);
  $('#tuning-reason').value = '';
  if (result.linkedChanges?.length) await loadExpansion(true);
  renderTuning();
  showAlert(`${words(lobby)} tuning is live for new runs.`);
});

async function loadExpansion(force = false) {
  if (state.expansion && !force) {
    renderExpansion();
    return;
  }
  const data = await api('/api/admin/expansion');
  state.expansion = data.expansion;
  state.expansionDraft = structuredClone(data.expansion.config);
  rebuildControlIndex();
  renderExpansion();
}

function renderExpansion() {
  if (!state.expansion) return;
  const readiness = state.expansion.productionReadiness || {};
  const readinessNode = $('#production-readiness');
  if (readinessNode) {
    const cards = [
      ['Competitive replay', readiness.competitiveReplay],
      ['Paid revive', readiness.paidRevivePayments],
      ['Ad rewards', readiness.advertisementRewards],
      ['Treasury Safe', {
        configured: Boolean(readiness.treasurySafe?.address),
        enabled: true,
        detail: readiness.treasurySafe
          ? `${readiness.treasurySafe.threshold}-of-${readiness.treasurySafe.owners}`
          : ''
      }]
    ];
    readinessNode.innerHTML = cards.map(([label, status]) => `<article class="panel metric">
      <span>${escapeHtml(label)}</span>
      <strong>${status?.configured ? 'READY' : 'BLOCKED'}</strong>
      <small>${escapeHtml(status?.verification || status?.provider || status?.store || status?.detail || status?.blocker || '')}</small>
    </article>`).join('');
  }
  const needle = $('#expansion-search').value.trim().toLowerCase();
  const visible = state.expansion.schema.filter((entry) =>
    !needle || `${entry.category} ${entry.label} ${entry.description}`.toLowerCase().includes(needle)
  );
  const groups = visible.reduce((map, entry) => {
    if (!map.has(entry.category)) map.set(entry.category, []);
    map.get(entry.category).push(entry);
    return map;
  }, new Map());
  const draft = state.expansionDraft || state.expansion.config;
  const settings = draft.settings;
  $('#expansion-result-count').textContent = `${visible.length.toLocaleString()} of ${state.expansion.schema.length.toLocaleString()} feature settings`;
  const settingCards = [...groups].map(([category, entries], index) => `<details class="panel structured-card" ${needle || index < 2 ? 'open' : ''}>
    <summary><strong>${escapeHtml(category)}</strong><span>${entries.length} controls</span></summary>
    <div class="tuning-grid">${entries.map((entry) => expansionField(entry, settings[entry.id])).join('')}</div>
  </details>`).join('');
  const characters = Object.entries(draft.characters)
    .filter(([id, character]) => !needle || `${id} ${Object.entries(character).flat().join(' ')}`.toLowerCase().includes(needle))
    .map(([id, character]) => `<details class="panel structured-card" ${needle ? 'open' : ''}>
    <summary><strong>${escapeHtml(character.name)}</strong><span>${character.enabled ? 'Enabled' : 'Disabled'}</span></summary>
    <div class="tuning-grid">${Object.entries(character).map(([key, value]) => characterField(id, key, value)).join('')}</div>
  </details>`).join('');
  $('#expansion-fields').innerHTML = `${settingCards}<div class="section-heading"><div><p class="eyebrow">PLAYABLE ROSTER</p><h2>Characters</h2></div></div>${characters}`;
}

function expansionField(entry, value) {
  const linked = linkedControlForExpansion(entry.id);
  const linkedData = linked ? `data-linked-control="${linked.id}"` : '';
  let input;
  if (entry.type === 'boolean') input = `<input data-expansion-setting="${entry.id}" ${linkedData} type="checkbox" ${value ? 'checked' : ''}>`;
  else if (entry.type === 'enum') input = `<select data-expansion-setting="${entry.id}" ${linkedData}>${entry.options.map((option) => `<option value="${escapeHtml(option)}" ${option === value ? 'selected' : ''}>${escapeHtml(words(option))}</option>`).join('')}</select>`;
  else input = `<input data-expansion-setting="${entry.id}" ${linkedData} type="${entry.type === 'atomic' ? 'text' : 'number'}" ${entry.type === 'atomic' ? '' : `min="${entry.min}" max="${entry.max}" step="${entry.type === 'integer' ? 1 : 'any'}"`} value="${escapeHtml(value)}">`;
  return `<label class="tuning-field ${linked ? 'linked-field' : ''}">${escapeHtml(entry.label)}${linked ? `<span class="link-chip">Linked · ${escapeHtml(linked.linkedTo)}</span>` : ''}${input}<small>${escapeHtml(entry.description)}${entry.type !== 'boolean' && entry.type !== 'enum' && entry.type !== 'atomic' ? ` Safe range: ${entry.min}–${entry.max}.` : ''}</small></label>`;
}

function characterField(id, key, value) {
  const linked = linkedControlForCharacter(id, key);
  const linkedData = linked ? `data-linked-control="${linked.id}"` : '';
  const opening = `<label class="tuning-field ${linked ? 'linked-field' : ''}">${escapeHtml(words(key))}${linked ? `<span class="link-chip">Linked · ${escapeHtml(linked.linkedTo)}</span>` : ''}`;
  if (key === 'enabled') return `${opening}<input data-character="${id}" data-character-field="${key}" ${linkedData} type="checkbox" ${value ? 'checked' : ''}></label>`;
  if (typeof value === 'number') return `${opening}<input data-character="${id}" data-character-field="${key}" ${linkedData} type="number" step="any" value="${value}"></label>`;
  return `${opening}<input data-character="${id}" data-character-field="${key}" ${linkedData} maxlength="200" value="${escapeHtml(value)}"></label>`;
}

$('#expansion-search').addEventListener('input', renderExpansion);
$('#expansion-fields').addEventListener('input', (event) => {
  const setting = event.target.closest('[data-expansion-setting]');
  const character = event.target.closest('[data-character]');
  if (setting) {
    const value = setting.type === 'checkbox' ? setting.checked : setting.type === 'number' ? Number(setting.value) : setting.value;
    state.expansionDraft.settings[setting.dataset.expansionSetting] = value;
    if (setting.dataset.linkedControl) syncLinkedDraft(setting.dataset.linkedControl, value, 'expansion');
  }
  if (character) {
    const value = character.type === 'checkbox' ? character.checked : character.type === 'number' ? Number(character.value) : character.value;
    state.expansionDraft.characters[character.dataset.character][character.dataset.characterField] = value;
    if (character.dataset.linkedControl) syncLinkedDraft(character.dataset.linkedControl, value, 'expansion');
  }
});
$('#expansion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = objectDiff(state.expansion.config.settings, state.expansionDraft.settings);
  const characters = Object.fromEntries(Object.entries(state.expansionDraft.characters).flatMap(([id, character]) => {
    const changes = objectDiff(state.expansion.config.characters[id] || {}, character);
    return Object.keys(changes).length ? [[id, changes]] : [];
  }));
  if (!Object.keys(settings).length && !Object.keys(characters).length) {
    showAlert('No Modes & Characters values changed.');
    return;
  }
  if (!await confirmAction('Save Modes & Characters settings?', 'Every field is schema validated, linked controls move together, and the reason is audit logged.')) return;
  const result = await api('/api/admin/expansion', {
    method: 'PUT',
    body: { patch: { settings, characters }, reason: $('#expansion-reason').value }
  });
  state.expansion.config = result.config;
  state.expansionDraft = structuredClone(result.config);
  $('#expansion-reason').value = '';
  await Promise.all([
    loadTuning(true),
    window.mattMineAdminEconomy?.load?.()
  ]);
  renderExpansion();
  showAlert('Modes & Characters settings validated, synchronized, saved, and audited.');
});

$('#export-expansion').addEventListener('click', () => {
  if (!state.expansionDraft) return;
  downloadJson(`matt-mine-expansion-r${state.expansion.config.revision}.json`, state.expansionDraft);
});

$('#reset-expansion').addEventListener('click', async () => {
  if (!state.expansion?.defaults) return;
  if (!await confirmAction('Load safe expansion defaults?', 'This only stages the defaults in the form. Enter a reason and press Save to apply them.')) return;
  state.expansionDraft = structuredClone(state.expansion.defaults);
  renderExpansion();
  showAlert('Safe defaults loaded for review. No server setting changed yet.');
});

$('#import-expansion').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported.settings || !imported.characters) throw new Error('Preset must contain settings and characters.');
    state.expansionDraft = imported;
    renderExpansion();
    showAlert('Preset loaded for review. Press Save to validate and apply it.');
  } catch (error) {
    showAlert(`Preset rejected: ${error.message}`, true);
  } finally {
    event.target.value = '';
  }
});

$('#beta-access-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!await confirmAction('Change Beta Testing access?', 'The entitlement is server owned and the change is audit logged.')) return;
  await api('/api/admin/beta-testers', {
    method: 'PUT',
    body: {
      address: $('#beta-wallet').value,
      enabled: $('#beta-enabled').value === 'true',
      reason: $('#beta-reason').value
    }
  });
  $('#beta-reason').value = '';
  await loadExpansion(true);
  showAlert('Beta Testing access updated.');
});

$('#refresh-mine-operations').addEventListener('click', () => loadMineOperations(true));
$('#load-reward-week').addEventListener('click', () => loadMineOperations(true));

async function loadMineOperations(showSuccess = false) {
  const weekInput = $('#reward-week');
  if (!weekInput.value) weekInput.value = previousUtcWeek();
  try {
    const data = await api(`/api/admin/mine-operations?week=${encodeURIComponent(weekInput.value)}`);
    state.mineOperations = data;
    renderMineOperations(data);
    renderRewardOperations(data.rewards);
    if (showSuccess) showAlert('Mine operations and unpaid rewards refreshed from the server and Ronin.');
  } catch (error) {
    $('#mine-operations-grid').innerHTML = `<article class="panel">${escapeHtml(error.message)}</article>`;
    $('#reward-operations-summary').innerHTML = `<article class="panel">${escapeHtml(error.message)}</article>`;
  }
}

function renderMineOperations(data) {
  $('#mine-operations-grid').innerHTML = (data.mines || []).map((mine) => {
    const controls = mine.controls || {};
    const available = new Set(mine.availableControls || []);
    const gates = [
      ['entries', 'New runs', controls.entriesPaused, available.has('entries')],
      ['results', 'Finish runs', controls.resultsPaused, available.has('results')],
      ['payments', 'Payments', controls.paymentsPaused, available.has('payments')],
      ['rewards', 'Rewards', controls.rewardsPaused, available.has('rewards')]
    ];
    const applicableGates = gates.filter(([, , , isAvailable]) => isAvailable);
    return `<article class="panel mine-operations-card" data-mine="${escapeHtml(mine.id)}">
      <div class="mine-operations-title">
        <div><span class="mine-number">${mineNumber(mine.id)}</span><h3>${escapeHtml(mine.name)}</h3></div>
        <span class="badge ${applicableGates.some(([, , paused]) => paused) ? 'warning' : ''}">${applicableGates.every(([, , paused]) => !paused) ? 'OPEN' : 'LIMITED'}</span>
      </div>
      <div class="mine-live-counts">
        <span><b>${Number(mine.activeRuns || 0).toLocaleString()}</b> active</span>
        <span><b>${Number(mine.finishedRuns || 0).toLocaleString()}</b> finished</span>
        <span><b>${available.has('payments') ? Number(mine.pendingPayments || 0).toLocaleString() : '—'}</b>${available.has('payments') ? ' pending payments' : ' no payment flow'}</span>
      </div>
      <div class="mine-gates">${gates.map(([gate, label, paused, isAvailable]) => `
        <button type="button" class="mine-gate ${!isAvailable ? 'unavailable' : paused ? 'paused' : 'open'}"
          ${isAvailable ? `data-mine-control="${escapeHtml(mine.id)}" data-mine-gate="${gate}" data-next-paused="${paused ? 'false' : 'true'}"` : 'disabled'}>
          <span>${escapeHtml(label)}</span><strong>${!isAvailable ? 'NOT USED' : paused ? 'PAUSED' : 'OPEN'}</strong><small>${!isAvailable ? 'No such flow in this mine' : paused ? 'Click to resume' : 'Click to pause'}</small>
        </button>`).join('')}</div>
      <div class="mine-next-action"><strong>NEXT</strong><span>${escapeHtml(mineNextAction(mine, controls))}</span></div>
      <div class="action-row mine-links">
        <button type="button" class="ghost" data-operations-tab="studio">Edit live configuration</button>
        <button type="button" class="danger" data-terminate-mine-runs="${escapeHtml(mine.id)}" ${Number(mine.activeRuns || 0) > 0 ? '' : 'disabled'}>END ${Number(mine.activeRuns || 0).toLocaleString()} ACTIVE RUN${Number(mine.activeRuns || 0) === 1 ? '' : 'S'}</button>
        ${mine.id === 'arena'
          ? '<button type="button" class="ghost" data-operations-tab="arena">Schedule or settle Arena</button>'
          : ['daily', 'pass'].includes(mine.id)
            ? '<button type="button" class="ghost" data-scroll-payouts="true">Open payout desk</button>'
            : ''}
      </div>
      ${mine.id === 'arena' ? '<p class="mine-footnote">Server controls are here. Contract entry and settlement controls remain in Daily Arena.</p>' : ''}
    </article>`;
  }).join('');
}

$('#mine-operations-grid').addEventListener('click', async (event) => {
  const tabLink = event.target.closest('[data-operations-tab]');
  if (tabLink) {
    await activateTab(tabLink.dataset.operationsTab);
    return;
  }
  if (event.target.closest('[data-scroll-payouts]')) {
    $('.reward-desk-heading').scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const terminateButton = event.target.closest('[data-terminate-mine-runs]');
  if (terminateButton) {
    const mine = terminateButton.dataset.terminateMineRuns;
    const reason = $('#mine-control-reason').value;
    if (!reason.trim()) {
      showAlert('Write a reason before ending active runs.', true);
      $('#mine-control-reason').focus();
      return;
    }
    if (!await confirmAction(
      `End every active ${words(mine)} run now?`,
      'This is immediate. Players in that mine will be removed from their current run. Consumed payments, entries, and credits are not refunded or rewritten.'
    )) return;
    const result = await api(`/api/admin/mine-operations/${encodeURIComponent(mine)}/terminate-runs`, {
      method: 'POST',
      body: { reason }
    });
    $('#mine-control-reason').value = '';
    await refreshOverview();
    await loadMineOperations();
    showAlert(`${Number(result.affected || 0)} ${words(mine)} active run${Number(result.affected || 0) === 1 ? '' : 's'} ended.`);
    return;
  }
  const button = event.target.closest('[data-mine-control]');
  if (!button) return;
  const mine = button.dataset.mineControl;
  const gate = button.dataset.mineGate;
  const paused = button.dataset.nextPaused === 'true';
  const reason = $('#mine-control-reason').value;
  if (!reason.trim()) {
    showAlert('Write a reason before changing a mine control.', true);
    $('#mine-control-reason').focus();
    return;
  }
  if (!await confirmAction(`${paused ? 'Pause' : 'Resume'} ${words(mine)} ${gate}?`, 'This takes effect immediately and is audit logged. Existing records are preserved.')) return;
  await api(`/api/admin/mine-operations/${encodeURIComponent(mine)}`, {
    method: 'PUT',
    body: { patch: { [`${gate}Paused`]: paused }, reason }
  });
  $('#mine-control-reason').value = '';
  await refreshOverview();
  await loadMineOperations();
  showAlert(`${words(mine)} ${gate} ${paused ? 'paused' : 'resumed'}.`);
});

function renderRewardOperations(rewards = {}) {
  $('#reward-week-help').textContent = rewards.publicationEnabled
    ? `Live publishing enabled · maximum ${Number(rewards.maxBoardMatt || 0).toLocaleString()} MATT per board`
    : 'Publishing is not enabled on this server.';
  $('#reward-operations-summary').innerHTML = (rewards.boards || []).map((board) => {
    const label = board.mode === 'paid' ? 'Pass Ranked' : 'Free Ranked';
    const draft = board.draft || null;
    const obligations = board.obligations || [];
    return `<article class="panel reward-board" data-board="${escapeHtml(board.mode)}">
      <div class="reward-board-header">
        <div><p class="eyebrow">${escapeHtml(label)}</p><h3>${escapeHtml(rewards.week || board.week)}</h3></div>
        <span class="reward-stage">STEP ${rewardStep(board)} OF 6</span>
      </div>
      <ol class="reward-steps">
        ${rewardStepItem(1, 'Leaderboard closed', board.snapshotFinalized, board.snapshotFinalized ? `${Number(board.participantCount || 0)} eligible miners` : 'Waiting for the immutable server snapshot')}
        ${rewardStepItem(2, 'Payout obligation created', Boolean(draft), draft ? `${Number(draft.allocatedMatt || 0).toLocaleString()} MATT locked to ${draft.entries?.length || 0} wallets` : 'Choose the pool below')}
        ${rewardStepItem(3, 'Independent approval', draft?.status === 'approved' || draft?.status === 'published', draft ? words(draft.status) : 'Waiting')}
        ${rewardStepItem(4, 'Safe executed', board.chain?.published === true, board.chain?.published ? 'Exact epoch found on Ronin' : 'Download and execute the Safe JSON')}
        ${rewardStepItem(5, 'Server synchronized', draft?.status === 'published', draft?.status === 'published' ? 'Players can claim' : 'Sync after the Safe transaction is mined')}
        ${rewardStepItem(6, 'Claims monitored', board.unpaidCount === 0 && obligations.length > 0, obligations.length ? `${Number(board.paidCount || 0)} paid · ${Number(board.unpaidCount || 0)} unpaid` : 'Starts after publication')}
      </ol>
      ${draft ? `<div class="reward-terms">
        <span><small>POOL</small><strong>${Number(draft.allocatedMatt || 0).toLocaleString()} MATT</strong></span>
        <span><small>CLAIM DEADLINE</small><strong>${formatRewardDeadline(draft.claimDeadline)}</strong></span>
        <span><small>PAID</small><strong>${Number(board.paidMatt || 0).toLocaleString()} MATT</strong></span>
        <span class="${Number(board.unpaidMatt || 0) > 0 ? 'unpaid' : ''}"><small>STILL OWED</small><strong>${Number(board.unpaidMatt || 0).toLocaleString()} MATT</strong></span>
      </div>` : ''}
      <div class="reward-next"><strong>DO THIS NEXT</strong><p>${escapeHtml(board.nextAction || 'Refresh status.')}</p></div>
      ${!draft && board.snapshotFinalized ? `<div class="reward-create-row">
        <label>Total ${escapeHtml(label)} pool (MATT)<input data-reward-pool="${escapeHtml(board.mode)}" type="number" min="1" max="${Number(rewards.maxBoardMatt || 5000000)}" step="1" value="${board.mode === 'paid' ? 5000000 : 2500000}"></label>
        <label>Claim window (days)<input data-reward-days="${escapeHtml(board.mode)}" type="number" min="1" max="90" value="30"></label>
        <button type="button" data-create-reward="${escapeHtml(board.mode)}">Create exact obligation</button>
      </div>` : ''}
      ${draft ? `<div class="reward-actions action-row">
        ${draft.status === 'draft' ? `<button type="button" data-reward-approve="${escapeHtml(draft.id)}">Approve + create Safe JSON</button>` : ''}
        ${draft.status === 'approved' && !board.chain?.published ? `<button type="button" data-reward-approve="${escapeHtml(draft.id)}">Rebuild Safe JSON</button>` : ''}
        ${['approved', 'published'].includes(draft.status) ? `<button type="button" class="ghost" data-reward-sync="${escapeHtml(draft.id)}">Check Ronin + synchronize</button>` : ''}
      </div>
      <details class="reward-obligations" ${board.unpaidCount ? 'open' : ''}>
        <summary><strong>Unpaid obligations</strong><span>${Number(board.unpaidMatt || 0).toLocaleString()} MATT still owed</span></summary>
        ${rewardObligationTable(obligations)}
      </details>` : ''}
    </article>`;
  }).join('') || '<article class="panel">The reward pipeline is unavailable.</article>';
}

$('#reward-operations-summary').addEventListener('click', async (event) => {
  const create = event.target.closest('[data-create-reward]');
  if (create) {
    const mode = create.dataset.createReward;
    const poolMatt = Number($(`[data-reward-pool="${mode}"]`).value);
    const claimDays = Number($(`[data-reward-days="${mode}"]`).value);
    if (!await confirmAction('Create this exact payout obligation?', 'Winner wallets and amounts become immutable. Verify the week, board, total pool, and leaderboard first.')) return;
    await api('/api/admin/rewards/drafts', {
      method: 'POST',
      body: { mode, week: $('#reward-week').value, poolMatt, claimDays }
    });
    await loadMineOperations();
    showAlert('Immutable payout obligation created. Complete independent approval next.');
    return;
  }
  const approve = event.target.closest('[data-reward-approve]');
  if (approve) {
    await approveReward(approve.dataset.rewardApprove);
    return;
  }
  const sync = event.target.closest('[data-reward-sync]');
  if (sync) await syncReward(sync.dataset.rewardSync);
});

function rewardObligationTable(obligations) {
  if (!obligations.length) return '<p>No player obligations were created.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Rank</th><th>Wallet</th><th>Score</th><th>MATT owed</th><th>Payment</th></tr></thead><tbody>${obligations.map((entry) => `<tr>
    <td>#${Number(entry.rank || 0)}</td><td>${escapeHtml(short(entry.address))}</td><td>${Number(entry.score || 0).toLocaleString()}</td>
    <td>${Number(entry.amountMatt || 0).toLocaleString()}</td><td><span class="badge ${entry.status === 'paid' ? '' : 'warning'}">${escapeHtml(words(entry.status))}</span></td>
  </tr>`).join('')}</tbody></table></div>`;
}

function rewardStep(board) {
  if (!board.snapshotFinalized) return 1;
  if (!board.draft) return 2;
  if (board.draft.status === 'draft') return 3;
  if (!board.chain?.published) return 4;
  if (board.draft.status !== 'published') return 5;
  return 6;
}

function rewardStepItem(number, label, complete, detail) {
  return `<li class="${complete ? 'complete' : ''}"><span>${complete ? '✓' : number}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div></li>`;
}

function formatRewardDeadline(value) {
  const timestamp = Number(value || 0) * 1000;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Not set';
  return new Date(timestamp).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  });
}

function mineNumber(mine) {
  return { practice: '01', arena: '02', daily: '03', pass: '04', weekly: '05' }[mine] || '—';
}

function mineNextAction(mine, controls) {
  if (controls.entriesPaused && !controls.resultsPaused) return 'New entries are closed. Let active runs finish, then pause Finish runs.';
  if (controls.entriesPaused && controls.resultsPaused) {
    if (mine.id === 'arena') return 'Competition is closed. Open Daily Arena and prepare the full-pool settlement.';
    if (['daily', 'pass'].includes(mine.id)) return 'Competition is closed. Use the payout desk after the weekly leaderboard finalizes.';
    return 'Competition is closed. Review results before reopening.';
  }
  if (controls.paymentsPaused) return 'Play is open, but payments are stopped. Resume only after payment verification is healthy.';
  if (controls.rewardsPaused) return 'Play is open, but payouts and claims are stopped. Review obligations before resuming.';
  if (mine.id === 'daily') return 'Mine is live. Monitor active runs; use the payout desk after the weekly board closes.';
  if (mine.id === 'weekly') return 'Mine is live. Monitor active runs and pause New runs first when closing.';
  if (mine.id === 'practice') return 'Mine is live. Monitor active runs and paid Practice reward claims.';
  if (mine.id === 'arena') return 'Arena is live. Monitor entries here and settle the full pool from Daily Arena after close.';
  return 'Mine is live. Monitor active runs and paid credits; pause New runs first when closing.';
}

function renderReadiness(readiness = {}) {
  const hero = $('#readiness-hero');
  if (!hero) return;
  hero.dataset.status = readiness.status || 'blocked';
  $('#readiness-score').textContent = Number.isFinite(readiness.score) ? readiness.score : '—';
  $('#readiness-label').textContent = readiness.label || 'Readiness unavailable';
  $('#readiness-copy').textContent = readiness.requiredCount
    ? `${readiness.readyRequired} of ${readiness.requiredCount} core systems ready. Optional features are shown separately.`
    : 'The live server did not return readiness details.';
  $('#readiness-checked').textContent = readiness.checkedAt
    ? `Checked ${new Date(readiness.checkedAt).toLocaleTimeString()}`
    : 'Not checked';
  $('#readiness-monitors').innerHTML = (readiness.monitors || []).map((monitor) => `
    <article class="readiness-monitor" data-status="${escapeHtml(monitor.status)}">
      <span class="monitor-group">${escapeHtml(monitor.group)}${monitor.required ? ' · CORE' : ''}</span>
      <strong>${escapeHtml(monitor.label)}</strong>
      <p>${escapeHtml(monitor.detail)}</p>
    </article>
  `).join('') || '<article class="readiness-monitor" data-status="blocked"><strong>No readiness data</strong><p>Run the checks again.</p></article>';
}

$('#refresh-overview').addEventListener('click', async () => {
  $('#refresh-overview').disabled = true;
  try {
    await refreshOverview();
    showAlert('Live readiness checks completed.');
  } catch (error) {
    showAlert(error.message, true);
  } finally {
    $('#refresh-overview').disabled = false;
  }
});

function startOverviewMonitor() {
  if (state.overviewTimer) clearInterval(state.overviewTimer);
  state.overviewTimer = setInterval(() => {
    if (state.key && state.activeTab === 'overview' && document.visibilityState === 'visible') {
      refreshOverview().catch(() => undefined);
    }
  }, 30_000);
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
  await loadMineOperations();
}

async function syncReward(id) {
  const transactionHash = prompt('Paste the Ronin publication transaction hash (optional if the exact epoch is already on-chain).') || '';
  await api(`/api/admin/rewards/drafts/${id}/sync`, { method: 'POST', body: { transactionHash } });
  await loadMineOperations();
  showAlert('Reward draft synchronized with Ronin.');
}

$('#refresh-arena-admin').addEventListener('click', loadArenaAdmin);
$('#arena-admin-day').addEventListener('change', loadArenaAdmin);

$('#arena-schedule-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const day = $('#arena-admin-day').value;
  const feeMatt = Number($('#arena-admin-fee').value);
  const seedMatt = Number($('#arena-admin-seed').value || 0);
  const reason = $('#arena-admin-schedule-reason').value;
  if (!await confirmAction(
    'Prepare this Arena day?',
    `${feeMatt.toLocaleString()} MATT per unlimited entry, with ${seedMatt.toLocaleString()} MATT Treasury seed. The price cannot change after the UTC day opens.`
  )) return;
  const result = await api(`/api/admin/arena/days/${encodeURIComponent(day)}`, {
    method: 'PUT',
    body: { feeMatt, seedMatt, reason }
  });
  renderArenaSafePackage(
    'Arena schedule and seed',
    result.arena?.safe,
    result.arena?.transactions,
    `matt-mine-arena-${day}-schedule.json`
  );
  $('#arena-admin-schedule-reason').value = '';
  await loadArenaAdmin();
  showAlert('Arena Safe package prepared. No transaction was broadcast.');
});

$('#arena-prepare-settlement').addEventListener('click', async () => {
  const day = $('#arena-admin-day').value;
  const reason = $('#arena-admin-action-reason').value;
  if (!reason) {
    showAlert('A settlement reason is required.', true);
    return;
  }
  if (!await confirmAction(
    'Prepare full-pool settlement?',
    'The immutable daily snapshot becomes one Safe transaction that distributes the complete entry pool and Treasury seed to verified winners.'
  )) return;
  const result = await api(`/api/admin/arena/days/${encodeURIComponent(day)}/settlement`, {
    method: 'POST',
    body: { reason }
  });
  const draft = result.settlement?.draft || result.settlement;
  renderArenaSafePackage(
    'Arena full-pool settlement',
    draft?.safe,
    draft?.transactions || (draft?.transaction ? [draft.transaction] : []),
    `matt-mine-arena-${day}-settlement.json`
  );
  $('#arena-admin-action-reason').value = '';
  await loadArenaAdmin();
});

$('#arena-prepare-cancel').addEventListener('click', async () => {
  const day = $('#arena-admin-day').value;
  const reason = $('#arena-admin-action-reason').value;
  if (!reason) {
    showAlert('A cancellation reason is required.', true);
    return;
  }
  if (!await confirmAction(
    'Prepare Arena cancellation?',
    'Cancellation enables exact player entry refunds and returns only that day’s Treasury seed under the contract rules.'
  )) return;
  const result = await api(`/api/admin/arena/days/${encodeURIComponent(day)}/cancel`, {
    method: 'POST',
    body: { reason }
  });
  renderArenaSafePackage(
    'Arena cancellation',
    result.cancellation?.safe,
    result.cancellation?.transaction ? [result.cancellation.transaction] : [],
    `matt-mine-arena-${day}-cancel.json`
  );
  $('#arena-admin-action-reason').value = '';
  await loadArenaAdmin();
});

$('#arena-seed-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const day = $('#arena-admin-day').value;
  const seedMatt = Number($('#arena-seed-top-up').value);
  const reason = $('#arena-seed-reason').value;
  if (!await confirmAction(
    'Prepare Treasury seed top-up?',
    `Prepare an ordered approval and ${seedMatt.toLocaleString()} MATT seed transaction for ${day}? The contract enforces the cumulative 10,000,000 MATT cap.`
  )) return;
  const result = await api(`/api/admin/arena/days/${encodeURIComponent(day)}/seed`, {
    method: 'POST',
    body: { seedMatt, reason }
  });
  renderArenaSafePackage(
    'Arena seed top-up',
    result.seed?.safe,
    result.seed?.transactions,
    `matt-mine-arena-${day}-seed.json`
  );
  $('#arena-seed-reason').value = '';
  await loadArenaAdmin();
});

document.querySelectorAll('[data-arena-control]').forEach((button) => {
  button.addEventListener('click', async () => {
    const action = button.dataset.arenaControl;
    const reason = $('#arena-control-reason').value;
    if (!reason) {
      showAlert('A control-change reason is required.', true);
      return;
    }
    if (!await confirmAction(
      'Prepare Arena pause control?',
      `Prepare ${words(action)} for the emergency-pauser wallet? Nothing will be signed or broadcast.`
    )) return;
    const result = await api(`/api/admin/arena/controls/${encodeURIComponent(action)}`, {
      method: 'POST',
      body: { reason }
    });
    renderArenaDirectTransaction(
      `Arena ${words(action)}`,
      result.control,
      `matt-mine-arena-${action}-direct.json`
    );
    $('#arena-control-reason').value = '';
    await loadArenaAdmin();
  });
});

async function loadArenaAdmin() {
  const dayInput = $('#arena-admin-day');
  if (!dayInput.value) dayInput.value = nextUtcDay();
  try {
    const data = await api(`/api/admin/arena?day=${encodeURIComponent(dayInput.value)}`);
    const arena = data.arena || {};
    const board = arena.leaderboard || {};
    const settlement = arena.settlement || {};
    const controls = arena.controls || {};
    const config =
      arena.day && typeof arena.day === 'object'
        ? arena.day
        : arena.config || arena.dayConfig || board;
    const feeMatt = config.fee?.matt ?? config.feeMatt ?? config.entryFeeMatt ?? 25_000;
    const seedMatt = config.seed?.matt ?? config.seedMatt ?? config.seededMatt ?? 0;
    const replayReady = config.replayReady === true;
    $('#arena-admin-fee').value = Number(feeMatt);
    $('#arena-admin-seed').value = Number(seedMatt);
    const scheduleButton = document.querySelector('#arena-schedule-form button[type="submit"]');
    const seedButton = document.querySelector('#arena-seed-form button[type="submit"]');
    const unpauseEntriesButton = document.querySelector('[data-arena-control="unpause-entries"]');
    for (const button of [scheduleButton, seedButton, unpauseEntriesButton]) {
      if (!button) continue;
      button.disabled = !replayReady;
      button.title = replayReady
        ? ''
        : 'Security-locked until input-only deterministic replay is release-ready.';
    }
    $('#arena-admin-metrics').innerHTML = [
      metric('Status', config.status || board.status || 'Unscheduled'),
      metric('Entries', config.entryCount || board.entryCount || 0),
      metric('Unique miners', config.uniquePlayers || board.participantCount || 0),
      metric('Entry pool', `${mattDisplay(config.entryPoolRaw ?? config.entryPoolMatt ?? config.entryMatt ?? board.entryPoolRaw)} MATT`),
      metric('Treasury seed', `${mattDisplay(config.seed?.raw ?? config.seedRaw ?? config.seedMatt ?? config.seededMatt ?? board.seedRaw)} MATT`),
      metric('Total pool', `${mattDisplay(config.prizePoolRaw ?? config.prizePoolMatt ?? config.totalPoolMatt ?? board.prizePoolRaw)} MATT`)
    ].join('');
    $('#arena-admin-status').innerHTML = [
      row('UTC day', config.day || dayInput.value),
      row('Configured entry', `${mattDisplay(config.fee?.raw ?? config.feeMatt ?? config.entryFeeMatt)} MATT`),
      row('Player pool ceiling', 'None'),
      row('Daily Treasury seed cap', '10,000,000 MATT'),
      row('Paid entry release gate', config.enabled ? 'Enabled' : `Locked${config.liveBlocker ? ` · ${config.liveBlocker}` : ''}`),
      row('Executable setup', replayReady ? 'Available' : 'Blocked by replay gate'),
      row('Snapshot', board.finalized ? 'Immutable' : 'Not finalized'),
      row('Settlement', settlement.status || (settlement.draft ? 'Draft ready' : 'Not prepared'))
    ].join('');
    $('#arena-control-status').innerHTML = [
      row('Onchain entries', controls.entriesPaused ? 'Paused' : 'Open'),
      row('Onchain settlement', controls.settlementPaused ? 'Paused' : 'Open')
    ].join('');
    const rows = settlement.allocations?.length ? settlement.allocations : board.rows || [];
    $('#arena-admin-winners').innerHTML = rows.length
      ? rows.slice(0, 10).map((winner, index) => `<tr>
          <td>#${Number(winner.rank || index + 1)}</td>
          <td>${escapeHtml(short(winner.address || winner.wallet))}</td>
          <td>${Number(winner.score || 0).toLocaleString()}</td>
          <td>${Number(winner.entries || winner.entryCount || 0).toLocaleString()}</td>
          <td>${mattDisplay(winner.payoutMatt ?? winner.amountMatt ?? winner.payoutRaw)}</td>
        </tr>`).join('')
      : '<tr><td colspan="5">No finalized Arena winners for this day.</td></tr>';
  } catch (error) {
    $('#arena-admin-metrics').innerHTML = metric('Arena', 'Not configured');
    $('#arena-admin-status').innerHTML = `<p>${escapeHtml(error.message)}</p>`;
    $('#arena-control-status').innerHTML = '<p>Onchain pause state is unavailable.</p>';
    $('#arena-admin-winners').innerHTML = '<tr><td colspan="5">Arena data is unavailable.</td></tr>';
  }
}

function renderArenaSafePackage(title, safe, transactions = [], fallbackFileName) {
  const panel = $('#arena-admin-transaction');
  panel.hidden = false;
  panel.innerHTML = `<h2>${escapeHtml(title)} — not broadcast</h2>
    ${row('Ordered Safe transactions', transactions?.length || safe?.transactions?.length || 0)}
    <p>Download this JSON file, inspect the exact day, MATT amounts, winner addresses, and total, then drag it into the Ronin Safe Transaction Builder for Safe-owner approval.</p>
    <div class="action-row"><button id="download-arena-safe-json">Download Safe JSON</button><button id="copy-arena-safe-json" class="ghost">Copy JSON</button></div>
    <div class="code">${escapeHtml(JSON.stringify(transactions?.length ? transactions : safe?.transactions || [], null, 2))}</div>`;
  $('#download-arena-safe-json').addEventListener('click', () => downloadJson(fallbackFileName, safe));
  $('#copy-arena-safe-json').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(safe, null, 2)));
}

function renderArenaDirectTransaction(title, control = {}, fallbackFileName) {
  const panel = $('#arena-admin-transaction');
  const transaction = control.transaction || control.transactions?.[0] || {};
  const downloadable = {
    schemaVersion: 1,
    kind: 'direct-role-transaction',
    requiredSigner: control.requiredSigner || transaction.requiredSigner,
    broadcast: false,
    transaction
  };
  panel.hidden = false;
  panel.innerHTML = `<h2>${escapeHtml(title)} — not broadcast</h2>
    ${row('Required signer', downloadable.requiredSigner || 'Emergency pauser')}
    ${row('To', transaction.to || 'Unavailable')}
    ${row('Value', transaction.value ?? '0')}
    <p>This action must be sent directly by the named emergency-pauser wallet. It is not a Treasury Safe transaction.</p>
    <p>Calldata</p><div class="code">${escapeHtml(transaction.data || '')}</div>
    <div class="action-row"><button id="download-arena-direct-json">Download direct transaction JSON</button><button id="copy-arena-direct-json" class="ghost">Copy JSON</button></div>`;
  $('#download-arena-direct-json').addEventListener('click', () => downloadJson(fallbackFileName, downloadable));
  $('#copy-arena-direct-json').addEventListener('click', () => navigator.clipboard.writeText(JSON.stringify(downloadable, null, 2)));
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

async function hydrateControlIndex() {
  await Promise.allSettled([loadTuning(), loadExpansion()]);
  rebuildControlIndex();
}

function rebuildControlIndex() {
  state.controlIndex = buildAdminControlIndex({
    tuningSchema: state.tuning?.schema || [],
    expansionSchema: state.expansion?.schema || [],
    characters: state.expansionDraft?.characters || state.expansion?.config?.characters || {}
  });
}

$('#control-search').addEventListener('input', renderControlSearch);
$('#control-search').addEventListener('focus', renderControlSearch);
$('#control-search-results').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-control-result]');
  if (!button) return;
  const result = state.controlIndex.find((entry) => entry.id === button.dataset.controlResult);
  if (!result) return;
  await openControlSearchResult(result);
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    $('#control-search').focus();
    $('#control-search').select();
  }
  if (event.key === 'Escape') {
    $('#control-search-results').hidden = true;
    $('#control-search').blur();
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#command-toolbar')) $('#control-search-results').hidden = true;
});

document.addEventListener('admin-linked-control-change', (event) => {
  syncLinkedDraft(event.detail?.id, event.detail?.value, event.detail?.source || 'nugget-economy');
});

document.addEventListener('admin-linked-controls-saved', () => {
  Promise.all([loadExpansion(true), loadTuning(true), refreshOverview()]).catch((error) => showAlert(error.message, true));
});

function renderControlSearch() {
  const query = $('#control-search').value;
  const results = searchAdminControls(state.controlIndex, query, 14);
  const panel = $('#control-search-results');
  panel.hidden = !query.trim();
  if (!query.trim()) {
    panel.innerHTML = '';
    return;
  }
  panel.innerHTML = results.map((result) => `
    <button class="search-result" type="button" data-control-result="${escapeHtml(result.id)}">
      <strong>${escapeHtml(result.label)}</strong>
      <small>${escapeHtml(result.group)} · ${escapeHtml(result.description)}</small>
      <span>Open</span>
    </button>
  `).join('') || '<div class="search-result"><strong>No controls found</strong><small>Try a shorter phrase or a category name.</small></div>';
}

async function openControlSearchResult(result) {
  $('#control-search-results').hidden = true;
  if (result.id.startsWith('tuning:')) {
    if (!state.tuning) await loadTuning();
    const definition = state.tuning.schema.find((entry) => `tuning:${entry.id}` === result.id);
    $('#tuning-category').value = definition?.category || '';
    $('#tuning-search').value = definition?.label || result.label;
    await activateTab(result.tab);
    $('#tuning-fields').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (result.id.startsWith('expansion:')) {
    if (!state.expansion) await loadExpansion();
    const definition = state.expansion.schema.find((entry) => `expansion:${entry.id}` === result.id);
    $('#expansion-search').value = definition
      ? `${definition.category} ${definition.label}`
      : result.label;
    await activateTab(result.tab);
    $('#expansion-fields').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (result.id.startsWith('character:')) {
    if (!state.expansion) await loadExpansion();
    const [, characterId] = result.id.split(':');
    $('#expansion-search').value = characterId;
    await activateTab(result.tab);
    $('#expansion-fields').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    await activateTab(result.tab);
  }
  $('#control-search').value = '';
}

function syncLinkedDraft(id, value, source) {
  if (!id) return;
  const retention = RETENTION_CONTROL_LINKS.find((entry) => entry.id === id);
  if (retention) {
    if (source === 'tuning') {
      if (state.expansionDraft) state.expansionDraft.settings[retention.expansionKey] = Number((Number(value) * 100).toFixed(4));
      setLinkedInput(`[data-expansion-setting="${retention.expansionKey}"]`, Number(value) * 100);
    } else {
      if (state.tuningDrafts[retention.lobby]) state.tuningDrafts[retention.lobby].deathKeepFraction = Number((Number(value) / 100).toFixed(4));
      if ($('#tuning-lobby').value === retention.lobby) setLinkedInput('[data-tuning="deathKeepFraction"]', Number(value) / 100);
    }
    return;
  }
  if (id === 'advertisement-rewards-enabled') {
    const enabled = value === true;
    if (state.expansionDraft) state.expansionDraft.settings.advertisementRewardsEnabled = enabled;
    setLinkedInput('[data-expansion-setting="advertisementRewardsEnabled"]', enabled);
    setLinkedInput('#economy-ads-enabled', enabled);
    return;
  }
  const characterPrice = CHARACTER_PRICE_CONTROL_LINKS.find((entry) => entry.id === id);
  if (!characterPrice) return;
  const price = Math.max(0, Math.round(Number(value) || 0));
  if (state.expansionDraft?.characters?.[characterPrice.characterId]) {
    state.expansionDraft.characters[characterPrice.characterId].nuggetPrice = price;
  }
  setLinkedInput(`[data-character="${characterPrice.characterId}"][data-character-field="nuggetPrice"]`, price);
  const selector = {
    ronke: '#economy-character-ronke',
    adlDyno: '#economy-character-adl',
    axie: '#economy-character-axie',
    orc: '#economy-character-orc'
  }[characterPrice.economyKey];
  setLinkedInput(selector, price);
}

function setLinkedInput(selector, value) {
  const input = selector ? $(selector) : null;
  if (!input) return;
  if (input.type === 'checkbox') input.checked = value === true;
  else input.value = Number.isFinite(Number(value)) ? Number(value) : value;
}

function objectDiff(original = {}, next = {}) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => original[key] !== value));
}

async function api(path, options = {}) {
  let response = await adminFetch(path, options);
  let payload = await response.json().catch(() => ({}));
  if (response.status === 403 && payload.error?.code === 'admin_step_up_required') {
    await performAdminStepUp();
    response = await adminFetch(path, options);
    payload = await response.json().catch(() => ({}));
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Request failed (${response.status})`);
    error.code = payload.error?.code || '';
    throw error;
  }
  return payload;
}

async function adminFetch(path, options = {}) {
  return fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: { ...(state.csrfToken ? { 'x-matt-csrf': state.csrfToken } : {}), ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
}

async function connectAdminWallet() {
  const provider = window.ronin?.provider;
  if (!provider?.request) throw new Error('Ronin Wallet was not detected.');
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = accounts?.[0];
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) throw new Error('Ronin Wallet did not return a valid account.');
  const currentChain = Number.parseInt(await provider.request({ method: 'eth_chainId' }), 16);
  if (currentChain !== 2020) await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x7e4' }] });
  const challengeResponse = await fetch('/api/auth/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, chainId: 2020, origin: location.origin })
  });
  const challengePayload = await challengeResponse.json();
  if (!challengeResponse.ok) throw new Error(challengePayload.error?.message || 'Admin sign-in challenge failed.');
  const signature = await provider.request({ method: 'personal_sign', params: [challengePayload.challenge.message, address] });
  const verifyResponse = await fetch('/api/auth/verify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, nonce: challengePayload.challenge.nonce, signature })
  });
  const verified = await verifyResponse.json();
  if (!verifyResponse.ok) throw new Error(verified.error?.message || 'Admin wallet signature was rejected.');
  const playerToken = verified.session?.token;
  if (!playerToken) throw new Error('Admin wallet verification did not return a player session.');
  const sessionResponse = await fetch('/api/admin/auth/session', {
    method: 'POST', credentials: 'same-origin', headers: { authorization: `Bearer ${playerToken}` }
  });
  const session = await sessionResponse.json();
  await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${playerToken}` } }).catch(() => undefined);
  if (!sessionResponse.ok) throw new Error(session.error?.message || 'This wallet is not authorized for Admin.');
  state.csrfToken = session.csrfToken;
  state.adminAddress = session.admin.address;
  state.provider = provider;
  window.mattMineAdminSession = { fetch: api, address: state.adminAddress };
}

async function performAdminStepUp() {
  if (!state.provider || !state.adminAddress) throw new Error('Reconnect the authorized Admin wallet.');
  const created = await adminFetch('/api/admin/auth/step-up/challenge', { method: 'POST', body: {} });
  const challengePayload = await created.json();
  if (!created.ok) throw new Error(challengePayload.error?.message || 'Could not create Admin step-up challenge.');
  const signature = await state.provider.request({ method: 'personal_sign', params: [challengePayload.challenge.message, state.adminAddress] });
  const verified = await adminFetch('/api/admin/auth/step-up/verify', { method: 'POST', body: { nonce: challengePayload.challenge.nonce, signature } });
  if (!verified.ok) throw new Error('Admin step-up signature failed.');
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
function metric(label, value) { return `<div class="metric"><span class="muted">${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`; }
function status(enabled) { return enabled ? 'Enabled' : 'Paused'; }
function short(value) { const text = String(value || ''); return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text; }
function words(value) { return String(value).replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (char) => char.toUpperCase()); }
function argumentHint(type) { return type === 'address' ? '0x…' : type === 'board' ? 'free or paid' : type === 'ron' ? 'RON amount' : type === 'matt' ? 'MATT amount' : 'Whole number'; }
function nextUtcDay() {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}
function previousUtcWeek() {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const currentMonday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 1);
  return new Date(currentMonday - 7 * 86_400_000).toISOString().slice(0, 10);
}
function mattDisplay(value) {
  if (value === undefined || value === null || value === '') return '0';
  const text = String(value);
  try {
    const parsed = BigInt(text);
    const matt = parsed > 10_000_000_000n ? parsed / 10n ** 18n : parsed;
    return Number(matt <= BigInt(Number.MAX_SAFE_INTEGER) ? matt : 0n).toLocaleString();
  } catch {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString() : '0';
  }
}
