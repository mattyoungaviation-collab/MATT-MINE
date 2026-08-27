import { MattMineGame } from './game/GameV4.js';
import { apiClient } from './game/apiClient.js';
import { prepareProfileImage } from './game/profileImage.js';
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
import { nftGameplayTraits, nftXpProgress } from './game/nftTraits.js';
import {
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
import {
  NftGarageClient,
  NFT_GARAGE_CHESTS,
  NFT_GARAGE_RARITIES,
  NFT_GARAGE_SLOTS,
  crystalWithdrawalAvailability,
  formatTokenUnits as formatGarageTokenUnits,
  garageChestOutcomes,
  garageImageUrl,
  parseTokenUnits
} from './game/nftGarageClient.js';
import {
  enterMobileGameplayFullscreen,
  exitMobileGameplayFullscreen,
  mobilePortraitGameplay,
  touchInputDetected
} from './game/mobile.js';
import {
  needsMobileWalletConnectHandoff,
  rememberRoninWalletChoice,
  roninWalletPairingUrl
} from './game/mobileWalletConnect.js';

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const canvas = $('#game');
const screens = [...document.querySelectorAll('.screen')];
const hud = $('#hud');
const mobileControls = $('#mobile-controls');
const mobileWalletConnectDialog = $('#walletconnect-mobile-dialog');
const mobileWalletConnectOpenRonin = $('#walletconnect-open-ronin');
const mobileWalletConnectCancel = $('#walletconnect-mobile-cancel');
const mobileTransactionDialog = $('#wallet-transaction-dialog');
const mobileTransactionTitle = $('#wallet-transaction-title');
const mobileTransactionCopy = $('#wallet-transaction-copy');
const isLocalPreview = ['localhost', '127.0.0.1', '[::1]'].includes(globalThis.location?.hostname);
const economy = new LocalEconomyStore();
const PRACTICE_CLAIM_PLACEHOLDER_PRICE = 5000;
const ARENA_LEADERBOARD_MODE = 'arena';
const ENDLESS_LEADERBOARD_MODE = 'endless';
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
let activeBoard = ARENA_LEADERBOARD_MODE;
let serverConfig = null;
let serverPlayer = null;
let endlessPlayerStats = null;
let pendingKeybindings = defaultKeybindings();
let activeServerRun = null;
let pendingRunFinalization = null;
let runFinalizationBusy = false;
let nftPracticeRecoveryBusy = false;
let lockedMinerRecoveryBusy = false;
let nftGarageBusy = false;
let nftGarageSnapshot = null;
let pendingGarageChestProduct = null;
let nftCrystalBankBusy = false;
let nftWalletSnapshot = null;
let nftCrystalTransactionHash = '';
const SELECTED_MINER_STORAGE_KEY = 'matt-mine:selected-nft-miner';
const PENDING_MINE_STORAGE_KEY = 'matt-mine:pending-mine-destination';
const ENDLESS_RUN_STORAGE_KEY = 'matt-mine:endless-run-v1';
let selectedNftMinerId = 0;
let minerSelectionBusy = false;
let pendingMineDestination = restoredPendingMineDestination();
let paymentStatus = null;
let publicPaymentStatus = null;
let endlessPublicStatus = null;
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
let activeEndlessTranscript = null;
let endlessCheckpointBusy = false;
let activePracticeClaim = null;
let resultScreenMode = null;
let returnToMinerAfterRun = false;
let activeBetaTools = null;
let paidRevivePending = false;
let paidReviveBusy = false;
let paidReviveContext = null;
let pendingAvatarDataUrl = '';
let abandonConfirmUntil = 0;
let abandonResetTimer = null;
let touchInputActive = touchInputDetected(globalThis);
let liveDashboardTimer = null;
let liveDashboardBusy = false;
const wallet = new RoninWalletAdapter({
  api: apiClient,
  onInvalidated(reason) {
    serverPlayer = null;
    endlessPlayerStats = null;
    activeServerRun = null;
    activeArenaRun = null;
    activeArenaTranscript = null;
    activeEndlessTranscript = null;
    nftGarageSnapshot = null;
    nftWalletSnapshot = null;
    nftCrystalTransactionHash = '';
    arenaPlayer = normalizeArenaPlayer();
    profile = loadProfile();
    game?.setProfile(profile);
    showCrystalTransaction('');
    renderWalletCrystalBank();
    updateMenu();
    toast(reason);
  }
});
const nftGarage = new NftGarageClient({ wallet, api: apiClient });

const ui = {
  healthText: $('#health-text'),
  healthFill: $('#health-fill'),
  shieldRow: $('#shield-row'),
  shieldText: $('#shield-text'),
  shieldFill: $('#shield-fill'),
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
  endlessHud: $('#endless-hud'),
  endlessPhase: $('#endless-phase'),
  endlessRequired: $('#endless-required'),
  endlessDifficulty: $('#endless-difficulty'),
  endlessCapability: $('#endless-capability'),
  endlessDanger: $('#endless-danger'),
  endlessModifier: $('#endless-modifier'),
  arenaRoundTimer: $('#arena-round-timer'),
  arenaRoundTime: $('#arena-round-time'),
  weaponSlots: [...document.querySelectorAll('.weapon-slot')],
  weaponButtons: [...document.querySelectorAll('.weapon-button')],
  attackButton: $('#attack-button')
};

function showScreen(id = null) {
  for (const screen of screens) screen.classList.toggle('active', screen.id === id);
  document.body.classList.toggle('launch-active', id === 'launch');
  document.body.dataset.activeScreen = id || 'game';
  for (const button of document.querySelectorAll('#site-nav [data-site-action]')) {
    const action = button.dataset.siteAction;
    const active = (action === 'mines' && id === 'menu') ||
      (action === 'how-to-play' && id === 'how-to-play') ||
      (action === 'leaderboards' && id === 'leaderboards') ||
      (action === 'pass' && (id === 'mine-pass' || id === 'pass-mine' || id === 'pass-cosmetics')) ||
      (action === 'account' && (id === 'miner-profile' || id === 'miner-select'));
    button.classList.toggle('active', active);
  }
  syncLiveDashboardPolling(id);
}

function syncLiveDashboardPolling(screenId) {
  clearInterval(liveDashboardTimer);
  liveDashboardTimer = null;
  const liveScreens = new Set([
    'launch', 'miner-select', 'menu', 'pass-mine', 'miner-profile',
    'mine-pass', 'daily-arena', 'leaderboards'
  ]);
  if (!serverPlayer || !liveScreens.has(screenId)) return;
  liveDashboardTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && !app.classList.contains('gameplay-active')) {
      void refreshVisibleDashboard(screenId);
    }
  }, 30_000);
}

