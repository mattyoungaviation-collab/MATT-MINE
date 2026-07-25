import { MattMineGame } from './game/GameV4.js';
import { apiClient } from './game/apiClient.js';
import { META_UPGRADES } from './game/config.js';
import {
  ADMIN_ROLES,
  LocalEconomyStore,
  RUN_MODES,
  claimLatestReward,
  consumeRun,
  dailyRecord,
  estimatedLeaderboardReward,
  passDaysRemaining,
  passIsActive,
  passLevel,
  latestReward,
  passPoolMatt,
  previewLeaderboard,
  publishRewardEpoch,
  purchasePaidRun,
  purchasePass,
  recordRun,
  resetEconomyForTesting,
  runAccess,
  setWalletBan,
  updateAdminSettings,
  weeklyUserScore
} from './game/economy.js';
import { formatNumber } from './game/utils.js';
import { loadProfile, saveProfile } from './game/storage.js';
import { RoninWalletAdapter } from './game/walletAdapter.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#game');
const screens = [...document.querySelectorAll('.screen')];
const hud = $('#hud');
const mobileControls = $('#mobile-controls');
const economy = new LocalEconomyStore();
let profile = loadProfile();
let toastTimer;
let activeBoard = RUN_MODES.FREE;
let serverConfig = null;
let serverPlayer = null;
let activeServerRun = null;
let walletBusy = false;
const wallet = new RoninWalletAdapter({
  api: apiClient,
  onInvalidated(reason) {
    serverPlayer = null;
    activeServerRun = null;
    profile = loadProfile();
    game?.setProfile(profile);
    updateMenu();
    toast(reason);
  }
});

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
  dashMobileText: $('#dash-mobile-text'),
  runModeHud: $('#run-mode-hud'),
  weaponSlots: [...document.querySelectorAll('.weapon-slot')],
  weaponButtons: [...document.querySelectorAll('.weapon-button')],
  attackButton: $('#attack-button')
};

function showScreen(id = null) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === id);
}

function setGameplayUi(active) {
  hud.classList.toggle('active', active);
  mobileControls.classList.toggle('active', active);
}

function updateMenu() {
  const state = economy.state;
  const daily = dailyRecord(state);
  const passActive = passIsActive(state);
  const connected = Boolean(serverPlayer);
  const freeAccess = connected
    ? {
        allowed: Boolean(serverPlayer.entitlements?.freeRunAvailable),
        reason: serverPlayer.suspended ? 'Wallet suspended' : 'Used today'
      }
    : { allowed: true, reason: 'Ronin sign-in required' };
  const paidAccess = runAccess(state, RUN_MODES.PAID);
  $('#menu-nuggets').textContent = formatNumber(profile.bankedNuggets);
  $('#menu-depth').textContent = String(profile.bestDepth);
  $('#menu-score').textContent = formatNumber(profile.bestScore);
  $('#wallet-label').textContent = connected ? abbreviateAddress(serverPlayer.address) : walletBusy ? 'CONNECTING…' : 'CONNECT RONIN';
  $('#wallet-network').textContent = connected
    ? `${serverConfig?.chainName || 'RONIN'} · SERVER VERIFIED`
    : `${serverConfig?.chainName || 'RONIN MAINNET'} · SIGN TO PLAY RANKED`;
  $('#wallet-button').classList.toggle('connected', connected);
  $('#wallet-button').disabled = walletBusy;
  $('#free-run-status').textContent = connected
    ? serverPlayer.suspended ? 'SUSPENDED' : freeAccess.allowed ? 'AVAILABLE' : 'USED TODAY'
    : 'WALLET REQUIRED';
  $('#free-run-status').classList.toggle('unavailable', !freeAccess.allowed);
  $('#free-run-cta').textContent = !connected ? 'SIGN IN WITH RONIN' : freeAccess.allowed ? 'PLAY FREE' : 'COME BACK TOMORROW';
  $('#free-run-button').disabled = connected && !freeAccess.allowed;
  $('#pass-status').textContent = passActive ? 'PASS ACTIVE' : 'FREE TIER';
  $('#pass-days').textContent = passActive ? `${passDaysRemaining(state)} days remaining` : 'Premium locked';
  $('#paid-credit-count').textContent = String(state.player.paidRunCredits);
  $('#paid-daily-status').textContent = `${daily.paidRunsUsed} / ${state.settings.maxPaidRunsPerDay} used today`;
  $('#paid-run-cta').textContent = paidAccess.allowed
    ? 'START PAID RUN'
    : passActive
      ? state.player.paidRunCredits > 0 ? paidAccess.reason.toUpperCase() : 'BUY A RUN CREDIT'
      : 'VIEW PASS';
  $('#paid-run-button').classList.toggle('ready', paidAccess.allowed);
  $('#pass-price').textContent = trimNumber(state.settings.passPriceRon);
  $('#paid-run-price').textContent = trimNumber(state.settings.paidRunPriceRon);
  $('#paid-run-price-copy').textContent = `${trimNumber(state.settings.paidRunPriceRon)} RON`;
  renderPassProgress();
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('active');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('active'), 2600);
}

