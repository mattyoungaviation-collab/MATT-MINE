import { drawCompetitionMap } from './mineMapRenderer.js';
import { COMPETITION_DEPTH_COUNT, competitionMapForDepth } from './competitionStudio.js';
import { CHARACTER_DEFAULTS } from './expansionConfig.js';

export async function mountMineHub(apiClient) {
  const layout = document.querySelector('.matchmaking-layout');
  if (!layout) return null;
  const state = { slots: [], selected: null };
  layout.innerHTML = `
    <div class="competition-hub">
      <div class="competition-hub-heading">
        <div><span>LIVE MINES</span><strong>Choose your mine</strong></div>
        <small>Practice is public. Arena, Pass, and Endless require your selected Miner NFT.</small>
      </div>
      <div class="competition-slot-grid" data-mine-cards aria-label="MATT Mine competitions"></div>
    </div>
    <div class="competition-legacy-bridge" aria-hidden="true">
      <button id="paid-run-button" type="button"></button>
      <span id="pass-status"></span><span id="pass-days"></span>
      <span id="paid-credit-count"></span><span id="paid-daily-status"></span><span id="paid-run-cta"></span>
      <button id="arena-button" type="button"></button>
      <span id="arena-menu-pool"></span><span id="arena-menu-action"></span>
      <button id="practice-run-button" type="button"></button>
    </div>`;
  const modal = document.createElement('section');
  modal.id = 'mine-detail';
  modal.className = 'mine-detail';
  modal.hidden = true;
  modal.innerHTML = `
    <div class="mine-detail-shell">
      <button type="button" data-mine-close aria-label="Close">×</button>
      <header><div><span data-mine-kicker>OFFICIAL MINE</span><h2 data-mine-name></h2><p data-mine-subtitle></p></div><b data-mine-state>LIVE</b></header>
      <div class="mine-detail-layout">
        <div class="mine-detail-map">
          <div class="mine-depth-tabs" data-mine-depth-tabs aria-label="Mine depths"></div>
          <canvas width="1000" height="560"></canvas>
          <div data-mine-loadout></div>
        </div>
        <div class="mine-detail-board">
          <div class="mine-board-top"><span data-board-title>LEADERBOARD</span><small data-board-period></small></div>
          <div data-mine-rules class="mine-rule-strip"></div>
          <div class="mine-board-scroll"><table><thead><tr><th>#</th><th>MINER</th><th>SCORE</th><th>DEPTH</th></tr></thead><tbody data-mine-board></tbody></table></div>
          <button type="button" data-mine-enter>ENTER THIS MINE</button>
        </div>
      </div>
    </div>`;
  document.body.append(modal);
  modal.querySelector('[data-mine-close]').addEventListener('click', () => closeModal(modal));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal(modal);
  });
  modal.querySelector('[data-mine-enter]').addEventListener('click', () => {
    if (!state.selected || state.selected.comingSoon || state.selected.entriesPaused) return;
    closeModal(modal);
    window.dispatchEvent(new CustomEvent('mattmine:slot-enter', { detail: { slot: state.selected } }));
  });
  modal.querySelector('[data-mine-depth-tabs]').addEventListener('click', (event) => {
    const button = event.target.closest('[data-mine-depth]');
    if (!button || !state.selected) return;
    renderDetailDepth(modal, state.selected, Number(button.dataset.mineDepth));
  });

  try {
    const result = await apiClient.mineSlots();
    state.slots = result.slots || [];
  } catch {
    state.slots = fallbackSlots();
  }
  renderCards(layout.querySelector('[data-mine-cards]'), state.slots);
  layout.querySelector('[data-mine-cards]').addEventListener('click', async (event) => {
    const card = event.target.closest('[data-mine-slot]');
    if (!card) return;
    const slot = state.slots.find((entry) => entry.id === card.dataset.mineSlot);
    if (!slot || slot.comingSoon) return;
    card.classList.add('loading');
    try {
      const detail = await apiClient.mineSlot(slot.id);
      state.selected = detail.slot || slot;
      renderDetail(modal, state.selected, detail.leaderboard);
      modal.hidden = false;
      requestAnimationFrame(() => modal.classList.add('active'));
    } finally {
      card.classList.remove('loading');
    }
  });
  return state;
}

