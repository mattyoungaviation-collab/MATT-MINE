const panel = document.querySelector('#wallet-detail');

if (panel) {
  const observer = new MutationObserver(() => queueMicrotask(attachPlayerEditor));
  observer.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
}

async function attachPlayerEditor() {
  if (!panel || panel.hidden) return;
  const address = panel.querySelector('h2')?.textContent?.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) return;
  if (panel.dataset.editorFor === address && panel.querySelector('.player-state-editor')) return;
  panel.dataset.editorFor = address;

  const placeholder = document.createElement('section');
  placeholder.className = 'player-state-editor editor-loading';
  placeholder.innerHTML = '<h3>Complete player editor</h3><p>Loading mutable player state…</p>';
  panel.appendChild(placeholder);

  try {
    const data = await adminApi(`/api/admin/wallets/${address}`);
    if (panel.dataset.editorFor !== address) return;
    placeholder.replaceWith(renderPlayerEditor(address, data));
  } catch (error) {
    placeholder.innerHTML = `<h3>Complete player editor</h3><p class="bad">${escapeHtml(error.message)}</p>`;
  }
}

function renderPlayerEditor(address, data) {
  const wallet = data.wallet || {};
  const editor = data.editor || {};
  const profile = wallet.profile || {};
  const pass = wallet.passInventory || {};
  const passProgress = wallet.passProgress || {};
  const chest = pass.chests?.[editor.chestId] || {};
  const keybindings = wallet.keybindings || {};
  const section = document.createElement('section');
  section.className = 'player-state-editor';
  section.innerHTML = `
    <div class="editor-heading">
      <div><p class="eyebrow">SERVER-OWNED PLAYER DATA</p><h3>Complete player editor</h3></div>
      <span class="badge">Audit logged</span>
    </div>
    <div class="notice warning">Exact edits apply immediately. Expire active runs first. Confirmed payments, published rewards, on-chain balances, and finished leaderboard scores remain protected.</div>

    <form class="player-editor-form">
      <article class="editor-section">
        <h4>Identity and daily access</h4>
        <div class="compact-grid">
          <label>Permanent miner name<input data-player-field="identity-name" maxlength="16" value="${escapeHtml(wallet.identity?.name || '')}"></label>
          <label class="toggle">Remove profile picture<input data-player-field="clear-avatar" type="checkbox"></label>
          <label class="toggle">Free run used today<input data-player-field="free-run-used" type="checkbox" ${wallet.freeRunUsedToday ? 'checked' : ''}></label>
        </div>
      </article>

      <article class="editor-section">
        <h4>Gameplay profile</h4>
        <div class="compact-grid">
          ${numberField('Banked nuggets', 'bankedNuggets', profile.bankedNuggets, 0, editor.limits?.bankedNuggets)}
          ${numberField('Best depth', 'bestDepth', profile.bestDepth, 0, editor.limits?.bestDepth)}
          ${numberField('Best score', 'bestScore', profile.bestScore, 0, editor.limits?.bestScore)}
          ${numberField('Total finished runs', 'totalRuns', profile.totalRuns, 0, editor.limits?.totalRuns)}
        </div>
      </article>

      <article class="editor-section">
        <h4>Permanent upgrade ranks</h4>
        <div class="compact-grid">
          ${(editor.metaUpgrades || []).map((upgrade) => `
            <label>${escapeHtml(upgrade.name)}
              <input data-meta-upgrade="${escapeHtml(upgrade.id)}" type="number" min="0" max="${Number(upgrade.max)}" step="1" value="${Number(profile.meta?.[upgrade.id] || 0)}">
              <small>${escapeHtml(upgrade.description || '')} · maximum ${Number(upgrade.max)}</small>
            </label>`).join('')}
        </div>
      </article>

      <article class="editor-section">
        <h4>Pass progress and chests</h4>
        <div class="compact-grid">
          ${numberField('Pass XP', 'passXp', passProgress.xp, 0, editor.limits?.passXp)}
          ${numberField('Available Pass chests', 'chestAvailable', chest.available, 0, 100)}
          ${numberField('Opened Pass chests', 'chestOpened', chest.opened, 0, 100)}
          ${numberField('Last chest timestamp', 'chestLastOpenedAt', chest.lastOpenedAt, 0, Number.MAX_SAFE_INTEGER)}
        </div>
        <h5>Pass achievements / claimed reward levels</h5>
        <div class="check-list">
          ${(editor.passRewards || []).map((reward) => `
            <label class="toggle">Level ${Number(reward.level)} · ${escapeHtml(reward.name)}
              <input data-claimed-level="${Number(reward.level)}" type="checkbox" ${pass.claimedLevels?.includes(reward.level) ? 'checked' : ''}>
            </label>`).join('')}
        </div>
      </article>

      <article class="editor-section">
        <h4>Owned cosmetics</h4>
        <div class="check-list">
          ${(editor.cosmetics || []).map((cosmetic) => `
            <label class="toggle">${escapeHtml(cosmetic.name)} <small>${escapeHtml(cosmetic.slot)}</small>
              <input data-owned-cosmetic="${escapeHtml(cosmetic.id)}" type="checkbox" ${pass.cosmetics?.includes(cosmetic.id) ? 'checked' : ''}>
            </label>`).join('')}
        </div>
        <h5>Equipped loadout</h5>
        <div class="compact-grid">
          ${(editor.cosmeticSlots || []).map((slot) => `
            <label>${escapeHtml(words(slot))}
              <select data-equipped-slot="${escapeHtml(slot)}">
                <option value="">None</option>
                ${(editor.cosmetics || []).filter((cosmetic) => cosmetic.slot === slot).map((cosmetic) => `
                  <option value="${escapeHtml(cosmetic.id)}" ${pass.equipped?.[slot] === cosmetic.id ? 'selected' : ''}>${escapeHtml(cosmetic.name)}</option>`).join('')}
              </select>
            </label>`).join('')}
        </div>
      </article>

      <article class="editor-section">
        <h4>Gameplay keybindings</h4>
        <div class="compact-grid">
          ${Object.entries(keybindings).map(([action, key]) => `
            <label>${escapeHtml(words(action))}<input data-keybinding="${escapeHtml(action)}" value="${escapeHtml(key)}"></label>`).join('')}
        </div>
      </article>

      <article class="editor-section">
        <label>Required reason<input data-player-field="reason" maxlength="240" placeholder="Why is this exact player data changing?" required></label>
        <div class="action-row"><button type="submit">Save exact player state</button></div>
        <p class="editor-status" aria-live="polite"></p>
      </article>
    </form>

    <article class="editor-section danger-zone">
      <h4>Beta reset tools</h4>
      <p>These remove mutable server progression only. They never alter wallet funds, confirmed purchases, published claims, or completed leaderboard records.</p>
      <label>Required reset reason<input data-reset-reason maxlength="240" placeholder="Why is this player being reset?"></label>
      <div class="action-row">
        <button type="button" class="ghost" data-player-reset="upgrades">Reset permanent upgrades</button>
        <button type="button" class="ghost" data-player-reset="zero_nuggets">Zero nuggets</button>
        <button type="button" class="ghost" data-player-reset="achievements">Clear Pass achievements</button>
        <button type="button" class="ghost" data-player-reset="cosmetics">Remove cosmetics</button>
        <button type="button" class="ghost" data-player-reset="keybindings">Reset controls</button>
        <button type="button" class="danger" data-player-reset="profile">Reset gameplay profile</button>
        <button type="button" class="danger" data-player-reset="pass">Reset full Pass track</button>
        <button type="button" class="danger" data-player-reset="allProgress">Reset all off-chain progression</button>
      </div>
      <p class="reset-status" aria-live="polite"></p>
    </article>`;

  section.querySelector('.player-editor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const reason = section.querySelector('[data-player-field="reason"]').value;
    const status = section.querySelector('.editor-status');
    const patch = collectExactPatch(section);
    await submitPlayerPatch(address, patch, reason, status, 'Save this exact player state?');
  });

  section.querySelectorAll('[data-player-reset]').forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.playerReset;
      const reason = section.querySelector('[data-reset-reason]').value;
      const status = section.querySelector('.reset-status');
      const patch = resetPatch(action);
      await submitPlayerPatch(
        address,
        patch,
        reason,
        status,
        `${button.textContent.trim()} for ${short(address)}?`
      );
    });
  });

  return section;
}

