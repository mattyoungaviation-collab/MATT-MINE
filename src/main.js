import { MattMineGame } from './game/Game.js';
import { META_UPGRADES } from './game/config.js';
import { formatNumber } from './game/utils.js';
import { loadProfile, saveProfile } from './game/storage.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#game');
const screens = [...document.querySelectorAll('.screen')];
const hud = $('#hud');
const mobileControls = $('#mobile-controls');
let profile = loadProfile();
let toastTimer;

const ui = {
  healthText: $('#health-text'),
  healthFill: $('#health-fill'),
  levelText: $('#level-text'),
  xpText: $('#xp-text'),
  xpFill: $('#xp-fill'),
  depthText: $('#depth-text'),
  lootText: $('#loot-text'),
  multiplierText: $('#multiplier-text'),
  objectiveText: $('#objective-text'),
  roomText: $('#room-text'),
  dashFill: $('#dash-fill'),
  dashMobileText: $('#dash-mobile-text')
};

function showScreen(id = null) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === id);
}

function setGameplayUi(active) {
  hud.classList.toggle('active', active);
  mobileControls.classList.toggle('active', active);
}

function updateMenu() {
  $('#menu-nuggets').textContent = formatNumber(profile.bankedNuggets);
  $('#menu-depth').textContent = String(profile.bestDepth);
  $('#menu-score').textContent = formatNumber(profile.bestScore);
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('active');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('active'), 2300);
}

const game = new MattMineGame(canvas, profile, {
  onRunStart() {
    showScreen();
    setGameplayUi(true);
  },
  onHud(stats) {
    ui.healthText.textContent = `${Math.ceil(stats.health)} / ${Math.round(stats.maxHealth)}`;
    ui.healthFill.style.width = `${Math.max(0, (stats.health / stats.maxHealth) * 100)}%`;
    ui.levelText.textContent = stats.level;
    ui.xpText.textContent = `${Math.floor(stats.xp)} / ${stats.nextXp} XP`;
    ui.xpFill.style.width = `${Math.min(100, (stats.xp / stats.nextXp) * 100)}%`;
    ui.depthText.textContent = stats.depth;
    ui.lootText.textContent = formatNumber(stats.loot);
    ui.multiplierText.textContent = stats.multiplier.toFixed(1);
    ui.roomText.textContent = stats.room;
    ui.dashFill.style.width = `${Math.round(stats.dashReady * 100)}%`;
    if (ui.dashMobileText) ui.dashMobileText.textContent = stats.dashReady >= 0.999 ? 'DASH' : `${Math.ceil((1 - stats.dashReady) * 3)}s`;
  },
  onObjective(text) {
    ui.objectiveText.textContent = text;
  },
  onLevelUp(options) {
    const container = $('#level-options');
    container.innerHTML = '';
    for (const option of options) {
      const button = document.createElement('button');
      button.className = 'level-card';
      button.innerHTML = `<span class="upgrade-icon">${option.icon}</span><strong>${option.name}</strong><small>${option.description}</small>`;
      button.addEventListener('click', () => game.chooseRunUpgrade(option.id));
      container.appendChild(button);
    }
    showScreen('level-up');
    setGameplayUi(false);
  },
  onUpgradeChosen(upgrade) {
    showScreen();
    setGameplayUi(true);
    toast(`${upgrade.name} equipped`);
  },
  onDepthChoice(data) {
    $('#depth-summary').textContent = `You can bank ${formatNumber(data.projectedPayout)} nuggets now, or descend for a x${data.nextMultiplier.toFixed(1)} total loot multiplier.`;
    $('#descend-button').textContent = data.depth >= 5 ? 'MAX DEPTH — EXTRACT' : 'DESCEND DEEPER';
    showScreen('depth-choice');
    setGameplayUi(false);
  },
  onDepthStarted() {
    showScreen();
    setGameplayUi(true);
  },
  onRunEnd(result) {
    $('#end-kicker').textContent = result.extracted ? 'EXTRACTION SUCCESSFUL' : 'THE MINE TOOK ITS CUT';
    $('#end-title').textContent = result.extracted ? 'Loot Secured' : 'You Were Knocked Out';
    $('#end-stats').innerHTML = `
      <div><span>Banked</span><strong>${formatNumber(result.banked)}</strong></div>
      <div><span>${result.extracted ? 'Run Value' : 'Lost Loot'}</span><strong>${formatNumber(result.extracted ? result.projected : result.lost)}</strong></div>
      <div><span>Depth</span><strong>${result.depth}</strong></div>
      <div><span>Enemies</span><strong>${result.kills}</strong></div>
      <div><span>Ore Broken</span><strong>${result.oreBroken}</strong></div>
      <div><span>Run Time</span><strong>${formatTime(result.elapsed)}</strong></div>
    `;
    showScreen('run-end');
    setGameplayUi(false);
    updateMenu();
  },
  onProfileChanged(nextProfile) {
    profile = nextProfile;
    saveProfile(profile);
    game.setProfile(profile);
  },
  onMenu() {
    showScreen('menu');
    setGameplayUi(false);
    updateMenu();
  },
  onToast: toast
});

window.__MATT_MINE_GAME__ = game;

$('#play-button').addEventListener('click', () => game.startRun());
$('#play-again-button').addEventListener('click', () => game.startRun());
$('#menu-button').addEventListener('click', () => game.backToMenu());
$('#extract-button').addEventListener('click', () => game.extract());
$('#descend-button').addEventListener('click', () => game.descend());
$('#upgrades-button').addEventListener('click', () => {
  renderShop();
  showScreen('upgrade-shop');
});
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => showScreen('menu'));
}

function renderShop() {
  const grid = $('#shop-grid');
  grid.innerHTML = '';
  for (const upgrade of META_UPGRADES) {
    const rank = profile.meta[upgrade.id] || 0;
    const cost = upgradeCost(upgrade, rank);
    const maxed = rank >= upgrade.max;
    const card = document.createElement('article');
    card.className = 'shop-card';
    card.innerHTML = `
      <div class="shop-card-top"><strong>${upgrade.name}</strong><span>Rank ${rank}/${upgrade.max}</span></div>
      <p>${upgrade.description}</p>
      <button class="buy-button" ${maxed || profile.bankedNuggets < cost ? 'disabled' : ''}>
        ${maxed ? 'MAXED' : `${formatNumber(cost)} NUGGETS`}
      </button>
    `;
    const button = card.querySelector('button');
    button.addEventListener('click', () => {
      if (maxed || profile.bankedNuggets < cost) return;
      profile.bankedNuggets -= cost;
      profile.meta[upgrade.id] = rank + 1;
      saveProfile(profile);
      game.setProfile(profile);
      updateMenu();
      renderShop();
      toast(`${upgrade.name} upgraded`);
    });
    grid.appendChild(card);
  }
  const balance = document.createElement('p');
  balance.className = 'shop-balance';
  balance.textContent = `Available: ${formatNumber(profile.bankedNuggets)} nuggets`;
  grid.appendChild(balance);
}

function upgradeCost(upgrade, rank) {
  return Math.floor(upgrade.baseCost * Math.pow(1.55, rank));
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

updateMenu();
showScreen('menu');
