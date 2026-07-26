import { MattMineGame } from './game/GameV4.js';
import { apiClient } from './game/apiClient.js';
import { META_UPGRADES, metaUpgradeCost } from './game/config.js';
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
import {
  PASS_CHEST_BONUS_NUGGETS,
  PASS_CHEST_ID,
  PASS_COSMETICS,
  PASS_REWARD_LEVELS,
  cosmeticById
} from './game/passRewards.js';
import {
  arenaTimeRemaining,
  formatMattRaw,
  normalizeArenaConfig,
  normalizeArenaLeaderboard,
  normalizeArenaPlayer
} from './game/arena.js';
import { ArenaTranscript } from './game/arenaTranscript.js';
import { loadProfile, saveProfile } from './game/storage.js';
import { RoninWalletAdapter } from './game/walletAdapter.js';

const $ = (selector) => document.querySelector(selector);
const canvas = $('#game');
const screens = [...document.querySelectorAll('.screen')];
const hud = $('#hud');
const mobileControls = $('#mobile-controls');
const isLocalPreview = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
const economy = new LocalEconomyStore();
let profile = loadProfile();
let toastTimer;
let activeBoard = RUN_MODES.FREE;
let serverConfig = null;
let serverPlayer = null;
let activeServerRun = null;
let paymentStatus = null;
let publicPaymentStatus = null;
let walletBusy = false;
let paymentBusy = false;
let activeServerClaim = null;
let passRewardsBusy = false;
let arenaConfig = normalizeArenaConfig();
let arenaPlayer = normalizeArenaPlayer();
let arenaLeaderboard = normalizeArenaLeaderboard();
let arenaBusy = false;
let arenaCountdownTimer = null;
let activeArenaRun = null;
let activeArenaTranscript = null;
const wallet = new RoninWalletAdapter({
  api: apiClient,
  onInvalidated(reason) {
    serverPlayer = null;
    activeServerRun = null;
    activeArenaRun = null;
    activeArenaTranscript = null;
    arenaPlayer = normalizeArenaPlayer();
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
  document.body.classList.toggle('launch-active', id === 'launch');
}

function setGameplayUi(active) {
  hud.classList.toggle('active', active);
  mobileControls.classList.toggle('active', active);
}

function applyPassInventory(passInventory) {
  if (!passInventory) return;
  if (serverPlayer) serverPlayer.passInventory = passInventory;
  if (paymentStatus) paymentStatus.passInventory = passInventory;
  game?.setCosmetics(passInventory.equipped || {});
}

function updateMenu() {
  const state = economy.state;
  const daily = dailyRecord(state);
  const livePayments = serverConfig?.realPaymentsEnabled === true;
  const passActive = livePayments ? paymentStatus?.pass?.active === true : passIsActive(state);
  const connected = Boolean(serverPlayer);
  const freeAccess = connected
    ? {
        allowed: Boolean(serverPlayer.entitlements?.freeRunAvailable),
        reason: serverPlayer.suspended ? 'Wallet suspended' : 'Used today'
      }
    : { allowed: true, reason: 'Ronin sign-in required' };
  const paidCredits = livePayments ? paymentStatus?.confirmedCredits || 0 : state.player.paidRunCredits;
  const paidRunsToday = livePayments ? paymentStatus?.paidRuns?.purchasedToday || 0 : daily.paidRunsUsed;
  const paidAccess = livePayments
    ? {
        allowed:
          connected &&
          !serverPlayer?.suspended &&
          passActive &&
          paidCredits > 0 &&
          paymentStatus?.paidRuns?.paused !== true,
        reason: !connected
          ? 'Ronin sign-in required'
          : serverPlayer?.suspended
            ? 'Wallet suspended'
            : !passActive
              ? 'Pass required'
              : paymentStatus?.paidRuns?.paused
                ? 'Paid runs paused'
                : paidCredits > 0
                  ? ''
                  : 'Buy a run credit'
      }
    : runAccess(state, RUN_MODES.PAID);
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
  const remainingPassDays = livePayments && paymentStatus
    ? Math.max(0, Math.ceil((paymentStatus.pass.expiresAt - Date.now()) / 86_400_000))
    : passDaysRemaining(state);
  $('#pass-days').textContent = passActive ? `${remainingPassDays} days remaining` : 'Premium locked';
  $('#paid-credit-count').textContent = String(paidCredits);
  $('#paid-daily-status').textContent = `${paidRunsToday} / ${livePayments ? paymentStatus?.paidRuns?.dailyLimit || 10 : state.settings.maxPaidRunsPerDay} purchased today`;
  $('#paid-run-cta').textContent = paidAccess.allowed
    ? 'START PAID RUN'
    : passActive
      ? paidCredits > 0 ? paidAccess.reason.toUpperCase() : 'BUY A RUN CREDIT'
      : 'VIEW PASS';
  $('#paid-run-button').classList.toggle('ready', paidAccess.allowed);
  const passPrice = livePayments
    ? paymentStatus
      ? weiToRon(paymentStatus.pass.priceRonWei)
      : publicPaymentStatus ? weiToRon(publicPaymentStatus.pass.priceRonWei) : null
    : publicPaymentStatus
      ? weiToRon(publicPaymentStatus.pass.priceRonWei)
      : state.settings.passPriceRon;
  const paidRunPrice = livePayments
    ? paymentStatus
      ? weiToRon(paymentStatus.paidRuns.priceRonWei)
      : publicPaymentStatus ? weiToRon(publicPaymentStatus.paidRuns.priceRonWei) : null
    : publicPaymentStatus
      ? weiToRon(publicPaymentStatus.paidRuns.priceRonWei)
      : state.settings.paidRunPriceRon;
  $('#pass-price').textContent = passPrice === null ? '—' : trimNumber(passPrice);
  $('#paid-run-price').textContent = paidRunPrice === null ? '—' : trimNumber(paidRunPrice);
  $('#paid-run-price-copy').textContent = paidRunPrice === null ? 'Connect wallet to load price' : `${trimNumber(paidRunPrice)} RON`;
  const transactionNotice = $('#transaction-mode-notice');
  if (transactionNotice) {
    transactionNotice.textContent = livePayments
      ? 'LIVE RONIN MAINNET · WALLET APPROVAL REQUIRED FOR EVERY PURCHASE'
      : isLocalPreview
        ? 'SAFE TEST MODE · REAL RON TRANSACTIONS DISABLED'
        : 'RANKED PLAY OPEN · PURCHASES TEMPORARILY PAUSED';
    transactionNotice.classList.toggle('live-payments', livePayments);
  }
  updateLaunch({
    connected,
    freeAccess,
    passPrice,
    paidRunPrice,
    livePayments,
    passActive
  });
  renderArenaMenuStatus();
  renderPassProgress();
}

function updateLaunch({ connected, freeAccess, passPrice, paidRunPrice, livePayments, passActive }) {
  const walletLabel = $('#launch-wallet-label');
  const walletButton = $('#launch-wallet-button');
  const freeStatus = $('#launch-free-status');
  const serverStatus = $('#launch-live-status');
  const date = $('#launch-date');
  const passPriceText = passPrice === null ? '—' : trimNumber(passPrice);
  const runPriceText = paidRunPrice === null ? '—' : trimNumber(paidRunPrice);

  if (date) {
    date.textContent = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric'
    }).format(new Date()).toUpperCase();
  }
  if (walletLabel) walletLabel.textContent = connected
    ? abbreviateAddress(serverPlayer.address)
    : walletBusy ? 'CONNECTING…' : 'CONNECT RONIN';
  if (walletButton) {
    walletButton.disabled = walletBusy;
    walletButton.classList.toggle('connected', connected);
  }
  if (freeStatus) {
    freeStatus.textContent = !connected
      ? 'READY'
      : serverPlayer?.suspended
        ? 'SUSPENDED'
        : freeAccess.allowed ? 'READY' : 'USED';
  }
  if (serverStatus) {
    const online = Boolean(serverConfig);
    serverStatus.textContent = online
      ? livePayments ? 'LIVE PAYMENTS' : 'SERVER ONLINE'
      : 'CONNECTING';
    serverStatus.classList.toggle('offline', !online);
  }
  for (const selector of ['#launch-pass-price', '#launch-pass-price-card']) {
    const element = $(selector);
    if (element) element.textContent = passPriceText;
  }
  for (const selector of ['#launch-run-price', '#launch-run-price-card']) {
    const element = $(selector);
    if (element) element.textContent = runPriceText;
  }
  const livePill = $('.launch-live-pill');
  if (livePill) {
    livePill.title = passActive
      ? 'Your connected wallet has an active MATT Mine Pass.'
      : 'MATT Mine contracts are deployed and verified on Ronin Mainnet.';
  }
}