function collectExactPatch(section) {
  const profile = {};
  for (const key of ['bankedNuggets', 'bestDepth', 'bestScore', 'totalRuns']) {
    profile[key] = numericValue(section.querySelector(`[data-profile-field="${key}"]`));
  }
  profile.meta = Object.fromEntries([...section.querySelectorAll('[data-meta-upgrade]')]
    .map((input) => [input.dataset.metaUpgrade, numericValue(input)]));

  const claimedLevels = [...section.querySelectorAll('[data-claimed-level]:checked')]
    .map((input) => Number(input.dataset.claimedLevel));
  const cosmetics = [...section.querySelectorAll('[data-owned-cosmetic]:checked')]
    .map((input) => input.dataset.ownedCosmetic);
  const equipped = Object.fromEntries([...section.querySelectorAll('[data-equipped-slot]')]
    .map((input) => [input.dataset.equippedSlot, input.value]));
  const keybindings = Object.fromEntries([...section.querySelectorAll('[data-keybinding]')]
    .map((input) => [input.dataset.keybinding, input.value]));

  return {
    identity: {
      name: section.querySelector('[data-player-field="identity-name"]').value,
      clearAvatar: section.querySelector('[data-player-field="clear-avatar"]').checked
    },
    profile,
    pass: {
      xp: numericValue(section.querySelector('[data-profile-field="passXp"]')),
      claimedLevels,
      cosmetics,
      equipped,
      chestAvailable: numericValue(section.querySelector('[data-profile-field="chestAvailable"]')),
      chestOpened: numericValue(section.querySelector('[data-profile-field="chestOpened"]')),
      chestLastOpenedAt: numericValue(section.querySelector('[data-profile-field="chestLastOpenedAt"]'))
    },
    daily: {
      freeRunUsedToday: section.querySelector('[data-player-field="free-run-used"]').checked
    },
    keybindings
  };
}

