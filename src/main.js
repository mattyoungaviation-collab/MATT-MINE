import { MattMineGame } from './game/GameV4.js';
import { apiClient } from './game/apiClient.js';
import { META_UPGRADES, metaUpgradeCost } from './game/config.js';
import { prepareProfileImage } from './game/profileImage.js';
import { mountDailyMinePreviews } from './game/dailyMapPreview.js';
import { KEYBIND_ACTIONS, defaultKeybindings, normalizeKeybindings } from './game/keybindings.js';
import { CONTROLLER_ACTIONS, defaultControllerProfile, normalizeControllerProfile } from './game/expansionConfig.js';
import { BetaDeveloperTools, defaultBetaConfiguration } from './game/betaTools.js';
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
  formatArenaRoundTime,
  formatMattRaw,
  normalizeArenaConfig,
  normalizeArenaLeaderboard,
  normalizeArenaPlayer
} from './game/arena.js';
import {
  ArenaTranscript,
  isRetryableAppendError,
  retryRunFinalization
} from './game/arenaTranscript.js';
import { COMPETITION_DEPTH_COUNT } from './game/competitionStudio.js';
import { mountMineHub } from './game/mineHub.js';
import { showMineLoadingScreen } from './game/mineLoadingScreen.js';
import { loadProfile, saveProfile } from './game/storage.js';
import { loadGameplayPreferences, saveGameplayPreferences } from './game/preferences.js';
import { RoninWalletAdapter } from './game/walletAdapter.js';
import { mobileLandscapeRequired, touchInputDetected } from './game/mobile.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const canvas = $('#game');
const screens = [...document.querySelectorAll('.screen')];
const hud = $('#hud');
const mobileControls = $('#mobile-controls');
const mobileOrientationGate = $('#mobile-orientation-gate');
const mobileOrientationTitle = $('#mobile-orientation-title');
const mobileOrientationCopy = $('#mobile-orientation-copy');
const mobileOrientationCancel = $('#mobile-orientation-cancel');
const isLocalPreview = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
const economy = new LocalEconomyStore();
const PRACTICE_CLAIM_PLACEHOLDER_PRICE = 5000;
const CONTROLLER_ACTION_LABELS = Object.freeze({
  attack: 'Attack', dash: 'Dash', pickaxe: 'Pickaxe', dynamite: 'Dynamite',
  blaster: 'Blaster', interact: 'Interact', pause: 'Pause', confirm: 'Confirm',
  cancel: 'Back', menuUp: 'Menu Up', menuDown: 'Menu Down',
  menuLeft: 'Menu Left', menuRight: 'Menu Right'
});
const CONTROLLER_BUTTON_LABELS = Object.freeze([
  'A / Cross', 'B / Circle', 'X / Square', 'Y / Triangle',
  'LB / L1', 'RB / R1', 'LT / L2', 'RT / R2', 'View / Share',
  'Menu / Options', 'Left Stick', 'Right Stick', 'D-pad Up',
  'D-pad Down', 'D-pad Left', 'D-pad Right', 'Home', 'Touchpad'
]);
let profile = loadProfile();
let gameplayPreferences = loadGameplayPreferences();
let toastTimer;
let activeBoard = RUN_MODES.FREE;
let serverConfig = null;
let serverPlayer = null;
let pendingKeybindings = defaultKeybindings();
let activeServerRun = null;
let pendingRunFinalization = null;
let runFinalizationBusy = false;
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
let activePracticeClaim = null;
let resultScreenMode = null;
let activeBetaTools = null;
let paidRevivePending = false;
let paidReviveBusy = false;
let paidReviveContext = null;
let pendingAvatarDataUrl = '';
let abandonConfirmUntil = 0;
let abandonResetTimer = null;
let touchInputActive = touchInputDetected(globalThis);
let pendingLandscapeAction = null;
let dailyMinePreviewCleanup = null;
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
  arenaRoundTimer: $('#arena-round-timer'),
  arenaRoundTime: $('#arena-round-time'),
  weaponSlots: [...document.querySelectorAll('.weapon-slot')],
  weaponButtons: [...document.querySelectorAll('.weapon-button')],
  attackButton: $('#attack-button')
};

function showScreen(id = null) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === id);
  document.body.classList.toggle('launch-active', id === 'launch');
}

function applyTouchInputMode(active = touchInputActive) {
  touchInputActive = Boolean(active);
  document.documentElement.classList.toggle('touch-input', touchInputActive);
  app.classList.toggle('touch-input', touchInputActive);
  mobileControls.setAttribute(
    'aria-hidden',
    String(!(touchInputActive && hud.classList.contains('active')))
  );
}

function needsMobileLandscape() {
  return mobileLandscapeRequired(globalThis, touchInputActive);
}

function queueUntilMobileLandscape(action) {
  if (!needsMobileLandscape()) return false;
  pendingLandscapeAction = action;
  syncMobileOrientationGate();
  return true;
}

function syncMobileOrientationGate() {
  const portrait = needsMobileLandscape();
  const gameplayActive = app.classList.contains('gameplay-active');
  if (pendingLandscapeAction && !portrait) {
    const action = pendingLandscapeAction;
    pendingLandscapeAction = null;
    mobileOrientationGate.hidden = true;
    requestAnimationFrame(() => void action());
    return;
  }
  if (!portrait || (!pendingLandscapeAction && !gameplayActive)) {
    mobileOrientationGate.hidden = true;
    return;
  }
  const waitingToStart = Boolean(pendingLandscapeAction);
  mobileOrientationTitle.textContent = waitingToStart
    ? 'Rotate to start your run'
    : 'Rotate back to keep playing';
  mobileOrientationCopy.textContent = waitingToStart
    ? 'Turn your phone sideways. Your run has not started and no entry has been used.'
    : 'Turn your phone sideways again. Timed Arena play continues while the phone is vertical.';
  mobileOrientationCancel.hidden = !waitingToStart;
  mobileOrientationGate.hidden = false;
}

function setGameplayUi(active) {
  hud.classList.toggle('active', active);
  mobileControls.classList.toggle('active', active);
  app.classList.toggle('gameplay-active', active);
  mobileControls.setAttribute('aria-hidden', String(!(active && touchInputActive)));
  syncMobileOrientationGate();
  if (!active) {
    if ($('#beta-tools')) $('#beta-tools').hidden = true;
    if ($('#controller-pause-overlay')) $('#controller-pause-overlay').hidden = true;
  }
}

applyTouchInputMode();
globalThis.matchMedia?.('(pointer: coarse)')?.addEventListener?.('change', () => {
  applyTouchInputMode(touchInputDetected(globalThis));
  syncMobileOrientationGate();
});
window.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' && !touchInputActive) applyTouchInputMode(true);
}, { passive: true });
window.addEventListener('resize', syncMobileOrientationGate);
window.visualViewport?.addEventListener?.('resize', syncMobileOrientationGate);
globalThis.screen?.orientation?.addEventListener?.('change', syncMobileOrientationGate);
mobileOrientationCancel.addEventListener('click', () => {
  pendingLandscapeAction = null;
  mobileOrientationGate.hidden = true;
});

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
  $('#wallet-label').textContent = connected
    ? serverPlayer.identity?.name || abbreviateAddress(serverPlayer.address)
    : walletBusy ? 'CONNECTING…' : 'CONNECT RONIN';
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
  $('#pass-days').textContent = passActive ? `${remainingPassDays} days remaining` : 'Pass needed';
  $('#paid-credit-count').textContent = String(paidCredits);
  $('#paid-daily-status').textContent = `${paidRunsToday} / ${livePayments ? paymentStatus?.paidRuns?.dailyLimit || 10 : state.settings.maxPaidRunsPerDay} bought today`;
  $('#paid-run-cta').textContent = paidAccess.allowed
    ? 'START PASS RUN'
    : passActive
      ? paidCredits > 0 ? paidAccess.reason.toUpperCase() : 'BUY RUN CREDIT'
      : 'GET MINE PASS';
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
  updateLaunch({
    connected,
    freeAccess,
    passPrice,
    paidRunPrice,
    livePayments,
    passActive
  });
  renderArenaMenuStatus();
  $('#weekly-run-button').hidden = serverPlayer?.expansion?.settings?.weeklyCompetitionEnabled !== true;
  $('#endless-run-button').hidden = serverPlayer?.expansion?.settings?.endlessEnabled !== true;
  $('#beta-run-button').hidden = serverPlayer?.expansion?.betaAvailable !== true;
  renderPassProgress();
  renderGameplayPreferences();
}

function updateLaunch({ connected, freeAccess, passPrice, paidRunPrice, livePayments, passActive }) {
  const walletLabel = $('#launch-wallet-label');
  const walletButton = $('#launch-wallet-button');
  const freeStatus = $('#launch-free-status');
  const serverStatus = $('#launch-live-status');
  const date = $('#launch-date');
  const menuDate = $('#menu-date');
  const passPriceText = passPrice === null ? '—' : trimNumber(passPrice);
  const runPriceText = paidRunPrice === null ? '—' : trimNumber(paidRunPrice);

  if (date) {
    const todayLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric'
    }).format(new Date()).toUpperCase();
    date.textContent = todayLabel;
    if (menuDate) menuDate.textContent = todayLabel;
  }
  if (walletLabel) walletLabel.textContent = connected
    ? serverPlayer.identity?.name || abbreviateAddress(serverPlayer.address)
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

