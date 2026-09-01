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
    <div class="notice warning">Exact edits apply immediately. Active runs can be ended automatically in this same audited action. Confirmed payments, published rewards, on-chain balances, and finished leaderboard scores remain protected.</div>

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
          ${numberField('Best depth', 'bestDepth', profile.bestDepth, 0, editor.limits?.bestDepth)}
          ${numberField('Best score', 'bestScore', profile.bestScore, 0, editor.limits?.bestScore)}
          ${numberField('Total finished runs', 'totalRuns', profile.totalRuns, 0, editor.limits?.totalRuns)}
        </div>
      </article>

      <article class="editor-section leaderboard-correction">
        <h4>Leaderboard score correction</h4>
        <p class="notice warning">Admin-only replay bypass for a documented failed run. This changes the current open leaderboard and is permanently audit logged. Closed payout weeks cannot be changed.</p>
        <div class="compact-grid">
          <label>Mine
            <select data-score-field="mode">
              <option value="free">Daily Mine</option>
              <option value="paid">Pass Mine</option>
            </select>
          </label>
          <label>Exact current-week score
            <input data-score-field="score" type="number" min="0" max="${Number(editor.limits?.weeklyScore || 35_000_000)}" step="1" value="${Number(wallet.leaderboardScores?.free || 0)}">
            <small>Week ${escapeHtml(wallet.leaderboardScores?.week || '')}. Use 0 to remove this player from the open board.</small>
          </label>
          <label class="toggle">End active run for the selected mine
            <input data-score-field="terminate-active-runs" type="checkbox" checked>
            <small>Releases a stuck run before applying the correction. Other mine types are untouched.</small>
          </label>
        </div>
        <label>Required correction reason<input data-score-field="reason" maxlength="240" placeholder="Example: verified failed extraction reported in support" required></label>
        <div class="action-row"><button type="button" data-score-override>Apply exact leaderboard score</button></div>
        <p class="score-override-status" aria-live="polite"></p>
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
        <h4>Consumables inventory</h4>
        <p class="notice">Available wallet inventory only. Positive amounts grant free items; negative amounts remove items. Every adjustment requires a reason and is audit logged.</p>
        <div class="compact-grid">
          ${[
            ['medic-pack', 'MEDIC PACK'],
            ['mythical-force-field', "MATT'S MYTHICAL FORCE FIELD"],
            ['heavy-crystal-hauler', 'HEAVY CRYSTAL HAULER']
          ].map(([id, name]) => `<label>${escapeHtml(name)} · owned ${Number(wallet.consumables?.inventory?.[id] || 0).toLocaleString()}<input data-consumable-adjustment="${escapeHtml(id)}" type="number" min="-1000000" max="1000000" step="1" value="0"><button type="button" data-adjust-consumable="${escapeHtml(id)}">ADD / REMOVE</button></label>`).join('')}
        </div>
        <label>Required adjustment reason<input data-consumable-reason maxlength="240" placeholder="Event grant, failed transaction correction, support case…"></label>
        <p class="consumable-adjustment-status" aria-live="polite"></p>
      </article>

      <article class="editor-section">
        <h4>Gameplay keybindings</h4>
        <div class="compact-grid">
          ${Object.entries(keybindings).map(([action, key]) => `
            <label>${escapeHtml(words(action))}<input data-keybinding="${escapeHtml(action)}" value="${escapeHtml(key)}"></label>`).join('')}
        </div>
      </article>

      <article class="editor-section">
        <label class="toggle">End active runs and apply now
          <input data-player-field="terminate-active-runs" type="checkbox" ${Number(wallet.activeRuns || 0) > 0 ? 'checked' : ''}>
          <small>${Number(wallet.activeRuns || 0)} active run${Number(wallet.activeRuns || 0) === 1 ? '' : 's'} detected. Any consumed entry or credit remains consumed.</small>
        </label>
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

  const scoreMode = section.querySelector('[data-score-field="mode"]');
  const scoreInput = section.querySelector('[data-score-field="score"]');
  scoreMode.addEventListener('change', () => {
    scoreInput.value = Number(wallet.leaderboardScores?.[scoreMode.value] || 0);
  });
  section.querySelector('[data-score-override]').addEventListener('click', async () => {
    const reason = section.querySelector('[data-score-field="reason"]').value;
    const status = section.querySelector('.score-override-status');
    const mode = scoreMode.value;
    const score = numericValue(scoreInput);
    const mine = mode === 'free' ? 'Daily Mine' : 'Pass Mine';
    if (String(reason || '').trim().length < 5) {
      status.textContent = 'Enter a reason of at least five characters.';
      status.classList.add('bad');
      return;
    }
    if (!globalThis.confirm(`Set this player’s ${mine} score to ${score.toLocaleString()} and bypass replay verification?`)) return;
    status.className = status.className.replace(/\s*(good|bad)\b/g, '');
    status.textContent = 'Applying score correction…';
    try {
      const result = await adminApi(`/api/admin/wallets/${address}/awards`, {
        method: 'POST',
        body: {
          type: 'score_override',
          mode,
          score,
          week: wallet.leaderboardScores?.week || '',
          terminateActiveRuns: section.querySelector('[data-score-field="terminate-active-runs"]').checked,
          reason
        }
      });
      status.textContent = `Leaderboard updated: ${Number(result.scoreCorrection?.previousScore || 0).toLocaleString()} → ${Number(result.scoreCorrection?.score || score).toLocaleString()}. ${Number(result.terminatedActiveRuns || 0)} active run(s) ended.`;
      status.classList.add('good');
      wallet.leaderboardScores ||= {};
      wallet.leaderboardScores[mode] = Number(result.scoreCorrection?.score || score);
    } catch (error) {
      status.textContent = error.message;
      status.classList.add('bad');
    }
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

  section.querySelectorAll('[data-adjust-consumable]').forEach((button) => {
    button.addEventListener('click', async () => {
      const consumableId = button.dataset.adjustConsumable;
      const amount = numericValue(section.querySelector(`[data-consumable-adjustment="${consumableId}"]`));
      const reason = section.querySelector('[data-consumable-reason]').value;
      const status = section.querySelector('.consumable-adjustment-status');
      if (!Number.isSafeInteger(amount) || amount === 0) return void (status.textContent = 'Enter a non-zero whole-number adjustment.');
      if (String(reason || '').trim().length < 5) return void (status.textContent = 'Enter a reason of at least five characters.');
      if (!globalThis.confirm(`${amount > 0 ? 'Add' : 'Remove'} ${Math.abs(amount)} Consumable charge(s) for ${short(address)}?`)) return;
      status.textContent = 'Applying audited inventory adjustment…';
      try {
        await adminApi(`/api/admin/wallets/${address}/awards`, { method: 'POST', body: { type: 'consumable', consumableId, amount, reason } });
        status.textContent = 'Consumables inventory updated and audit logged.';
        refreshBasePlayerPanel(address);
      } catch (error) {
        status.textContent = error.message;
      }
    });
  });

  return section;
}

function collectExactPatch(section) {
  const profile = {};
  for (const key of ['bestDepth', 'bestScore', 'totalRuns']) {
    profile[key] = numericValue(section.querySelector(`[data-profile-field="${key}"]`));
  }
  const claimedLevels = [...section.querySelectorAll('[data-claimed-level]:checked')]
    .map((input) => Number(input.dataset.claimedLevel));
  const cosmetics = [...section.querySelectorAll('[data-owned-cosmetic]:checked')]
    .map((input) => input.dataset.ownedCosmetic);
  const equipped = Object.fromEntries([...section.querySelectorAll('[data-equipped-slot]')]
    .map((input) => [input.dataset.equippedSlot, input.value]));
  const keybindings = Object.fromEntries([...section.querySelectorAll('[data-keybinding]')]
    .map((input) => [input.dataset.keybinding, input.value]));

  return {
    terminateActiveRuns: section.querySelector('[data-player-field="terminate-active-runs"]').checked,
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
  if (window.mattMineAdminSession?.fetch) return window.mattMineAdminSession.fetch(path, options);
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {
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