function resetPatch(action) {
  if (action === 'zero_nuggets') return { profile: { bankedNuggets: 0 } };
  return { reset: { [action]: true } };
}

async function submitPlayerPatch(address, patch, reason, status, confirmation) {
  status.className = status.className.replace(/\s*(good|bad)\b/g, '');
  if (String(reason || '').trim().length < 5) {
    status.textContent = 'Enter a reason of at least five characters.';
    status.classList.add('bad');
    return;
  }
  if (!globalThis.confirm(confirmation)) return;
  status.textContent = 'Applying…';
  try {
    await adminApi(`/api/admin/wallets/${address}/awards`, {
      method: 'POST',
      body: { type: 'state_patch', patch, reason }
    });
    status.textContent = 'Player state updated and audit logged.';
    status.classList.add('good');
    refreshBasePlayerPanel(address);
  } catch (error) {
    status.textContent = error.message;
    status.classList.add('bad');
  }
}

function refreshBasePlayerPanel(address) {
  panel.dataset.editorFor = '';
  const button = [...document.querySelectorAll('[data-wallet]')]
    .find((candidate) => candidate.dataset.wallet?.toLowerCase() === address.toLowerCase());
  if (button) button.click();
  else attachPlayerEditor();
}

async function adminApi(path, options = {}) {
  const key = sessionStorage.getItem('mattMineAdminKey') || '';
  if (!key) throw new Error('Unlock the Admin Command Center again.');
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: {
      'x-matt-admin-key': key,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
  return payload;
}

function numberField(label, key, value, min, max) {
  return `<label>${escapeHtml(label)}<input data-profile-field="${escapeHtml(key)}" type="number" min="${Number(min || 0)}" max="${Number(max ?? Number.MAX_SAFE_INTEGER)}" step="1" value="${Number(value || 0)}"></label>`;
}

function numericValue(input) {
  return Number(input?.value || 0);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
}

function short(value) {
  const text = String(value || '');
  return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function words(value) {
  return String(value).replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (char) => char.toUpperCase());
}