function renderCards(container, slots) {
  container.innerHTML = slots.map((slot) => {
    const paused = slot.entriesPaused === true;
    const stateLabel = slot.comingSoon
      ? 'COMING SOON'
      : paused
        ? 'PAUSED'
        : slot.state === 'live'
          ? 'LIVE NOW'
          : 'OPEN';
    const actionLabel = slot.comingSoon
      ? 'IN DEVELOPMENT'
      : paused
        ? 'VIEW BOARD · ENTRY PAUSED →'
        : slot.id === 'practice'
          ? 'OPEN PRACTICE →'
          : slot.id === 'endless'
            ? `${endlessEntryLabel(slot)} · MINER NFT REQUIRED · OPEN ENDLESS →`
            : 'MINER NFT REQUIRED · OPEN MINE →';
    const accessibleLabel = slot.comingSoon
      ? `${escapeHtml(slot.name)} coming soon`
      : paused
        ? `${escapeHtml(slot.snapshot?.name || slot.name)} paused. Open status and leaderboard`
        : `Open ${escapeHtml(slot.snapshot?.name || slot.name)}`;
    const map = competitionMapForDepth(slot.snapshot, 1);
    const theme = ['deep', 'crystal', 'magma', 'ruins'].includes(map.background) ? map.background : 'deep';
    const character = slot.snapshot?.loadout?.characterId || 'matt';
    const weapon = slot.snapshot?.loadout?.startingWeapon || 'pickaxe';
    return `
    <button type="button" class="competition-slot-card slot-${slot.id} slot-theme-${theme} ${slot.comingSoon ? 'disabled' : ''} ${paused ? 'paused' : ''}" data-mine-slot="${slot.id}" ${slot.comingSoon ? 'disabled' : ''} aria-label="${accessibleLabel}">
      ${slot.comingSoon ? '' : '<canvas class="slot-map-preview" data-slot-map width="620" height="300" aria-hidden="true"></canvas>'}
      ${slot.comingSoon ? '' : `<canvas class="slot-character-preview" data-slot-character="${escapeHtml(character)}" width="150" height="180" aria-hidden="true"></canvas>`}
      <span class="slot-number">0${slot.number}</span>
      <span class="slot-state">${stateLabel}</span>
      <strong>${escapeHtml(slot.snapshot?.name || slot.name)}</strong>
      <small>${escapeHtml(slot.snapshot?.subtitle || slot.subtitle || '')}</small>
      ${slot.comingSoon ? '' : `<span class="slot-loadout">${escapeHtml(characterName(character))} · ${escapeHtml(title(weapon))}</span>`}
      <span class="slot-meta">${actionLabel}</span>
    </button>`;
  }).join('');
  container.querySelectorAll('[data-mine-slot]').forEach((card) => {
    const slot = slots.find((candidate) => candidate.id === card.dataset.mineSlot);
    if (!slot?.snapshot || slot.comingSoon) return;
    drawCompetitionMap(card.querySelector('[data-slot-map]'), competitionMapForDepth(slot.snapshot, 1));
    drawCardCharacter(card.querySelector('[data-slot-character]'), slot.snapshot.loadout?.characterId || 'matt');
  });
}

function drawCardCharacter(canvas, characterId) {
  if (!canvas || typeof Image !== 'function') return;
  const roster = {
    matt: { src: '/assets/game/matt-dyno-spritesheet.png', x: 2, y: 0, width: 120, height: 241 },
    ronke: { src: '/assets/game/ronke-character-spritesheet.webp', x: 0, y: 0, width: 280, height: 340 },
    axie: { src: '/assets/game/axie-character-spritesheet.webp', x: 0, y: 0, width: 280, height: 340 },
    orc: { src: '/assets/game/orc-character-spritesheet.webp', x: 0, y: 0, width: 280, height: 340 }
  };
  const frame = roster[characterId] || roster.matt;
  const image = new Image();
  image.decoding = 'async';
  image.addEventListener('load', () => {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    const scale = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const width = frame.width * scale;
    const height = frame.height * scale;
    context.drawImage(
      image,
      frame.x,
      frame.y,
      Math.min(frame.width, image.naturalWidth - frame.x),
      Math.min(frame.height, image.naturalHeight - frame.y),
      (canvas.width - width) / 2,
      canvas.height - height,
      width,
      height
    );
  }, { once: true });
  image.src = frame.src;
}