async function refreshVisibleDashboard(screenId) {
  if (liveDashboardBusy || !serverPlayer || !apiClient.hasSession()) return;
  liveDashboardBusy = true;
  try {
    const [playerResult, paymentResult, endlessResult] = await Promise.allSettled([
      apiClient.me(),
      serverConfig?.realPaymentsEnabled === true ? apiClient.paymentStatus() : Promise.resolve(null),
      apiClient.endlessStatus()
    ]);
    if (playerResult.status === 'fulfilled') {
      serverPlayer = playerResult.value;
      profile = serverPlayer.profile;
      saveProfile(profile);
      game.setProfile(profile);
    }
    if (paymentResult?.status === 'fulfilled') {
      if (paymentResult.value) {
        paymentStatus = paymentResult.value;
        applyPassInventory(paymentStatus.passInventory);
      }
    }
    if (endlessResult.status === 'fulfilled') endlessPublicStatus = endlessResult.value;
    updateMenu();
    if (screenId === 'daily-arena') await refreshArena(true);
    if (screenId === 'leaderboards') await renderServerLeaderboard(activeBoard);
    if (screenId === 'miner-select') await refreshWalletCrystalBank(true);
    const liveState = $('#profile-live-state');
    if (liveState) liveState.textContent = `LIVE · ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } finally {
    liveDashboardBusy = false;
  }
}

function applyTouchInputMode(active = touchInputActive) {
  touchInputActive = Boolean(active);
  document.documentElement.classList.toggle('touch-input', touchInputActive);
  app.classList.toggle('touch-input', touchInputActive);
  syncMobileGameplayLayout();
  mobileControls.setAttribute(
    'aria-hidden',
    String(!(touchInputActive && hud.classList.contains('active')))
  );
}

function syncMobileGameplayLayout() {
  const portrait = mobilePortraitGameplay(globalThis, touchInputActive);
  document.documentElement.classList.toggle('portrait-mobile', portrait);
  app.classList.toggle('portrait-mobile', portrait);
  requestAnimationFrame(() => globalThis.__MATT_MINE_GAME__?.resize?.());
}

function setGameplayUi(active) {
  hud.classList.toggle('active', active);
  mobileControls.classList.toggle('active', active);
  app.classList.toggle('gameplay-active', active);
  mobileControls.setAttribute('aria-hidden', String(!(active && touchInputActive)));
  syncMobileGameplayLayout();
  if (!active) {
    if ($('#beta-tools')) $('#beta-tools').hidden = true;
    if ($('#controller-pause-overlay')) $('#controller-pause-overlay').hidden = true;
  }
}

function requestGameplayFullscreen() {
  if (!touchInputActive) return;
  void enterMobileGameplayFullscreen(app, window);
}

function leaveGameplayFullscreen() {
  void exitMobileGameplayFullscreen(window);
}

function showMobileWalletTransactionRequest({ transaction, nonce, index, count }) {
  if (wallet.providerKind !== 'walletconnect' || !needsMobileWalletConnectHandoff(window)) return;
  const approval = transaction.kind === 'approve';
  mobileTransactionTitle.textContent = approval ? 'Approve MATT in Ronin' : 'Send Arena payment in Ronin';
  mobileTransactionCopy.textContent = approval
    ? `Step ${index + 1} of ${count}: approve the exact Arena allowance. Payment nonce ${nonce}.`
    : `Step ${index + 1} of ${count}: submit the actual Arena entry transaction. Payment nonce ${nonce}.`;
  if (typeof mobileTransactionDialog.showModal === 'function') {
    if (!mobileTransactionDialog.open) mobileTransactionDialog.showModal();
  } else {
    mobileTransactionDialog.setAttribute('open', '');
  }
}

function closeMobileWalletTransactionRequest() {
  if (typeof mobileTransactionDialog.close === 'function' && mobileTransactionDialog.open) {
    mobileTransactionDialog.close();
  } else {
    mobileTransactionDialog.removeAttribute('open');
  }
}

applyTouchInputMode();
globalThis.matchMedia?.('(pointer: coarse)')?.addEventListener?.('change', () => {
  applyTouchInputMode(touchInputDetected(globalThis));
});
window.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch' && !touchInputActive) applyTouchInputMode(true);
}, { passive: true });
window.addEventListener('resize', syncMobileGameplayLayout);
window.visualViewport?.addEventListener?.('resize', syncMobileGameplayLayout);
globalThis.screen?.orientation?.addEventListener?.('change', syncMobileGameplayLayout);

function applyPassInventory(passInventory) {
  if (!passInventory) return;
  if (serverPlayer) serverPlayer.passInventory = passInventory;
  if (paymentStatus) paymentStatus.passInventory = passInventory;
  game?.setCosmetics(passInventory.equipped || {});
}

function disconnectedWalletCopy() {
  const chainName = String(serverConfig?.chainName || 'RONIN MAINNET').toUpperCase();
  if (globalThis.ronin?.provider?.request) {
    return {
      launchLabel: 'CONNECT RONIN',
      menuLabel: 'CONNECT RONIN',
      networkLabel: `${chainName} · SIGN TO PLAY RANKED`,
      freeRunLabel: 'SIGN IN WITH RONIN',
      title: 'Sign a one-time message with Ronin Wallet. No transaction is sent.'
    };
  }
  return {
    launchLabel: 'WALLETCONNECT',
    menuLabel: 'CONNECT WALLET',
    networkLabel: `WALLETCONNECT · ${chainName}`,
    freeRunLabel: 'CONNECT WALLET',
    title: 'Connect Ronin Wallet through WalletConnect. No transaction is sent.'
  };
}

function updateMenu() {
  const walletCopy = disconnectedWalletCopy();
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
  $('#menu-depth').textContent = String(profile.bestDepth);
  $('#menu-score').textContent = formatNumber(profile.bestScore);
  $('#wallet-label').textContent = connected
    ? serverPlayer.identity?.name || abbreviateAddress(serverPlayer.address)
    : walletBusy ? 'CONNECTING…' : walletCopy.menuLabel;
  $('#wallet-network').textContent = connected
    ? `${serverConfig?.chainName || 'RONIN'} · SERVER VERIFIED`
    : walletCopy.networkLabel;
  $('#wallet-button').title = walletCopy.title;
  $('#wallet-button').classList.toggle('connected', connected);
  $('#wallet-button').disabled = walletBusy;
  if ($('#site-account-label')) $('#site-account-label').textContent = connected
    ? serverPlayer.identity?.name || 'MINER PROFILE'
    : walletBusy ? 'CONNECTING…' : 'CONNECT WALLET';
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
  renderEndlessMenuStatus();
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
  renderInterruptedNftPractice();
  $('#beta-run-button').hidden = serverPlayer?.expansion?.betaAvailable !== true;
  renderPassProgress();
  renderGameplayPreferences();
  renderMineBriefings({ connected, freeAccess, passActive, remainingPassDays, paidCredits, paidRunsToday, paidRunPrice });
  renderProfileDashboard();
  if (connected && !liveDashboardTimer) {
    syncLiveDashboardPolling(document.querySelector('.screen.active')?.id || null);
  }
}

function renderInterruptedNftPractice() {
  const panel = $('#interrupted-nft-practice');
  const button = $('#resume-nft-practice-button');
  const copy = $('#interrupted-nft-practice-copy');
  if (!panel || !button || !copy) return;
  const interrupted = serverPlayer?.interruptedNftPractice;
  panel.hidden = !interrupted;
  if (!interrupted) return;
  copy.textContent = `Miner #${interrupted.minerId} is locked to a legacy run that cannot be resumed. Forfeiting applies the on-chain death rules, then starts public Practice.`;
  button.disabled = nftPracticeRecoveryBusy;
  button.textContent = nftPracticeRecoveryBusy ? 'FORFEITING OLD RUN…' : 'FORFEIT OLD RUN & START PRACTICE';
}

function renderMineBriefings({ connected, freeAccess, passActive, remainingPassDays, paidCredits, paidRunsToday, paidRunPrice }) {
  const dailyStatus = $('#daily-entry-status');
  const dailyStart = $('#start-daily-run-button');
  if (dailyStatus) {
    dailyStatus.textContent = !connected
      ? 'RONIN SIGN-IN REQUIRED'
      : freeAccess.allowed
        ? 'FREE RUN READY'
        : freeAccess.reason.toUpperCase();
  }
  if ($('#daily-attempt-value')) $('#daily-attempt-value').textContent = freeAccess.allowed ? '1 READY' : 'USED';
  if ($('#daily-best-value')) $('#daily-best-value').textContent = formatNumber(serverPlayer?.scores?.free || 0);
  if (dailyStart) {
    dailyStart.disabled = connected && !freeAccess.allowed;
    dailyStart.textContent = !connected
      ? 'CONNECT RONIN TO PLAY'
      : freeAccess.allowed
        ? 'START DAILY RUN'
        : 'DAILY RUN USED';
  }

  if ($('#pass-mine-state')) {
    $('#pass-mine-state').textContent = passActive
      ? `PASS ACTIVE · ${remainingPassDays} DAYS LEFT`
      : 'MINE PASS REQUIRED';
  }
  if ($('#pass-credit-value')) $('#pass-credit-value').textContent = formatNumber(paidCredits);
  const paidDailyLimit = serverConfig?.realPaymentsEnabled === true
    ? paymentStatus?.paidRuns?.dailyLimit || 10
    : economy.state.settings.maxPaidRunsPerDay;
  if ($('#pass-bought-value')) $('#pass-bought-value').textContent = `${paidRunsToday} / ${paidDailyLimit}`;
  if ($('#pass-best-value')) $('#pass-best-value').textContent = formatNumber(serverPlayer?.scores?.paid || 0);
  const passStart = $('#start-pass-mine-button');
  if (passStart) {
    passStart.disabled = connected && passActive && paidCredits < 1;
    passStart.textContent = !connected
      ? 'CONNECT RONIN TO CONTINUE'
      : !passActive
        ? 'GET MINE PASS'
        : paidCredits > 0
          ? 'START PASS RUN · USE 1 CREDIT'
          : 'BUY A RUN CREDIT FIRST';
  }
  const buyCredit = $('#buy-pass-credit-button');
  if (buyCredit) {
    buyCredit.disabled = !passActive || paymentBusy || paymentStatus?.paidRuns?.paused === true;
    buyCredit.textContent = paidRunPrice === null || paidRunPrice === undefined
      ? 'BUY RUN CREDIT'
      : `BUY ANOTHER CREDIT · ${trimNumber(paidRunPrice)} RON`;
  }
}

function renderProfileDashboard() {
  if (!$('#profile-best-score')) return;
  const currentProfile = serverPlayer?.profile || profile;
  $('#profile-best-score').textContent = formatNumber(currentProfile.bestScore || 0);
  $('#profile-best-depth').textContent = formatNumber(currentProfile.bestDepth || 0);
  $('#profile-total-runs').textContent = formatNumber(currentProfile.totalRuns || 0);

  const liveProgress = paymentStatus?.passProgress || serverPlayer?.passProgress;
  const xp = Number(liveProgress?.xp || 0);
  const progress = liveProgress || passLevel(xp);
  $('#profile-pass-level').textContent = String(progress.level || 1);
  $('#profile-pass-xp').textContent = liveProgress?.nextLevelXp
    ? `${formatNumber(liveProgress.currentLevelXp)} / ${formatNumber(liveProgress.nextLevelXp)} XP`
    : `${formatNumber(xp)} XP`;
  $('#profile-pass-fill').style.width = `${Math.round(Number(progress.progress || 0) * 100)}%`;
  const activePass = serverConfig?.realPaymentsEnabled === true
    ? paymentStatus?.pass?.active === true
    : passIsActive(economy.state);
  const days = serverConfig?.realPaymentsEnabled === true && paymentStatus
    ? Math.max(0, Math.ceil((paymentStatus.pass.expiresAt - Date.now()) / 86_400_000))
    : passDaysRemaining(economy.state);
  $('#profile-pass-days').textContent = activePass ? `${days} DAYS LEFT` : 'PASS INACTIVE';
  $('#profile-pass-badge').textContent = activePass ? `PASS ACTIVE · ${days} DAYS LEFT` : 'FREE TIER';


  const recentRuns = Array.isArray(serverPlayer?.recentRuns) ? serverPlayer.recentRuns : [];
  const compactRows = recentRuns.slice(0, 4).map((run) => `<tr>
    <td>${escapeHtml(profileRunLabel(run.mode))}</td>
    <td>${escapeHtml(formatProfileRunDate(run.finishedAt))}</td>
    <td>${formatNumber(run.result?.score || 0)}</td>
    <td>${run.result?.extracted ? 'EXTRACTED' : 'VERIFIED'}</td>
  </tr>`).join('');
  replaceProfileMarkup($('#profile-recent-runs'), compactRows || '<tr><td colspan="4">No completed server runs yet.</td></tr>');
  replaceProfileMarkup($('#profile-full-run-history'), recentRuns.map((run) => `<tr>
    <td>${escapeHtml(profileRunLabel(run.mode))}</td>
    <td>${escapeHtml(formatProfileRunDate(run.finishedAt))}</td>
    <td>${formatNumber(run.result?.score || 0)}</td>
    <td>${formatNumber(run.result?.depth || 0)}</td>
    <td>${run.result?.extracted ? 'EXTRACTED' : 'VERIFIED'}</td>
  </tr>`).join('') || '<tr><td colspan="5">No completed server runs yet.</td></tr>');

  const endlessLifetime = endlessPlayerStats?.lifetime || {};
  if ($('#profile-endless-depth')) {
    $('#profile-endless-depth').textContent = formatNumber(endlessLifetime.deepestPhase || 0);
    $('#profile-endless-score').textContent = formatNumber(endlessLifetime.highestScore || 0);
    $('#profile-endless-runs').textContent = formatNumber(endlessLifetime.totalRuns || 0);
    $('#profile-endless-crystals').textContent = formatNumber(endlessLifetime.crystalsBanked || 0);
    $('#profile-endless-enemies').textContent = formatNumber(endlessLifetime.enemiesDefeated || 0);
    $('#profile-endless-ore').textContent = formatNumber(endlessLifetime.oreBroken || 0);
    $('#profile-endless-xp').textContent = formatNumber(endlessLifetime.minerXpBanked || 0);
    $('#profile-endless-time').textContent = formatEndlessDuration(endlessLifetime.totalDurationMs || 0);
  }
  const endlessHistory = Array.isArray(endlessPlayerStats?.history) ? endlessPlayerStats.history : [];
  replaceProfileMarkup($('#profile-endless-run-history'), endlessHistory.map((run) => `<tr>
    <td>${escapeHtml(formatProfileRunDate(run.finishedAt))}</td>
    <td>#${formatNumber(run.minerId)} · L${formatNumber(run.minerLevel)}</td>
    <td>${formatNumber(run.highestPhase)}</td>
    <td>${formatNumber(run.score)}</td>
    <td>${formatNumber(run.crystalsBanked)}</td>
    <td>${formatNumber(run.oreBroken)}</td>
    <td>${formatNumber(run.enemiesDefeated)}</td>
    <td>${escapeHtml(formatEndlessDuration(run.durationMs))}</td>
    <td>${formatNumber(run.minerXpEarned)} / ${formatNumber(run.minerXpBanked)}</td>
    <td>${run.scoreRank ? `S #${formatNumber(run.scoreRank)}` : '—'}${run.depthRank ? ` · D #${formatNumber(run.depthRank)}` : ''}
      <details class="endless-run-details"><summary>EXACT STATS</summary><div>
        <span><b>Score</b>${escapeHtml(formatEndlessBreakdown(run.scoreBreakdown))}</span>
        <span><b>Enemies</b>${escapeHtml(formatEndlessBreakdown(run.enemyBreakdown))}</span>
        <span><b>Ore</b>${escapeHtml(formatEndlessBreakdown(run.oreBreakdown))}</span>
        <span><b>Crystals</b>${formatNumber(run.crystalsMined)} mined · ${formatNumber(run.crystalsBanked)} banked · ${formatNumber(run.crystalsLost)} lost</span>
        <span><b>Run</b>Capability ${formatNumber(run.minerCapability)} · Difficulty ${formatNumber(run.maximumDifficulty)} · Integrity ${formatNumber(run.integrityScore)} · Config v${formatNumber(run.configVersion)}</span>
      </div></details>
    </td>
  </tr>`).join('') || '<tr><td colspan="10">No completed Endless runs yet.</td></tr>');

  const equipped = serverPlayer?.passInventory?.equipped || {};
  const weapon = cosmeticById(equipped.weapon);
  const frame = cosmeticById(equipped.frame);
  const selectedCharacter = serverPlayer?.expansion?.selectedCharacter || 'matt';
  const character = serverPlayer?.expansion?.characters?.[selectedCharacter];
  $('#profile-character-name').textContent = character?.name || 'MATT';
  $('#profile-weapon-name').textContent = weapon?.name || 'STANDARD PICKAXE';
  $('#profile-frame-name').textContent = frame?.name || 'STANDARD FRAME';
  replaceProfileMarkup($('#profile-loadout-summary'), `
    <span>CHARACTER · ${escapeHtml(character?.name || 'MATT')}</span>
    <span>WEAPON · ${escapeHtml(weapon?.name || 'STANDARD PICKAXE')}</span>
    <span>FRAME · ${escapeHtml(frame?.name || 'STANDARD FRAME')}</span>`);
}

function replaceProfileMarkup(element, markup) {
  if (!element) return;
  const range = document.createRange();
  range.selectNode(element);
  element.replaceChildren(range.createContextualFragment(markup));
}

function profileRunLabel(mode) {
  if (mode === RUN_MODES.FREE) return 'DAILY MINE';
  if (mode === RUN_MODES.PAID) return 'PASS MINE';
  if (mode === RUN_MODES.PRACTICE) return 'PRACTICE';
  if (mode === RUN_MODES.WEEKLY) return 'SEVEN-DAY MINE';
  if (mode === RUN_MODES.ENDLESS) return 'ENDLESS MINE';
  return String(mode || 'MINE').replaceAll('_', ' ').toUpperCase();
}

function formatProfileRunDate(timestamp) {
  if (!Number(timestamp)) return '—';
  return new Date(Number(timestamp)).toLocaleString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

function activateProfileTab(tabId) {
  for (const button of document.querySelectorAll('[data-profile-tab]')) {
    button.classList.toggle('active', button.dataset.profileTab === tabId);
  }
  for (const panel of document.querySelectorAll('[data-profile-panel]')) {
    panel.classList.toggle('active', panel.dataset.profilePanel === tabId);
  }
}

function openPassMine() {
  updateMenu();
  showScreen('pass-mine');
}

window.addEventListener('mattmine:screen-change', (event) => {
  syncLiveDashboardPolling(event.detail?.screenId || null);
});

function updateLaunch({ connected, freeAccess, passPrice, paidRunPrice, livePayments, passActive }) {
  const walletCopy = disconnectedWalletCopy();
  const walletLabel = $('#launch-wallet-label');
  const walletButton = $('#launch-wallet-button');
  const walletConnectButton = $('#launch-walletconnect-button');
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
    : walletBusy ? 'CONNECTING…' : walletCopy.launchLabel;
  if (walletButton) {
    walletButton.hidden = !connected && !globalThis.ronin?.provider?.request;
    walletButton.disabled = walletBusy;
    walletButton.classList.toggle('connected', connected);
    walletButton.title = walletCopy.title;
  }
  if (walletConnectButton) {
    walletConnectButton.hidden = connected;
    walletConnectButton.disabled = walletBusy;
    walletConnectButton.title = 'Connect through WalletConnect, including the Ronin mobile app.';
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

function openMines() {
  setGameplayUi(false);
  showScreen('menu');
  updateMenu();
}

function selectedOwnedMiner() {
  return ownedNftMiners().find((miner) => miner.minerId === selectedNftMinerId) || null;
}

function openMineRoute(destination) {
  const selected = selectedOwnedMiner();
  if (selected && selected.gameplay?.runLocked !== true) {
    rememberPendingMineDestination();
    if (destination === 'arena') {
      void openArena();
      return;
    }
    if (destination === 'pass-mine') {
      openPassMine();
      return;
    }
    if (destination === 'endless') {
      void startRunMode(RUN_MODES.ENDLESS);
      return;
    }
  }
  rememberPendingMineDestination(destination);
  void openMinerSelect();
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
  $('#profile-title').textContent = requiresSetup ? 'Create Your Miner' : 'Miner Profile';
  $('#profile-intro').textContent = requiresSetup
    ? 'Choose carefully. Your miner name is unique and permanently tied to this wallet.'
    : 'Your identity, permanent progress, and mine history.';
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
  renderProfileDashboard();
  activateProfileTab('overview');
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
    void openMinerSelect();
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

async function connectWallet(options = {}) {
  if (walletBusy) return false;
  walletBusy = true;
  updateMenu();
  const walletConnectWatchdog = options.forceWalletConnect === true && options.showQrModal !== false
    ? setTimeout(() => {
        if (!document.querySelector('w3m-modal.open')) {
          toast('Wallet chooser did not open. In Safari, turn off content blockers for this site, reload, and try again.');
        }
      }, 8_000)
    : null;
  try {
    serverPlayer = await wallet.connect(options);
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
    if (walletConnectWatchdog) clearTimeout(walletConnectWatchdog);
    walletBusy = false;
    updateMenu();
  }
}

function openMobileWalletConnect(pairingUri) {
  mobileWalletConnectOpenRonin.href = roninWalletPairingUrl(pairingUri);
  if (typeof mobileWalletConnectDialog.showModal === 'function') {
    if (!mobileWalletConnectDialog.open) mobileWalletConnectDialog.showModal();
  } else {
    mobileWalletConnectDialog.setAttribute('open', '');
  }
}

function closeMobileWalletConnect() {
  if (typeof mobileWalletConnectDialog.close === 'function' && mobileWalletConnectDialog.open) {
    mobileWalletConnectDialog.close();
  } else {
    mobileWalletConnectDialog.removeAttribute('open');
  }
}

async function refreshServerPlayer() {
  if (!apiClient.hasSession()) {
    serverPlayer = null;
    endlessPlayerStats = null;
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
    await refreshEndlessPlayer(true);
    updateMenu();
    if (serverPlayer.identity?.requiresSetup) openMinerProfile(true);
    return serverPlayer;
  } catch (error) {
    serverPlayer = null;
    endlessPlayerStats = null;
    updateMenu();
    if (error?.code !== 'session_missing') toast(error.message);
    return null;
  }
}

async function refreshEndlessPlayer(silent = false) {
  if (!serverPlayer || !apiClient.hasSession()) {
    endlessPlayerStats = null;
    renderProfileDashboard();
    return null;
  }
  try {
    endlessPlayerStats = await apiClient.endlessPlayer();
    renderProfileDashboard();
    return endlessPlayerStats;
  } catch (error) {
    endlessPlayerStats = null;
    renderProfileDashboard();
    if (!silent) toast(error.message);
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

function applyAcceptedNftSettlement(accepted = {}) {
  const settlement = accepted.nftSettlement || null;
  const miner = settlement?.profile;
  if (serverPlayer && miner?.minerId) {
    cacheOwnedMiner(miner);
    serverPlayer.nftMiner = miner;
  }
  if (serverPlayer && accepted.nftCrystals) serverPlayer.nftCrystals = accepted.nftCrystals;
  return settlement;
}

function nftSettlementMarkup(settlement) {
  if (!settlement) return '';
  const outcome = String(settlement.outcome || 'settled').replaceAll('_', ' ').toUpperCase();
  const minerId = Number(settlement.minerId);
  const crystalsBanked = Number(settlement.crystalsBanked);
  const xpBanked = Number(settlement.xpBanked);
  const miner = Number.isFinite(minerId) ? `MINER #${formatNumber(minerId)}` : 'MINER';
  const rewardsKnown = settlement.crystalsBanked != null && settlement.xpBanked != null &&
    Number.isFinite(crystalsBanked) && Number.isFinite(xpBanked);
  const rewardCopy = rewardsKnown
    ? `${formatNumber(crystalsBanked)} MATT CRYSTALS BANKED · +${formatNumber(xpBanked)} XP`
    : settlement.alreadySettled === true
      ? 'ON-CHAIN SETTLEMENT ALREADY CONFIRMED'
      : 'ON-CHAIN SETTLEMENT CONFIRMED';
  return `<small>${miner} · ${escapeHtml(outcome)} · ${rewardCopy}</small>`;
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
        bossTelemetry: result.bossTelemetry || null,
        crystalsCarried: Math.max(0, Math.floor(result.crystalsCarried || 0)),
        completedPhases: Math.max(0, Math.min(0x1f, Math.floor(result.completedPhases || 0)))
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
    const nftSettlement = applyAcceptedNftSettlement(accepted);
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
    if (nftSettlement) $('#economy-result').innerHTML += nftSettlementMarkup(nftSettlement);
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
      await releaseIssuedServerRun(serverRun, transcript);
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
    if (accepted.profile) {
      profile = accepted.profile;
      saveProfile(profile);
      game.setProfile(profile);
      if (serverPlayer) serverPlayer.profile = accepted.profile;
    }
    if (paymentStatus && accepted.passProgress) {
      paymentStatus.passProgress = accepted.passProgress;
    }
    applyPassInventory(accepted.passInventory);
    const nftSettlement = applyAcceptedNftSettlement(accepted);
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
    if (nftSettlement) $('#economy-result').innerHTML += nftSettlementMarkup(nftSettlement);
    toast('MATT Arena score verified');
    if (nftSettlement) await refreshServerPlayer();
    else await refreshArena(true);
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

function queueFinalizationRetry(retry, label = 'RETRY SCORE SAVE') {
  pendingRunFinalization = retry;
  const retryButton = $('#play-again-button');
  retryButton.hidden = false;
  retryButton.disabled = false;
  retryButton.textContent = label;
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
  const projected = Math.max(0, Math.floor(result?.projected || 0));
  const isExpired = claim.status === 'pending' && claim.expiresAt <= Date.now();
  const paymentsEnabled = serverConfig?.realPaymentsEnabled === true;

  if (claim.status === 'claimed') {
    info.innerHTML = `<strong>Practice has no currency rewards.</strong><span>Final score: ${formatNumber(projected)}.</span>`;
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
    <span>Projected score: ${formatNumber(projected)}</span>
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

async function startRunMode(mode, options = {}) {
  const useServer =
    options.restartInterruptedNftPractice === true ||
    (mode === RUN_MODES.PAID && serverConfig?.paidRunsEnabled === true) ||
    mode === RUN_MODES.ENDLESS ||
    mode === RUN_MODES.BETA;
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
    requestGameplayFullscreen();
    let issuedRun = null;
    let issuedTranscript = null;
    try {
      const run = options.restartInterruptedNftPractice === true
        ? await apiClient.restartInterruptedNftPractice()
        : await startApprovedNftServerRun(mode, selectedNftMinerId);
      issuedRun = run;
      activeServerRun = run;
      activeEndlessTranscript = mode === RUN_MODES.ENDLESS ? createEndlessTranscript(run) : null;
      if (mode === RUN_MODES.ENDLESS) persistEndlessRun(run);
      if (serverPlayer && options.restartInterruptedNftPractice === true) {
        serverPlayer.interruptedNftPractice = null;
      }
      activeArenaTranscript = run.verification === 'fixed-step-input-replay'
        ? new ArenaTranscript(apiClient, run, {
            appendEvents: (...args) => apiClient.appendCompetitiveEvents(...args)
          })
        : null;
      issuedTranscript = activeArenaTranscript || activeEndlessTranscript;
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
        endlessRunId: run.runId,
        endlessConfigVersion: run.configVersion,
        endlessManifest: run.manifest,
        endlessContinuation: run.phaseInitialState,
        currentPhase: run.currentPhase,
        competitionSnapshot: run.competitionSnapshot,
        allowPaidRevive: run.paidReviveEligible === true,
        reviveLimitPerRun: run.reviveLimitPerRun,
        reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds,
        nftRun: run.nftRun || null
      });
      if (run.tuning?._minePassBenefits?.active === true) {
        toast('Mine Pass active · 2× Pass XP');
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
      if (issuedRun) await releaseIssuedServerRun(issuedRun, issuedTranscript);
      leaveGameplayFullscreen();
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
  requestGameplayFullscreen();
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

async function openMinerSelect() {
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  const miners = ownedNftMiners();
  if (!miners.some((miner) => miner.minerId === selectedNftMinerId)) {
    rememberSelectedMiner(miners[0]?.minerId || 0);
  }
  renderMinerSelect();
  const storedMinerId = Number(sessionStorage.getItem(SELECTED_MINER_STORAGE_KEY) || 0);
  if (!selectedNftMinerId && storedMinerId >= 1 && storedMinerId <= 1_000) {
    $('#miner-number-input').value = String(storedMinerId);
  }
  showScreen('miner-select');
  renderWalletCrystalBank();
  void refreshWalletCrystalBank();
}

function ownedNftMiners() {
  if (Array.isArray(serverPlayer?.nftMiners)) return serverPlayer.nftMiners;
  return serverPlayer?.nftMiner ? [serverPlayer.nftMiner] : [];
}

function rememberSelectedMiner(minerId) {
  const normalizedMinerId = Number.isSafeInteger(Number(minerId)) && Number(minerId) > 0
    ? Number(minerId)
    : 0;
  selectedNftMinerId = normalizedMinerId;
  try {
    if (normalizedMinerId) sessionStorage.setItem(SELECTED_MINER_STORAGE_KEY, String(normalizedMinerId));
    else sessionStorage.removeItem(SELECTED_MINER_STORAGE_KEY);
  } catch {}
}

function restoredPendingMineDestination() {
  try {
    const destination = sessionStorage.getItem(PENDING_MINE_STORAGE_KEY) || '';
    return ['arena', 'pass-mine', 'endless'].includes(destination) ? destination : '';
  } catch {
    return '';
  }
}

function rememberPendingMineDestination(destination = '') {
  const normalizedDestination = ['arena', 'pass-mine', 'endless'].includes(destination) ? destination : '';
  pendingMineDestination = normalizedDestination;
  try {
    if (normalizedDestination) sessionStorage.setItem(PENDING_MINE_STORAGE_KEY, normalizedDestination);
    else sessionStorage.removeItem(PENDING_MINE_STORAGE_KEY);
  } catch {}
  return normalizedDestination;
}

function cacheOwnedMiner(miner) {
  const miners = ownedNftMiners().filter((candidate) => candidate.minerId !== miner.minerId);
  serverPlayer.nftMiners = [...miners, miner].sort((left, right) => left.minerId - right.minerId);
  serverPlayer.nftMiner = serverPlayer.nftMiners[0] || null;
  const ids = new Set(Array.isArray(serverPlayer.nftMinerIds) ? serverPlayer.nftMinerIds : []);
  ids.add(miner.minerId);
  serverPlayer.nftMinerIds = [...ids].sort((left, right) => left - right);
  serverPlayer.nftMinerCount = Math.max(Number(serverPlayer.nftMinerCount) || 0, serverPlayer.nftMinerIds.length);
}

function setMinerNumberStatus(message, state = '') {
  const status = $('#miner-number-status');
  if (!status) return;
  status.textContent = message;
  status.className = state;
}

async function selectMinerByNumber() {
  const input = $('#miner-number-input');
  const minerId = Number(input?.value);
  if (!Number.isSafeInteger(minerId) || minerId < 1 || minerId > 1_000) {
    setMinerNumberStatus('Enter a Miner number from 1 to 1,000.', 'error');
    return false;
  }
  if (!serverPlayer) {
    const connected = await connectWallet();
    if (!connected) return false;
  }
  if (minerSelectionBusy) return false;
  minerSelectionBusy = true;
  $('#miner-number-submit').disabled = true;
  setMinerNumberStatus(`Checking ownership of Miner #${minerId} on Ronin Mainnet…`);
  try {
    const miner = await apiClient.ownedMiner(minerId);
    cacheOwnedMiner(miner);
    rememberSelectedMiner(miner.minerId);
    renderMinerSelect();
    if (!$('#miner-command-center').hidden) {
      nftGarageSnapshot = null;
      void refreshNftGarage();
    }
    setMinerNumberStatus(`Miner #${miner.minerId} selected. You can enter the mines now.`, 'success');
    return true;
  } catch (error) {
    setMinerNumberStatus(error?.message || `Miner #${minerId} could not be loaded.`, 'error');
    return false;
  } finally {
    minerSelectionBusy = false;
    $('#miner-number-submit').disabled = false;
  }
}

function renderMinerSelect() {
  const grid = $('#miner-select-grid');
  if (!grid) return;
  const miners = ownedNftMiners();
  grid.replaceChildren();
  if (!miners.length) {
    const empty = document.createElement('article');
    empty.className = 'miner-select-empty';
    const title = document.createElement('strong');
    title.textContent = 'SELECT A MINER NUMBER';
    const note = document.createElement('span');
    note.textContent = 'Enter a Miner number above. Ownership will be verified directly on Ronin Mainnet.';
    empty.append(title, note);
    grid.append(empty);
  }
  for (const miner of miners) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `miner-select-option${miner.minerId === selectedNftMinerId ? ' active' : ''}`;
    const image = document.createElement('img');
    image.src = minerImageUrl(miner);
    image.alt = '';
    const copy = document.createElement('span');
    const token = document.createElement('small');
    token.textContent = `MINER NFT #${miner.minerId}`;
    const evolution = document.createElement('strong');
    evolution.textContent = evolutionName(miner);
    const level = document.createElement('b');
    level.textContent = `LEVEL ${miner.progression?.level || 1}`;
    copy.append(token, evolution, level);
    button.append(image, copy);
    button.addEventListener('click', () => {
      rememberSelectedMiner(miner.minerId);
      $('#miner-number-input').value = String(miner.minerId);
      setMinerNumberStatus(`Miner #${miner.minerId} selected. You can enter the mines now.`, 'success');
      if (!$('#miner-command-center').hidden) {
        nftGarageSnapshot = null;
        void refreshNftGarage();
      }
      renderMinerSelect();
    });
    grid.append(button);
  }

  const selected = miners.find((miner) => miner.minerId === selectedNftMinerId) || null;
  const image = $('#selected-miner-image');
  const empty = $('#selected-miner-empty');
  image.hidden = !selected;
  empty.hidden = Boolean(selected);
  if (selected) image.src = minerImageUrl(selected);
  else empty.textContent = serverPlayer
    ? 'NO MINER NFT SELECTED\nCRYSTAL BANK AVAILABLE BELOW'
    : 'CONNECT RONIN\nTO LOAD MINERS';
  $('#selected-miner-name').textContent = selected ? `MATT MINE MINER #${selected.minerId}` : 'NO MINER SELECTED';
  const stats = $('#selected-miner-stats');
  stats.replaceChildren();
  if (selected) {
    const traits = nftGameplayTraits({ nftRun: { profile: selected } });
    const xp = nftXpProgress(selected);
    const values = traits
      ? [
          ['LEVEL', traits.level],
          ['BANKED XP', `${xp.bankedXp.toLocaleString()} XP`],
          ['NEXT LEVEL', xp.nextLevelXp === null ? 'MAX LEVEL' : `${xp.nextLevelXp.toLocaleString()} XP`],
          ['HEALTH', traits.maximumHealth],
          ['ARMOR SHIELD', traits.armorShield],
          ['PICKAXE', traits.pickaxeAttack],
          ['BLASTER', traits.blasterAttack],
          ['DYNAMITE', traits.dynamiteAttack],
          ['HEAL', traits.healAmount],
          ['CRYSTAL CARRY', traits.carryCapacity.toLocaleString()],
          ['DEATH RETENTION', `${(traits.deathRetentionBps / 100).toFixed(0)}%`],
          ['CRYSTALS / HOUR', traits.crystalsPerHour],
          ['EARNING', minerEarningLabel(selected, traits)]
        ]
      : [
          ['LEVEL', selected.progression?.level || 1],
          ['BANKED XP', `${xp.bankedXp.toLocaleString()} XP`],
          ['NEXT LEVEL', xp.nextLevelXp === null ? 'MAX LEVEL' : `${xp.nextLevelXp.toLocaleString()} XP`],
          ['HEALTH', selected.gameplay?.maximumHealth || 100],
          ['CRYSTAL CARRY', `${selected.gameplay?.crystalCarryMultiplier || 1}x`],
          ['ARMOR', selected.equipped?.armor ? selected.gameplay?.armorEffective ? 'ACTIVE' : 'DAMAGED' : 'NONE']
        ];
    for (const [label, value] of values) {
      const row = document.createElement('span');
      const name = document.createElement('small');
      name.textContent = label;
      const result = document.createElement('strong');
      result.textContent = String(value);
      row.append(name, result);
      stats.append(row);
    }
  }
  const enter = $('#enter-mines-button');
  const minerLocked = selected?.gameplay?.runLocked === true;
  enter.disabled = !selected || lockedMinerRecoveryBusy;
  enter.textContent = minerLocked
    ? lockedMinerRecoveryBusy ? 'FORFEITING LOCKED RUN...' : 'FORFEIT LOCKED RUN'
    : pendingMineDestination === 'arena'
      ? 'ENTER MATT ARENA'
      : pendingMineDestination === 'pass-mine'
        ? 'ENTER PASS MINE'
        : 'ENTER MINES';
  const loadout = $('#select-loadout-button');
  loadout.disabled = !selected || nftGarageBusy;
  loadout.textContent = nftGarageBusy ? 'LOADING LOADOUT...' : 'MANAGE LOADOUT';
  if (selected) $('#miner-number-input').value = String(selected.minerId);
}

function minerEarningLabel(miner, traits) {
  const value = miner?.gameplay?.earningStatus ?? miner?.earningStatus;
  if (typeof value === 'string' && value.trim()) return value.replaceAll('_', ' ').toUpperCase();
  if (typeof value === 'number') return ['NOT ELIGIBLE', 'ACTIVE', 'INACTIVE'][value] || 'NOT ELIGIBLE';
  return traits.level === 100 && traits.crystalsPerHour > 0 ? 'ACTIVE' : 'NOT ELIGIBLE';
}

function evolutionName(miner) {
  return ['ROOKIE MINER', 'APPRENTICE MINER', 'CRYSTAL HUNTER', 'VETERAN MINER', 'VAULT RAIDER', 'ELITE MINER', 'MINE LEGEND'][miner?.progression?.evolution || 0] || 'MATT MINE MINER';
}

function minerImageUrl(miner) {
  const equipment = miner?.equipped || {};
  const revision = [
    miner?.progression?.level || 1,
    miner?.progression?.bankedXp || 0,
    equipment.weapon || 0,
    equipment.backpack || 0,
    equipment.helmet || 0,
    equipment.armor || 0,
    miner?.gameplay?.armorEffective === false ? 'damaged' : 'active'
  ].join('-');
  return `/api/nft/miners/${miner.minerId}/image.png?v=${encodeURIComponent(revision)}`;
}

async function resumeInterruptedNftPractice() {
  if (nftPracticeRecoveryBusy || !serverPlayer?.interruptedNftPractice) return;
  const minerId = Number(serverPlayer.interruptedNftPractice.minerId || 0);
  const approved = window.confirm(
    `Forfeit Miner #${minerId}'s legacy run and start public Practice?\n\n` +
    'The old run cannot be resumed. It will be ended under the on-chain death rules: no XP or Crystals, the active Backpack burns, and equipped Armor is damaged.'
  );
  if (!approved) return;
  nftPracticeRecoveryBusy = true;
  updateMenu();
  try {
    await startRunMode(RUN_MODES.PRACTICE, { restartInterruptedNftPractice: true });
  } finally {
    nftPracticeRecoveryBusy = false;
    updateMenu();
  }
}

async function recoverLockedMinerRun(minerId) {
  if (lockedMinerRecoveryBusy || !minerId) return;
  const approved = window.confirm(
    `Forfeit Miner #${minerId}'s locked run? This does not resume the run. The correct on-chain game contract will record a death at its last verified checkpoint. Published death-retention rules apply; any active Backpack will be burned and equipped Armor will be damaged.`
  );
  if (!approved) return;
  lockedMinerRecoveryBusy = true;
  renderMinerSelect();
  try {
    const recovery = await apiClient.recoverLockedMinerRun(minerId);
    if (recovery.profile) cacheOwnedMiner(recovery.profile);
    else cacheOwnedMiner(await apiClient.ownedMiner(minerId));
    renderMinerSelect();
    setMinerNumberStatus(`Miner #${minerId}'s prior run was forfeited. The Miner is unlocked and ready.`, 'success');
    toast(`Miner #${minerId} run forfeited and unlocked`);
  } catch (error) {
    toast(error?.message || `Miner #${minerId} could not be unlocked.`);
  } finally {
    lockedMinerRecoveryBusy = false;
    renderMinerSelect();
  }
}

async function openMinerCommandCenter() {
  if (!selectedNftMinerId || !serverPlayer) return;
  const panel = $('#miner-command-center');
  if (nftGarageSnapshot?.minerId !== selectedNftMinerId) nftGarageSnapshot = null;
  panel.hidden = false;
  renderNftGarage();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await refreshNftGarage();
}

function closeMinerCommandCenter() {
  $('#miner-command-center').hidden = true;
  $('#selected-miner-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function refreshWalletCrystalBank(silent = false) {
  if (nftCrystalBankBusy || !serverPlayer) return null;
  nftCrystalBankBusy = true;
  if (!silent) setCrystalBankStatus('Reading your wallet-owned Crystal Bank and today\'s live withdrawal limits from Ronin...', 'busy');
  renderWalletCrystalBank();
  try {
    nftWalletSnapshot = await nftGarage.walletSnapshot({ address: serverPlayer.address });
    if (!silent) setCrystalBankStatus('Wallet Crystal Bank synchronized with Ronin Mainnet.');
    return nftWalletSnapshot;
  } catch (error) {
    setCrystalBankStatus(error?.message || 'The Wallet Crystal Bank could not be loaded.', 'error');
    return null;
  } finally {
    nftCrystalBankBusy = false;
    renderWalletCrystalBank();
  }
}

function renderWalletCrystalBank() {
  const snapshot = nftWalletSnapshot ? crystalWithdrawalAvailability(nftWalletSnapshot) : null;
  $('#garage-crystal-wallet-balance').textContent = snapshot
    ? `${formatGarageTokenUnits(snapshot.walletCrystalBalanceRaw)} CRYSTALS`
    : '--';
  $('#garage-crystal-balance').textContent = snapshot
    ? `${formatGarageTokenUnits(snapshot.crystalBalanceRaw)} CRYSTALS`
    : '--';
  $('#garage-crystal-withdrawable').textContent = snapshot
    ? `${formatGarageTokenUnits(snapshot.withdrawableRaw)} CRYSTALS`
    : '--';
  $('#garage-crystal-wallet-remaining').textContent = snapshot
    ? `${formatGarageTokenUnits(snapshot.walletRemainingRaw)} CRYSTALS`
    : '--';
  $('#garage-crystal-reset').textContent = snapshot ? formatCrystalReset(snapshot.nextUtcResetAt) : '--';

  const state = $('#garage-crystal-state');
  if (state) {
    state.textContent = nftCrystalBankBusy
      ? 'SYNCING'
      : !snapshot
        ? 'NOT LOADED'
        : snapshot.crystalBankPaused
          ? 'PAUSED'
          : snapshot.withdrawalAvailable
            ? 'READY'
            : snapshot.crystalBalanceRaw < snapshot.minimumWithdrawalRaw
              ? 'BELOW MINIMUM'
              : 'DAILY LIMIT REACHED';
  }

  const copy = $('#garage-withdraw-copy');
  if (copy) {
    copy.textContent = !snapshot
      ? 'Connect Ronin Wallet to load the live Crystal Bank balance and withdrawal limits.'
      : snapshot.crystalBankPaused
        ? 'Withdrawals are temporarily paused. Your banked MATT Crystals remain safe on-chain.'
        : `Minimum ${formatGarageTokenUnits(snapshot.minimumWithdrawalRaw)}. ` +
          `Your wallet has ${formatGarageTokenUnits(snapshot.walletRemainingRaw)} left today; ` +
          `${formatGarageTokenUnits(snapshot.globalRemainingRaw)} remains in today\'s network-wide limit. ` +
          `Limits reset at ${formatCrystalReset(snapshot.nextUtcResetAt)}.`;
  }

  const max = $('#garage-withdraw-all-button');
  max.disabled = nftCrystalBankBusy || !snapshot?.withdrawalAvailable;
  max.textContent = nftCrystalBankBusy ? 'READING LIMITS...' : 'USE MAX AVAILABLE';
  syncCrystalWithdrawalButton();
}

function syncCrystalWithdrawalButton() {
  const button = $('#garage-withdraw-button');
  const snapshot = nftWalletSnapshot ? crystalWithdrawalAvailability(nftWalletSnapshot) : null;
  let amount = 0n;
  try {
    amount = parseTokenUnits($('#garage-withdraw-input').value);
  } catch {}
  const valid = Boolean(
    snapshot?.withdrawalAvailable &&
    amount >= snapshot.minimumWithdrawalRaw &&
    amount <= snapshot.withdrawableRaw
  );
  button.disabled = nftCrystalBankBusy || !valid;
  button.textContent = nftCrystalBankBusy ? 'WAITING FOR RONIN...' : 'WITHDRAW CRYSTALS';
  return valid;
}

function setCrystalBankStatus(message, state = '') {
  const status = $('#garage-crystal-status');
  if (!status) return;
  status.textContent = message;
  status.className = `garage-status${state ? ` ${state}` : ''}`;
}

function showCrystalTransaction(transactionHash) {
  nftCrystalTransactionHash = transactionHash;
  const link = $('#garage-crystal-receipt');
  if (!link) return;
  link.hidden = !transactionHash;
  if (transactionHash) {
    link.href = `https://explorer.roninchain.com/tx/${encodeURIComponent(transactionHash)}`;
    link.textContent = `VIEW ${abbreviateHash(transactionHash)} ON RONIN`;
  }
}

async function refreshNftGarage() {
  if (nftGarageBusy || !serverPlayer || !selectedNftMinerId || $('#miner-command-center').hidden) return;
  nftGarageBusy = true;
  setGarageStatus(`Loading Miner #${selectedNftMinerId}, equipment, and balances directly from Ronin...`, 'busy');
  renderMinerSelect();
  renderNftGarage();
  try {
    nftGarageSnapshot = await nftGarage.snapshot({
      address: serverPlayer.address,
      minerId: selectedNftMinerId,
      ownedMinerIds: serverPlayer.nftMinerIds || ownedNftMiners().map((miner) => miner.minerId)
    });
    nftWalletSnapshot = crystalWithdrawalAvailability(nftGarageSnapshot);
    setGarageStatus(`Miner #${selectedNftMinerId} is synchronized with Ronin Mainnet.`);
  } catch (error) {
    setGarageStatus(error?.message || 'The Miner Command Center could not load.', 'error');
  } finally {
    nftGarageBusy = false;
    renderMinerSelect();
    renderNftGarage();
    renderWalletCrystalBank();
  }
}

async function loadMoreNftGarageEquipment() {
  const snapshot = nftGarageSnapshot?.minerId === selectedNftMinerId ? nftGarageSnapshot : null;
  if (nftGarageBusy || !snapshot?.equipmentNextCursor) return;
  nftGarageBusy = true;
  setGarageStatus(`Loading more Equipment NFTs for Miner #${snapshot.minerId}...`, 'busy');
  renderMinerSelect();
  renderNftGarage();
  try {
    const nextSnapshot = await nftGarage.loadMoreEquipment(snapshot);
    if (selectedNftMinerId !== snapshot.minerId) return;
    nftGarageSnapshot = nextSnapshot;
    const loaded = nextSnapshot.equipment.length;
    const total = Math.max(Number(nextSnapshot.equipmentTotal || 0), loaded);
    setGarageStatus(nextSnapshot.equipmentInventoryReset
      ? `Equipment ownership changed while loading. Inventory was safely refreshed from the first page (${loaded} of ${total}).`
      : `Loaded ${loaded} of ${total} Equipment NFTs.`);
  } catch (error) {
    setGarageStatus(error?.message || 'More Equipment NFTs could not be loaded.', 'error');
  } finally {
    nftGarageBusy = false;
    renderMinerSelect();
    renderNftGarage();
  }
}

function renderNftGarage() {
  const snapshot = nftGarageSnapshot?.minerId === selectedNftMinerId ? nftGarageSnapshot : null;
  const loadedEquipment = snapshot?.equipment?.length || 0;
  const totalEquipment = snapshot ? Math.max(Number(snapshot.equipmentTotal || 0), loadedEquipment) : 0;
  $('#garage-matt-balance').textContent = snapshot ? `${formatGarageTokenUnits(snapshot.mattBalanceRaw)} MATT` : '--';
  $('#garage-miner-state').textContent = snapshot ? snapshot.runLocked ? 'LOCKED IN RUN' : 'READY' : '--';
  $('#garage-equipment-count').textContent = snapshot
    ? `${loadedEquipment}${totalEquipment > loadedEquipment ? ` / ${totalEquipment}` : ''} ITEMS`
    : '--';
  $('#garage-inventory-state').textContent = nftGarageBusy
    ? 'SYNCING'
    : snapshot?.equipmentNextCursor ? `${totalEquipment - loadedEquipment} MORE` : snapshot ? 'LIVE' : 'NOT LOADED';
  renderGarageLoadout(snapshot);
  renderGarageEquipment(snapshot);
  renderGarageArmor(snapshot);
  renderGarageChests(snapshot);
}

function renderGarageLoadout(snapshot) {
  const container = $('#garage-loadout-slots');
  container.replaceChildren();
  for (const slot of NFT_GARAGE_SLOTS) {
    const tokenId = Number(snapshot?.loadout?.[slot.key] || 0);
    const item = snapshot?.equipment.find((candidate) => candidate.tokenId === tokenId);
    const card = document.createElement('article');
    card.className = 'garage-loadout-slot';
    const label = document.createElement('span');
    label.textContent = slot.label;
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = item?.metadata?.name || (tokenId ? `EQUIPMENT #${tokenId}` : slot.key === 'pickaxe' ? 'STARTER PICKAXE' : 'EMPTY');
    const detail = document.createElement('small');
    detail.textContent = item
      ? `${NFT_GARAGE_RARITIES[item.rarity] || 'UNKNOWN'} · TOKEN #${item.tokenId} · +${item.bonus}${item.damaged ? ' · DAMAGED' : ''}`
      : tokenId ? `TOKEN #${tokenId}` : 'No Equipment NFT equipped';
    copy.append(name, detail);
    card.append(label, copy);
    container.append(card);
  }
  $('#garage-wallet-note').textContent = !snapshot
    ? 'Open the Command Center to read the live loadout.'
    : snapshot.equipmentOperatorApproved
      ? 'Quick equip is enabled. Each equip or unequip is still one real Ronin transaction.'
      : 'The first equip includes one approval for the Loadout contract. Later equips need fewer confirmations.';
}

function renderGarageEquipment(snapshot) {
  const container = $('#garage-equipment-list');
  const loadMore = $('#garage-equipment-load-more');
  container.replaceChildren();
  loadMore.hidden = !snapshot?.equipmentNextCursor;
  loadMore.disabled = nftGarageBusy || !snapshot?.equipmentNextCursor;
  loadMore.textContent = nftGarageBusy && snapshot?.equipmentNextCursor ? 'LOADING EQUIPMENT...' : 'LOAD MORE EQUIPMENT';
  if (!snapshot?.equipment.length) {
    const empty = document.createElement('p');
    empty.className = 'garage-inventory-empty';
    empty.textContent = nftGarageBusy ? 'Reading Equipment NFTs from Ronin...' : 'No Equipment NFTs are available for this wallet yet.';
    container.append(empty);
    return;
  }
  for (const item of snapshot.equipment) {
    const equippedHere = item.equippedToMiner === snapshot.minerId;
    const equippedElsewhere = item.equippedToMiner > 0 && !equippedHere;
    const slot = NFT_GARAGE_SLOTS[item.slot];
    const occupiedTokenId = Number(snapshot.loadout?.[slot?.key] || 0);
    const card = document.createElement('article');
    card.className = `garage-equipment-card${equippedHere ? ' equipped' : ''}`;
    const image = document.createElement('img');
    image.src = garageImageUrl(item.metadata?.image);
    image.alt = item.metadata?.name || `Equipment #${item.tokenId}`;
    const copy = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = item.metadata?.name || `EQUIPMENT #${item.tokenId}`;
    const detail = document.createElement('small');
    detail.textContent = `${NFT_GARAGE_RARITIES[item.rarity] || 'UNKNOWN'} ${slot?.label || 'ITEM'} · TOKEN #${item.tokenId} · BONUS +${item.bonus}${item.damaged ? ' · DAMAGED' : ''}`;
    const location = document.createElement('small');
    location.textContent = equippedHere
      ? `EQUIPPED TO MINER #${snapshot.minerId}`
      : equippedElsewhere ? `EQUIPPED TO MINER #${item.equippedToMiner}` : 'IN WALLET';
    const action = document.createElement('button');
    action.type = 'button';
    action.className = equippedHere ? 'unequip' : '';
    action.disabled = nftGarageBusy || snapshot.runLocked || equippedElsewhere;
    action.textContent = equippedHere
      ? 'UNEQUIP'
      : equippedElsewhere
        ? `ON MINER #${item.equippedToMiner}`
        : occupiedTokenId ? 'REPLACE' : 'EQUIP';
    action.addEventListener('click', () => void mutateGarageEquipment(item));
    copy.append(name, detail, location, action);
    card.append(image, copy);
    container.append(card);
  }
}

function renderGarageArmor(snapshot) {
  const armorTokenId = Number(snapshot?.loadout?.armor || 0);
  const armor = snapshot?.equipment.find((item) => item.tokenId === armorTokenId);
  const button = $('#garage-repair-button');
  button.disabled = nftGarageBusy || !snapshot || snapshot.runLocked || !armor?.damaged;
  button.textContent = snapshot
    ? `REPAIR · ${formatGarageTokenUnits(snapshot.repairPriceRaw)} MATT`
    : 'REPAIR ARMOR';
  $('#garage-armor-copy').textContent = !snapshot
    ? 'Load a Miner to inspect its armor.'
    : snapshot.runLocked
      ? 'Armor cannot be changed while this Miner is locked in a run.'
      : !armor
        ? 'No armor is equipped.'
        : armor.damaged
          ? `${armor.metadata?.name || `Armor #${armor.tokenId}`} is damaged and provides no shield.`
          : `${armor.metadata?.name || `Armor #${armor.tokenId}`} is healthy and provides +${armor.bonus} shield.`;
}

function renderGarageChests(snapshot) {
  const container = $('#garage-chest-list');
  container.replaceChildren();
  const products = snapshot?.chestPrices || NFT_GARAGE_CHESTS;
  for (const product of products) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'garage-chest-product';
    button.disabled = nftGarageBusy || !snapshot;
    const label = document.createElement('span');
    label.textContent = product.label;
    const price = document.createElement('strong');
    price.textContent = product.priceRaw === undefined ? 'LOADING...' : `${formatGarageTokenUnits(product.priceRaw)} MATT`;
    const detail = document.createElement('small');
    detail.textContent = 'VIEW ODDS & EXACT STATS';
    button.append(label, price, detail);
    button.addEventListener('click', () => showGarageChestPreview(product));
    container.append(button);
  }
}

function formatEndlessDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatEndlessBreakdown(breakdown) {
  const entries = Object.entries(breakdown || {}).filter(([, value]) => Number(value) !== 0);
  return entries.length
    ? entries.map(([key, value]) => `${String(key).replaceAll(/([a-z])([A-Z])/g, '$1 $2')}: ${formatNumber(value)}`).join(' · ')
    : 'None';
}

function renderEndlessMenuStatus() {
  const status = endlessPublicStatus;
  // Competition Studio replaces the legacy mine cards after startup. The
  // Endless status remains available to the new hub, but its old labels are
  // intentionally absent once that replacement has mounted.
  if (!status || !$('#endless-menu-copy')) return;
  const rules = status.entryRules || {};
  const paid = status.paidEntryEnabled === true;
  const walletLimit = Number(rules.entriesPerWallet || 0);
  const minerLimit = Number(rules.entriesPerMiner || 0);
  $('#endless-menu-copy').textContent = paid
    ? `Selected Miner NFT required. Exact ${formatNumber(status.entryPriceMatt)} MATT entry; bank or descend forever.`
    : 'Selected Miner NFT required. Free entry; bank or descend forever.';
  $('#endless-menu-entry').textContent = paid
    ? `${formatNumber(status.entryPriceMatt)} MATT ENTRY`
    : 'FREE NFT ENTRY';
  $('#endless-menu-limits').textContent = [
    walletLimit > 0 ? `${walletLimit}/wallet` : 'Unlimited wallet entries',
    minerLimit > 0 ? `${minerLimit}/Miner` : 'Unlimited Miner entries',
    `Reset ${Number(rules.resetPeriodHours || 24)}h @ ${String(Number(rules.resetUtcHour || 0)).padStart(2, '0')}:00 UTC`
  ].join(' · ');
  $('#endless-menu-action').textContent = status.enabled
    ? status.inputReplayReady !== true
      ? 'VERIFICATION OFFLINE'
      : paid && status.paymentReady !== true ? 'ENTRY VERIFIER OFFLINE' : 'ENTER ENDLESS'
    : 'ENDLESS PAUSED';
  $('#endless-run-button').disabled = status.enabled !== true || status.inputReplayReady !== true;
}

function showGarageChestPreview(product) {
  const snapshot = nftGarageSnapshot?.minerId === selectedNftMinerId ? nftGarageSnapshot : null;
  if (!snapshot || nftGarageBusy || product?.priceRaw === undefined) return;
  pendingGarageChestProduct = product;
  const dialog = $('#garage-chest-dialog');
  const priceRaw = BigInt(product.priceRaw);
  const canAfford = BigInt(snapshot.mattBalanceRaw || 0) >= priceRaw;
  $('#garage-chest-dialog-label').textContent = product.label;
  $('#garage-chest-dialog-title').textContent = `${product.label} ODDS & STATS`;
  $('#garage-chest-dialog-price').textContent = `${formatGarageTokenUnits(priceRaw)} MATT`;
  $('#garage-chest-dialog-balance').textContent = `${formatGarageTokenUnits(snapshot.mattBalanceRaw)} MATT`;
  const outcomes = $('#garage-chest-dialog-outcomes');
  outcomes.replaceChildren();
  for (const outcome of garageChestOutcomes(product)) {
    const row = document.createElement('article');
    row.dataset.rarity = outcome.rarity.toLowerCase();
    const chance = document.createElement('strong');
    chance.textContent = outcome.chance;
    const copy = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = outcome.name;
    const stat = document.createElement('small');
    stat.textContent = `${outcome.rarity} · ${outcome.stat}`;
    copy.append(name, stat);
    row.append(chance, copy);
    outcomes.append(row);
  }
  const purchase = $('#garage-chest-dialog-purchase');
  purchase.disabled = !canAfford;
  purchase.textContent = canAfford
    ? `OPEN FOR ${formatGarageTokenUnits(priceRaw)} MATT`
    : `NEED ${formatGarageTokenUnits(priceRaw - BigInt(snapshot.mattBalanceRaw || 0))} MORE MATT`;
  $('#garage-chest-dialog-affordability').textContent = canAfford
    ? 'Your balance covers this chest. Ronin Wallet confirmation is still required.'
    : 'Your wallet does not currently have enough MATT for this chest.';
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeGarageChestPreview() {
  const dialog = $('#garage-chest-dialog');
  if (typeof dialog.close === 'function' && dialog.open) dialog.close('cancel');
  else dialog.removeAttribute('open');
}

function confirmGarageChestPurchase() {
  const product = pendingGarageChestProduct;
  if (!product || $('#garage-chest-dialog-purchase').disabled) return;
  closeGarageChestPreview();
  void openGarageChest(product);
}

function setGarageStatus(message, state = '') {
  const status = $('#garage-status');
  status.textContent = message;
  status.className = `garage-status${state ? ` ${state}` : ''}`;
}

async function mutateGarageEquipment(item) {
  const snapshot = nftGarageSnapshot;
  if (nftGarageBusy || !snapshot || snapshot.minerId !== selectedNftMinerId) return;
  const equippedHere = item.equippedToMiner === snapshot.minerId;
  const slot = NFT_GARAGE_SLOTS[item.slot];
  const occupied = Number(snapshot.loadout?.[slot?.key] || 0);
  const approvalCount = equippedHere ? 1 : (occupied ? 1 : 0) + (snapshot.equipmentOperatorApproved ? 0 : 1) + 1;
  nftGarageBusy = true;
  renderNftGarage();
  renderMinerSelect();
  setGarageStatus(
    `${equippedHere ? 'Unequipping' : occupied ? 'Replacing' : 'Equipping'} ${item.metadata?.name || `Equipment #${item.tokenId}`}. Expect ${approvalCount} Ronin Wallet confirmation${approvalCount === 1 ? '' : 's'}.`,
    'busy'
  );
  try {
    if (equippedHere) await nftGarage.unequip(snapshot, item);
    else await nftGarage.equip(snapshot, item);
    await refreshSelectedMinerFromChain(snapshot.minerId);
    nftGarageBusy = false;
    await refreshNftGarage();
    setGarageStatus(`Miner #${snapshot.minerId} loadout updated. No separate confirmation is needed.`);
  } catch (error) {
    setGarageStatus(error?.message || 'The equipment transaction failed.', 'error');
  } finally {
    nftGarageBusy = false;
    renderMinerSelect();
    renderNftGarage();
  }
}

async function repairGarageArmor() {
  const snapshot = nftGarageSnapshot;
  if (nftGarageBusy || !snapshot) return;
  nftGarageBusy = true;
  renderNftGarage();
  setGarageStatus('Repairing armor. Ronin may first request an exact MATT approval, then the repair transaction.', 'busy');
  try {
    await nftGarage.repairArmor(snapshot);
    await refreshSelectedMinerFromChain(snapshot.minerId);
    nftGarageBusy = false;
    await refreshNftGarage();
    setGarageStatus(`Miner #${snapshot.minerId} armor is repaired and active.`);
  } catch (error) {
    setGarageStatus(error?.message || 'Armor repair failed.', 'error');
  } finally {
    nftGarageBusy = false;
    renderMinerSelect();
    renderNftGarage();
  }
}

async function withdrawGarageCrystals() {
  const snapshot = nftWalletSnapshot ? crystalWithdrawalAvailability(nftWalletSnapshot) : null;
  if (nftCrystalBankBusy || !snapshot) return;
  let amountRaw;
  try {
    amountRaw = parseTokenUnits($('#garage-withdraw-input').value);
  } catch (error) {
    setCrystalBankStatus(error.message, 'error');
    return;
  }
  if (amountRaw < snapshot.minimumWithdrawalRaw || amountRaw > snapshot.withdrawableRaw) {
    setCrystalBankStatus(
      `Enter an amount from ${formatGarageTokenUnits(snapshot.minimumWithdrawalRaw)} to ${formatGarageTokenUnits(snapshot.withdrawableRaw)} MATT Crystals.`,
      'error'
    );
    syncCrystalWithdrawalButton();
    return;
  }
  nftCrystalBankBusy = true;
  renderWalletCrystalBank();
  setCrystalBankStatus(`Withdrawing ${formatGarageTokenUnits(amountRaw)} MATT Crystals to the connected wallet...`, 'busy');
  try {
    await nftGarage.withdrawCrystals(snapshot, amountRaw, {
      onBroadcast(transactionHash) {
        showCrystalTransaction(transactionHash);
        setCrystalBankStatus(`Withdrawal ${abbreviateHash(transactionHash)} was submitted. Waiting for Ronin confirmation...`, 'busy');
      }
    });
    $('#garage-withdraw-input').value = '';
    nftCrystalBankBusy = false;
    await refreshWalletCrystalBank(true);
    setCrystalBankStatus('MATT Crystals were withdrawn from the bank and minted into the connected wallet.');
  } catch (error) {
    setCrystalBankStatus(error?.message || 'Crystal withdrawal failed.', 'error');
  } finally {
    nftCrystalBankBusy = false;
    renderWalletCrystalBank();
  }
}

async function openGarageChest(product) {
  const snapshot = nftGarageSnapshot;
  if (nftGarageBusy || !snapshot) return;
  nftGarageBusy = true;
  renderNftGarage();
  setGarageStatus(`Opening ${product.label}. Ronin may first request an exact MATT approval, then the chest transaction.`, 'busy');
  try {
    await nftGarage.openChest(snapshot, product);
    nftGarageBusy = false;
    await refreshNftGarage();
    setGarageStatus(`${product.label} request confirmed. Randomness may take a moment; use Refresh if the new item is still minting.`);
  } catch (error) {
    setGarageStatus(error?.message || `${product.label} could not be opened.`, 'error');
  } finally {
    nftGarageBusy = false;
    renderNftGarage();
  }
}

async function refreshSelectedMinerFromChain(minerId) {
  const miner = await apiClient.ownedMiner(minerId);
  cacheOwnedMiner(miner);
  renderMinerSelect();
  return miner;
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
    const hasShield = Number(stats.maxShield || 0) > 0;
    ui.shieldRow.hidden = !hasShield;
    if (hasShield) {
      ui.shieldText.textContent = `${Math.ceil(stats.shield || 0)} / ${Math.round(stats.maxShield)}`;
      ui.shieldFill.style.width = `${Math.max(0, (Number(stats.shield || 0) / stats.maxShield) * 100)}%`;
    }
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
    const endless = stats.runMode === RUN_MODES.ENDLESS ? stats.endless : null;
    if (ui.endlessHud) {
      ui.endlessHud.hidden = !endless;
      if (endless) {
        ui.endlessPhase.textContent = formatNumber(stats.depth);
        ui.endlessRequired.textContent = formatNumber(endless.requiredRemaining);
        ui.endlessDifficulty.textContent = formatNumber(endless.difficulty?.budget || 0);
        ui.endlessCapability.textContent = formatNumber(Math.round(endless.capability?.rating || 0));
        ui.endlessDanger.textContent = endless.danger?.tier || 'LOW';
        ui.endlessDanger.dataset.tier = endless.danger?.tier || 'LOW';
        ui.endlessModifier.hidden = !endless.modifier && !endless.milestone;
        ui.endlessModifier.textContent = endless.milestone
          ? `MILESTONE${endless.modifier ? ` · ${String(endless.modifier).replaceAll('_', ' ').toUpperCase()}` : ''}`
          : String(endless.modifier || '').replaceAll('_', ' ').toUpperCase();
      }
    }
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
    game.input?.reset?.();
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
    $('#depth-summary').textContent = activeServerRun?.mode === RUN_MODES.ENDLESS
      ? `Phase ${data.depth} is server verified. Bank ${formatNumber(data.projectedPayout)} total score now, or descend into a new unique map. Difficulty rises; point opportunity follows the published phase budget.`
      : `You can secure ${formatNumber(data.projectedPayout)} score now, or descend for a x${data.nextMultiplier.toFixed(1)} total score multiplier.`;
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
    leaveGameplayFullscreen();
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    $('#paid-revive-panel').hidden = true;
    $('#play-again-button').hidden = false;
    $('#menu-button').hidden = false;
    const mode = result.mode || RUN_MODES.PRACTICE;
    resultScreenMode = mode;
    $('#menu-button').textContent = mode === RUN_MODES.PRACTICE ? 'BACK TO BASE' : 'MINER & CRYSTAL BANK';
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
      <div><span>Banked Score</span><strong>${formatNumber(result.banked)}</strong></div>
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
    else if (serverRun?.mode === RUN_MODES.ENDLESS) {
      if (serverRun.endlessBankSummary) {
        renderEndlessBankSummary(serverRun.endlessBankSummary);
        activeServerRun = null;
        clearPersistedEndlessRun();
      } else void finalizeEndlessKnockout(serverRun);
    } else if (serverRun) void submitServerRun(serverRun, result);
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
    leaveGameplayFullscreen();
    const openMinerAfterCleanup = returnToMinerAfterRun;
    returnToMinerAfterRun = false;
    resultScreenMode = null;
    paidRevivePending = false;
    paidReviveBusy = false;
    paidReviveContext = null;
    clearPracticeClaimPanel();
    setGameplayUi(false);
    if (openMinerAfterCleanup && serverPlayer) {
      void openMinerSelect();
      return;
    }
    showScreen('menu');
    updateMenu();
  },
  onRunAbandoned(context) {
    abandonIssuedRun(context);
  },
  onFatalError(error) {
    const failedMode = activeServerRun?.mode || activeArenaRun?.mode || RUN_MODES.PRACTICE;
    abandonIssuedRun({ mode: failedMode, reason: 'client_runtime_error' });
    leaveGameplayFullscreen();
    showScreen('menu');
    setGameplayUi(false);
    updateMenu();
    toast(`Run stopped safely: ${error.message}`);
  },
  onArenaInput(event) {
    activeArenaTranscript?.record(event);
    activeEndlessTranscript?.record(event);
  },
  onArenaEvent() {},
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
    if (action === 'mines' || action === 'enter') {
      openMines();
      return;
    }
    if (action === 'pass-mine' || action === 'arena' || action === 'endless') {
      openMineRoute(action);
      return;
    }
    if (action === 'how-to-play') {
      showScreen('how-to-play');
      return;
    }
    if (action === 'pass') {
      openPass();
      return;
    }
    if (action === 'leaderboards') {
      openLeaderboards(ARENA_LEADERBOARD_MODE);
      return;
    }
    void openMinerSelect();
  });
}

for (const button of document.querySelectorAll('[data-site-action]')) {
  button.addEventListener('click', () => {
    const action = button.dataset.siteAction;
    if (action === 'home') return openLaunch(true);
    if (action === 'how-to-play') return showScreen('how-to-play');
    if (action === 'leaderboards') return openLeaderboards(ARENA_LEADERBOARD_MODE);
    if (action === 'pass') return openPass();
    if (action === 'mines') {
      return openMines();
    }
    if (action === 'account') {
      if (serverPlayer) return openMinerProfile(false);
      return void connectWallet();
    }
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

$('#launch-walletconnect-button').addEventListener('click', () => {
  if (serverPlayer) return;
  const mobileHandoff = needsMobileWalletConnectHandoff(window);
  toast(mobileHandoff ? 'Preparing Ronin Wallet...' : 'Opening WalletConnect chooser...');
  void connectWallet({
    forceWalletConnect: true,
    showQrModal: !mobileHandoff,
    onDisplayUri: mobileHandoff ? openMobileWalletConnect : undefined
  }).finally(closeMobileWalletConnect);
});

mobileWalletConnectOpenRonin.addEventListener('click', () => {
  rememberRoninWalletChoice(window);
  toast('Approve the connection in Ronin Wallet, then return to Safari.');
});

mobileWalletConnectCancel.addEventListener('click', () => {
  closeMobileWalletConnect();
  window.location.reload();
});

$('#home-button').addEventListener('click', () => openLaunch(true));
$('#miner-select-home').addEventListener('click', () => {
  rememberPendingMineDestination();
  openMines();
});
$('#mines-how-to-button').addEventListener('click', () => showScreen('how-to-play'));
$('#mines-miner-button').addEventListener('click', () => {
  rememberPendingMineDestination();
  void openMinerSelect();
});
$('#miner-number-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void selectMinerByNumber();
});
$('#enter-mines-button').addEventListener('click', () => {
  if (!selectedNftMinerId) return;
  const selected = ownedNftMiners().find((miner) => miner.minerId === selectedNftMinerId);
  if (selected?.gameplay?.runLocked === true) {
    void recoverLockedMinerRun(selectedNftMinerId);
    return;
  }
  rememberSelectedMiner(selectedNftMinerId);
  const destination = pendingMineDestination;
  rememberPendingMineDestination();
  if (destination === 'arena') {
    void openArena();
    return;
  }
  if (destination === 'pass-mine') {
    openPassMine();
    return;
  }
  if (destination === 'endless') {
    void startRunMode(RUN_MODES.ENDLESS);
    return;
  }
  openMines();
});
$('#select-loadout-button').addEventListener('click', () => void openMinerCommandCenter());
$('#garage-refresh-button').addEventListener('click', () => void refreshNftGarage());
$('#garage-equipment-load-more').addEventListener('click', () => void loadMoreNftGarageEquipment());
$('#garage-crystal-refresh-button').addEventListener('click', () => void refreshWalletCrystalBank());
$('#garage-close-button').addEventListener('click', closeMinerCommandCenter);
$('#garage-repair-button').addEventListener('click', () => void repairGarageArmor());
$('#garage-chest-dialog-close').addEventListener('click', closeGarageChestPreview);
$('#garage-chest-dialog-cancel').addEventListener('click', closeGarageChestPreview);
$('#garage-chest-dialog-purchase').addEventListener('click', confirmGarageChestPurchase);
$('#garage-chest-dialog').addEventListener('click', (event) => {
  if (event.target === $('#garage-chest-dialog')) closeGarageChestPreview();
});
$('#garage-chest-dialog').addEventListener('close', () => {
  pendingGarageChestProduct = null;
});
$('#garage-withdraw-button').addEventListener('click', () => void withdrawGarageCrystals());
$('#garage-withdraw-input').addEventListener('input', syncCrystalWithdrawalButton);
$('#garage-withdraw-all-button').addEventListener('click', () => {
  if (!nftWalletSnapshot) return;
  const availability = crystalWithdrawalAvailability(nftWalletSnapshot);
  $('#garage-withdraw-input').value = formatGarageTokenUnits(availability.withdrawableRaw, 18, 18);
  syncCrystalWithdrawalButton();
});
$('#practice-run-button').addEventListener('click', () => void startRunMode(RUN_MODES.PRACTICE));
$('#endless-run-button').addEventListener('click', () => openMineRoute('endless'));
$('#resume-nft-practice-button').addEventListener('click', () => void resumeInterruptedNftPractice());
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
  openMineRoute('pass-mine');
});
$('#start-pass-mine-button').addEventListener('click', async () => {
  if (!serverPlayer && serverConfig?.paidRunsEnabled === true) {
    const connected = await connectWallet();
    if (!connected) return;
  }
  if (serverConfig?.paidRunsEnabled === true) {
    if (!paymentStatus?.pass?.active) return openPass();
    if ((paymentStatus.confirmedCredits || 0) < 1) return openPassMine();
    void startRunMode(RUN_MODES.PAID);
    return;
  }
  const access = runAccess(economy.state, RUN_MODES.PAID);
  if (access.allowed) void startRunMode(RUN_MODES.PAID);
  else openPass();
});
$('#buy-pass-credit-button').addEventListener('click', () => {
  if (serverConfig?.realPaymentsEnabled === true) {
    void purchaseLivePaidRun('pass-mine');
    return;
  }
  const result = economy.apply(purchasePaidRun(economy.state));
  toast(result.ok
    ? `${result.priceRon} RON modeled → ${formatNumber(result.mattBought)} MATT · 0 burned`
    : result.error);
  openPassMine();
});
$('#pass-mine-leaderboard-button').addEventListener('click', () => openLeaderboards(RUN_MODES.PAID));
$('#pass-mine-back-button').addEventListener('click', () => { showScreen('menu'); updateMenu(); });
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
$('#menu-button').addEventListener('click', () => {
  returnToMinerAfterRun = resultScreenMode !== RUN_MODES.PRACTICE;
  game.backToMenu();
});
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
$('#extract-button').addEventListener('click', () => {
  if (activeServerRun?.mode === RUN_MODES.ENDLESS) void checkpointEndlessChoice('bank');
  else game.extract();
});
$('#descend-button').addEventListener('click', () => {
  if (activeServerRun?.mode === RUN_MODES.ENDLESS) void checkpointEndlessChoice('descend');
  else game.descend();
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
$('#crystal-bank-button').addEventListener('click', async () => {
  await openMinerSelect();
  requestAnimationFrame(() => $('#wallet-crystal-bank')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
});
$('#profile-back-button').addEventListener('click', () => { showScreen('menu'); updateMenu(); });
$('#profile-manage-loadout-button').addEventListener('click', () => void openCosmetics());
$('#profile-loadout-button').addEventListener('click', () => void openCosmetics());
$('#profile-pass-button').addEventListener('click', openPass);
for (const tab of document.querySelectorAll('[data-profile-tab]')) {
  tab.addEventListener('click', () => activateProfileTab(tab.dataset.profileTab));
}
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
$('#leaderboards-button').addEventListener('click', () => openLeaderboards(ARENA_LEADERBOARD_MODE));
$('#arena-button').addEventListener('click', () => openMineRoute('arena'));
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
  tab.addEventListener('click', () => openLeaderboards(tab.dataset.board));
}

$('#endless-leaderboard-filter')?.addEventListener('change', () => {
  if (activeBoard === ENDLESS_LEADERBOARD_MODE) void renderServerLeaderboard(activeBoard);
});

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

async function purchaseLivePaidRun(returnScreen = 'mine-pass') {
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
    if (returnScreen === 'pass-mine') openPassMine();
    else openPass();
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
    if (!silent && error?.status !== 404) toast(error.message || 'MATT Arena status is unavailable.');
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
    toast('MATT Arena entries are not open.');
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
    const transactionHashes = await wallet.purchaseArenaEntry(transactions, {
      onWalletRequest: showMobileWalletTransactionRequest,
      onWalletRequestSettled: closeMobileWalletTransactionRequest
    });
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
  requestGameplayFullscreen();
  arenaBusy = true;
  renderArena();
  try {
    const approval = await approveNftRun('arena', selectedNftMinerId);
    const run = await apiClient.startArenaRun(selectedNftMinerId, '', approval);
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
      reviveLimitPerRun: run.reviveLimitPerRun,
      reviveInvulnerabilitySeconds: run.reviveInvulnerabilitySeconds,
      nftRun: run.nftRun || null
    });
    if (run.challenge?.tuning?._minePassBenefits?.active === true) {
      toast('Mine Pass active · 2× Pass XP');
    }
  } catch (error) {
    leaveGameplayFullscreen();
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
    'Release the unfinished MATT Arena run?\n\n' +
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
      <p>Contains a permanent cosmetic reward, including the exclusive Molten Pickaxe.</p>
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
    toast(`Pass Chest opened · ${result.rewards.cosmetic?.name || 'cosmetic collection complete'}`);
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
    tab.classList.toggle('active', tab.dataset.board === mode);
  }
  const endless = mode === ENDLESS_LEADERBOARD_MODE;
  $('#endless-leaderboard-filter-wrap').hidden = !endless;
  $('#reward-claim-card').hidden = endless;
  if (endless) {
    applyEndlessLeaderboardLabels();
    replaceProfileMarkup($('#leaderboard-body'), '<tr><td colspan="4">Loading verified Endless rankings…</td></tr>');
    renderLeaderboardPodium([]);
    activeServerClaim = null;
    showScreen('leaderboards');
    void renderServerLeaderboard(mode);
    return;
  }
  if (mode === ARENA_LEADERBOARD_MODE) {
    $('#board-pool-label').textContent = 'Current Daily Pool';
    $('#board-score-label').textContent = 'Your Daily Score';
    $('#board-reward-label').textContent = 'Projected Arena Reward';
    $('#board-score-column-label').textContent = 'Daily Score';
    $('#board-pool').textContent = formatMattRaw(arenaLeaderboard.totalPoolRaw || arenaConfig.prizePoolRaw);
    $('#board-score').textContent = arenaPlayer.bestScore ? formatNumber(arenaPlayer.bestScore) : '—';
    $('#board-reward').textContent = '—';
    replaceProfileMarkup($('#leaderboard-body'), '<tr><td colspan="4">Loading current Arena rankings…</td></tr>');
    renderLeaderboardPodium([]);
    activeServerClaim = null;
    showScreen('leaderboards');
    void renderServerLeaderboard(mode);
    return;
  }
  $('#board-pool-label').textContent = 'Weekly Pool';
  $('#board-score-label').textContent = 'Your Weekly Score';
  $('#board-reward-label').textContent = 'Projected Reward';
  $('#board-score-column-label').textContent = 'Weekly Score';
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
  renderLeaderboardPodium(rows);
  $('#leaderboard-body').innerHTML = rows.slice(3).map((row) => `
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
  if (mode === ENDLESS_LEADERBOARD_MODE) {
    await renderEndlessLeaderboardPanel();
    return;
  }
  if (mode === ARENA_LEADERBOARD_MODE) {
    await renderArenaLeaderboardPanel();
    return;
  }
  const note = $('#leaderboard-note');
  if (note) note.textContent = 'Loading server-verified rankings…';
  try {
    const leaderboard = await apiClient.leaderboard(mode);
    $('#board-score').textContent = formatNumber(leaderboard.playerScore);
    const rows = leaderboard.rows;
    renderLeaderboardPodium(rows);
    $('#leaderboard-body').innerHTML = rows.length > 3
      ? rows.slice(3).map((row) => `
          <tr class="${row.isPlayer ? 'player-row' : ''}">
            <td>#${row.rank}</td>
            <td>${renderMinerIdentity(row)}${row.isPlayer ? ' · YOU' : ''}</td>
            <td>${formatNumber(row.score)}</td>
            <td>SERVER VERIFIED</td>
          </tr>
        `).join('')
      : `<tr><td colspan="4">${rows.length ? 'More miners will appear as verified scores arrive.' : `No verified ${mode === RUN_MODES.PAID ? 'Pass' : 'Free'} scores yet this week.`}</td></tr>`;
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

async function renderArenaLeaderboardPanel() {
  const note = $('#leaderboard-note');
  if (note) note.textContent = 'Loading current server-verified Arena rankings…';
  try {
    await refreshArena(true);
    const leaderboard = arenaLeaderboard;
    const rows = leaderboard.rows;
    const viewerAddress = String(serverPlayer?.address || '').toLowerCase();
    const playerRow = rows.find((row) => row.isPlayer) ||
      rows.find((row) => viewerAddress && row.address.toLowerCase() === viewerAddress) ||
      rows.find((row) => arenaPlayer.rank > 0 && row.rank === arenaPlayer.rank);
    const playerScore = arenaPlayer.bestScore || playerRow?.score || 0;
    const playerRewardRaw = playerRow?.payoutRaw || playerRow?.projectedRaw || 0n;

    $('#board-pool').textContent = formatMattRaw(leaderboard.totalPoolRaw || arenaConfig.prizePoolRaw);
    $('#board-score').textContent = playerScore ? formatNumber(playerScore) : '—';
    $('#board-reward').textContent = playerRewardRaw ? formatMattRaw(playerRewardRaw) : '—';
    renderLeaderboardPodium(rows);
    replaceProfileMarkup($('#leaderboard-body'), rows.length > 3
      ? rows.slice(3).map((row) => `
          <tr class="${row === playerRow ? 'player-row' : ''}">
            <td>#${row.rank}</td>
            <td>${renderMinerIdentity(row)}${row === playerRow ? ' · YOU' : ''}</td>
            <td>${formatNumber(row.score)}</td>
            <td>SERVER VERIFIED</td>
          </tr>
        `).join('')
      : `<tr><td colspan="4">${rows.length ? 'More miners will appear as verified Arena scores arrive.' : 'No verified Arena scores yet today.'}</td></tr>`);

    $('#published-reward-text').textContent = playerRow
      ? `${playerRewardRaw ? formatMattRaw(playerRewardRaw) : 'Reward pending'} · Rank #${playerRow.rank}`
      : 'No Arena reward position yet';
    $('#published-reward-status').textContent = leaderboard.finalized
      ? `Final Arena standings for ${leaderboard.day} UTC.`
      : `Live projection for ${leaderboard.day} UTC · final payout follows Arena settlement.`;
    const claimButton = $('#claim-reward-button');
    claimButton.disabled = true;
    claimButton.textContent = leaderboard.finalized ? 'ARENA SETTLEMENT' : 'LIVE PROJECTION';
    if (note) {
      note.textContent = leaderboard.finalized
        ? `Permanent server snapshot · Arena ${leaderboard.day} UTC`
        : `Server-authoritative Arena rankings · ${leaderboard.day} UTC · ${formatNumber(leaderboard.participantCount)} miners`;
    }
  } catch (error) {
    renderLeaderboardPodium([]);
    replaceProfileMarkup($('#leaderboard-body'), '<tr><td colspan="4">Arena rankings are temporarily unavailable.</td></tr>');
    $('#board-pool').textContent = '—';
    $('#board-score').textContent = '—';
    $('#board-reward').textContent = '—';
    renderServerClaim(null);
    if (note) note.textContent = `Arena leaderboard unavailable: ${error.message}`;
  }
}

function renderLeaderboardPodium(rows = []) {
  const podium = $('#leaderboard-podium');
  if (!podium) return;
  const places = [2, 1, 3];
  replaceProfileMarkup(podium, places.map((place) => {
    const row = rows.find((entry) => Number(entry.rank) === place);
    const fallback = `<span class="podium-avatar" aria-hidden="true">${place}</span><strong>OPEN POSITION</strong><small>NO VERIFIED SCORE</small>`;
    return `<article class="podium-place place-${place}"><b>#${place}</b>${row
      ? `${renderMinerIdentity(row)}<small>${escapeHtml(row.displayValue || formatNumber(row.score))}</small>`
      : fallback}</article>`;
  }).join(''));
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
    return '<strong>Practice complete</strong><span>No XP, no MATT Crystals, and no leaderboard score. Practice remains unlimited.</span>';
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
    : `Knockout counted ${formatNumber(result.banked)} retained score`;
  return `
    <strong>${mode === RUN_MODES.PAID ? 'PASS LEADERBOARD' : 'FREE LEADERBOARD'} · #${player?.rank || '—'}</strong>
    <span>Weekly score: ${formatNumber(weekly)} · Projected leaderboard share: ${formatNumber(reward)} MATT</span>
    <small>${scoreNote} · ${mode === RUN_MODES.PAID ? `2× reward weight · Pass XP ${formatNumber(recorded.passXp || economy.state.player.passXp)}` : 'One free ranked run consumed for today'} · Rewards remain estimates until verified and published.</small>
  `;
}

function modeLabel(mode, rewardWeight = 0) {
  if (mode === RUN_MODES.FREE) return 'FREE RANKED · 1×';
  if (mode === RUN_MODES.PAID) return `PASS RANKED · ${rewardWeight || 2}×`;
  if (mode === 'arena') return 'MATT ARENA';
  if (mode === RUN_MODES.ENDLESS) return 'MATT MINE ENDLESS · NFT ONLY';
  return 'PRACTICE · NO XP · NO CRYSTALS';
}

async function approveNftRun(mode, minerId) {
  if (!minerId) throw new Error('Select a MATT Mine Miner NFT first.');
  const prepared = await apiClient.prepareNftRunAuthorization(mode, minerId);
  return wallet.signNftRunAuthorization(prepared);
}

async function startApprovedNftServerRun(mode, minerId) {
  if (mode === RUN_MODES.ENDLESS) {
    const entry = await apiClient.prepareEndlessEntry(minerId);
    const approval = entry.runApprovalRequired ? await approveNftRun(mode, minerId) : null;
    if (entry.paidEntryEnabled && !entry.entryTransaction) {
      throw new Error('Paid Endless entry is temporarily closed while its MATT verifier is unavailable. No payment was requested.');
    }
    const entryTransactionHash = entry.paidEntryEnabled
      ? await wallet.purchaseEndlessEntry(entry.entryTransaction)
      : '';
    return apiClient.startRun(mode, minerId, approval, entryTransactionHash ? { entryTransactionHash } : null);
  }
  if (mode !== RUN_MODES.PAID) return apiClient.startRun(mode, 0);
  const approval = await approveNftRun(mode, minerId);
  return apiClient.startRun(mode, minerId, approval);
}

function selectedEndlessLeaderboard() {
  const [board = 'score', scope = 'all-time'] = String($('#endless-leaderboard-filter')?.value || 'score:all-time').split(':');
  return { board, scope };
}

function applyEndlessLeaderboardLabels() {
  const { board, scope } = selectedEndlessLeaderboard();
  const scopeLabel = scope === 'all-time' ? 'All-Time' : scope[0].toUpperCase() + scope.slice(1);
  const boardLabel = board === 'deepest' ? 'Deepest Descent' : 'Highest Score';
  $('#board-pool-label').textContent = 'Verified Board';
  $('#board-score-label').textContent = `Your ${boardLabel}`;
  $('#board-reward-label').textContent = 'Board Window';
  $('#board-score-column-label').textContent = `${boardLabel} / Phase`;
  $('#board-pool').textContent = boardLabel.toUpperCase();
  $('#board-reward').textContent = scopeLabel.toUpperCase();
  return { board, scope, scopeLabel, boardLabel };
}

async function renderEndlessLeaderboardPanel() {
  const selection = applyEndlessLeaderboardLabels();
  const note = $('#leaderboard-note');
  if (note) note.textContent = `Loading ${selection.scopeLabel.toLowerCase()} ${selection.boardLabel.toLowerCase()} rankings…`;
  try {
    const leaderboard = await apiClient.endlessLeaderboard(selection.scope, selection.board);
    const rows = leaderboard.rows || [];
    const player = leaderboard.player || rows.find((row) => row.isPlayer);
    $('#board-score').textContent = player
      ? selection.board === 'deepest'
        ? `PHASE ${formatNumber(player.deepestPhase)}`
        : formatNumber(player.score)
      : '—';
    const displayRows = rows.map((row) => ({
      ...row,
      displayValue: selection.board === 'deepest'
        ? `PHASE ${formatNumber(row.deepestPhase)} · ${formatNumber(row.score)} PTS`
        : `${formatNumber(row.score)} PTS · PHASE ${formatNumber(row.deepestPhase)}`
    }));
    renderLeaderboardPodium(displayRows);
    replaceProfileMarkup($('#leaderboard-body'), rows.length > 3
      ? rows.slice(3).map((row) => `<tr class="${row.isPlayer ? 'player-row' : ''}">
          <td>#${row.rank}</td>
          <td>${renderMinerIdentity(row)}${row.isPlayer ? ' · YOU' : ''}</td>
          <td>${selection.board === 'deepest' ? `PHASE ${formatNumber(row.deepestPhase)} · ${formatNumber(row.score)}` : `${formatNumber(row.score)} · PHASE ${formatNumber(row.deepestPhase)}`}</td>
          <td>MINER #${formatNumber(row.minerId)} · L${formatNumber(row.minerLevel)} · CAP ${formatNumber(row.minerCapability)}</td>
        </tr>`).join('')
      : `<tr><td colspan="4">${rows.length ? 'More verified Endless miners will appear here.' : 'No verified Endless runs yet.'}</td></tr>`);
    if (note) note.textContent = `${selection.scopeLabel} ${selection.boardLabel} · one best verified run per wallet · score, phase, difficulty, duration, enemies, then ore break ties.`;
  } catch (error) {
    renderLeaderboardPodium([]);
    replaceProfileMarkup($('#leaderboard-body'), '<tr><td colspan="4">Endless rankings are temporarily unavailable.</td></tr>');
    $('#board-score').textContent = '—';
    if (note) note.textContent = `Endless leaderboard unavailable: ${error.message}`;
  }
}

async function checkpointEndlessChoice(action) {
  const run = activeServerRun;
  if (endlessCheckpointBusy || run?.mode !== RUN_MODES.ENDLESS || game.state !== 'depthchoice') return;
  endlessCheckpointBusy = true;
  const extractButton = $('#extract-button');
  const descendButton = $('#descend-button');
  extractButton.disabled = true;
  descendButton.disabled = true;
  const originalExtract = extractButton.textContent;
  const originalDescend = descendButton.textContent;
  if (action === 'bank') extractButton.textContent = 'SERVER BANKING...';
  else descendButton.textContent = 'VERIFYING PHASE...';
  try {
    if (!activeEndlessTranscript) throw new Error('The authoritative Endless input transcript is unavailable. Reconnect to restart this phase safely.');
    const pending = run.pendingEndlessCheckpoint;
    if (pending && pending.action !== action) {
      throw new Error(`The signed ${pending.action === 'bank' ? 'extract' : 'descend'} action is awaiting server acceptance. Retry that same choice.`);
    }
    let inputCheckpoint = pending?.inputCheckpoint || null;
    if (!inputCheckpoint) {
      activeEndlessTranscript.record({
        type: 'command',
        tick: Math.round(Number(game.run?.elapsed || 0) * 1_000),
        command: action === 'bank' ? 'extract' : 'descend'
      });
      inputCheckpoint = await activeEndlessTranscript.close();
      run.pendingEndlessCheckpoint = { action, inputCheckpoint };
    }
    const accepted = await retryRunFinalization(() => apiClient.checkpointEndlessPhase(
      run.runId,
      run.runToken,
      run.checkpoint,
      inputCheckpoint,
      action
    ), { onRetry: showDatabaseReconnect });
    run.pendingEndlessCheckpoint = null;
    run.checkpoint = accepted.checkpoint;
    run.currentPhase = accepted.run.currentPhase;
    run.completedPhases = accepted.run.completedPhases;
    run.score = accepted.run.score;
    run.crystalsCarried = accepted.run.crystalsCarried;
    run.manifest = accepted.nextManifest || accepted.run.manifest;
    if (action === 'descend') {
      run.inputCheckpoint = accepted.nextInputCheckpoint;
      run.phaseInitialState = accepted.run.phaseInitialState;
      activeEndlessTranscript = null;
      game.runContext.endlessManifest = accepted.nextManifest;
      toast(`Phase ${accepted.phase.phase} verified · ${formatNumber(accepted.phase.score)} points · descending`);
      game.descend();
      activeEndlessTranscript = createEndlessTranscript(run);
    } else {
      activeEndlessTranscript = null;
      run.endlessBankSummary = accepted.summary;
      if (accepted.rewardSettlement?.pending) {
        toast('Run verified. Reward settlement is queued and can be retried safely.');
      }
      toast(accepted.summary.leaderboardSubmitted
        ? `${formatNumber(accepted.summary.totalScore)} verified Endless points banked`
        : `${formatNumber(accepted.summary.totalScore)} verified points saved; leaderboard submissions are paused`);
      game.extract();
    }
  } catch (error) {
    toast(error.message);
  } finally {
    endlessCheckpointBusy = false;
    extractButton.disabled = false;
    descendButton.disabled = false;
    extractButton.textContent = originalExtract;
    descendButton.textContent = originalDescend;
  }
}

function renderEndlessBankSummary(summary = {}) {
  $('#economy-result').innerHTML = `
    <strong>ENDLESS RUN SERVER VERIFIED</strong>
    <span>${formatNumber(summary.totalScore)} points · Phase ${formatNumber(summary.deepestPhase)} · ${formatNumber(summary.crystalsCarried)} crystals carried</span>
    <small>${formatNumber(summary.requiredEnemiesDefeated)} required enemies · ${formatNumber(summary.guardiansDefeated)} Guardians · ${formatNumber(summary.oreBroken)} ore · checkpoint ${escapeHtml(String(summary.digest || '').slice(0, 16))}</small>
  `;
  toast(summary.leaderboardSubmitted === false
    ? 'Endless run banked; leaderboard submissions are temporarily paused'
    : 'Endless run banked and added to the leaderboard');
}

function persistEndlessRun(run) {
  try {
    sessionStorage.setItem(ENDLESS_RUN_STORAGE_KEY, JSON.stringify({ runId: run.runId, runToken: run.runToken }));
  } catch {}
}

function clearPersistedEndlessRun() {
  try { sessionStorage.removeItem(ENDLESS_RUN_STORAGE_KEY); } catch {}
}

async function reconnectPersistedEndlessRun() {
  if (!serverPlayer || activeServerRun || activeArenaRun) return false;
  let saved = null;
  try { saved = JSON.parse(sessionStorage.getItem(ENDLESS_RUN_STORAGE_KEY) || 'null'); } catch {}
  if (!saved?.runId || !saved?.runToken) return false;
  try {
    const run = await apiClient.reconnectEndlessRun(saved.runId, saved.runToken);
    activeServerRun = run;
    activeEndlessTranscript = createEndlessTranscript(run);
    rememberSelectedMiner(run.minerId);
    await showMineLoadingScreen({ id: 'endless', name: 'MATT Mine Endless', snapshot: { map: run.manifest?.map } });
    game.startRun({
      mode: RUN_MODES.ENDLESS,
      runId: run.runId,
      seed: run.seed,
      endlessRunId: run.runId,
      endlessConfigVersion: run.configVersion,
      endlessSnapshot: run.endlessSnapshot,
      endlessManifest: run.manifest,
      endlessContinuation: run.phaseInitialState,
      currentPhase: run.currentPhase,
      nftRun: run.nftRun,
      tuning: {}
    });
    toast(`Reconnected to Endless Phase ${run.currentPhase}`);
    return true;
  } catch (error) {
    clearPersistedEndlessRun();
    console.warn('[MATT Mine] Endless reconnect unavailable.', error);
    return false;
  }
}

async function finalizeEndlessKnockout(run) {
  showFinalizationBusy('CLOSING ENDLESS RUN');
  try {
    await activeEndlessTranscript?.discard?.();
    activeEndlessTranscript = null;
    const accepted = await apiClient.abandonEndlessRun(run.runId, run.runToken, 'knockout');
    renderEndlessBankSummary(accepted.summary);
    if (activeServerRun === run) activeServerRun = null;
    clearPersistedEndlessRun();
    clearPendingFinalization();
    await refreshServerPlayer();
  } catch (error) {
    const errorCode = String(error?.code || 'request_failed').toUpperCase();
    const roninReason = String(error?.details?.reason || '').trim();
    $('#economy-result').innerHTML = `
      <strong>ENDLESS CLOSE FAILED</strong>
      <span>${escapeHtml(error.message || 'The Endless run could not be closed.')}</span>
      <small>ERROR ${escapeHtml(errorCode)}${roninReason ? ` · RONIN ${escapeHtml(roninReason)}` : ''} · This exact message will remain here. Your run and signed checkpoints are still saved. Press RETRY ENDLESS CLOSE; do not start another run.</small>
    `;
    queueFinalizationRetry(() => finalizeEndlessKnockout(run), 'RETRY ENDLESS CLOSE');
    toast(error.message);
  } finally {
    activeEndlessTranscript = null;
    runFinalizationBusy = false;
  }
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
    <button type="button" data-character-select="${id}" ${!character.enabled ? 'disabled' : ''}>${selected === id ? 'SELECTED' : 'SELECT'}</button>
  </article>`).join('') || '<p class="preview-note">Sign in to load your server-owned characters.</p>';
  document.querySelectorAll('[data-character-select]').forEach((button) => button.addEventListener('click', async () => {
    const id = button.dataset.characterSelect;
    const character = serverPlayer.expansion.characters[id];
    try {
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
  activateProfileTab('controls');
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
  const endlessTranscript = activeEndlessTranscript;
  activeServerRun = null;
  activeArenaRun = null;
  activeArenaTranscript = null;
  activeEndlessTranscript = null;
  if (serverRun?.mode === RUN_MODES.ENDLESS) clearPersistedEndlessRun();
  const transcriptDiscard = Promise.all([
    transcript?.discard?.(),
    endlessTranscript?.discard?.()
  ]);
  toast('Run abandoned - no score was submitted');

  void (async () => {
    try {
      await transcriptDiscard;
      if (arenaRun) {
        await retryRunFinalization(
          () => apiClient.abandonArenaRun(arenaRun.runId, arenaRun.runToken)
        );
        await refreshArena(true);
      } else if (serverRun) {
        await retryRunFinalization(
          () => serverRun.mode === RUN_MODES.ENDLESS
            ? apiClient.abandonEndlessRun(serverRun.runId, serverRun.runToken)
            : apiClient.abandonRun(serverRun.runId, serverRun.runToken)
        );
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

async function releaseIssuedServerRun(serverRun, transcript = null) {
  if (!serverRun?.runId || !serverRun?.runToken) return false;
  await transcript?.discard?.().catch(() => undefined);
  try {
    await retryRunFinalization(
      () => serverRun.mode === RUN_MODES.ENDLESS
        ? apiClient.abandonEndlessRun(serverRun.runId, serverRun.runToken)
        : apiClient.abandonRun(serverRun.runId, serverRun.runToken)
    );
    return true;
  } catch (error) {
    // A successful finish makes abandonment return "not active". In every
    // other case the server TTL and Admin release control remain the final
    // fallback, so cleanup must not hide the original run error.
    console.warn('[MATT Mine] Issued run cleanup could not be confirmed.', error);
    return false;
  } finally {
    if (activeServerRun === serverRun) activeServerRun = null;
    if (activeArenaTranscript === transcript) activeArenaTranscript = null;
    if (activeEndlessTranscript === transcript) activeEndlessTranscript = null;
  }
}

function createEndlessTranscript(run) {
  if (!run?.runId || !run?.runToken || !run?.inputCheckpoint) return null;
  return new ArenaTranscript(apiClient, {
    runId: run.runId,
    runToken: run.runToken,
    checkpoint: run.inputCheckpoint
  }, {
    appendEvents: (...args) => apiClient.appendEndlessInputs(...args)
  });
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function formatCrystalReset(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '00:00 UTC';
  const date = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  }).format(new Date(value)).toUpperCase();
  return `${date} · 00:00 UTC`;
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
    [RUN_MODES.PAID]: 'pass',
    [RUN_MODES.ENDLESS]: 'endless',
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
    openMineRoute('arena');
    return;
  }
  if (slot.id === 'pass') {
    openMineRoute('pass-mine');
    return;
  }
  if (slot.id === 'endless') {
    openMineRoute('endless');
    return;
  }
  const mode = { practice: RUN_MODES.PRACTICE }[slot.id];
  if (mode) void startRunMode(mode);
});

window.addEventListener('beforeunload', (event) => {
  if (!activeServerRun && !activeArenaRun) return;
  event.preventDefault();
  event.returnValue = '';
});

async function bootstrapServer() {
  try {
    [serverConfig, publicPaymentStatus, endlessPublicStatus] = await Promise.all([
      apiClient.config(),
      apiClient.publicPaymentStatus(),
      apiClient.endlessStatus()
    ]);
    const restored = await wallet.restore();
    if (restored) {
      serverPlayer = restored;
      profile = restored.profile;
      saveProfile(profile);
      game.setProfile(profile);
      await refreshPaymentStatus(true);
      const storedMinerId = Number(sessionStorage.getItem(SELECTED_MINER_STORAGE_KEY) || 0);
      if (ownedNftMiners().some((miner) => miner.minerId === storedMinerId)) {
        rememberSelectedMiner(storedMinerId);
      } else if (storedMinerId && restored.nftMinerIds?.includes(storedMinerId)) {
        try {
          const storedMiner = await apiClient.ownedMiner(storedMinerId);
          cacheOwnedMiner(storedMiner);
          rememberSelectedMiner(storedMinerId);
        } catch {}
      }
    }
    await refreshArena(true);
    await mountMineHub(apiClient);
    await reconnectPersistedEndlessRun();
  } catch (error) {
    console.warn('[MATT Mine] Server bootstrap unavailable.', error);
    await mountMineHub(apiClient);
  }
  const adminButton = $('#admin-button');
  adminButton.hidden = !isLocalPreview;
  adminButton.parentElement?.classList.toggle('public-menu', !isLocalPreview);
  updateMenu();
  const loadoutConfirmed = new URLSearchParams(globalThis.location?.search || '').get('loadout') === 'confirmed';
  if (serverPlayer?.identity?.requiresSetup) openMinerProfile(true);
  else if (serverPlayer && loadoutConfirmed) {
    sessionStorage.removeItem(SELECTED_MINER_STORAGE_KEY);
    history.replaceState({}, '', '/');
    await openMinerSelect();
    toast(`Miner #${selectedNftMinerId} loadout confirmed · Ronin Mainnet restored`);
  }
  else if (serverPlayer && pendingMineDestination) await openMinerSelect();
  await startCompetitionStudioTest();
}

updateMenu();
showScreen('launch');
void bootstrapServer();

setInterval(() => {
  const run = activeServerRun;
  if (run?.mode !== RUN_MODES.ENDLESS || !run.checkpoint || endlessCheckpointBusy) return;
  void apiClient.heartbeatEndlessRun(run.runId, run.runToken, run.checkpoint).catch((error) => {
    if (!isRetryableAppendError(error)) console.warn('[MATT Mine] Endless heartbeat rejected.', error);
  });
}, 30_000);