function openMinerProfile(forceSetup = false) {
  if (!serverPlayer) {
    void connectWallet().then((connected) => {
      if (connected) openMinerProfile(false);
    });
    return;
  }
  pendingAvatarDataUrl = '';
  const identity = serverPlayer.identity || { requiresSetup: true };
  const requiresSetup = forceSetup || identity.requiresSetup || !identity.name;
  const panel = $('.miner-profile-panel');
  panel?.classList.toggle('setup-required', requiresSetup);
  $('#profile-title').textContent = requiresSetup ? 'Create Your Miner' : 'Your Miner Profile';
  $('#profile-intro').textContent = requiresSetup
    ? 'Choose carefully. Your miner name is unique and permanently tied to this wallet.'
    : 'Your miner name is permanent. You can upload a new leaderboard picture whenever you want.';
  $('#profile-name').value = identity.name || '';
  $('#profile-name').readOnly = !requiresSetup;
  $('#profile-name-note').textContent = requiresSetup
    ? 'Names ignore capitalization when checking duplicates and cannot be changed after saving.'
    : `Permanently linked to ${abbreviateAddress(serverPlayer.address)}.`;
  $('#save-profile-button').hidden = !requiresSetup;
  $('#update-avatar-button').hidden = true;
  $('#profile-status').textContent = requiresSetup
    ? 'Finish this one-time setup before entering ranked games.'
    : 'Your name and picture appear on every MATT Mine leaderboard.';
  renderProfileAvatar(identity.avatarUrl || '');
  pendingKeybindings = { ...(serverPlayer.keybindings || defaultKeybindings()) };
  renderKeybindings();
  loadControllerSettings();
  renderCharacters();
  showScreen('miner-profile');
  if (requiresSetup) $('#profile-name').focus();
}

function renderProfileAvatar(dataUrl = '') {
  const preview = $('#profile-avatar-preview');
  const fallback = $('#profile-avatar-fallback');
  preview.hidden = !dataUrl;
  fallback.hidden = Boolean(dataUrl);
  if (dataUrl) preview.src = dataUrl;
  else preview.removeAttribute('src');
  fallback.textContent = (serverPlayer?.identity?.name || $('#profile-name').value || 'M').slice(0, 1).toUpperCase();
}

async function saveMinerIdentity() {
  if (!serverPlayer || !serverPlayer.identity?.requiresSetup || walletBusy) return;
  walletBusy = true;
  const button = $('#save-profile-button');
  button.disabled = true;
  button.textContent = 'SAVING PERMANENT NAME…';
  try {
    const result = await apiClient.setIdentity($('#profile-name').value, pendingAvatarDataUrl);
    serverPlayer.identity = result.identity;
    if (wallet.player) wallet.player.identity = result.identity;
    pendingAvatarDataUrl = '';
    updateMenu();
    showScreen('menu');
    toast(`Welcome to the mine, ${result.identity.name}.`);
  } catch (error) {
    $('#profile-status').textContent = error.message;
    toast(error.message);
  } finally {
    walletBusy = false;
    button.disabled = false;
    button.textContent = 'LOCK IN MINER NAME';
  }
}

async function updateMinerAvatar() {
  if (!serverPlayer?.identity?.name || !pendingAvatarDataUrl || walletBusy) return;
  walletBusy = true;
  const button = $('#update-avatar-button');
  button.disabled = true;
  button.textContent = 'UPLOADING…';
  try {
    const result = await apiClient.updateAvatar(pendingAvatarDataUrl);
    serverPlayer.identity = result.identity;
    if (wallet.player) wallet.player.identity = result.identity;
    pendingAvatarDataUrl = '';
    renderProfileAvatar(result.identity.avatarUrl);
    button.hidden = true;
    $('#profile-status').textContent = 'Profile picture updated across the server leaderboards.';
    toast('Profile picture updated');
  } catch (error) {
    $('#profile-status').textContent = error.message;
    toast(error.message);
  } finally {
    walletBusy = false;
    button.disabled = false;
    button.textContent = 'UPDATE PROFILE PICTURE';
  }
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
    game.input.setKeybindings(serverPlayer.keybindings || defaultKeybindings());
    if (serverPlayer.expansion?.controller) game.input.setControllerProfile(serverPlayer.expansion.controller);
    await refreshPaymentStatus(true);
    if (serverPlayer.identity?.requiresSetup) {
      openMinerProfile(true);
      toast('Choose your permanent miner name to finish signing in.');
      return false;
    }
    toast(`Signed in · ${serverPlayer.identity?.name || abbreviateAddress(serverPlayer.address)}`);
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
    game.input.setKeybindings(serverPlayer.keybindings || defaultKeybindings());
    if (serverPlayer.expansion?.controller) game.input.setControllerProfile(serverPlayer.expansion.controller);
    await refreshPaymentStatus(true);
    await refreshArena(true);
    updateMenu();
    if (serverPlayer.identity?.requiresSetup) openMinerProfile(true);
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
  if (runFinalizationBusy) return;
  runFinalizationBusy = true;
  showFinalizationBusy('SERVER VERIFYING');
  const transcript = activeArenaTranscript;
  activePracticeClaim = null;
  clearPracticeClaimPanel();
  $('#economy-result').innerHTML = '<strong>SERVER VERIFYING</strong><span>Checking entitlement, run token, score rules, and replay protection…</span>';
  try {
    const competitiveCheckpoint = transcript
      ? await retryRunFinalization(() => transcript.close(), {
          onRetry: showDatabaseReconnect
        })
      : null;
    if (serverRun.verification === 'fixed-step-input-replay' && !competitiveCheckpoint) {
      throw new Error('The competitive transcript was not checkpointed.');
    }
    const accepted = await retryRunFinalization(
      () => apiClient.finishRun(serverRun.runId, serverRun.runToken, {
        extracted: Boolean(result.extracted),
        projected: Math.max(0, Math.floor(result.projected || 0)),
        banked: Math.max(0, Math.floor(result.banked || 0)),
        depth: Math.max(1, Math.floor(result.depth || 1)),
        kills: Math.max(0, Math.floor(result.kills || 0)),
        oreBroken: Math.max(0, Math.floor(result.oreBroken || 0)),
        elapsed: Math.max(0, Number(result.elapsed || 0)),
        bossTelemetry: result.bossTelemetry || null
      }, competitiveCheckpoint),
      { onRetry: showDatabaseReconnect }
    );
    if (activeServerRun === serverRun) activeServerRun = null;
    if (activeArenaTranscript === transcript) activeArenaTranscript = null;
    clearPendingFinalization();
    profile = accepted.profile;
    saveProfile(profile);
    game.setProfile(profile);
    const leaderboard = accepted.leaderboard || {};
    const playerRow = Array.isArray(leaderboard.rows)
      ? leaderboard.rows.find((row) =>
          row.isPlayer ||
          String(row.address || '').toLowerCase() === String(serverPlayer?.address || '').toLowerCase()
        )
      : null;
    const playerScore = leaderboard.playerScore ?? playerRow?.score ?? accepted.run?.score ?? 0;
    const playerRank = leaderboard.playerRank ?? playerRow?.rank ?? 0;
    leaderboard.playerScore = playerScore;
    leaderboard.playerRank = playerRank;
    if (serverPlayer) {
      serverPlayer.profile = accepted.profile;
      serverPlayer.passProgress = accepted.passProgress;
      serverPlayer.passInventory = accepted.passInventory;
      if (serverRun.mode === RUN_MODES.FREE || serverRun.mode === RUN_MODES.PAID) {
        serverPlayer.scores[serverRun.mode] = playerScore;
      }
    }
    if (paymentStatus && accepted.passProgress) paymentStatus.passProgress = accepted.passProgress;
    applyPassInventory(accepted.passInventory);
    const boardName = serverRun.mode === RUN_MODES.FREE
      ? 'Free'
      : serverRun.mode === RUN_MODES.PAID
        ? 'Pass'
        : serverRun.mode === RUN_MODES.WEEKLY
          ? 'Challenge'
          : serverRun.mode === RUN_MODES.ENDLESS
            ? 'Endless'
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
    if (serverRun.mode === RUN_MODES.PRACTICE) {
      activePracticeClaim = accepted.practiceClaim || null;
      renderPracticeClaimPanel(activePracticeClaim, result);
    } else {
      clearPracticeClaimPanel();
    }
    toast('Run accepted by the MATT Mine server');
    await refreshServerPlayer();
  } catch (error) {
    const retryable = isRetryableAppendError(error);
    if (retryable) {
      queueFinalizationRetry(() => submitServerRun(serverRun, result));
    } else {
      if (activeServerRun === serverRun) activeServerRun = null;
      if (activeArenaTranscript === transcript) activeArenaTranscript = null;
      clearPendingFinalization();
    }
    $('#economy-result').innerHTML = `
      <strong>${retryable ? 'SCORE SAVE INTERRUPTED' : 'SERVER REJECTED RUN'}</strong>
      <span>${escapeHtml(error.message)}</span>
      <small>${retryable
        ? 'Your run is still held on this screen. Press RETRY SCORE SAVE when PostgreSQL reconnects.'
        : 'No leaderboard score was recorded. The server profile remains authoritative.'}</small>
    `;
    if (serverRun.mode === RUN_MODES.PRACTICE) clearPracticeClaimPanel();
    toast(error.message);
    await refreshServerPlayer();
  } finally {
    runFinalizationBusy = false;
  }
}