function renderDetail(modal, slot, leaderboard) {
  const snapshot = slot.snapshot || {};
  modal.classList.remove('slot-practice', 'slot-arena', 'slot-pass', 'slot-endless');
  modal.classList.add(`slot-${slot.id}`);
  modal.querySelector('[data-mine-kicker]').textContent = slot.leaderboard ? 'MINER-GATED MINE' : 'PUBLIC PRACTICE MINE';
  modal.querySelector('[data-mine-name]').textContent = snapshot.name || slot.name;
  modal.querySelector('[data-mine-subtitle]').textContent = snapshot.subtitle || '';
  modal.querySelector('[data-mine-state]').textContent = slot.entriesPaused
    ? 'PAUSED'
    : slot.state === 'coming-soon'
      ? 'COMING SOON'
      : 'LIVE';
  modal.querySelector('[data-board-title]').textContent = snapshot.rules?.leaderboardTitle || (slot.leaderboard ? 'LEADERBOARD' : 'PRACTICE BRIEFING');
  modal.querySelector('[data-board-period]').textContent = leaderboard?.week || leaderboard?.day || 'CURRENT COMPETITION';
  modal.querySelector('[data-mine-loadout]').innerHTML = `
    <span><small>CHARACTER</small><b>${characterName(snapshot.loadout?.characterId || 'matt')}</b></span>
    <span><small>START</small><b>${title(snapshot.loadout?.startingWeapon || 'pickaxe')}</b></span>
    <span><small>${slot.id === 'endless' ? 'ENTRY LIMIT' : 'ATTEMPTS'}</small><b>${slot.id === 'endless' ? endlessEntryLimitLabel(slot) : snapshot.rules?.attemptLimit ? snapshot.rules.attemptLimit : 'UNLIMITED'}</b></span>`;
  modal.querySelector('[data-mine-rules]').innerHTML = `
    <span>${escapeHtml(snapshot.rules?.instructions || 'Beat the Guardian and return to the lift.')}</span>
    <b>${escapeHtml(snapshot.rules?.rewardLabel || '')}</b>`;
  const rows = leaderboard?.rows || [];
  modal.querySelector('[data-mine-board]').innerHTML = slot.leaderboard
    ? rows.length
      ? rows.slice(0, 100).map((row) => `<tr><td>${row.rank || '—'}</td><td>${escapeHtml(row.identity?.name || row.walletId || shortAddress(row.address))}</td><td>${format(row.score)}</td><td>${row.deepestPhase || row.depth || row.completedDays || '—'}</td></tr>`).join('')
      : '<tr><td colspan="4">Be the first miner on this board.</td></tr>'
    : '<tr><td colspan="4">Practice is unlimited and never affects a ranked leaderboard.</td></tr>';
  const enterButton = modal.querySelector('[data-mine-enter]');
  enterButton.textContent = slot.entriesPaused
    ? 'MINE PAUSED'
    : slot.id === 'practice'
      ? 'START PRACTICE'
      : slot.id === 'arena'
        ? 'ENTER ARENA'
        : slot.id === 'endless'
          ? `ENTER ENDLESS · ${endlessEntryLabel(slot)}`
          : 'ENTER THIS MINE';
  enterButton.disabled = slot.entriesPaused === true;
  modal.dataset.depth = '1';
  modal.querySelector('[data-mine-depth-tabs]').innerHTML = slot.id === 'endless'
    ? '<button type="button" data-mine-depth="1" class="active">PROCEDURAL PHASE PREVIEW</button>'
    : Array.from(
        { length: COMPETITION_DEPTH_COUNT },
        (_, index) => `<button type="button" data-mine-depth="${index + 1}" class="${index === 0 ? 'active' : ''}">DEPTH ${index + 1}</button>`
      ).join('');
  renderDetailDepth(modal, slot, 1);
}

function renderDetailDepth(modal, slot, depth) {
  const normalizedDepth = Math.max(1, Math.min(COMPETITION_DEPTH_COUNT, Math.floor(depth || 1)));
  modal.dataset.depth = String(normalizedDepth);
  modal.querySelectorAll('[data-mine-depth]').forEach((button) => {
    button.classList.toggle('active', Number(button.dataset.mineDepth) === normalizedDepth);
  });
  drawCompetitionMap(modal.querySelector('canvas'), competitionMapForDepth(slot.snapshot, normalizedDepth));
}

function closeModal(modal) {
  modal.classList.remove('active');
  setTimeout(() => { modal.hidden = true; }, 160);
}

function fallbackSlots() {
  return [
    ['practice', 1, 'Practice Mine', false, '#55dfb4'],
    ['arena', 2, 'MATT Arena', true, '#ffcf32'],
    ['pass', 3, 'Pass Mine', true, '#bd74ff'],
    ['endless', 4, 'MATT Mine Endless', true, '#59e4ff']
  ].map(([id, number, name, leaderboard, color, comingSoon = false]) => ({ id, number, name, leaderboard, color, comingSoon }));
}

function endlessEntryLabel(slot = {}) {
  if (slot.freeEntry === true) return 'FREE ENTRY';
  const price = Number(slot.entryPriceMatt);
  return Number.isFinite(price) && price > 0
    ? `${format(price)} MATT ENTRY`
    : 'ENTRY TERMS FROM SERVER';
}

function endlessEntryLimitLabel(slot = {}) {
  const rules = slot.entryRules || {};
  const wallet = Number(rules.entriesPerWallet || 0);
  const miner = Number(rules.entriesPerMiner || 0);
  if (!wallet && !miner) return 'UNLIMITED';
  const limits = [
    wallet > 0 ? `${format(wallet)}/WALLET` : '',
    miner > 0 ? `${format(miner)}/MINER` : ''
  ].filter(Boolean).join(' · ');
  return `${limits} / ${format(rules.resetPeriodHours || 24)}H`;
}

function shortAddress(address) {
  const value = String(address || '');
  return value ? `${value.slice(0, 6)}…${value.slice(-4)}` : 'MINER';
}

function title(value) {
  return String(value || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function characterName(value) {
  return CHARACTER_DEFAULTS[value]?.name || title(value);
}

function format(value) {
  return Number(value || 0).toLocaleString();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
