import { drawCompetitionMap } from './mineMapRenderer.js';

const MINIMUM_LOADING_MS = 10_000;

export async function showMineLoadingScreen(slot, options = {}) {
  const overlay = ensureOverlay();
  const snapshot = slot?.snapshot || options.snapshot || null;
  overlay.querySelector('[data-loading-name]').textContent = snapshot?.name || slot?.name || 'MATT Mine';
  overlay.querySelector('[data-loading-subtitle]').textContent = snapshot?.rules?.instructions || 'Study the route. The mine opens in ten seconds.';
  overlay.querySelector('[data-loading-character]').textContent = title(snapshot?.loadout?.characterId || 'matt');
  overlay.querySelector('[data-loading-weapon]').textContent = title(snapshot?.loadout?.startingWeapon || 'pickaxe');
  overlay.querySelector('[data-loading-fingerprint]').textContent = snapshot?.fingerprint
    ? `MAP ${snapshot.fingerprint.slice(0, 10).toUpperCase()}`
    : 'OFFICIAL MATT MINE';
  const canvas = overlay.querySelector('canvas');
  drawCompetitionMap(canvas, snapshot?.map);
  overlay.hidden = false;
  overlay.classList.add('active');
  const startedAt = performance.now();
  let remaining = 10;
  const countdown = overlay.querySelector('[data-loading-countdown]');
  countdown.textContent = remaining;
  const timer = setInterval(() => {
    remaining = Math.max(0, 10 - Math.floor((performance.now() - startedAt) / 1_000));
    countdown.textContent = remaining || 'GO';
  }, 100);
  const minimum = new Promise((resolve) => setTimeout(resolve, options.minimumMs ?? MINIMUM_LOADING_MS));
  await Promise.all([minimum, options.ready || Promise.resolve()]);
  clearInterval(timer);
  overlay.classList.remove('active');
  overlay.hidden = true;
}

function ensureOverlay() {
  let overlay = document.querySelector('#mine-loading-screen');
  if (overlay) return overlay;
  overlay = document.createElement('section');
  overlay.id = 'mine-loading-screen';
  overlay.className = 'mine-loading-screen';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="mine-loading-shell">
      <header>
        <div><span>MISSION BRIEFING</span><h2 data-loading-name>Loading Mine</h2><p data-loading-subtitle></p></div>
        <strong data-loading-countdown>10</strong>
      </header>
      <div class="mine-loading-map"><canvas width="1280" height="640"></canvas></div>
      <footer>
        <span><small>CHARACTER</small><b data-loading-character>MATT</b></span>
        <span><small>STARTING TOOL</small><b data-loading-weapon>PICKAXE</b></span>
        <span><small>CONTROLS</small><b>MOVE · AIM · ATTACK · DASH</b></span>
        <em data-loading-fingerprint>OFFICIAL MATT MINE</em>
      </footer>
    </div>`;
  document.body.append(overlay);
  return overlay;
}

function title(value) {
  return String(value || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