async function submitArenaRun(run) {
  if (runFinalizationBusy) return;
  runFinalizationBusy = true;
  showFinalizationBusy('SAVING ARENA SCORE');
  const transcript = activeArenaTranscript;
  $('#economy-result').innerHTML =
    '<strong>ARENA REPLAY IN PROGRESS</strong><span>The server is replaying the signed event transcript and calculating the authoritative score…</span>';
  try {
    const checkpoint = await retryRunFinalization(() => transcript?.close(), {
      onRetry: showDatabaseReconnect
    });
    if (!checkpoint) throw new Error('The Arena transcript was not checkpointed.');
    const accepted = await retryRunFinalization(
      () => apiClient.finishArenaRun(run.runId, run.runToken, checkpoint),
      { onRetry: showDatabaseReconnect }
    );
    if (accepted.accepted === false && accepted.attemptRestored === true) {
      if (activeArenaRun === run) activeArenaRun = null;
      if (activeArenaTranscript === transcript) activeArenaTranscript = null;
      clearPendingFinalization();
      $('#economy-result').innerHTML = `
        <strong>ARENA ATTEMPT RESTORED</strong>
        <span>${escapeHtml(accepted.message)}</span>
        <small>No score was recorded and no additional MATT payment is required. Return to MATT Arena and start the restored attempt.</small>
      `;
      toast('Arena attempt restored — no additional MATT required');
      await refreshArena(true);
      return;
    }
    if (activeArenaRun === run) activeArenaRun = null;
    if (activeArenaTranscript === transcript) activeArenaTranscript = null;
    clearPendingFinalization();
    const result = accepted.result || {};
    const leaderboard = accepted.leaderboard || {};
    arenaPlayer = normalizeArenaPlayer({
      ...arenaPlayer,
      bestScore: leaderboard.playerScore ?? result.score ?? arenaPlayer.bestScore,
      rank: leaderboard.playerRank ?? arenaPlayer.rank
    });
    if (serverPlayer && accepted.passProgress) {
      serverPlayer.passProgress = accepted.passProgress;
    }
    if (paymentStatus && accepted.passProgress) {
      paymentStatus.passProgress = accepted.passProgress;
    }
    applyPassInventory(accepted.passInventory);
    const passXpCopy = accepted.passXpAwarded
      ? ` · +${accepted.passXpAwarded} Pass XP`
      : '';
    const unlockedCopy = accepted.passRewardsUnlocked?.length
      ? ` · UNLOCKED ${accepted.passRewardsUnlocked.map((reward) => reward.name).join(', ')}`
      : '';
    $('#economy-result').innerHTML = `
      <strong>ARENA SCORE VERIFIED${arenaPlayer.rank ? ` · #${arenaPlayer.rank}` : ''}</strong>
      <span>Authoritative score: ${formatNumber(result.score || arenaPlayer.bestScore)}${passXpCopy}${unlockedCopy}</span>
      <small>The signed transcript was replayed against today's deterministic challenge. Browser-reported score totals were not trusted.</small>
    `;
    toast('Daily Arena score verified');
    await refreshArena(true);
  } catch (error) {
    const retryable = isRetryableAppendError(error);
    if (retryable) {
      queueFinalizationRetry(() => submitArenaRun(run));
    } else {
      if (activeArenaRun === run) activeArenaRun = null;
      if (activeArenaTranscript === transcript) activeArenaTranscript = null;
      clearPendingFinalization();
    }
    $('#economy-result').innerHTML = `
      <strong>${retryable ? 'ARENA SCORE SAVE INTERRUPTED' : 'ARENA RUN REJECTED'}</strong>
      <span>${escapeHtml(error.message || 'The server could not verify this run.')}</span>
      <small>${retryable
        ? 'Your paid entry and finished run are still held here. Press RETRY SCORE SAVE after PostgreSQL reconnects.'
        : 'The deterministic replay rejected this run and no Arena score was recorded.'}</small>
    `;
    toast(error.message || 'Arena verification failed.');
    await refreshArena(true);
  } finally {
    runFinalizationBusy = false;
  }
}

function showFinalizationBusy(label) {
  pendingRunFinalization = null;
  const retryButton = $('#play-again-button');
  const menuButton = $('#menu-button');
  retryButton.hidden = false;
  retryButton.disabled = true;
  retryButton.textContent = `${label}...`;
  menuButton.hidden = false;
  menuButton.disabled = true;
}

function showDatabaseReconnect(_error, retry) {
  $('#economy-result').innerHTML = `
    <strong>DATABASE RECONNECTING</strong>
    <span>Your run is preserved. Saving attempt ${retry.nextAttempt} will begin automatically.</span>
    <small>Do not close this page or start another run.</small>
  `;
}

function queueFinalizationRetry(retry) {
  pendingRunFinalization = retry;
  const retryButton = $('#play-again-button');
  retryButton.hidden = false;
  retryButton.disabled = false;
  retryButton.textContent = 'RETRY SCORE SAVE';
  const menuButton = $('#menu-button');
  menuButton.hidden = false;
  menuButton.disabled = true;
}

function clearPendingFinalization() {
  pendingRunFinalization = null;
  const retryButton = $('#play-again-button');
  retryButton.hidden = false;
  retryButton.disabled = false;
  retryButton.textContent = 'CHOOSE NEXT RUN';
  const menuButton = $('#menu-button');
  menuButton.hidden = false;
  menuButton.disabled = false;
}

function clearPracticeClaimPanel() {
  const panel = $('#practice-claim-panel');
  if (!panel) return;
  panel.hidden = true;
  const info = $('#practice-claim-info');
  const hashInput = $('#practice-claim-hash');
  if (info) info.innerHTML = '';
  if (hashInput) {
    hashInput.value = '';
    hashInput.disabled = false;
  }
}

function renderPracticeClaimPanel(claim, result) {
  const panel = $('#practice-claim-panel');
  if (!panel) return;
  if (resultScreenMode !== RUN_MODES.PRACTICE) {
    clearPracticeClaimPanel();
    return;
  }
  const info = $('#practice-claim-info');
  const hashInput = $('#practice-claim-hash');
  const claimButton = $('#practice-claim-button');
  const declineButton = $('#practice-decline-button');
  if (!claim || !claim.runId) {
    clearPracticeClaimPanel();
    return;
  }
  panel.hidden = false;
  const projected = Math.max(0, Math.floor(claim.projectedNuggets || result?.projected || 0));
  const isExpired = claim.status === 'pending' && claim.expiresAt <= Date.now();
  const paymentsEnabled = serverConfig?.realPaymentsEnabled === true;

  if (claim.status === 'claimed') {
    info.innerHTML = `<strong>Practice rewards claimed.</strong><span>Earned ${formatNumber(projected)} nuggets.</span>`;
    if (claimButton) claimButton.disabled = true;
    if (declineButton) declineButton.disabled = true;
    if (hashInput) hashInput.disabled = true;
    return;
  }
  if (claim.status === 'discarded') {
    info.innerHTML = '<strong>Practice rewards declined.</strong><span>You chose not to claim this run reward. Decline is final.</span>';
    if (claimButton) claimButton.disabled = true;
    if (declineButton) declineButton.disabled = true;
    if (hashInput) hashInput.disabled = true;
    return;
  }
  if (isExpired) {
    info.innerHTML = '<strong>Practice claim expired.</strong><span>The 24-hour practice claim window has ended.</span>';
    if (claimButton) claimButton.disabled = true;
    if (declineButton) declineButton.disabled = true;
    if (hashInput) hashInput.disabled = true;
    return;
  }
  if (!paymentsEnabled) {
    if (claimButton) {
      claimButton.disabled = true;
      claimButton.textContent = 'PRACTICE CLAIM BLOCKED';
    }
  } else if (claimButton) {
    claimButton.disabled = false;
    claimButton.textContent = 'CLAIM PRACTICE REWARDS';
  }
  if (declineButton) declineButton.disabled = false;
  if (hashInput) hashInput.disabled = !paymentsEnabled;
  info.innerHTML = `
    <strong>Practice rewards are available.</strong>
    <span>Projected nuggets: ${formatNumber(projected)}</span>
    <span>Approximate claim price: ${formatNumber(PRACTICE_CLAIM_PLACEHOLDER_PRICE)} MATT</span>
    <small>If you decline, the projected reward is discarded. Exact reward rates are configured and server-verified once payment integration is live.</small>
  `;
}

async function claimPracticeRewards() {
  if (!activePracticeClaim || activePracticeClaim.status !== 'pending') {
    return;
  }
  if (serverConfig?.realPaymentsEnabled !== true) {
    toast('Practice reward claims are disabled until verified payment integration is enabled.');
    return;
  }
  const hashInput = $('#practice-claim-hash');
  const hash = hashInput?.value ? hashInput.value.trim() : '';
  const valid = /^0x[a-fA-F0-9]{64}$/.test(hash);
  if (!valid) {
    toast('Paste a valid 32-byte reward payment transaction hash.');
    return;
  }
  const claimButton = $('#practice-claim-button');
  const declineButton = $('#practice-decline-button');
  claimButton.disabled = true;
  claimButton.textContent = 'VERIFYING CLAIM…';
  declineButton.disabled = true;
  try {
    const accepted = await apiClient.practiceRunClaim(activePracticeClaim.runId, 'claim', hash);
    activePracticeClaim = accepted.practiceClaim || accepted;
    profile = accepted.profile;
    saveProfile(profile);
    game.setProfile(profile);
    if (serverPlayer) {
      serverPlayer.profile = accepted.profile;
    }
    renderPracticeClaimPanel(activePracticeClaim);
    toast('Practice reward claim applied.');
    await refreshServerPlayer();
  } catch (error) {
    toast(error.message);
    await refreshServerPlayer();
    renderPracticeClaimPanel(activePracticeClaim);
  } finally {
    claimButton.disabled = false;
    claimButton.textContent = serverConfig?.realPaymentsEnabled === true
      ? 'CLAIM PRACTICE REWARDS'
      : 'PRACTICE CLAIM BLOCKED';
    declineButton.disabled = !activePracticeClaim || activePracticeClaim.status !== 'pending' || !serverConfig;
  }
}

async function declinePracticeRewards() {
  if (!activePracticeClaim || activePracticeClaim.status !== 'pending') return;
  const claimButton = $('#practice-claim-button');
  const declineButton = $('#practice-decline-button');
  claimButton.disabled = true;
  declineButton.disabled = true;
  declineButton.textContent = 'SKIPPING…';
  try {
    const accepted = await apiClient.practiceRunClaim(activePracticeClaim.runId, 'decline');
    activePracticeClaim = accepted.practiceClaim || accepted;
    profile = accepted.profile;
    saveProfile(profile);
    game.setProfile(profile);
    if (serverPlayer) {
      serverPlayer.profile = accepted.profile;
    }
    renderPracticeClaimPanel(activePracticeClaim);
    toast('Practice reward discarded.');
    await refreshServerPlayer();
  } catch (error) {
    toast(error.message);
    await refreshServerPlayer();
    renderPracticeClaimPanel(activePracticeClaim);
  } finally {
    claimButton.disabled = true;
    declineButton.disabled = !activePracticeClaim || activePracticeClaim.status !== 'pending';
    declineButton.textContent = 'DECLINE REWARDS';
  }
}

async function startRunMode(mode) {
  if (queueUntilMobileLandscape(() => startRunMode(mode))) return;
  const useServer =
    mode === RUN_MODES.FREE ||
    (mode === RUN_MODES.PAID && serverConfig?.paidRunsEnabled === true) ||
    (mode === RUN_MODES.PRACTICE && serverPlayer) ||
    [RUN_MODES.BETA, RUN_MODES.WEEKLY, RUN_MODES.ENDLESS].includes(mode);
  activePracticeClaim = null;
  resultScreenMode = null;
  clearPracticeClaimPanel();
  if (useServer) {
    if (!serverPlayer) {
      const connected = await connectWallet();
      if (!connected) return;
    }
    if (mode !== RUN_MODES.PRACTICE && serverPlayer.identity?.requiresSetup) {
      openMinerProfile(true);
      return;
    }
    try {
      const run = await apiClient.startRun(mode);
      activeServerRun = run;
      activeArenaTranscript = run.verification === 'fixed-step-input-replay'
        ? new ArenaTranscript(apiClient, run, {
            appendEvents: (...args) => apiClient.appendCompetitiveEvents(...args)
          })
        : null;
      if (mode === RUN_MODES.FREE) serverPlayer.entitlements.freeRunAvailable = false;
      if (mode === RUN_MODES.PAID && paymentStatus) {
        paymentStatus.confirmedCredits = Math.max(0, paymentStatus.confirmedCredits - 1);
      }
      showScreen();
      setGameplayUi(false);
      await showMineLoadingScreen({
        id: run.competitionSlotId || slotIdForMode(mode),
        name: run.competitionSnapshot?.name || mode,
        snapshot: run.competitionSnapshot || run.tuning?._competitionSnapshot
      });
      game.startRun({
        mode: run.mode,
        seed: run.seed,
        day: run.day,
        week: run.week,
        rewardWeight: run.rewardWeight,
        tuning: run.tuning,
        characterId: run.characterId,
        character: run.character,
        weeklyStage: run.weeklyStage,
        endlessSnapshot: run.endlessSnapshot,
        competitionSnapshot: run.competitionSnapshot,
        allowPaidRevive: run.paidReviveEligible === true,
        reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds
      });
      if (run.tuning?._minePassBenefits?.active === true) {
        toast('Mine Pass active · 2× XP and nuggets');
      }
      if (mode === RUN_MODES.BETA) {
        const entitlement = await apiClient.betaAccess();
        activeBetaTools = new BetaDeveloperTools(game, entitlement);
        $('#beta-config-json').value = JSON.stringify(defaultBetaConfiguration(), null, 2);
        $('#beta-tools').hidden = false;
      } else {
        activeBetaTools = null;
        $('#beta-tools').hidden = true;
      }
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
  const tuning = await apiClient.gameTuning(mode).catch(() => ({}));
  const mine = await apiClient.mineSlot(slotIdForMode(mode)).catch(() => null);
  await showMineLoadingScreen(mine?.slot || {
    id: slotIdForMode(mode),
    name: 'MATT Mine',
    snapshot: tuning?._competitionSnapshot
  });
  game.startRun({
    mode: result.mode,
    seed: result.seed,
    day: result.day,
    week: result.week,
    rewardWeight: result.rewardWeight,
    tuning,
    competitionSnapshot: mine?.slot?.snapshot || tuning?._competitionSnapshot
  });
  updateMenu();
}

async function purchasePaidRevive() {
  const button = $('#paid-revive-button');
  if (paidReviveBusy) return;
  if (!paidRevivePending) {
    toast('This revive offer is no longer active.');
    return;
  }
  const context = paidReviveContext || createPaidReviveContext();
  if (!context?.runId || !context?.transcript) {
    button.disabled = true;
    button.textContent = 'REVIVE UNAVAILABLE';
    $('#economy-result').innerHTML =
      '<strong>REVIVE UNAVAILABLE</strong><span>The verified run session is no longer active.</span><small>End the run safely and start another mine.</small>';
    toast('The verified run session expired. End this run and start another mine.');
    return;
  }
  paidReviveContext = context;
  paidReviveBusy = true;
  button.disabled = true;
  let serverPending = Boolean(context.pending);
  try {
    if (!context.pending) {
      button.textContent = 'VERIFYING KNOCKOUT...';
      $('#economy-result').innerHTML =
        '<strong>VERIFYING KNOCKOUT</strong><span>Securing the latest server replay checkpoint.</span><small>Ronin Wallet opens after the server confirms this revive is eligible.</small>';
      const checkpoint = await context.transcript.flush();
      if (!checkpoint) throw new Error('The verified run checkpoint is unavailable.');
      context.pending = await apiClient.requestPaidRevive(context.runId, { checkpoint });
      serverPending = true;
    }
    if (!context.transactionHash) {
      button.textContent = `CONFIRM ${formatRonWei(context.pending.priceRonWei)} RON`;
      $('#economy-result').innerHTML = `
        <strong>RONIN CONFIRMATION REQUIRED</strong>
        <span>Approve exactly ${formatRonWei(context.pending.priceRonWei)} RON in Ronin Wallet.</span>
        <small>Keep this page open while the transaction confirms.</small>
      `;
      context.transactionHash = await wallet.sendPreparedTransaction(context.pending.transaction, {
        onBroadcast(transactionHash) {
          context.transactionHash = transactionHash;
        }
      });
    }
    button.textContent = 'CONFIRMING ON RONIN...';
    $('#economy-result').innerHTML =
      '<strong>PAYMENT SENT</strong><span>Waiting for the verified Ronin receipt.</span><small>Do not close the game. Confirmation can be retried without paying again.</small>';
    await apiClient.confirmPaidRevive(context.runId, context.transactionHash);
    if (!game.applyPaidRevive()) throw new Error('The saved run could not resume safely.');
    paidRevivePending = false;
    paidReviveContext = null;
  } catch (error) {
    if (serverPending && !context.transactionHash) {
      await apiClient.cancelPaidRevive(context.runId).catch(() => undefined);
      context.pending = null;
    }
    button.disabled = false;
    button.textContent = context.transactionHash ? 'RETRY CONFIRMATION' : 'REVIVE WITH RON';
    $('#economy-result').innerHTML = `
      <strong>${context.transactionHash ? 'CONFIRMATION NEEDS RETRY' : 'REVIVE NOT STARTED'}</strong>
      <span>${escapeHtml(error.message || 'The revive could not be completed.')}</span>
      <small>${context.transactionHash
        ? 'Your payment hash is saved in this open game. Retry confirmation without sending another payment.'
        : 'No RON was accepted. You can try again or safely end the run.'}</small>
    `;
    toast(error.message);
  } finally {
    paidReviveBusy = false;
  }
}

function declinePaidRevive() {
  if (!paidRevivePending) return;
  if (paidReviveBusy || paidReviveContext?.transactionHash) {
    toast('Finish confirming the broadcast revive payment before ending this run.');
    return;
  }
  paidRevivePending = false;
  paidReviveContext = null;
  game.declinePaidRevive();
}

function formatRonWei(value) {
  try {
    const raw = BigInt(value);
    const whole = raw / 1_000_000_000_000_000_000n;
    const fraction = (raw % 1_000_000_000_000_000_000n)
      .toString()
      .padStart(18, '0')
      .replace(/0+$/, '')
      .slice(0, 4);
    return fraction ? `${whole}.${fraction}` : String(whole);
  } catch {
    return '10';
  }
}

const game = new MattMineGame(canvas, profile, {
  onRunStart() {
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    resetAbandonButton();
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
    const showArenaRoundTimer = stats.runMode === 'arena' && stats.roundDurationMs > 0;
    if (ui.arenaRoundTimer) {
      ui.arenaRoundTimer.hidden = !showArenaRoundTimer;
      ui.arenaRoundTimer.classList.toggle(
        'ending',
        showArenaRoundTimer && stats.roundRemainingMs <= 60_000
      );
      ui.arenaRoundTimer.classList.toggle(
        'critical',
        showArenaRoundTimer && stats.roundRemainingMs <= 10_000
      );
    }
    if (ui.arenaRoundTime && showArenaRoundTimer) {
      const label = formatArenaRoundTime(stats.roundRemainingMs);
      if (ui.arenaRoundTime.textContent !== label) ui.arenaRoundTime.textContent = label;
    }
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
    focusControllerChoice(container.querySelector('.level-card'));
  },
  onUpgradeChosen(upgrade) {
    showScreen();
    setGameplayUi(true);
    toast(`${upgrade.name} equipped`);
  },
  onDepthChoice(data) {
    $('#depth-summary').textContent = `You can bank ${formatNumber(data.projectedPayout)} nuggets now, or descend for a x${data.nextMultiplier.toFixed(1)} total loot multiplier.`;
    $('#descend-button').textContent = activeServerRun?.mode === RUN_MODES.ENDLESS
      ? 'DESCEND ENDLESS'
      : data.depth >= 5 ? 'MAX DEPTH — EXTRACT' : 'DESCEND DEEPER';
    showScreen('depth-choice');
    setGameplayUi(false);
    focusControllerChoice($('#extract-button'));
  },
  onDepthStarted() {
    showScreen();
    setGameplayUi(true);
  },
  onRunEnd(result) {
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    $('#paid-revive-panel').hidden = true;
    $('#play-again-button').hidden = false;
    $('#menu-button').hidden = false;
    const mode = result.mode || RUN_MODES.PRACTICE;
    resultScreenMode = mode;
    const serverRun = activeServerRun && activeServerRun.mode === mode ? activeServerRun : null;
    const arenaRun = activeArenaRun && mode === 'arena' ? activeArenaRun : null;
    const recorded = serverRun || arenaRun
      ? { ok: true, serverPending: true }
      : economy.apply(recordRun(economy.state, result));
    $('#end-kicker').textContent = result.timeLimitReached
      ? 'ARENA TIME EXPIRED'
      : result.extracted
        ? 'EXTRACTION SUCCESSFUL'
        : 'THE MINE TOOK ITS CUT';
    $('#end-title').textContent = result.timeLimitReached
      ? 'Score Auto-Extracted'
      : result.extracted
        ? 'Loot Secured'
        : 'You Were Knocked Out';
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
    if (mode !== RUN_MODES.PRACTICE) clearPracticeClaimPanel();
    showScreen('run-end');
    setGameplayUi(false);
    updateMenu();
    if (arenaRun) void submitArenaRun(arenaRun);
    else if (serverRun) void submitServerRun(serverRun, result);
  },
  onPaidReviveOffered(data) {
    paidRevivePending = true;
    paidReviveBusy = false;
    paidReviveContext = createPaidReviveContext();
    const reviveRun = activeArenaRun || activeServerRun;
    resultScreenMode = reviveRun?.mode || RUN_MODES.PRACTICE;
    $('#end-kicker').textContent = 'MINER DOWN';
    $('#end-title').textContent = 'Revive This Run?';
    $('#run-mode-result').textContent = modeLabel(
      reviveRun?.mode || RUN_MODES.PRACTICE,
      reviveRun?.rewardWeight || 0
    );
    $('#end-stats').innerHTML = `
      <div><span>Current Loot</span><strong>${formatNumber(data.projected)}</strong></div>
      <div><span>Depth</span><strong>${data.depth}</strong></div>
      <div><span>Enemies</span><strong>${data.kills}</strong></div>
      <div><span>Ore Broken</span><strong>${data.oreBroken}</strong></div>
    `;
    $('#economy-result').innerHTML = '<strong>RUN PAUSED</strong><span>Your rooms, weapons, upgrades, boss progress, and score are preserved.</span>';
    const reviveButton = $('#paid-revive-button');
    reviveButton.disabled = !paidReviveContext;
    reviveButton.textContent = paidReviveContext ? 'REVIVE WITH RON' : 'REVIVE UNAVAILABLE';
    $('#paid-revive-decline').disabled = false;
    $('#paid-revive-panel').hidden = false;
    $('#play-again-button').hidden = true;
    $('#menu-button').hidden = true;
    showScreen('run-end');
    setGameplayUi(false);
  },
  onPaidReviveApplied() {
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    $('#paid-revive-panel').hidden = true;
    showScreen();
    setGameplayUi(true);
    toast('Revived at full health');
  },
  onProfileChanged(nextProfile) {
    profile = nextProfile;
    saveProfile(profile);
    game.setProfile(profile);
  },
  onMenu() {
    resultScreenMode = null;
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    clearPracticeClaimPanel();
    showScreen('menu');
    setGameplayUi(false);
    updateMenu();
  },
  onRunAbandoned(context) {
    abandonIssuedRun(context);
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
game.setScreenShakeEnabled(gameplayPreferences.screenShake);

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
$('#weekly-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.WEEKLY));
$('#endless-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.ENDLESS));
$('#beta-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.BETA));
document.querySelectorAll('[data-beta-action]').forEach((button) => button.addEventListener('click', () => {
  if (!activeBetaTools) return;
  const actions = {
    restore: () => activeBetaTools.restoreHealth(),
    refill: () => activeBetaTools.refillBlaster(),
    clear: () => activeBetaTools.clearMonsters(),
    reset: () => activeBetaTools.restartDepth(),
    spawn: () => activeBetaTools.spawnEnemies(),
    boss: () => activeBetaTools.spawnBosses()
  };
  actions[button.dataset.betaAction]?.();
}));
$('#beta-apply-config').addEventListener('click', () => {
  try {
    const applied = activeBetaTools?.importJson($('#beta-config-json').value);
    if (applied) $('#beta-config-json').value = JSON.stringify(applied, null, 2);
    toast('Beta configuration applied');
  } catch (error) {
    toast(error.message);
  }
});
$('#beta-copy-config').addEventListener('click', () => {
  if (!activeBetaTools) return;
  navigator.clipboard.writeText(activeBetaTools.exportJson());
  toast('Beta configuration copied');
});
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
$('#play-again-button').addEventListener('click', () => {
  if (pendingRunFinalization) {
    const retry = pendingRunFinalization;
    pendingRunFinalization = null;
    void retry();
    return;
  }
  game.backToMenu();
});
$('#menu-button').addEventListener('click', () => game.backToMenu());
$('#practice-claim-button').addEventListener('click', () => void claimPracticeRewards());
$('#practice-decline-button').addEventListener('click', () => void declinePracticeRewards());
$('#paid-revive-button').addEventListener('click', () => void purchasePaidRevive());
$('#paid-revive-decline').addEventListener('click', declinePaidRevive);
$('#abandon-run-button').addEventListener('click', () => {
  const now = Date.now();
  if (now > abandonConfirmUntil) {
    abandonConfirmUntil = now + 6_000;
    const button = $('#abandon-run-button');
    button.textContent = 'PRESS AGAIN TO LEAVE';
    button.classList.add('confirming');
    clearTimeout(abandonResetTimer);
    abandonResetTimer = setTimeout(resetAbandonButton, 6_000);
    return;
  }
  resetAbandonButton();
  game.abandonRun();
});
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
$('#shake-toggle-button').addEventListener('click', () => {
  gameplayPreferences = saveGameplayPreferences({
    ...gameplayPreferences,
    screenShake: !gameplayPreferences.screenShake
  });
  game.setScreenShakeEnabled(gameplayPreferences.screenShake);
  renderGameplayPreferences();
  toast(gameplayPreferences.screenShake ? 'Screen shake on' : 'Screen shake off');
});
$('#profile-button').addEventListener('click', () => openMinerProfile(false));
$('#controls-button').addEventListener('click', () => void openPlayerControls());
$('#save-profile-button').addEventListener('click', () => void saveMinerIdentity());
$('#update-avatar-button').addEventListener('click', () => void updateMinerAvatar());
$('#save-keybinds-button').addEventListener('click', () => void savePlayerKeybindings());
$('#reset-keybinds-button').addEventListener('click', () => {
  pendingKeybindings = defaultKeybindings();
  renderKeybindings();
  toast('Default controls restored — press Save Controls to keep them');
});
$('#controller-dead-zone').addEventListener('input', renderControllerSettings);
$('#controller-aim-sensitivity').addEventListener('input', renderControllerSettings);
$('#reset-controller-button').addEventListener('click', () => {
  const defaults = defaultControllerProfile();
  $('#controller-dead-zone').value = defaults.deadZone;
  $('#controller-aim-sensitivity').value = defaults.aimSensitivity;
  $('#controller-vibration').checked = defaults.vibration;
  renderControllerMappings(defaults.mapping);
  renderControllerSettings();
  toast('Controller defaults loaded — press Save Controller to keep them');
});
$('#save-controller-button').addEventListener('click', () => void saveControllerSettings());
$('#resume-run-button').addEventListener('click', resumeControllerPausedRun);
window.addEventListener('mattmine:controller', (event) => {
  const status = $('#controller-status');
  if (!status) return;
  status.textContent = event.detail?.connected
    ? `Controller ${Number(event.detail.index) + 1} connected.`
    : 'Controller disconnected. The current run is paused for safety.';
  if (event.detail?.pauseRequested && game.state === 'playing') pauseControllerRun();
});
$('#profile-name').addEventListener('input', () => renderProfileAvatar(pendingAvatarDataUrl || serverPlayer?.identity?.avatarUrl || ''));
$('#profile-avatar-input').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  $('#profile-status').textContent = 'Preparing your profile picture…';
  try {
    pendingAvatarDataUrl = await prepareProfileImage(file);
    renderProfileAvatar(pendingAvatarDataUrl);
    const requiresSetup = Boolean(serverPlayer?.identity?.requiresSetup);
    $('#update-avatar-button').hidden = requiresSetup;
    if (requiresSetup) {
      $('#profile-status').textContent = 'Picture ready. Lock in your name to save the complete profile.';
    } else {
      $('#update-avatar-button').hidden = false;
      $('#profile-status').textContent = 'Publishing your profile picture…';
      await updateMinerAvatar();
    }
  } catch (error) {
    pendingAvatarDataUrl = '';
    renderProfileAvatar(serverPlayer?.identity?.avatarUrl || '');
    $('#profile-status').textContent = error.message;
    toast(error.message);
  } finally {
    event.target.value = '';
  }
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
    if (button.dataset.close === 'miner-profile' && serverPlayer?.identity?.requiresSetup) {
      toast('Choose your permanent miner name to continue.');
      return;
    }
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
    $('#claim-reward-button').textContent = 'CHECKING CLAIM…';
    $('#published-reward-status').textContent = 'Checking your proof on Ronin Mainnet…';
    try {
      const prepared = await apiClient.prepareRewardClaim(activeServerClaim.id);
      $('#claim-reward-button').textContent = 'CONFIRM IN RONIN WALLET';
      $('#published-reward-status').textContent = 'Approve the claim in Ronin Wallet. You only pay the network gas.';
      const transactionHash = await wallet.claimReward(prepared.transaction);
      toast(`MATT claimed · ${abbreviateHash(transactionHash)}`);
      await renderServerLeaderboard(activeBoard);
    } catch (error) {
      const message = error.message || 'The MATT claim could not be completed.';
      toast(message);
      await renderServerLeaderboard(activeBoard);
      $('#published-reward-status').textContent = message;
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
    : 'CLOSED TODAY';
  const launchEntry = $('#launch-arena-entry');
  if (launchEntry) {
    launchEntry.textContent = arenaConfig.enabled && arenaConfig.feeRaw > 0n
      ? formatMattRaw(arenaConfig.feeRaw)
      : 'MATT ENTRY';
  }
  const launchState = $('#launch-arena-state');
  if (launchState) launchState.textContent = arenaConfig.enabled ? '24-HOUR POOL' : 'CLOSED TODAY';
  const menuAction = $('#arena-menu-action');
  if (menuAction) menuAction.textContent = arenaConfig.enabled ? 'ENTER ARENA' : 'VIEW ARENA';
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
    if (!arenaConfig.enabled) {
      arenaLeaderboard = normalizeArenaLeaderboard({
        day: arenaConfig.day,
        status: arenaConfig.status,
        totalPoolRaw: arenaConfig.prizePoolRaw,
        rows: []
      });
      arenaPlayer = normalizeArenaPlayer();
      renderArenaMenuStatus();
      if ($('#daily-arena').classList.contains('active')) renderArena();
      return arenaConfig;
    }
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
    : 'CLOSED';
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
  const entryCutoffLabel = config.entryCutoffAt
    ? new Date(config.entryCutoffAt).toISOString().slice(11, 16)
    : '23:35';
  $('#arena-day-label').textContent = `${config.day} UTC · MATT entry closes ${entryCutoffLabel} UTC · official runs close 00:00 UTC.`;

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
          ? 'ARENA CLOSED'
          : config.entriesPaused
            ? 'ENTRIES PAUSED'
            : !entryWindowOpen
              ? 'ENTRY WINDOW CLOSED'
              : config.status !== 'open'
                ? 'ENTRY WINDOW CLOSED'
                : `BUY ENTRY · ${formatMattRaw(config.feeRaw)}`;

  const startButton = $('#start-arena-run-button');
  const strandedActiveRun = Boolean(player.activeRunId) && !activeArenaRun;
  const canStart =
    Boolean(serverPlayer) &&
    !serverPlayer.suspended &&
    config.enabled &&
    runWindowOpen &&
    config.status === 'open' &&
    player.unusedAttempts > 0;
  startButton.disabled = arenaBusy || (!canStart && !strandedActiveRun);
  startButton.textContent = strandedActiveRun
    ? 'RELEASE ACTIVE ARENA RUN'
    : !serverPlayer
    ? 'CONNECT RONIN TO PLAY'
    : serverPlayer.suspended
      ? 'WALLET SUSPENDED'
      : !config.enabled
        ? 'ARENA CLOSED'
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
          <td>${renderMinerIdentity(row)}${row.isPlayer ? ' · YOU' : ''}</td>
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
  $('#arena-note').textContent = strandedActiveRun
    ? 'An earlier Arena run is still active. Release it to continue. Its consumed entry will not be refunded and no score will be recorded.'
    : !config.enabled
      ? 'Today\'s Arena is closed. Check back after the next daily reset.'
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

function arenaUsesPublicEligibility() {
  const eligibility = serverConfig?.eligibility;
  return eligibility?.enforcement === 'public_attestation' &&
    eligibility.publicModes?.includes('arena');
}

function walletAcceptedCurrentArenaRules() {
  const configured = serverConfig?.eligibility;
  const accepted = serverPlayer?.paidCompetitionEligibility?.arena;
  return Boolean(
    configured?.rulesVersion &&
    configured?.rulesHash &&
    accepted?.rulesVersion === configured.rulesVersion &&
    accepted?.rulesHash === configured.rulesHash
  );
}

function requestArenaEligibilityAcknowledgement() {
  const configured = serverConfig?.eligibility;
  const dialog = $('#arena-eligibility-dialog');
  const form = $('#arena-eligibility-form');
  if (!dialog || !form || !configured?.rulesVersion || !configured?.rulesHash) {
    throw new Error('The current Arena eligibility rules are unavailable.');
  }
  form.reset();
  $('#arena-rules-version').textContent = `v${configured.rulesVersion}`;
  $('#arena-rules-hash').textContent = configured.rulesHash;
  for (const link of [$('#arena-rules-link'), $('#arena-eligibility-rules-link')]) {
    if (link && configured.rulesUrl) link.href = configured.rulesUrl;
  }
  $('#arena-eligibility-rules-link').textContent = `OPEN ARENA RULES v${configured.rulesVersion} (PLAIN TEXT)`;
  if (dialog.open) dialog.close('cancel');
  dialog.showModal();
  return new Promise((resolve) => {
    let acknowledgement = null;
    const cancelButton = $('#arena-eligibility-cancel');
    const onSubmit = (event) => {
      event.preventDefault();
      acknowledgement = {
        age18OrOlder: $('#arena-age-attestation').checked,
        locatedInJurisdiction: $('#arena-location-attestation').checked,
        notProhibited: $('#arena-prohibited-attestation').checked,
        acceptedRules: $('#arena-rules-attestation').checked,
        jurisdiction: $('#arena-jurisdiction').value,
        rulesVersion: configured.rulesVersion,
        rulesHash: configured.rulesHash
      };
      dialog.close('accepted');
    };
    const onCancel = () => dialog.close('cancel');
    const onClose = () => {
      form.removeEventListener('submit', onSubmit);
      cancelButton.removeEventListener('click', onCancel);
      resolve(dialog.returnValue === 'accepted' ? acknowledgement : null);
    };
    form.addEventListener('submit', onSubmit);
    cancelButton.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose, { once: true });
  });
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
  arenaBusy = true;
  renderArena();
  try {
    const eligibilityAcknowledgement = arenaUsesPublicEligibility() && !walletAcceptedCurrentArenaRules()
      ? await requestArenaEligibilityAcknowledgement()
      : null;
    if (arenaUsesPublicEligibility() && !walletAcceptedCurrentArenaRules() && !eligibilityAcknowledgement) return;
    const quote = await apiClient.arenaEntryQuote(arenaConfig.day, eligibilityAcknowledgement);
    if (quote.eligibility?.enforcement === 'public_attestation') {
      serverPlayer.paidCompetitionEligibility ||= {};
      serverPlayer.paidCompetitionEligibility.arena = {
        rulesVersion: quote.eligibility.rulesVersion,
        rulesHash: quote.eligibility.rulesHash,
        jurisdiction: quote.eligibility.jurisdiction,
        acceptedAt: quote.eligibility.acceptedAt
      };
    }
    const balanceLine = quote.balanceRaw
      ? `\n\nWallet balance: ${formatMattRaw(quote.balanceRaw)} MATT`
      : '';
    const gasLine = quote.ronBalanceRaw
      ? `\nGas balance: ${formatRonWei(quote.ronBalanceRaw)} RON`
      : '';
    const approved = window.confirm(
      `Enter today's MATT Arena for ${formatMattRaw(quote.amountRaw || arenaConfig.feeRaw)}?` +
      `${balanceLine}${gasLine}\n\nEvery accepted MATT enters the player prize pool. Ronin Wallet may request an approval transaction followed by the Arena entry transaction.`
    );
    if (!approved) return;
    const transactions = quote.transactions || quote.transaction;
    const transactionHashes = await wallet.purchaseArenaEntry(transactions);
    const entryTransactionHash = transactionHashes.at(-1);
    toast('Arena entry mined · server confirming');
    const confirmation = await apiClient.confirmArenaEntry(
      entryTransactionHash,
      quote.eligibilityReceipt || ''
    );
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
  if (queueUntilMobileLandscape(startArenaRun)) return;
  if (arenaPlayer.activeRunId && !activeArenaRun) {
    await releaseActiveArenaRun();
    return;
  }
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
    showScreen();
    setGameplayUi(false);
    await showMineLoadingScreen({
      id: 'arena',
      name: run.challenge?.tuning?._competitionSnapshot?.name || 'MATT Arena',
      snapshot: run.challenge?.tuning?._competitionSnapshot
    });
    const arenaCompetitionSnapshot = run.challenge?.tuning?._competitionSnapshot;
    game.startRun({
      mode: 'arena',
      seed: run.dailySeed || run.seed,
      day: run.day,
      rewardWeight: 0,
      roundDurationMs: run.challenge?.maxTicks,
      tuning: run.challenge?.tuning || {},
      competitionSnapshot: arenaCompetitionSnapshot,
      characterId: arenaCompetitionSnapshot?.loadout?.characterId || 'matt',
      character: run.challenge?.tuning?._competitionCharacter || {},
      allowPaidRevive: run.paidReviveEligible === true,
      reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds
    });
    if (run.challenge?.tuning?._minePassBenefits?.active === true) {
      toast('Mine Pass active · 2× XP and nuggets');
    }
  } catch (error) {
    activeArenaRun = null;
    activeArenaTranscript = null;
    toast(error.message || 'Arena run could not start.');
    await refreshArena(true);
  } finally {
    arenaBusy = false;
  }
}