async function connectWallet() {
  if (walletBusy) return false;
  walletBusy = true;
  updateMenu();
  try {
    serverPlayer = await wallet.connect();
    profile = serverPlayer.profile;
    saveProfile(profile);
    game.setProfile(profile);
    toast(`Signed in · ${abbreviateAddress(serverPlayer.address)}`);
    return true;
  } catch (error) {
    toast(error?.message || 'Ronin Wallet sign-in failed.');
    return false;
  } finally {
    walletBusy = false;
    updateMenu();
  }
}

async function refreshServerPlayer() {
  if (!apiClient.hasSession()) {
    serverPlayer = null;
    updateMenu();
    return null;
  }
  try {
    serverPlayer = await wallet.refresh();
    profile = serverPlayer.profile;
    saveProfile(profile);
    game.setProfile(profile);
    updateMenu();
    return serverPlayer;
  } catch (error) {
    serverPlayer = null;
    updateMenu();
    if (error?.code !== 'session_missing') toast(error.message);
    return null;
  }
}

async function submitServerRun(serverRun, result) {
  activeServerRun = null;
  $('#economy-result').innerHTML = '<strong>SERVER VERIFYING</strong><span>Checking entitlement, run token, score rules, and replay protection…</span>';
  try {
    const accepted = await apiClient.finishRun(serverRun.runId, serverRun.runToken, {
      extracted: Boolean(result.extracted),
      projected: Math.max(0, Math.floor(result.projected || 0)),
      banked: Math.max(0, Math.floor(result.banked || 0)),
      depth: Math.max(1, Math.floor(result.depth || 1)),
      kills: Math.max(0, Math.floor(result.kills || 0)),
      oreBroken: Math.max(0, Math.floor(result.oreBroken || 0)),
      elapsed: Math.max(0, Number(result.elapsed || 0))
    });
    profile = accepted.profile;
    saveProfile(profile);
    game.setProfile(profile);
    const leaderboard = accepted.leaderboard;
    if (serverPlayer) {
      serverPlayer.profile = accepted.profile;
      serverPlayer.scores[serverRun.mode] = leaderboard.playerScore;
    }
    $('#economy-result').innerHTML = `
      <strong>SERVER VERIFIED${leaderboard.playerRank ? ` · #${leaderboard.playerRank}` : ''}</strong>
      <span>Weekly ${serverRun.mode === RUN_MODES.FREE ? 'Free' : 'Practice'} score: ${formatNumber(leaderboard.playerScore)}</span>
      <small>Entitlement, one-time run token, telemetry limits, secured-loot rule, and duplicate submission checks passed.</small>
    `;
    toast('Run accepted by the MATT Mine server');
    await refreshServerPlayer();
  } catch (error) {
    $('#economy-result').innerHTML = `
      <strong>SERVER REJECTED RUN</strong>
      <span>${escapeHtml(error.message)}</span>
      <small>No leaderboard score was recorded. The server profile remains authoritative.</small>
    `;
    toast(error.message);
    await refreshServerPlayer();
  }
}

async function startRunMode(mode) {
  const useServer = mode === RUN_MODES.FREE || (mode === RUN_MODES.PRACTICE && serverPlayer);
  if (useServer) {
    if (!serverPlayer) {
      const connected = await connectWallet();
      if (!connected) return;
    }
    try {
      const run = await apiClient.startRun(mode);
      activeServerRun = run;
      if (mode === RUN_MODES.FREE) serverPlayer.entitlements.freeRunAvailable = false;
      game.startRun({
        mode: run.mode,
        seed: run.seed,
        day: run.day,
        week: run.week,
        rewardWeight: run.rewardWeight
      });
      updateMenu();
    } catch (error) {
      toast(error.message);
      await refreshServerPlayer();
    }
    return;
  }

  const result = economy.apply(consumeRun(economy.state, mode));
  if (!result.ok) {
    toast(result.error);
    if (mode === RUN_MODES.PAID) openPass();
    updateMenu();
    return;
  }
  game.startRun({
    mode: result.mode,
    seed: result.seed,
    day: result.day,
    week: result.week,
    rewardWeight: result.rewardWeight
  });
  updateMenu();
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
    ui.runModeHud.textContent = modeLabel(stats.runMode, stats.rewardWeight);
    ui.runModeHud.dataset.mode = stats.runMode;
    if (ui.dashMobileText) ui.dashMobileText.textContent = stats.dashReady >= 0.999 ? 'DASH' : `${Math.ceil((1 - stats.dashReady) * 3)}s`;
    for (const slot of ui.weaponSlots) {
      const id = slot.dataset.weapon;
      const weapon = stats.weapons[id];
      slot.classList.toggle('active', stats.weapon === id);
      slot.classList.toggle('locked', !weapon.unlocked);
      const value = slot.querySelector(`[data-weapon-value="${id}"]`);
      if (value) value.textContent = weapon.unlocked ? weapon.value : 'LOCKED';
    }
    for (const button of ui.weaponButtons) {
      const id = button.dataset.weapon;
      const weapon = stats.weapons[id];
      button.classList.toggle('active', stats.weapon === id);
      button.classList.toggle('locked', !weapon.unlocked);
    }
    if (ui.attackButton) ui.attackButton.textContent = stats.weapon === 'dynamite' ? '🧨' : stats.weapon === 'blaster' ? '✦' : '⛏';
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
    const mode = result.mode || RUN_MODES.PRACTICE;
    const serverRun = activeServerRun && activeServerRun.mode === mode ? activeServerRun : null;
    const recorded = serverRun
      ? { ok: true, serverPending: true }
      : economy.apply(recordRun(economy.state, result));
    $('#end-kicker').textContent = result.extracted ? 'EXTRACTION SUCCESSFUL' : 'THE MINE TOOK ITS CUT';
    $('#end-title').textContent = result.extracted ? 'Loot Secured' : 'You Were Knocked Out';
    $('#run-mode-result').textContent = modeLabel(mode, result.rewardWeight);
    $('#run-mode-result').dataset.mode = mode;
    $('#end-stats').innerHTML = `
      <div><span>Banked</span><strong>${formatNumber(result.banked)}</strong></div>
      <div><span>${result.extracted ? 'Run Score' : 'Lost Loot'}</span><strong>${formatNumber(result.extracted ? result.projected : result.lost)}</strong></div>
      <div><span>Depth</span><strong>${result.depth}</strong></div>
      <div><span>Enemies</span><strong>${result.kills}</strong></div>
      <div><span>Ore Broken</span><strong>${result.oreBroken}</strong></div>
      <div><span>Run Time</span><strong>${formatTime(result.elapsed)}</strong></div>
    `;
    $('#economy-result').innerHTML = economyResultMarkup(mode, result, recorded);
    showScreen('run-end');
    setGameplayUi(false);
    updateMenu();
    if (serverRun) void submitServerRun(serverRun, result);
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
  onFatalError(error) {
    showScreen('menu');
    setGameplayUi(false);
    updateMenu();
    toast(`Run stopped safely: ${error.message}`);
  },
  onToast: toast
});

window.__MATT_MINE_GAME__ = game;
window.__MATT_MINE_ECONOMY__ = economy;
window.__MATT_MINE_API__ = apiClient;

$('#free-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.FREE));
$('#practice-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.PRACTICE));
$('#paid-run-button').addEventListener('click', () => {
  const access = runAccess(economy.state, RUN_MODES.PAID);
  if (access.allowed) void startRunMode(RUN_MODES.PAID);
  else openPass();
});
$('#wallet-button').addEventListener('click', () => {
  if (serverPlayer) {
    void refreshServerPlayer().then(() => toast('Server wallet session refreshed'));
  } else {
    void connectWallet();
  }
});
$('#play-again-button').addEventListener('click', () => game.backToMenu());
$('#menu-button').addEventListener('click', () => game.backToMenu());
$('#extract-button').addEventListener('click', () => game.extract());
$('#descend-button').addEventListener('click', () => game.descend());
$('#upgrades-button').addEventListener('click', () => {
  renderShop();
  showScreen('upgrade-shop');
});
$('#pass-button').addEventListener('click', openPass);
$('#leaderboards-button').addEventListener('click', () => openLeaderboards(RUN_MODES.FREE));
$('#admin-button').addEventListener('click', openAdmin);

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    showScreen('menu');
    updateMenu();
  });
}

$('#buy-pass-button').addEventListener('click', () => {
  const result = economy.apply(purchasePass(economy.state));
  toast(result.ok ? `Test pass active for 30 days · ${result.priceRon} RON modeled` : result.error);
  openPass();
});

$('#buy-paid-run-button').addEventListener('click', () => {
  const result = economy.apply(purchasePaidRun(economy.state));
  toast(result.ok
    ? `${result.priceRon} RON modeled → ${formatNumber(result.mattBought)} MATT · 0 burned`
    : result.error);
  openPass();
});

for (const tab of document.querySelectorAll('.leaderboard-tab')) {
  tab.addEventListener('click', () => openLeaderboards(tab.dataset.board === 'paid' ? RUN_MODES.PAID : RUN_MODES.FREE));
}

$('#publish-rewards').addEventListener('click', () => {
  const result = economy.apply(publishRewardEpoch(economy.state, ADMIN_ROLES.REWARD));
  toast(result.ok ? `Reward epoch published · ${formatNumber(result.epoch.totalRewardMatt)} MATT` : result.error);
  openAdmin();
});

$('#claim-reward-button').addEventListener('click', () => {
  const result = economy.apply(claimLatestReward(economy.state));
  toast(result.ok ? `Test claim recorded · ${formatNumber(result.epoch.totalRewardMatt)} MATT` : result.error);
  openLeaderboards(activeBoard);
});

$('#apply-pauses').addEventListener('click', () => {
  const result = economy.apply(updateAdminSettings(economy.state, {
    rankedPaused: $('#pause-ranked').checked,
    passSalesPaused: $('#pause-pass').checked,
    paidRunsPaused: $('#pause-paid').checked,
    claimsPaused: $('#pause-claims').checked
  }, ADMIN_ROLES.PAUSER));
  toast(result.ok ? 'Emergency controls updated immediately' : result.error);
  openAdmin();
});

$('#apply-prices').addEventListener('click', () => {
  const result = economy.apply(updateAdminSettings(economy.state, {
    passPriceRon: numberValue('#admin-pass-price'),
    paidRunPriceRon: numberValue('#admin-run-price'),
    mattPerRonQuote: numberValue('#admin-matt-quote')
  }, ADMIN_ROLES.PRICE));
  toast(result.ok ? 'Prices updated with no timelock' : result.error);
  openAdmin();
});

$('#apply-pools').addEventListener('click', () => {
  const result = economy.apply(updateAdminSettings(economy.state, {
    freeWeeklyPoolMatt: numberValue('#admin-free-pool'),
    passBaseWeeklyPoolMatt: numberValue('#admin-pass-pool')
  }, ADMIN_ROLES.TREASURY));
  toast(result.ok ? 'Weekly pool settings updated' : result.error);
  openAdmin();
});

$('#toggle-ban').addEventListener('click', () => {
  const result = economy.apply(setWalletBan(economy.state, !economy.state.player.banned, ADMIN_ROLES.MODERATOR));
  toast(result.ok ? (result.banned ? 'Test wallet suspended' : 'Test wallet restored') : result.error);
  openAdmin();
});

$('#reset-economy').addEventListener('click', () => {
  const result = resetEconomyForTesting(economy.state, ADMIN_ROLES.GAME);
  if (result.ok) economy.save(result.state);
  toast(result.ok ? 'Local economy reset' : result.error);
  openAdmin();
});

function openPass() {
  const state = economy.state;
  const active = passIsActive(state);
  $('#pass-state-label').textContent = active ? `PASS ACTIVE · ${passDaysRemaining(state)} DAYS LEFT` : 'FREE TIER ACTIVE';
  $('#buy-pass-button').textContent = active ? `EXTEND 30 DAYS · ${trimNumber(state.settings.passPriceRon)} RON` : `ACTIVATE TEST PASS · ${trimNumber(state.settings.passPriceRon)} RON`;
  $('#buy-paid-run-button').disabled = !active || state.settings.paidRunsPaused;
  $('#buy-paid-run-button').textContent = active ? `BUY TEST RUN · ${trimNumber(state.settings.paidRunPriceRon)} RON` : 'PASS REQUIRED';
  updateMenu();
  showScreen('mine-pass');
}

function renderPassProgress() {
  const state = economy.state;
  const level = passLevel(state.player.passXp);
  $('#pass-level').textContent = String(level.level);
  $('#pass-xp-text').textContent = `${formatNumber(state.player.passXp)} XP`;
  $('#pass-xp-fill').style.width = `${Math.round(level.progress * 100)}%`;
  const rewards = ['Starter Badge', '250K MATT Draw', 'Gold Trail', 'Pass Chest', 'Crystal Skin', 'Founder Frame', 'Guardian Aura', 'Season Trophy'];
  $('#pass-track').innerHTML = rewards.map((reward, index) => `
    <div class="pass-node ${index + 1 <= level.level ? 'unlocked' : ''}">
      <span>${index + 1}</span><small>${reward}</small>
    </div>
  `).join('');
}

function openLeaderboards(mode) {
  activeBoard = mode;
  for (const tab of document.querySelectorAll('.leaderboard-tab')) {
    tab.classList.toggle('active', tab.dataset.board === (mode === RUN_MODES.PAID ? 'paid' : 'free'));
  }
  const rows = previewLeaderboard(economy.state, mode);
  const player = rows.find((row) => row.isPlayer);
  const pool = mode === RUN_MODES.PAID ? passPoolMatt(economy.state) : economy.state.settings.freeWeeklyPoolMatt;
  $('#board-pool').textContent = `${formatNumber(pool)} MATT`;
  $('#board-score').textContent = formatNumber(weeklyUserScore(economy.state, mode));
  $('#board-reward').textContent = `${formatNumber(estimatedLeaderboardReward(economy.state, mode, player?.rank || 0))} MATT`;
  const published = latestReward(economy.state);
  $('#published-reward-text').textContent = published ? `${formatNumber(published.totalRewardMatt)} MATT` : 'No reward epoch published';
  $('#published-reward-status').textContent = published
    ? published.claimedAt ? `Claim recorded ${new Date(published.claimedAt).toLocaleString('en-US')}` : `Published for week ${published.week}`
    : 'Admin test publisher has not finalized this week.';
  $('#claim-reward-button').disabled = !published || Boolean(published.claimedAt) || economy.state.settings.claimsPaused;
  $('#claim-reward-button').textContent = published?.claimedAt ? 'CLAIMED' : economy.state.settings.claimsPaused ? 'CLAIMS PAUSED' : 'CLAIM TEST MATT';
  $('#leaderboard-body').innerHTML = rows.map((row) => `
    <tr class="${row.isPlayer ? 'player-row' : ''}">
      <td>#${row.rank}</td>
      <td>${row.walletId}${row.isPlayer ? ' · YOU' : ''}</td>
      <td>${formatNumber(row.score)}</td>
      <td>${row.isPreview ? 'PREVIEW' : row.score > 0 ? 'VERIFIED LOCAL' : 'NO SCORE'}</td>
    </tr>
  `).join('');
  showScreen('leaderboards');
  if (serverPlayer && mode === RUN_MODES.FREE) void renderServerLeaderboard(mode);
}

async function renderServerLeaderboard(mode) {
  const note = $('#leaderboard-note');
  if (note) note.textContent = 'Loading server-verified rankings…';
  try {
    const leaderboard = await apiClient.leaderboard(mode);
    $('#board-score').textContent = formatNumber(leaderboard.playerScore);
    const rows = leaderboard.rows;
    $('#leaderboard-body').innerHTML = rows.length
      ? rows.map((row) => `
          <tr class="${row.isPlayer ? 'player-row' : ''}">
            <td>#${row.rank}</td>
            <td>${escapeHtml(row.walletId)}${row.isPlayer ? ' · YOU' : ''}</td>
            <td>${formatNumber(row.score)}</td>
            <td>SERVER VERIFIED</td>
          </tr>
        `).join('')
      : '<tr><td colspan="4">No verified Free scores yet this week.</td></tr>';
    if (note) note.textContent = `Server-authoritative daily-best rankings · Week ${leaderboard.week}`;
  } catch (error) {
    if (note) note.textContent = `Server leaderboard unavailable: ${error.message}`;
  }
}

function openAdmin() {
  const state = economy.state;
  const settings = state.settings;
  $('#pause-ranked').checked = settings.rankedPaused;
  $('#pause-pass').checked = settings.passSalesPaused;
  $('#pause-paid').checked = settings.paidRunsPaused;
  $('#pause-claims').checked = settings.claimsPaused;
  $('#admin-pass-price').value = settings.passPriceRon;
  $('#admin-run-price').value = settings.paidRunPriceRon;
  $('#admin-matt-quote').value = settings.mattPerRonQuote;
  $('#admin-free-pool').value = settings.freeWeeklyPoolMatt;
  $('#admin-pass-pool').value = settings.passBaseWeeklyPoolMatt;
  $('#admin-wallet').textContent = state.walletId;
  $('#toggle-ban').textContent = state.player.banned ? 'RESTORE WALLET' : 'SUSPEND WALLET';
  $('#admin-accounting').innerHTML = `
    <span>RON from passes <b>${trimNumber(state.accounting.ronFromPasses)}</b></span>
    <span>RON from runs <b>${trimNumber(state.accounting.ronFromPaidRuns)}</b></span>
    <span>MATT purchased <b>${formatNumber(state.accounting.mattBoughtTotal)}</b></span>
    <span>Current Pass pool <b>${formatNumber(state.accounting.currentPassPoolMatt)}</b></span>
    <span>Future rewards <b>${formatNumber(state.accounting.futureRewardsMatt)}</b></span>
    <span>Reserve <b>${formatNumber(state.accounting.reserveMatt)}</b></span>
    <span>Burned <b>0</b></span>
  `;
  $('#published-epochs').innerHTML = state.publishedRewards.length
    ? [...state.publishedRewards].reverse().slice(0, 5).map((epoch) => `<div><b>${epoch.id}</b><span>${formatNumber(epoch.totalRewardMatt)} MATT · ${epoch.claimedAt ? 'CLAIMED' : 'READY'}</span></div>`).join('')
    : '<small>No epochs published.</small>';
  const audits = [...state.audit].reverse().slice(0, 40);
  $('#audit-count').textContent = `${state.audit.length} actions`;
  $('#audit-log').innerHTML = audits.length ? audits.map((entry) => `
    <div class="audit-entry"><time>${new Date(entry.timestamp).toLocaleString('en-US')}</time><b>${entry.action}</b><span>${entry.actor}</span><small>${escapeHtml(entry.details)}</small></div>
  `).join('') : '<p class="empty-audit">No actions recorded yet.</p>';
  showScreen('admin-panel');
}

function economyResultMarkup(mode, result, recorded) {
  if (recorded.serverPending) {
    return '<strong>SERVER VERIFICATION PENDING</strong><span>The local result will not enter the leaderboard unless the server accepts it.</span>';
  }
  if (mode === RUN_MODES.PRACTICE) {
    return '<strong>Practice complete</strong><span>No MATT reward and no leaderboard score. Practice remains unlimited.</span>';
  }
  if (!recorded.ok) {
    return `<strong>Ranked score rejected</strong><span>${escapeHtml(recorded.error)}</span>`;
  }
  const rows = previewLeaderboard(economy.state, mode);
  const player = rows.find((row) => row.isPlayer);
  const reward = estimatedLeaderboardReward(economy.state, mode, player?.rank || 0);
  const weekly = weeklyUserScore(economy.state, mode);
  const scoreNote = result.extracted
    ? 'Successful extraction counted at full run score'
    : `Knockout counted only ${formatNumber(result.banked)} secured nuggets`;
  return `
    <strong>${mode === RUN_MODES.PAID ? 'PASS LEADERBOARD' : 'FREE LEADERBOARD'} · #${player?.rank || '—'}</strong>
    <span>Weekly score: ${formatNumber(weekly)} · Projected leaderboard share: ${formatNumber(reward)} MATT</span>
    <small>${scoreNote} · ${mode === RUN_MODES.PAID ? `2× reward weight · Pass XP ${formatNumber(recorded.passXp || economy.state.player.passXp)}` : 'One free ranked run consumed for today'} · Rewards remain estimates until verified and published.</small>
  `;
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
    button.addEventListener('click', async () => {
      if (maxed || profile.bankedNuggets < cost) return;
      if (serverPlayer) {
        button.disabled = true;
        try {
          const result = await apiClient.purchaseUpgrade(upgrade.id);
          profile = result.profile;
          serverPlayer.profile = result.profile;
          saveProfile(profile);
          game.setProfile(profile);
          updateMenu();
          renderShop();
          toast(`${upgrade.name} upgraded · server saved`);
        } catch (error) {
          toast(error.message);
          await refreshServerPlayer();
          renderShop();
        }
        return;
      }
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

function modeLabel(mode, rewardWeight = 0) {
  if (mode === RUN_MODES.FREE) return 'FREE RANKED · 1×';
  if (mode === RUN_MODES.PAID) return `PASS RANKED · ${rewardWeight || 2}×`;
  return 'PRACTICE · NO REWARD';
}

function upgradeCost(upgrade, rank) {
  return Math.floor(upgrade.baseCost * Math.pow(1.55, rank));
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function trimNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function numberValue(selector) {
  return Number($(selector).value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function abbreviateAddress(address) {
  return typeof address === 'string' && address.length >= 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : String(address || '');
}

async function bootstrapServer() {
  try {
    serverConfig = await apiClient.config();
    const restored = await wallet.restore();
    if (restored) {
      serverPlayer = restored;
      profile = restored.profile;
      saveProfile(profile);
      game.setProfile(profile);
    }
  } catch (error) {
    console.warn('[MATT Mine] Server bootstrap unavailable.', error);
  }
  updateMenu();
}

updateMenu();
showScreen('menu');
void bootstrapServer();