function openLaunch(scrollToTop = false) {
  setGameplayUi(false);
  showScreen('launch');
  updateMenu();
  if (scrollToTop) $('#launch-scroll')?.scrollTo({ top: 0, behavior: 'smooth' });
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
    await refreshPaymentStatus(true);
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
    await refreshPaymentStatus(true);
    await refreshArena(true);
    updateMenu();
    return serverPlayer;
  } catch (error) {
    serverPlayer = null;
    updateMenu();
    if (error?.code !== 'session_missing') toast(error.message);
    return null;
  }
}

async function refreshPaymentStatus(silent = false) {
  if (!serverPlayer || serverConfig?.realPaymentsEnabled !== true) {
    paymentStatus = null;
    updateMenu();
    return null;
  }
  try {
    paymentStatus = await apiClient.paymentStatus();
    applyPassInventory(paymentStatus.passInventory);
    updateMenu();
    return paymentStatus;
  } catch (error) {
    paymentStatus = null;
    updateMenu();
    if (!silent) toast(error.message);
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
      serverPlayer.passProgress = accepted.passProgress;
      serverPlayer.passInventory = accepted.passInventory;
      serverPlayer.scores[serverRun.mode] = leaderboard.playerScore;
    }
    if (paymentStatus && accepted.passProgress) paymentStatus.passProgress = accepted.passProgress;
    applyPassInventory(accepted.passInventory);
    const boardName = serverRun.mode === RUN_MODES.FREE
      ? 'Free'
      : serverRun.mode === RUN_MODES.PAID
        ? 'Pass'
        : 'Practice';
    const passXpCopy = accepted.run?.passXpAwarded
      ? ` · +${accepted.run.passXpAwarded} Pass XP`
      : '';
    const unlockedCopy = accepted.passRewardsUnlocked?.length
      ? ` · UNLOCKED ${accepted.passRewardsUnlocked.map((reward) => reward.name).join(', ')}`
      : '';
    $('#economy-result').innerHTML = `
      <strong>SERVER VERIFIED${leaderboard.playerRank ? ` · #${leaderboard.playerRank}` : ''}</strong>
      <span>Weekly ${boardName} score: ${formatNumber(leaderboard.playerScore)}${passXpCopy}${unlockedCopy}</span>
      <small>Entitlement, Pass status, one-time run token, telemetry limits, secured-loot rule, and duplicate submission checks passed.</small>
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

async function submitArenaRun(run) {
  const transcript = activeArenaTranscript;
  activeArenaRun = null;
  activeArenaTranscript = null;
  $('#economy-result').innerHTML =
    '<strong>ARENA REPLAY IN PROGRESS</strong><span>The server is replaying the signed event transcript and calculating the authoritative score…</span>';
  try {
    const checkpoint = await transcript?.close();
    if (!checkpoint) throw new Error('The Arena transcript was not checkpointed.');
    const accepted = await apiClient.finishArenaRun(run.runId, run.runToken, checkpoint);
    const result = accepted.result || {};
    const leaderboard = accepted.leaderboard || {};
    arenaPlayer = normalizeArenaPlayer({
      ...arenaPlayer,
      unusedAttempts: Math.max(0, arenaPlayer.unusedAttempts - 1),
      bestScore: leaderboard.playerScore ?? result.score ?? arenaPlayer.bestScore,
      rank: leaderboard.playerRank ?? arenaPlayer.rank
    });
    $('#economy-result').innerHTML = `
      <strong>ARENA SCORE VERIFIED${arenaPlayer.rank ? ` · #${arenaPlayer.rank}` : ''}</strong>
      <span>Authoritative score: ${formatNumber(result.score || arenaPlayer.bestScore)}</span>
      <small>The signed transcript was replayed against today's deterministic challenge. Browser-reported score totals were not trusted.</small>
    `;
    toast('Daily Arena score verified');
    await refreshArena(true);
  } catch (error) {
    $('#economy-result').innerHTML = `
      <strong>ARENA RUN REJECTED</strong>
      <span>${escapeHtml(error.message || 'The server could not verify this run.')}</span>
      <small>No Arena leaderboard score was recorded.</small>
    `;
    toast(error.message || 'Arena verification failed.');
    await refreshArena(true);
  }
}

async function startRunMode(mode) {
  const useServer =
    mode === RUN_MODES.FREE ||
    (mode === RUN_MODES.PAID && serverConfig?.paidRunsEnabled === true) ||
    (mode === RUN_MODES.PRACTICE && serverPlayer);
  if (useServer) {
    if (!serverPlayer) {
      const connected = await connectWallet();
      if (!connected) return;
    }
    try {
      const run = await apiClient.startRun(mode);
      activeServerRun = run;
      if (mode === RUN_MODES.FREE) serverPlayer.entitlements.freeRunAvailable = false;
      if (mode === RUN_MODES.PAID && paymentStatus) {
        paymentStatus.confirmedCredits = Math.max(0, paymentStatus.confirmedCredits - 1);
      }
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
    const arenaRun = activeArenaRun && mode === 'arena' ? activeArenaRun : null;
    const recorded = serverRun || arenaRun
      ? { ok: true, serverPending: true }
      : economy.apply(recordRun(economy.state, result));
    $('#end-kicker').textContent = result.extracted ? 'EXTRACTION SUCCESSFUL' : 'THE MINE TOOK ITS CUT';
    $('#end-title').textContent = result.extracted ? 'Loot Secured' : 'You Were Knocked Out';
    $('#run-mode-result').textContent = modeLabel(mode, result.rewardWeight);
    $('#run-mode-result').dataset.mode = mode;
    $('#run-cosmetic-result').innerHTML = renderRunCosmeticResult();
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
    if (arenaRun) void submitArenaRun(arenaRun);
    else if (serverRun) void submitServerRun(serverRun, result);
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
  onArenaInput(event) {
    activeArenaTranscript?.record(event);
  },
  onToast: toast
});

window.__MATT_MINE_GAME__ = game;
window.__MATT_MINE_ECONOMY__ = economy;
window.__MATT_MINE_API__ = apiClient;

for (const button of document.querySelectorAll('[data-launch-action]')) {
  button.addEventListener('click', () => {
    const action = button.dataset.launchAction;
    if (action === 'practice') {
      void startRunMode(RUN_MODES.PRACTICE);
      return;
    }
    if (action === 'pass') {
      openPass();
      return;
    }
    if (action === 'arena') {
      void openArena();
      return;
    }
    showScreen('menu');
    updateMenu();
  });
}

for (const button of document.querySelectorAll('[data-launch-scroll]')) {
  button.addEventListener('click', () => {
    document.getElementById(button.dataset.launchScroll)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start'
    });
  });
}

$('#launch-wallet-button').addEventListener('click', () => {
  if (serverPlayer) {
    void refreshServerPlayer().then(() => toast('Ronin session refreshed'));
  } else {
    void connectWallet();
  }
});

$('#home-button').addEventListener('click', () => openLaunch(true));
$('#free-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.FREE));
$('#practice-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.PRACTICE));
$('#paid-run-button').addEventListener('click', () => {
  if (serverConfig?.paidRunsEnabled === true) {
    if ((paymentStatus?.confirmedCredits || 0) > 0 && paymentStatus?.pass?.active) {
      void startRunMode(RUN_MODES.PAID);
    } else {
      openPass();
    }
    return;
  }
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
$('#sound-button').addEventListener('click', () => {
  renderAudioSettings();
  showScreen('sound-settings');
});
$('#sound-mute-button').addEventListener('click', () => {
  game.audio.setMuted(!game.audio.settings().muted);
  renderAudioSettings();
});
$('#music-volume').addEventListener('input', (event) => {
  game.audio.setMusicVolume(Number(event.target.value) / 100);
  renderAudioSettings();
});
$('#effects-volume').addEventListener('input', (event) => {
  game.audio.setEffectsVolume(Number(event.target.value) / 100);
  game.audio.play('weapon');
  renderAudioSettings();
});
$('#pass-button').addEventListener('click', openPass);
$('#manage-cosmetics-button').addEventListener('click', () => void openCosmetics());
$('#leaderboards-button').addEventListener('click', () => openLeaderboards(RUN_MODES.FREE));
$('#arena-button').addEventListener('click', () => void openArena());
$('#admin-button').addEventListener('click', openAdmin);

for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => {
    showScreen('menu');
    updateMenu();
  });
}

$('#buy-pass-button').addEventListener('click', () => {
  if (serverConfig?.realPaymentsEnabled === true) {
    void purchaseLivePass();
    return;
  }
  const result = economy.apply(purchasePass(economy.state));
  toast(result.ok ? `Test pass active for 30 days · ${result.priceRon} RON modeled` : result.error);
  openPass();
});

$('#buy-paid-run-button').addEventListener('click', () => {
  if (serverConfig?.realPaymentsEnabled === true) {
    void purchaseLivePaidRun();
    return;
  }
  const result = economy.apply(purchasePaidRun(economy.state));
  toast(result.ok
    ? `${result.priceRon} RON modeled → ${formatNumber(result.mattBought)} MATT · 0 burned`
    : result.error);
  openPass();
});

$('#buy-arena-entry-button').addEventListener('click', () => void purchaseArenaEntry());
$('#start-arena-run-button').addEventListener('click', () => void startArenaRun());
$('#arena-refund-button').addEventListener('click', () => void claimArenaRefund());

for (const tab of document.querySelectorAll('.leaderboard-tab')) {
  tab.addEventListener('click', () => openLeaderboards(tab.dataset.board === 'paid' ? RUN_MODES.PAID : RUN_MODES.FREE));
}

$('#publish-rewards').addEventListener('click', () => {
  const result = economy.apply(publishRewardEpoch(economy.state, ADMIN_ROLES.REWARD));
  toast(result.ok ? `Reward epoch published · ${formatNumber(result.epoch.totalRewardMatt)} MATT` : result.error);
  openAdmin();
});

$('#claim-reward-button').addEventListener('click', async () => {
  if (serverPlayer && activeServerClaim) {
    if (walletBusy) return;
    walletBusy = true;
    $('#claim-reward-button').disabled = true;
    $('#claim-reward-button').textContent = 'OPENING RONIN WALLET…';
    try {
      const prepared = await apiClient.prepareRewardClaim(activeServerClaim.id);
      const transactionHash = await wallet.claimReward(prepared.transaction);
      toast(`MATT claimed · ${abbreviateHash(transactionHash)}`);
      await renderServerLeaderboard(activeBoard);
    } catch (error) {
      toast(error.message || 'The MATT claim could not be completed.');
      await renderServerLeaderboard(activeBoard);
    } finally {
      walletBusy = false;
    }
    return;
  }
  if (!isLocalPreview) {
    toast('Connect Ronin Wallet to claim a published MATT reward.');
    return;
  }
  const result = economy.apply(claimLatestReward(economy.state));
  toast(result.ok ? `Local claim preview recorded · ${formatNumber(result.epoch.totalRewardMatt)} MATT` : result.error);
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

async function purchaseLivePass() {
  if (paymentBusy) return;
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  if (!paymentStatus) await refreshPaymentStatus();
  if (!paymentStatus) return;
  const price = weiToRon(paymentStatus.pass.priceRonWei);
  if (!window.confirm(`Activate the MATT Mine Pass for ${trimNumber(price)} RON on Ronin Mainnet? Ronin Wallet will ask you to approve the transaction.`)) return;
  paymentBusy = true;
  openPass();
  try {
    const transactionHash = await wallet.purchasePass(paymentStatus.pass.transaction);
    const confirmation = await apiClient.confirmPassPurchase(transactionHash);
    if (paymentStatus && confirmation.passProgress) {
      paymentStatus.passProgress = confirmation.passProgress;
    }
    applyPassInventory(confirmation.passInventory);
    if (confirmation.rewards?.length) {
      toast(`Unlocked ${confirmation.rewards.map((reward) => reward.name).join(', ')}`);
    }
    toast(`Pass transaction confirmed · ${abbreviateHash(transactionHash)}`);
    await refreshPaymentStatus();
  } catch (error) {
    toast(error?.message || 'Pass purchase failed.');
  } finally {
    paymentBusy = false;
    openPass();
  }
}

async function purchaseLivePaidRun() {
  if (paymentBusy) return;
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  if (!paymentStatus) await refreshPaymentStatus();
  if (!paymentStatus?.pass?.active) {
    toast('Activate the MATT Mine Pass first.');
    openPass();
    return;
  }
  paymentBusy = true;
  openPass();
  try {
    const quote = await apiClient.paidRunQuote();
    const price = weiToRon(paymentStatus.paidRuns.priceRonWei);
    const protectedMatt = weiToToken(quote.minMattOut);
    const approved = window.confirm(
      `Buy one paid ranked run for ${trimNumber(price)} RON? The contract will buy at least ${formatNumber(Math.floor(protectedMatt))} MATT at this quote. Ronin Wallet will ask you to approve.`
    );
    if (!approved) return;
    const transactionHash = await wallet.purchasePaidRun(quote.transaction);
    toast('Transaction mined · server confirming entitlement');
    await apiClient.confirmPaidRunPurchase(transactionHash);
    await refreshPaymentStatus();
    toast(`Paid run ready · ${abbreviateHash(transactionHash)}`);
  } catch (error) {
    toast(error?.message || 'Paid-run purchase failed.');
  } finally {
    paymentBusy = false;
    openPass();
  }
}

function renderArenaMenuStatus() {
  const pool = $('#arena-menu-pool');
  if (!pool) return;
  pool.textContent = arenaConfig.enabled
    ? formatMattRaw(arenaConfig.prizePoolRaw)
    : arenaConfig.previewAvailable
      ? 'SECURITY PREVIEW'
      : 'COMING SOON';
  const launchEntry = $('#launch-arena-entry');
  if (launchEntry) {
    launchEntry.textContent = arenaConfig.enabled && arenaConfig.feeRaw > 0n
      ? formatMattRaw(arenaConfig.feeRaw)
      : 'MATT ENTRY';
  }
  const launchState = $('#launch-arena-state');
  if (launchState) launchState.textContent = arenaConfig.enabled ? '24-HOUR POOL' : 'SECURITY PREVIEW';
  const menuAction = $('#arena-menu-action');
  if (menuAction) menuAction.textContent = arenaConfig.enabled ? 'ENTER ARENA →' : 'VIEW PREVIEW →';
}

async function openArena() {
  showScreen('daily-arena');
  renderArena();
  await refreshArena();
}

async function refreshArena(silent = false) {
  try {
    const config = await apiClient.arenaConfig();
    arenaConfig = normalizeArenaConfig(config);
    const requests = [apiClient.arenaLeaderboard(arenaConfig.day)];
    if (serverPlayer) requests.push(apiClient.arenaMe(arenaConfig.day));
    const [leaderboardResult, playerResult] = await Promise.allSettled(requests);
    if (leaderboardResult.status === 'fulfilled') {
      arenaLeaderboard = normalizeArenaLeaderboard(leaderboardResult.value);
    }
    if (playerResult?.status === 'fulfilled') {
      arenaPlayer = normalizeArenaPlayer(playerResult.value);
    } else if (!serverPlayer) {
      arenaPlayer = normalizeArenaPlayer();
    }
  } catch (error) {
    arenaConfig = normalizeArenaConfig({ status: 'disabled', enabled: false });
    arenaLeaderboard = normalizeArenaLeaderboard();
    if (!silent && error?.status !== 404) toast(error.message || 'Daily Arena status is unavailable.');
  }
  renderArenaMenuStatus();
  if ($('#daily-arena').classList.contains('active')) renderArena();
  return arenaConfig;
}

function renderArena() {
  const config = arenaConfig;
  const player = arenaPlayer;
  const leaderboard = arenaLeaderboard;
  const now = Date.now();
  const runWindowOpen = !config.snapshotAt || now < config.snapshotAt;
  const entryWindowOpen = !config.entryCutoffAt || now <= config.entryCutoffAt;
  const canceled =
    config.chainStatus === 3 ||
    ['canceled', 'cancelled'].includes(config.status);
  const settled = config.chainStatus === 2;
  const awaitingSafeSettlement = leaderboard.finalized && !settled && !canceled;
  const awaitingSettlement =
    !canceled &&
    !settled &&
    (!runWindowOpen || leaderboard.status === 'closed');
  const stateLabel = config.enabled
    ? settled
      ? 'SETTLED'
      : canceled
        ? 'CANCELED'
        : awaitingSafeSettlement
          ? 'AWAITING SAFE'
          : awaitingSettlement
            ? 'AWAITING REVIEW'
            : config.entriesPaused
              ? 'ENTRIES PAUSED'
              : config.status === 'open'
                ? 'OPEN'
                : config.status.toUpperCase()
    : config.previewAvailable
      ? 'SECURITY LOCKED'
      : 'NOT DEPLOYED';
  const badge = $('#arena-state-badge');
  badge.textContent = stateLabel;
  badge.dataset.state = config.status;
  $('#arena-entry-pool').textContent = formatMattRaw(config.entryPoolRaw);
  $('#arena-seed-pool').textContent = formatMattRaw(config.seedRaw);
  $('#arena-total-pool').textContent = formatMattRaw(config.prizePoolRaw);
  $('#arena-entry-price').textContent = formatMattRaw(config.feeRaw);
  $('#arena-entry-count').textContent = formatNumber(player.entries);
  $('#arena-attempt-count').textContent = formatNumber(player.unusedAttempts);
  $('#arena-best-score').textContent = player.bestScore ? formatNumber(player.bestScore) : '—';
  $('#arena-day-label').textContent = `${config.day} UTC · MATT entry closes 23:35 UTC · official runs close 00:00 UTC.`;

  const canEnter =
    Boolean(serverPlayer) &&
    config.enabled &&
    !config.entriesPaused &&
    entryWindowOpen &&
    config.status === 'open' &&
    !serverPlayer?.suspended;
  const buyButton = $('#buy-arena-entry-button');
  buyButton.disabled = arenaBusy || !canEnter;
  buyButton.textContent = arenaBusy
    ? 'WAITING FOR RONIN WALLET…'
    : !serverPlayer
      ? 'CONNECT RONIN TO ENTER'
      : serverPlayer.suspended
        ? 'WALLET SUSPENDED'
        : !config.enabled
          ? 'ARENA CONTRACT NOT ACTIVE'
          : config.entriesPaused
            ? 'ENTRIES PAUSED'
            : !entryWindowOpen
              ? 'ENTRY WINDOW CLOSED'
              : config.status !== 'open'
                ? 'ENTRY WINDOW CLOSED'
                : `BUY ENTRY · ${formatMattRaw(config.feeRaw)}`;

  const startButton = $('#start-arena-run-button');
  const canStart =
    Boolean(serverPlayer) &&
    !serverPlayer.suspended &&
    config.enabled &&
    runWindowOpen &&
    config.status === 'open' &&
    player.unusedAttempts > 0;
  startButton.disabled = arenaBusy || !canStart;
  startButton.textContent = !serverPlayer
    ? 'CONNECT RONIN TO PLAY'
    : serverPlayer.suspended
      ? 'WALLET SUSPENDED'
      : !config.enabled
        ? 'ARENA SECURITY LOCKED'
        : !runWindowOpen
          ? 'COMPETITION CLOSED'
          : player.unusedAttempts > 0
            ? `START ARENA RUN · ${player.unusedAttempts} READY`
            : 'BUY AN ENTRY FIRST';

  const rows = leaderboard.rows;
  $('#arena-leaderboard-body').innerHTML = rows.length
    ? rows.map((row) => `
        <tr class="${row.isPlayer ? 'player-row' : ''}">
          <td>#${row.rank}</td>
          <td>${abbreviateAddress(row.address || row.walletId)}${row.isPlayer ? ' · YOU' : ''}</td>
          <td>${formatNumber(row.score)}</td>
          <td>${formatNumber(row.entries)}</td>
          <td>${formatMattRaw(row.payoutRaw || row.projectedRaw)}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="5">No verified Arena scores yet today.</td></tr>';

  $('#arena-settlement-status').textContent = canceled
    ? 'Competition canceled'
    : settled
      ? 'Pool distributed'
      : awaitingSafeSettlement
        ? 'Awaiting Safe settlement'
        : awaitingSettlement
          ? 'Awaiting reviewed settlement'
          : 'Competition open';
  $('#arena-settlement-note').textContent = canceled
    ? 'Every paid entry is refundable. Treasury seed returns only under the contract cancellation rules.'
    : settled
      ? `The full ${formatMattRaw(config.prizePoolRaw)} pool was assigned by the verified settlement.`
      : awaitingSafeSettlement
        ? 'The reviewed rankings are frozen. The pool remains in the Arena contract until two Treasury Safe signers approve and execute the exact settlement.'
        : awaitingSettlement
          ? 'Entries are closed. Rankings remain provisional until anti-cheat review is complete and the Treasury Safe approves the immutable settlement.'
          : 'The Treasury Safe settles the verified daily result and the contract distributes the complete pool.';
  const refundButton = $('#arena-refund-button');
  refundButton.hidden = !player.refundable;
  refundButton.disabled = arenaBusy || !player.refundable;
  refundButton.textContent = player.refundRaw
    ? `CLAIM ${formatMattRaw(player.refundRaw)} REFUND`
    : 'CLAIM CANCELED ENTRY REFUND';
  $('#arena-note').textContent = !config.enabled
    ? config.liveBlocker === 'input_replay_not_ready'
      ? 'Daily Arena preview is ready, but paid entry is security-locked until the server can replay raw player inputs. No MATT can be accepted by this build.'
      : 'Daily Arena is safely disabled until its isolated Ronin contract is deployed, verified, and configured.'
    : `Unlimited entries · ${formatNumber(config.entryCount || leaderboard.entryCount)} total entries · ${formatNumber(config.uniquePlayers || leaderboard.participantCount)} unique miners · Best verified score per wallet.`;

  clearInterval(arenaCountdownTimer);
  updateArenaCountdown();
  if ($('#daily-arena').classList.contains('active') && config.snapshotAt > Date.now()) {
    arenaCountdownTimer = setInterval(updateArenaCountdown, 1_000);
  }
}

function updateArenaCountdown() {
  const countdown = arenaTimeRemaining(arenaConfig.snapshotAt);
  const element = $('#arena-countdown');
  if (element) element.textContent = countdown.complete ? 'CLOSED' : countdown.label;
}

async function purchaseArenaEntry() {
  if (arenaBusy) return;
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  if (
    !arenaConfig.enabled ||
    arenaConfig.status !== 'open' ||
    arenaConfig.entriesPaused ||
    (arenaConfig.entryCutoffAt && Date.now() > arenaConfig.entryCutoffAt)
  ) {
    toast('Daily Arena entries are not open.');
    return;
  }
  const approved = window.confirm(
    `Enter today's MATT Arena for ${formatMattRaw(arenaConfig.feeRaw)}? Every accepted MATT enters the player prize pool. Ronin Wallet may request an approval transaction followed by the Arena entry transaction.`
  );
  if (!approved) return;
  arenaBusy = true;
  renderArena();
  try {
    const quote = await apiClient.arenaEntryQuote(arenaConfig.day);
    const transactions = quote.transactions || quote.transaction;
    const transactionHashes = await wallet.purchaseArenaEntry(transactions);
    const entryTransactionHash = transactionHashes.at(-1);
    toast('Arena entry mined · server confirming');
    const confirmation = await apiClient.confirmArenaEntry(entryTransactionHash);
    arenaPlayer = normalizeArenaPlayer({
      ...arenaPlayer,
      entries: arenaPlayer.entries + (confirmation.alreadyConfirmed ? 0 : 1),
      unusedAttempts: confirmation.unusedAttempts
    });
    toast(`Arena attempt ready · ${abbreviateHash(entryTransactionHash)}`);
    await refreshArena(true);
  } catch (error) {
    toast(error.message || 'Arena entry failed.');
  } finally {
    arenaBusy = false;
    renderArena();
  }
}

async function startArenaRun() {
  if (
    arenaBusy ||
    !serverPlayer ||
    serverPlayer.suspended ||
    !arenaConfig.enabled ||
    arenaConfig.status !== 'open' ||
    (arenaConfig.snapshotAt && Date.now() >= arenaConfig.snapshotAt) ||
    arenaPlayer.unusedAttempts <= 0
  ) {
    return;
  }
  arenaBusy = true;
  renderArena();
  try {
    const run = await apiClient.startArenaRun();
    activeArenaRun = run;
    activeArenaTranscript = new ArenaTranscript(apiClient, run);
    arenaPlayer = normalizeArenaPlayer({
      ...arenaPlayer,
      unusedAttempts: Math.max(0, arenaPlayer.unusedAttempts - 1)
    });
    game.startRun({
      mode: 'arena',
      seed: run.dailySeed || run.seed,
      day: run.day,
      rewardWeight: 0
    });
  } catch (error) {
    activeArenaRun = null;
    activeArenaTranscript = null;
    toast(error.message || 'Arena run could not start.');
    await refreshArena(true);
  } finally {
    arenaBusy = false;
  }
}

async function claimArenaRefund() {
  if (arenaBusy || !arenaPlayer.refundable) return;
  arenaBusy = true;
  renderArena();
  try {
    const prepared = await apiClient.prepareArenaRefund(arenaConfig.day);
    const transactionHash = await wallet.claimArenaRefund(prepared.transaction);
    toast(`Arena refund claimed · ${abbreviateHash(transactionHash)}`);
    await refreshArena(true);
  } catch (error) {
    toast(error.message || 'Arena refund failed.');
  } finally {
    arenaBusy = false;
    renderArena();
  }
}

function openPass() {
  const state = economy.state;
  if (serverConfig?.realPaymentsEnabled === true) {
    const active = paymentStatus?.pass?.active === true;
    const days = paymentStatus
      ? Math.max(0, Math.ceil((paymentStatus.pass.expiresAt - Date.now()) / 86_400_000))
      : 0;
    const passPrice = paymentStatus ? weiToRon(paymentStatus.pass.priceRonWei) : null;
    const runPrice = paymentStatus ? weiToRon(paymentStatus.paidRuns.priceRonWei) : null;
    $('#pass-state-label').textContent = active ? `PASS ACTIVE · ${days} DAYS LEFT` : 'FREE TIER ACTIVE';
    $('#buy-pass-button').disabled = paymentBusy || paymentStatus?.pass?.paused === true;
    $('#buy-pass-button').textContent = paymentBusy
      ? 'WAITING FOR RONIN WALLET...'
      : !paymentStatus
        ? 'CONNECT RONIN TO LOAD LIVE PRICE'
      : active
        ? `EXTEND 30 DAYS · ${trimNumber(passPrice)} RON`
        : `ACTIVATE LIVE PASS · ${trimNumber(passPrice)} RON`;
    $('#buy-paid-run-button').disabled =
      paymentBusy ||
      !active ||
      !paymentStatus ||
      paymentStatus.paidRuns.paused;
    $('#buy-paid-run-button').textContent = paymentBusy
      ? 'TRANSACTION PENDING...'
      : active
        ? `BUY LIVE RUN · ${trimNumber(runPrice)} RON`
        : 'PASS REQUIRED';
    const passNote = $('#pass-purchase-note');
    if (passNote) {
      passNote.textContent = 'This sends real RON on Ronin Mainnet only after you approve it in Ronin Wallet.';
    }
    if (active && serverPlayer) void syncLivePassRewards();
    updateMenu();
    showScreen('mine-pass');
    return;
  }
  const active = passIsActive(state);
  $('#pass-state-label').textContent = active ? `PASS ACTIVE · ${passDaysRemaining(state)} DAYS LEFT` : 'FREE TIER ACTIVE';
  $('#buy-pass-button').textContent = active ? `EXTEND 30 DAYS · ${trimNumber(state.settings.passPriceRon)} RON` : `ACTIVATE TEST PASS · ${trimNumber(state.settings.passPriceRon)} RON`;
  $('#buy-paid-run-button').disabled = !active || state.settings.paidRunsPaused;
  $('#buy-paid-run-button').textContent = active ? `BUY TEST RUN · ${trimNumber(state.settings.paidRunPriceRon)} RON` : 'PASS REQUIRED';
  const passNote = $('#pass-purchase-note');
  if (passNote) passNote.textContent = 'Local test mode models the Pass without sending a real transaction.';
  updateMenu();
  showScreen('mine-pass');
}

function renderPassProgress() {
  const state = economy.state;
  const liveProgress = serverConfig?.realPaymentsEnabled === true
    ? paymentStatus?.passProgress || serverPlayer?.passProgress
    : null;
  const xp = liveProgress?.xp ?? state.player.passXp;
  const level = liveProgress || passLevel(xp);
  const passActive = serverConfig?.realPaymentsEnabled === true
    ? paymentStatus?.pass?.active === true
    : passIsActive(state);
  $('#pass-level').textContent = String(level.level);
  $('#pass-xp-text').textContent = `${formatNumber(xp)} XP`;
  $('#pass-xp-fill').style.width = `${Math.round(level.progress * 100)}%`;
  const inventory = paymentStatus?.passInventory || serverPlayer?.passInventory;
  const claimedLevels = inventory?.claimedLevels || [];
  $('#pass-track').innerHTML = PASS_REWARD_LEVELS.map((reward) => {
    const owned = claimedLevels.includes(reward.level);
    const earned = reward.level <= level.level;
    const suffix = owned ? ' · OWNED' : earned && passActive ? ' · READY' : '';
    return `
    <div class="pass-node ${owned ? 'unlocked owned' : earned && passActive ? 'ready' : ''}">
      <span>${reward.level}</span><small>${reward.name}${suffix}</small>
    </div>
  `;
  }).join('');
  const manageButton = $('#manage-cosmetics-button');
  if (manageButton) {
    manageButton.disabled = !serverPlayer && !isLocalPreview;
    manageButton.textContent = serverPlayer || isLocalPreview
      ? 'MANAGE COSMETICS & REWARDS'
      : 'CONNECT RONIN TO MANAGE REWARDS';
  }
}

async function syncLivePassRewards() {
  if (passRewardsBusy || !serverPlayer || paymentStatus?.pass?.active !== true) return;
  passRewardsBusy = true;
  try {
    const result = await apiClient.syncPassRewards();
    if (serverPlayer) serverPlayer.passProgress = result.passProgress;
    if (paymentStatus) paymentStatus.passProgress = result.passProgress;
    applyPassInventory(result.passInventory);
    if (result.rewards?.length) {
      toast(`Pass reward unlocked · ${result.rewards.map((reward) => reward.name).join(', ')}`);
    }
    renderPassProgress();
  } catch (error) {
    if (error?.code !== 'pass_inactive') console.warn('[MATT Mine] Pass reward sync failed.', error);
  } finally {
    passRewardsBusy = false;
  }
}

async function openCosmetics() {
  showScreen('pass-cosmetics');
  renderCosmetics();
  if (!serverPlayer) return;
  const note = $('#cosmetics-note');
  if (note) note.textContent = 'Loading your permanent server-owned collection…';
  try {
    const result = await apiClient.syncPassRewards();
    if (serverPlayer) serverPlayer.passProgress = result.passProgress;
    applyPassInventory(result.passInventory);
    renderCosmetics();
  } catch (error) {
    if (error?.code === 'pass_not_owned') {
      const result = await apiClient.passRewards().catch(() => null);
      if (result) {
        applyPassInventory(result.passInventory);
        renderCosmetics();
      }
      if (note) note.textContent = 'Activate the MATT Mine Pass to begin unlocking permanent rewards.';
    } else if (note) {
      note.textContent = `Collection unavailable: ${error.message}`;
    }
  }
}

function renderCosmetics() {
  const inventory = paymentStatus?.passInventory || serverPlayer?.passInventory;
  const equipped = inventory?.equipped || {};
  const cosmetics = inventory?.cosmetics || [];
  const previewItems = ['skin', 'trail', 'weapon', 'aura', 'frame', 'badge', 'title', 'trophy']
    .map((slot) => cosmeticById(equipped[slot]))
    .filter(Boolean);
  $('#cosmetic-preview').innerHTML = `
    <div class="cosmetic-preview-miner ${equipped.frame === 'founder_frame' ? 'founder-frame' : ''} ${equipped.skin === 'crystal_skin' ? 'crystal-skin' : ''}">
      <span class="preview-aura ${equipped.aura === 'guardian_aura' ? 'active' : ''}"></span>
      <b>M</b>
      ${equipped.trail === 'gold_trail' ? '<i class="preview-trail">✦ ✦ ✦</i>' : ''}
    </div>
    <div>
      <span class="eyebrow">CURRENT LOADOUT</span>
      <h3>${previewItems.length ? previewItems.map((item) => item.name).join(' · ') : 'Standard Miner'}</h3>
      <p>${equipped.title === 'ore_reactor_title' ? '⚡ ORE REACTOR · ' : ''}${equipped.badge === 'starter_badge' ? 'MATT PASS HOLDER · ' : ''}${equipped.trophy === 'season_trophy' ? '★ SEASON ONE COMPLETE' : 'Equip unlocked rewards below.'}</p>
    </div>
  `;

  const chest = inventory?.chests?.[PASS_CHEST_ID] || { available: 0, opened: 0 };
  $('#pass-chest-card').innerHTML = `
    <div>
      <span class="eyebrow">LEVEL 3 REWARD</span>
      <h3>Pass Chest</h3>
      <p>Contains the exclusive Molten Pickaxe and ${formatNumber(PASS_CHEST_BONUS_NUGGETS)} permanent nuggets.</p>
    </div>
    <div class="pass-chest-actions">
      <strong>${chest.available || 0} UNOPENED</strong>
      <button id="open-pass-chest-button" class="primary-button" ${!serverPlayer || !chest.available || passRewardsBusy ? 'disabled' : ''}>${chest.available ? 'OPEN CHEST' : chest.opened ? 'OPENED' : 'LOCKED'}</button>
    </div>
  `;

  $('#cosmetics-grid').innerHTML = Object.values(PASS_COSMETICS).map((cosmetic) => {
    const owned = cosmetics.includes(cosmetic.id);
    const isEquipped = equipped[cosmetic.slot] === cosmetic.id;
    return `
      <article class="cosmetic-card ${owned ? 'owned' : 'locked'} ${isEquipped ? 'equipped' : ''}">
        <span class="cosmetic-icon">${renderCosmeticIcon(cosmetic)}</span>
        <div><small>${cosmetic.slot.toUpperCase()}</small><h3>${cosmetic.name}</h3><p>${cosmetic.description}</p></div>
        <button class="secondary-button cosmetic-equip-button" data-slot="${cosmetic.slot}" data-cosmetic-id="${cosmetic.id}" ${!owned || passRewardsBusy ? 'disabled' : ''}>
          ${isEquipped ? 'UNEQUIP' : owned ? 'EQUIP' : 'LOCKED'}
        </button>
      </article>
    `;
  }).join('');

  const note = $('#cosmetics-note');
  if (note) {
    note.textContent = serverPlayer
      ? `${cosmetics.length} of ${Object.keys(PASS_COSMETICS).length} cosmetics owned · unlocks are permanent and server verified.`
      : 'Connect Ronin Wallet to load your permanent collection.';
  }

  $('#open-pass-chest-button')?.addEventListener('click', () => void openPassChest());
  for (const button of document.querySelectorAll('.cosmetic-equip-button')) {
    button.addEventListener('click', () => void toggleCosmetic(button.dataset.slot, button.dataset.cosmeticId));
  }
}

async function toggleCosmetic(slot, cosmeticId) {
  if (passRewardsBusy || !serverPlayer) return;
  const equipped = serverPlayer.passInventory?.equipped?.[slot] === cosmeticId;
  passRewardsBusy = true;
  renderCosmetics();
  try {
    const result = await apiClient.equipPassCosmetic(slot, equipped ? '' : cosmeticId);
    applyPassInventory(result.passInventory);
    toast(`${cosmeticById(cosmeticId)?.name || 'Cosmetic'} ${equipped ? 'unequipped' : 'equipped'}`);
  } catch (error) {
    toast(error.message);
  } finally {
    passRewardsBusy = false;
    renderCosmetics();
  }
}

async function openPassChest() {
  if (passRewardsBusy || !serverPlayer) return;
  passRewardsBusy = true;
  renderCosmetics();
  try {
    const result = await apiClient.openPassChest(PASS_CHEST_ID);
    profile = result.profile;
    saveProfile(profile);
    game.setProfile(profile);
    applyPassInventory(result.passInventory);
    toast(`Pass Chest opened · Molten Pickaxe + ${formatNumber(result.rewards.nuggets)} nuggets`);
    updateMenu();
  } catch (error) {
    toast(error.message);
  } finally {
    passRewardsBusy = false;
    renderCosmetics();
  }
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
    : isLocalPreview
      ? 'Local reward preview has not been published.'
      : 'Connect Ronin Wallet to check live MATT rewards.';
  const localClaimAvailable = isLocalPreview && published && !published.claimedAt && !economy.state.settings.claimsPaused;
  $('#claim-reward-button').disabled = !localClaimAvailable;
  $('#claim-reward-button').textContent = published?.claimedAt
    ? 'CLAIMED'
    : economy.state.settings.claimsPaused
      ? 'CLAIMS PAUSED'
      : isLocalPreview
        ? 'LOCAL CLAIM PREVIEW'
        : 'CONNECT WALLET TO CLAIM';
  $('#leaderboard-body').innerHTML = rows.map((row) => `
    <tr class="${row.isPlayer ? 'player-row' : ''}">
      <td>#${row.rank}</td>
      <td>${renderMinerIdentity(row)}${row.isPlayer ? ' · YOU' : ''}</td>
      <td>${formatNumber(row.score)}</td>
      <td>${row.isPreview ? 'PREVIEW' : row.score > 0 ? 'VERIFIED LOCAL' : 'NO SCORE'}</td>
    </tr>
  `).join('');
  showScreen('leaderboards');
  if (serverPlayer && (mode === RUN_MODES.FREE || serverConfig?.paidRunsEnabled === true)) {
    void renderServerLeaderboard(mode);
  }
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
            <td>${renderMinerIdentity(row)}${row.isPlayer ? ' · YOU' : ''}</td>
            <td>${formatNumber(row.score)}</td>
            <td>SERVER VERIFIED</td>
          </tr>
        `).join('')
      : `<tr><td colspan="4">No verified ${mode === RUN_MODES.PAID ? 'Pass' : 'Free'} scores yet this week.</td></tr>`;
    const claims = await apiClient.rewardClaims();
    activeServerClaim = claims.find((claim) => claim.mode === mode) || null;
    renderServerClaim(activeServerClaim);
    if (note) {
      note.textContent = leaderboard.finalized
        ? `Permanent server snapshot · Week ${leaderboard.week}`
        : `Server-authoritative daily-best rankings · Week ${leaderboard.week}`;
    }
  } catch (error) {
    activeServerClaim = null;
    renderServerClaim(null);
    if (note) note.textContent = `Server leaderboard unavailable: ${error.message}`;
  }
}

function renderMinerIdentity(row) {
  const appearance = row.appearance || {};
  const title = cosmeticById(appearance.title);
  const badge = cosmeticById(appearance.badge);
  const trophy = cosmeticById(appearance.trophy);
  return `
    <span class="miner-identity ${appearance.frame === 'founder_frame' ? 'founder-frame' : ''}">
      ${badge ? `<i class="miner-badge" title="${escapeHtml(badge.name)}">${renderCosmeticIcon(badge)}</i>` : ''}
      <b>${escapeHtml(row.walletId)}</b>
      ${title ? `<small>${escapeHtml(title.name)}</small>` : ''}
      ${trophy ? `<em title="${escapeHtml(trophy.name)}">${trophy.icon}</em>` : ''}
    </span>
  `;
}

function renderRunCosmeticResult() {
  const equipped = serverPlayer?.passInventory?.equipped || {};
  const title = cosmeticById(equipped.title);
  const badge = cosmeticById(equipped.badge);
  const trophy = cosmeticById(equipped.trophy);
  if (!title && !badge && !trophy && equipped.frame !== 'founder_frame') return '';
  return `
    <span class="miner-identity result-identity ${equipped.frame === 'founder_frame' ? 'founder-frame' : ''}">
      ${badge ? `<i class="miner-badge" title="${escapeHtml(badge.name)}">${renderCosmeticIcon(badge)}</i>` : ''}
      <b>${serverPlayer ? escapeHtml(abbreviateAddress(serverPlayer.address)) : 'MATT MINER'}</b>
      ${title ? `<small>${escapeHtml(title.name)}</small>` : ''}
      ${trophy ? `<em>${trophy.icon}</em>` : ''}
    </span>
  `;
}

function renderCosmeticIcon(cosmetic) {
  if (cosmetic?.image) {
    return `<img class="cosmetic-logo" src="${escapeHtml(cosmetic.image)}" alt="" aria-hidden="true" />`;
  }
  return escapeHtml(cosmetic?.icon || '');
}

function renderServerClaim(claim) {
  const button = $('#claim-reward-button');
  if (!claim) {
    $('#published-reward-text').textContent = 'No reward ready';
    $('#published-reward-status').textContent = 'Finalized MATT rewards will appear here.';
    button.disabled = true;
    button.textContent = 'CLAIM MATT';
    return;
  }
  const claimed = claim.chain?.claimed === true;
  const published = claim.chain?.published === true;
  const paused = claim.chain?.paused === true;
  $('#published-reward-text').textContent = `${formatNumber(claim.amountMatt)} MATT · Rank #${claim.rank}`;
  $('#published-reward-status').textContent = claimed
    ? 'Claim confirmed on Ronin Mainnet.'
    : paused
      ? 'Reward claims are temporarily paused.'
      : published
        ? `Published for week ${claim.week} · Claim before ${new Date(claim.claimDeadline * 1000).toLocaleDateString('en-US')}.`
        : 'Reward allocation approved; waiting for Safe publication.';
  button.disabled = claimed || paused || !published || claim.chain?.unavailable === true;
  button.textContent = claimed
    ? 'CLAIMED'
    : paused
      ? 'CLAIMS PAUSED'
      : published
        ? 'CLAIM MATT'
        : 'PUBLICATION PENDING';
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
    const cost = metaUpgradeCost(upgrade, rank);
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
  if (mode === 'arena') return 'MATT DAILY ARENA';
  return 'PRACTICE · NO REWARD';
}

function renderAudioSettings() {
  const settings = game.audio.settings();
  const musicPercent = Math.round(settings.musicVolume * 100);
  const effectsPercent = Math.round(settings.effectsVolume * 100);
  $('#sound-mute-button').textContent = settings.muted ? 'UNMUTE ALL' : 'MUTE ALL';
  $('#sound-mute-button').classList.toggle('active', settings.muted);
  $('#music-volume').value = musicPercent;
  $('#effects-volume').value = effectsPercent;
  $('#music-volume-value').textContent = `${musicPercent}%`;
  $('#effects-volume-value').textContent = `${effectsPercent}%`;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function trimNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function weiToRon(value) {
  return Number(BigInt(value || '0')) / 1e18;
}

function weiToToken(value) {
  return Number(BigInt(value || '0')) / 1e18;
}

function abbreviateHash(value) {
  return typeof value === 'string' && value.length >= 14
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : String(value || '');
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
    publicPaymentStatus = await apiClient.publicPaymentStatus();
    const restored = await wallet.restore();
    if (restored) {
      serverPlayer = restored;
      profile = restored.profile;
      saveProfile(profile);
      game.setProfile(profile);
      await refreshPaymentStatus(true);
    }
    await refreshArena(true);
  } catch (error) {
    console.warn('[MATT Mine] Server bootstrap unavailable.', error);
  }
  const adminButton = $('#admin-button');
  adminButton.hidden = !isLocalPreview;
  adminButton.parentElement?.classList.toggle('public-menu', !isLocalPreview);
  updateMenu();
}

updateMenu();
showScreen('launch');
void bootstrapServer();