function createPaidReviveContext() {
  const run = activeArenaRun || activeServerRun;
  return run && activeArenaTranscript
    ? {
        runId: run.runId,
        transcript: activeArenaTranscript,
        pending: null,
        transactionHash: ''
      }
    : null;
}

async function releaseActiveArenaRun() {
  if (arenaBusy || !arenaPlayer.activeRunId) return;
  const approved = window.confirm(
    'Release the unfinished Daily Arena run?\n\n' +
    'This clears the active-run lock. The consumed Arena entry remains used and no score will be recorded.'
  );
  if (!approved) return;
  arenaBusy = true;
  renderArena();
  try {
    await apiClient.abandonActiveArenaRun();
    activeArenaRun = null;
    activeArenaTranscript = null;
    toast('Active Arena run released. You can start another purchased attempt.');
    await refreshArena(true);
  } catch (error) {
    toast(error.message || 'The active Arena run could not be released.');
  } finally {
    arenaBusy = false;
    renderArena();
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
  const identity = row.identity || {};
  const title = cosmeticById(appearance.title);
  const badge = cosmeticById(appearance.badge);
  const trophy = cosmeticById(appearance.trophy);
  const name = identity.name || row.walletId || abbreviateAddress(row.address);
  const avatar = identity.avatarUrl || '';
  return `
    <span class="miner-identity ${appearance.frame === 'founder_frame' ? 'founder-frame' : ''}">
      ${avatar ? `<img class="miner-avatar" src="${escapeHtml(avatar)}" alt="" aria-hidden="true" />` : ''}
      ${badge ? `<i class="miner-badge" title="${escapeHtml(badge.name)}">${renderCosmeticIcon(badge)}</i>` : ''}
      <b>${escapeHtml(name)}</b>
      ${title ? `<small>${escapeHtml(title.name)}</small>` : ''}
      ${trophy ? `<em title="${escapeHtml(trophy.name)}">${trophy.icon}</em>` : ''}
    </span>
  `;
}

function renderRunCosmeticResult() {
  const equipped = serverPlayer?.passInventory?.equipped || {};
  const identity = serverPlayer?.identity || {};
  const title = cosmeticById(equipped.title);
  const badge = cosmeticById(equipped.badge);
  const trophy = cosmeticById(equipped.trophy);
  if (!serverPlayer && !title && !badge && !trophy && equipped.frame !== 'founder_frame') return '';
  return `
    <span class="miner-identity result-identity ${equipped.frame === 'founder_frame' ? 'founder-frame' : ''}">
      ${identity.avatarUrl ? `<img class="miner-avatar" src="${escapeHtml(identity.avatarUrl)}" alt="" aria-hidden="true" />` : ''}
      ${badge ? `<i class="miner-badge" title="${escapeHtml(badge.name)}">${renderCosmeticIcon(badge)}</i>` : ''}
      <b>${serverPlayer ? escapeHtml(identity.name || abbreviateAddress(serverPlayer.address)) : 'MATT MINER'}</b>
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

function renderKeybindings() {
  $('#keybind-grid').innerHTML = KEYBIND_ACTIONS.map((action) =>
    `<button type="button" class="secondary-button keybind-button" data-keybind="${action.id}"><span>${escapeHtml(action.label)}</span><strong>${escapeHtml(keyName(pendingKeybindings[action.id]))}</strong></button>`
  ).join('');
  document.querySelectorAll('[data-keybind]').forEach((button) => button.addEventListener('click', () => {
    button.classList.add('listening');
    button.querySelector('strong').textContent = 'PRESS KEY';
    window.addEventListener('keydown', (event) => {
      event.preventDefault();
      pendingKeybindings[button.dataset.keybind] = event.code;
      renderKeybindings();
    }, { once: true, capture: true });
  }));
}

function renderControllerSettings() {
  const deadZone = Number($('#controller-dead-zone')?.value || .18);
  const sensitivity = Number($('#controller-aim-sensitivity')?.value || 1);
  if ($('#controller-dead-zone-value')) $('#controller-dead-zone-value').textContent = `${Math.round(deadZone * 100)}%`;
  if ($('#controller-aim-sensitivity-value')) $('#controller-aim-sensitivity-value').textContent = `${sensitivity.toFixed(2)}×`;
}

function renderControllerMappings(mapping = defaultControllerProfile().mapping) {
  const grid = $('#controller-mapping-grid');
  if (!grid) return;
  grid.innerHTML = CONTROLLER_ACTIONS.map((action) => `<label>
    <span>${escapeHtml(CONTROLLER_ACTION_LABELS[action] || action)}</span>
    <select data-controller-action="${action}">
      ${Array.from({ length: 18 }, (_, button) => `<option value="${button}" ${Number(mapping[action]) === button ? 'selected' : ''}>${escapeHtml(CONTROLLER_BUTTON_LABELS[button] || `Button ${button}`)}</option>`).join('')}
    </select>
  </label>`).join('');
}

const CHARACTER_PORTRAIT_IDS = new Set(['ronke', 'axie', 'orc']);

function renderCharacters() {
  const characters = serverPlayer?.expansion?.characters || {};
  const selected = serverPlayer?.expansion?.selectedCharacter || 'matt';
  $('#character-grid').innerHTML = Object.entries(characters).map(([id, character]) => `<article class="character-card ${selected === id ? 'selected' : ''}">
    ${CHARACTER_PORTRAIT_IDS.has(id) ? `<span class="character-portrait character-portrait-${id}" role="img" aria-label="${escapeHtml(character.name)}"></span>` : ''}
    <div><strong>${escapeHtml(character.name)}</strong><small>${escapeHtml(character.description)}</small></div>
    <p>HP ${Math.round(character.baseHealth)} · SPEED ${Number(character.movementSpeed).toFixed(2)}× · PICKAXE ${Number(character.pickaxeDamage).toFixed(2)}× · BLASTER ${Number(character.blasterDamage).toFixed(2)}×</p>
    <button type="button" data-character-select="${id}" ${!character.enabled ? 'disabled' : ''}>${character.owned ? (selected === id ? 'SELECTED' : 'SELECT') : character.nuggetPrice > 0 ? `UNLOCK · ${Number(character.nuggetPrice).toLocaleString()} NUGGETS` : 'LOCKED'}</button>
  </article>`).join('') || '<p class="preview-note">Sign in to load your server-owned characters.</p>';
  document.querySelectorAll('[data-character-select]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.characterSelect;
    const character = serverPlayer.expansion.characters[id];
    try {
      if (!character.owned && character.nuggetPrice > 0) {
        serverPlayer.expansion = await apiClient.purchaseCharacter(id);
        serverPlayer.profile.bankedNuggets -= character.nuggetPrice;
      }
      const result = await apiClient.selectCharacter(id);
      serverPlayer.expansion.selectedCharacter = result.selectedCharacter;
      renderCharacters();
      updateMenu();
      toast(`${result.character.name} selected`);
    } catch (error) {
      toast(error.message);
    }
  }));
}

function loadControllerSettings() {
  const controller = serverPlayer?.expansion?.controller || defaultControllerProfile();
  $('#controller-dead-zone').value = controller.deadZone;
  $('#controller-aim-sensitivity').value = controller.aimSensitivity;
  $('#controller-vibration').checked = controller.vibration !== false;
  renderControllerMappings(controller.mapping);
  renderControllerSettings();
}

async function saveControllerSettings() {
  if (!serverPlayer) return toast('Connect Ronin Wallet first');
  try {
    const base = serverPlayer.expansion?.controller || defaultControllerProfile();
    const controller = normalizeControllerProfile({
      ...base,
      deadZone: Number($('#controller-dead-zone').value),
      aimSensitivity: Number($('#controller-aim-sensitivity').value),
      vibration: $('#controller-vibration').checked,
      mapping: Object.fromEntries([...document.querySelectorAll('[data-controller-action]')]
        .map((input) => [input.dataset.controllerAction, Number(input.value)]))
    });
    const saved = await apiClient.updateController(controller);
    serverPlayer.expansion ||= {};
    serverPlayer.expansion.controller = saved;
    game.input.setControllerProfile(saved);
    toast('Controller settings saved to your profile');
  } catch (error) {
    $('#profile-status').textContent = error.message;
  }
}

function pauseControllerRun() {
  if (game.state !== 'playing') return;
  game.state = 'paused';
  game.audio?.pause?.();
  $('#controller-pause-overlay').hidden = false;
  requestAnimationFrame(() => $('#resume-run-button')?.focus());
}

function resumeControllerPausedRun() {
  if (game.state !== 'paused') return;
  $('#controller-pause-overlay').hidden = true;
  game.state = 'playing';
  game.audio?.resume?.();
}

let controllerMenuPrevious = [];
function pollControllerMenus() {
  const profile = serverPlayer?.expansion?.controller || defaultControllerProfile();
  const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
  const preferred = pads?.[profile.activeIndex];
  const pad = preferred?.connected ? preferred : [...(pads || [])].find((entry) => entry?.connected);
  const current = pad ? pad.buttons.map((button) => button.pressed || button.value >= .55) : [];
  const pressed = (action) => {
    const button = profile.mapping?.[action];
    return current[button] === true && controllerMenuPrevious[button] !== true;
  };
  if (pad) {
    if (game.state === 'playing' && pressed('pause')) pauseControllerRun();
    else if (game.state === 'paused' && pressed('pause')) resumeControllerPausedRun();
    else if (game.state !== 'playing') {
      if (pressed('menuUp') || pressed('menuLeft')) moveControllerFocus(-1, pad, profile);
      if (pressed('menuDown') || pressed('menuRight')) moveControllerFocus(1, pad, profile);
      if (pressed('confirm')) {
        const target = document.activeElement;
        if (target instanceof HTMLElement && target.matches('button,a,[role="button"]')) target.click();
      }
      if (pressed('cancel')) {
        const scope = activeControllerScope();
        const target = scope?.querySelector('.close-button,[data-close],#menu-button');
        if (target instanceof HTMLElement) target.click();
      }
    }
  }
  controllerMenuPrevious = current;
  requestAnimationFrame(pollControllerMenus);
}

function activeControllerScope() {
  if (!$('#controller-pause-overlay').hidden) return $('#controller-pause-overlay');
  return document.querySelector('.screen.active') || document.body;
}

function moveControllerFocus(direction, pad, profile) {
  const scope = activeControllerScope();
  const focusable = [...scope.querySelectorAll('button:not([disabled]):not([hidden]),a[href],select:not([disabled]),input:not([disabled]):not([type="hidden"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const currentIndex = focusable.indexOf(document.activeElement);
  const next = focusable[(currentIndex + direction + focusable.length) % focusable.length];
  next.focus();
  next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (profile.vibration && pad.vibrationActuator?.playEffect) {
    void pad.vibrationActuator.playEffect('dual-rumble', {
      duration: 35,
      weakMagnitude: .12,
      strongMagnitude: 0
    }).catch(() => {});
  }
}

function focusControllerChoice(element) {
  requestAnimationFrame(() => {
    if (!(element instanceof HTMLElement)) return;
    element.focus();
    element.scrollIntoView({ block: 'nearest' });
  });
}

requestAnimationFrame(pollControllerMenus);

async function openPlayerControls() {
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  openMinerProfile(false);
  loadControllerSettings();
  renderCharacters();
  requestAnimationFrame(() => {
    const editor = $('#keybind-editor');
    editor.classList.add('keybind-highlight');
    editor.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => editor.classList.remove('keybind-highlight'), 1_600);
  });
}

function keyName(code) {
  if (code === 'Space') return 'SPACE';
  if (code === 'ShiftLeft') return 'LEFT SHIFT';
  if (code === 'ShiftRight') return 'RIGHT SHIFT';
  if (code === 'ControlLeft') return 'LEFT CTRL';
  if (code === 'ControlRight') return 'RIGHT CTRL';
  if (code === 'AltLeft') return 'LEFT ALT';
  if (code === 'AltRight') return 'RIGHT ALT';
  if (code?.startsWith('Key')) return code.slice(3);
  if (code?.startsWith('Digit')) return code.slice(5);
  if (code?.startsWith('Arrow')) return code.slice(5).toUpperCase();
  return String(code || '').toUpperCase();
}

async function savePlayerKeybindings() {
  if (!serverPlayer) return toast('Connect Ronin Wallet first');
  try {
    const saved = await apiClient.updateKeybindings(normalizeKeybindings(pendingKeybindings));
    serverPlayer.keybindings = saved;
    game.input.setKeybindings(saved);
    toast('Controls saved to your profile');
  } catch (error) {
    $('#profile-status').textContent = error.message;
  }
}

function renderGameplayPreferences() {
  const button = $('#shake-toggle-button');
  if (!button) return;
  button.textContent = gameplayPreferences.screenShake ? 'SHAKE ON' : 'SHAKE OFF';
  button.setAttribute('aria-pressed', String(gameplayPreferences.screenShake));
  button.title = gameplayPreferences.screenShake
    ? 'Turn off screen shake'
    : 'Turn on screen shake';
}

function resetAbandonButton() {
  abandonConfirmUntil = 0;
  clearTimeout(abandonResetTimer);
  abandonResetTimer = null;
  const button = $('#abandon-run-button');
  if (!button) return;
  button.textContent = 'ABANDON RUN';
  button.classList.remove('confirming');
}

function abandonIssuedRun(context = {}) {
  const serverRun = activeServerRun;
  const arenaRun = activeArenaRun;
  const transcript = activeArenaTranscript;
  activeServerRun = null;
  activeArenaRun = null;
  activeArenaTranscript = null;
  const transcriptDiscard = transcript?.discard() || Promise.resolve();
  toast('Run abandoned - no score was submitted');

  void (async () => {
    try {
      await transcriptDiscard;
      if (arenaRun) {
        await apiClient.abandonArenaRun(arenaRun.runId, arenaRun.runToken);
        await refreshArena(true);
      } else if (serverRun) {
        await apiClient.abandonRun(serverRun.runId, serverRun.runToken);
        await refreshServerPlayer();
      }
    } catch (error) {
      console.warn('[MATT Mine] Run abandonment could not be confirmed.', error);
      toast(context.mode === 'practice'
        ? 'Practice run closed'
        : 'Run closed locally; server release is pending');
    }
  })();
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

function slotIdForMode(mode) {
  return {
    [RUN_MODES.PRACTICE]: 'practice',
    [RUN_MODES.FREE]: 'daily',
    [RUN_MODES.PAID]: 'pass',
    [RUN_MODES.WEEKLY]: 'weekly',
    arena: 'arena'
  }[mode] || 'practice';
}

async function startCompetitionStudioTest() {
  if (new URLSearchParams(window.location.search).get('studioTest') !== '1') return false;
  let snapshot;
  try {
    snapshot = JSON.parse(localStorage.getItem('matt-mine-studio-test-v1') || 'null');
  } catch {}
  if (!snapshot?.map || snapshot.status !== 'test') {
    toast('Studio test map was not found. Return to Admin and press Test in Practice.');
    return false;
  }
  const testDepth = Math.max(
    1,
    Math.min(COMPETITION_DEPTH_COUNT, Math.floor(Number(snapshot.testDepth) || 1))
  );
  await showMineLoadingScreen({
    id: 'practice',
    name: snapshot.name || 'Studio Test Mine',
    snapshot
  }, { minimumMs: 2_500, depth: testDepth });
  game.startRun({
    mode: RUN_MODES.PRACTICE,
    seed: `STUDIO-TEST-${snapshot.id || Date.now()}`,
    day: new Date().toISOString().slice(0, 10),
    rewardWeight: 0,
    startingDepth: testDepth,
    tuning: {
      usePerDepthRoomSpawns: false,
      _competitionSnapshot: snapshot,
      safeStartSeconds: snapshot.rules?.safeStartSeconds ?? 4,
      maximumDrones: snapshot.loadout?.maximumDrones ?? 4,
      ignorePermanentUpgrades: snapshot.loadout?.permanentUpgrades === false,
      disableRunUpgrades: snapshot.loadout?.runUpgrades === false
    },
    competitionSnapshot: snapshot,
    allowPaidRevive: false
  });
  toast('ADMIN TEST · rewards and scores disabled');
  return true;
}

window.addEventListener('mattmine:slot-enter', (event) => {
  const slot = event.detail?.slot;
  if (!slot || slot.comingSoon) return;
  if (slot.id === 'arena') {
    void openArena();
    return;
  }
  if (slot.id === 'pass') {
    if (
      serverConfig?.paidRunsEnabled === true &&
      (paymentStatus?.confirmedCredits || 0) > 0 &&
      paymentStatus?.pass?.active
    ) {
      void startRunMode(RUN_MODES.PAID);
    } else {
      openPass();
    }
    return;
  }
  const mode = {
    practice: RUN_MODES.PRACTICE,
    daily: RUN_MODES.FREE,
    weekly: RUN_MODES.WEEKLY
  }[slot.id];
  if (mode) void startRunMode(mode);
});

async function bootstrapServer() {
  const today = new Date().toISOString().slice(0, 10);
  dailyMinePreviewCleanup?.();
  dailyMinePreviewCleanup = mountDailyMinePreviews({ day: today });
  try {
    serverConfig = await apiClient.config();
    publicPaymentStatus = await apiClient.publicPaymentStatus();
    const freeTuning = await apiClient.gameTuning(RUN_MODES.FREE).catch(() => ({}));
    dailyMinePreviewCleanup?.();
    dailyMinePreviewCleanup = mountDailyMinePreviews({ day: today, tuning: freeTuning });
    const restored = await wallet.restore();
    if (restored) {
      serverPlayer = restored;
      profile = restored.profile;
      saveProfile(profile);
      game.setProfile(profile);
      await refreshPaymentStatus(true);
    }
    await refreshArena(true);
    await mountMineHub(apiClient);
  } catch (error) {
    console.warn('[MATT Mine] Server bootstrap unavailable.', error);
    await mountMineHub(apiClient);
  }
  const adminButton = $('#admin-button');
  adminButton.hidden = !isLocalPreview;
  adminButton.parentElement?.classList.toggle('public-menu', !isLocalPreview);
  updateMenu();
  if (serverPlayer?.identity?.requiresSetup) openMinerProfile(true);
  await startCompetitionStudioTest();
}

updateMenu();
showScreen('launch');
void bootstrapServer();
