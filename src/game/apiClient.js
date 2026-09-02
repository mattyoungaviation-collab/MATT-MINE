const SESSION_STORAGE_KEY = 'matt-mine-server-session-v1';
const WALLET_SESSION_ERROR_CODES = new Set([
  'authorization_required',
  'player_session_required',
  'session_expired',
  'session_invalid',
  'session_missing'
]);

export function walletSessionReauthenticationRequired(error) {
  return Number(error?.status || 0) === 401 && WALLET_SESSION_ERROR_CODES.has(String(error?.code || ''));
}

export class MattMineApiError extends Error {
  constructor(message, status = 0, code = 'request_failed', details = null) {
    super(message);
    this.name = 'MattMineApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class MattMineApiClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.storage = options.storage || globalThis.sessionStorage;
    this.token = this.storage?.getItem(SESSION_STORAGE_KEY) || '';
  }

  async config() {
    const response = await this.request('/api/config');
    return response.config;
  }

  async siteTheme() {
    const response = await this.request('/api/theme');
    return response.siteTheme;
  }

  async publicPaymentStatus() {
    const response = await this.request('/api/payments/public-status');
    return response.status;
  }

  async mineSlots() {
    return this.request('/api/mines');
  }

  async mineSlot(slotId, period = '') {
    const query = period ? `?${new URLSearchParams({ period })}` : '';
    return this.request(`/api/mines/${encodeURIComponent(slotId)}${query}`);
  }

  async endlessStatus() {
    const response = await this.request('/api/endless/status');
    return response.endless;
  }

  async prepareEndlessEntry(minerId) {
    const response = await this.request('/api/endless/entry/prepare', {
      method: 'POST',
      authenticated: true,
      body: { minerId }
    });
    return response.entry;
  }

  async appendEndlessInputs(runId, runToken, previousCheckpoint, events) {
    const response = await this.request('/api/endless/inputs', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, previousCheckpoint, events }
    });
    return response.inputCheckpoint;
  }

  async checkpointEndlessPhase(runId, runToken, previousCheckpoint, inputCheckpoint, action) {
    return this.request('/api/endless/checkpoint', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, previousCheckpoint, inputCheckpoint, action }
    });
  }

  async heartbeatEndlessRun(runId, runToken, checkpoint) {
    return this.request('/api/endless/heartbeat', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, checkpoint }
    });
  }

  async reconnectEndlessRun(runId, runToken) {
    const response = await this.request('/api/endless/reconnect', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken }
    });
    return response.run;
  }

  async resumeEndlessRun(minerId) {
    const response = await this.request('/api/endless/resume', {
      method: 'POST',
      authenticated: true,
      body: { minerId }
    });
    return response.run;
  }

  async abandonEndlessRun(runId, runToken, reason = 'abandoned') {
    return this.request('/api/endless/abandon', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, reason }
    });
  }

  async retryEndlessSettlement(runId) {
    const response = await this.request('/api/endless/settle', {
      method: 'POST',
      authenticated: true,
      body: { runId }
    });
    return response.settlement;
  }

  async endlessLeaderboard(scope = 'all-time', board = 'score') {
    const query = new URLSearchParams({ scope, board });
    const response = await this.request(`/api/competitions/endless/leaderboard?${query}`, { authenticated: true });
    return response.leaderboard;
  }

  async endlessPlayer() {
    const response = await this.request('/api/endless/player', { authenticated: true });
    return response.player;
  }

  async createChallenge(address, chainId, origin = globalThis.location?.origin) {
    const response = await this.request('/api/auth/challenge', {
      method: 'POST',
      body: { address, chainId, origin }
    });
    return response.challenge;
  }

  async verifyChallenge(address, nonce, signature) {
    const response = await this.request('/api/auth/verify', {
      method: 'POST',
      body: { address, nonce, signature }
    });
    this.setToken(response.session.token);
    return response.session;
  }

  async me() {
    const response = await this.request('/api/me', { authenticated: true });
    return response.player;
  }

  async ownedMiner(minerId) {
    const response = await this.request(`/api/me/miners/${encodeURIComponent(minerId)}`, {
      authenticated: true
    });
    return response.miner;
  }

  async equipmentInventory(cursor = '', limit = 50, priorityTokenIds = []) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', String(cursor));
    if (priorityTokenIds.length > 0) query.set('priority', priorityTokenIds.join(','));
    const response = await this.request(`/api/me/equipment?${query}`, {
      authenticated: true
    });
    return response.inventory;
  }

  async setIdentity(name, avatarDataUrl = '') {
    return this.request('/api/profile/identity', {
      method: 'POST',
      authenticated: true,
      body: { name, avatarDataUrl }
    });
  }

  async updateAvatar(avatarDataUrl) {
    return this.request('/api/profile/avatar', {
      method: 'PUT',
      authenticated: true,
      body: { avatarDataUrl }
    });
  }

  async paymentStatus() {
    const response = await this.request('/api/payments/status', { authenticated: true });
    return response.status;
  }

  async confirmPassPurchase(transactionHash) {
    return this.request('/api/payments/pass/confirm', {
      method: 'POST',
      authenticated: true,
      body: { transactionHash }
    });
  }

  async consumablesCatalog() {
    const response = await this.request('/api/consumables', { authenticated: this.hasSession() });
    return response;
  }

  async updateConsumableLoadout(items) {
    return this.request('/api/consumables/loadout', {
      method: 'PUT',
      authenticated: true,
      body: { items }
    });
  }

  async consumablePurchaseQuote(items) {
    return this.request('/api/consumables/purchases/quote', {
      method: 'POST',
      authenticated: true,
      body: { items }
    });
  }

  async confirmConsumablePurchase(quoteId, transactionHash) {
    return this.request('/api/consumables/purchases/confirm', {
      method: 'POST',
      authenticated: true,
      body: { quoteId, transactionHash }
    });
  }

  async passRewards() {
    return this.request('/api/pass/rewards', { authenticated: true });
  }

  async syncPassRewards() {
    return this.request('/api/pass/rewards/sync', {
      method: 'POST',
      authenticated: true,
      body: {}
    });
  }

  async equipPassCosmetic(slot, cosmeticId) {
    return this.request('/api/pass/loadout', {
      method: 'PUT',
      authenticated: true,
      body: { slot, cosmeticId }
    });
  }

  async openPassChest(chestId) {
    return this.request('/api/pass/chests/open', {
      method: 'POST',
      authenticated: true,
      body: { chestId }
    });
  }

  async paidRunQuote() {
    const response = await this.request('/api/payments/paid-run/quote', {
      method: 'POST',
      authenticated: true,
      body: {}
    });
    return response.quote;
  }

  async confirmPaidRunPurchase(transactionHash) {
    return this.request('/api/payments/paid-run/confirm', {
      method: 'POST',
      authenticated: true,
      body: { transactionHash }
    });
  }

  async arenaConfig(day = '') {
    const query = day ? `?${new URLSearchParams({ day })}` : '';
    const response = await this.request(`/api/arena/config${query}`);
    return response.arena || response.config;
  }

  async arenaEntryQuote(day = '', eligibility = null) {
    const response = await this.request('/api/arena/entries/quote', {
      method: 'POST',
      authenticated: true,
      body: {
        ...(day ? { day } : {}),
        ...(eligibility ? { eligibility } : {})
      }
    });
    return response.quote;
  }

  async confirmArenaEntry(transactionHash, eligibilityReceipt = '') {
    return this.request('/api/arena/entries/confirm', {
      method: 'POST',
      authenticated: true,
      body: { transactionHash, eligibilityReceipt }
    });
  }

  async arenaMe(day = '') {
    const query = day ? `?${new URLSearchParams({ day })}` : '';
    const response = await this.request(`/api/arena/me${query}`, {
      authenticated: true
    });
    return response.player || response.arena;
  }

  async arenaLeaderboard(day = '') {
    const query = day ? `?${new URLSearchParams({ day })}` : '';
    const response = await this.request(`/api/arena/leaderboard${query}`);
    return response.leaderboard;
  }

  async startArenaRun(minerId, entryId = '', approval = null) {
    const response = await this.request('/api/arena/runs/start', {
      method: 'POST',
      authenticated: true,
      body: {
        minerId,
        ...(entryId ? { entryId } : {}),
        ...(approval ? approval : {})
      }
    });
    return response.run;
  }

  async appendArenaEvents(runId, runToken, previousCheckpoint, events) {
    const response = await this.request('/api/arena/runs/events', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, previousCheckpoint, events }
    });
    return response.checkpoint;
  }

  async appendCompetitiveEvents(runId, runToken, previousCheckpoint, events) {
    const response = await this.request('/api/runs/competitive/events', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, previousCheckpoint, events }
    });
    return response.checkpoint;
  }

  async finishArenaRun(runId, runToken, checkpoint) {
    return this.request('/api/arena/runs/finish', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, checkpoint }
    });
  }

  async abandonArenaRun(runId, runToken) {
    return this.request('/api/arena/runs/abandon', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken }
    });
  }

  async abandonActiveArenaRun() {
    return this.request('/api/arena/runs/abandon-active', {
      method: 'POST',
      authenticated: true,
      body: {}
    });
  }

  async prepareArenaRefund(day = '') {
    return this.request('/api/arena/refunds/prepare', {
      method: 'POST',
      authenticated: true,
      body: day ? { day } : {}
    });
  }

  async prepareNftRunAuthorization(mode, minerId) {
    const response = await this.request('/api/nft/v2/runs/authorization', {
      method: 'POST',
      authenticated: true,
      body: { mode, minerId }
    });
    return response.authorization;
  }

  async startRun(mode, minerId = 0, approval = null, extra = null) {
    const response = await this.request('/api/runs/start', {
      method: 'POST',
      authenticated: true,
      body: { mode, ...(minerId ? { minerId } : {}), ...(approval ? approval : {}), ...(extra || {}) }
    });
    return response.run;
  }

  async restartInterruptedNftPractice() {
    const response = await this.request('/api/runs/nft-practice/restart', {
      method: 'POST',
      authenticated: true,
      body: {}
    });
    return response.run;
  }

  async recoverLockedMinerRun(minerId) {
    const response = await this.request('/api/nft/v2/runs/recover', {
      method: 'POST',
      authenticated: true,
      body: { minerId }
    });
    return response.recovery;
  }

  async finishRun(runId, runToken, result, competitiveCheckpoint = null) {
    return this.request('/api/runs/finish', {
      method: 'POST',
      authenticated: true,
      body: {
        runId,
        runToken,
        result,
        ...(competitiveCheckpoint ? { competitiveCheckpoint } : {})
      }
    });
  }

  async updateKeybindings(keybindings) {
    const response = await this.request('/api/profile/keybindings', {
      method: 'PUT',
      authenticated: true,
      body: { keybindings }
    });
    return response.keybindings;
  }

  async expansionStatus() {
    const response = await this.request('/api/expansion/status', { authenticated: true });
    return response.expansion;
  }

  async updateController(controller) {
    const response = await this.request('/api/profile/controller', {
      method: 'PUT',
      authenticated: true,
      body: { controller }
    });
    return response.controller;
  }

  async selectCharacter(characterId) {
    return this.request('/api/characters/select', {
      method: 'POST',
      authenticated: true,
      body: { characterId }
    });
  }

  async betaAccess() {
    const response = await this.request('/api/beta/access', {
      method: 'POST',
      authenticated: true,
      body: {}
    });
    return response.beta;
  }

  async requestPaidRevive(runId, deathState) {
    const response = await this.request('/api/revives/request', {
      method: 'POST',
      authenticated: true,
      body: { runId, deathState }
    });
    return response.revive;
  }

  async confirmPaidRevive(runId, transactionHash) {
    const response = await this.request('/api/revives/confirm', {
      method: 'POST',
      authenticated: true,
      body: { runId, transactionHash }
    });
    return response.revive;
  }

  async cancelPaidRevive(runId) {
    const response = await this.request('/api/revives/cancel', {
      method: 'POST',
      authenticated: true,
      body: { runId }
    });
    return response.revive;
  }

  async gameTuning(lobby) {
    const response = await this.request(`/api/game-tuning/${encodeURIComponent(lobby)}`);
    return response.preset;
  }

  async abandonRun(runId, runToken) {
    return this.request('/api/runs/abandon', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken }
    });
  }

  async leaderboard(mode, week = '') {
    const query = new URLSearchParams({ mode });
    if (week) query.set('week', week);
    const response = await this.request(`/api/leaderboards?${query}`, {
      authenticated: true
    });
    return response.leaderboard;
  }

  async rewardClaims() {
    const response = await this.request('/api/rewards/claims', {
      authenticated: true
    });
    return response.claims;
  }

  async prepareRewardClaim(draftId) {
    return this.request(`/api/rewards/claims/${encodeURIComponent(draftId)}/prepare`, {
      method: 'POST',
      authenticated: true,
      body: {}
    });
  }

  async signOut() {
    if (this.token) {
      try {
        await this.request('/api/auth/logout', {
          method: 'POST',
          authenticated: true,
          body: {}
        });
      } catch {}
    }
    this.clearSession();
  }

  hasSession() {
    return Boolean(this.token);
  }

  clearSession() {
    this.token = '';
    try {
      this.storage?.removeItem(SESSION_STORAGE_KEY);
    } catch {}
  }

  setToken(token) {
    this.token = token;
    try {
      this.storage?.setItem(SESSION_STORAGE_KEY, token);
    } catch {}
  }

  async request(path, options = {}) {
    if (!this.fetch) throw new MattMineApiError('This browser does not support server requests.');
    const headers = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.authenticated) {
      if (!this.token) throw new MattMineApiError('Sign in with Ronin Wallet to continue.', 401, 'session_missing');
      headers.authorization = `Bearer ${this.token}`;
    }
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw new MattMineApiError('The MATT Mine server is unavailable.', 0, 'server_unavailable');
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch {}
    if (!response.ok || !payload?.ok) {
      const error = new MattMineApiError(
        payload?.error?.message || `Server request failed (${response.status}).`,
        response.status,
        payload?.error?.code || 'request_failed',
        payload?.error?.details || null
      );
      // Run tokens and signed checkpoints also use HTTP 401. They must not
      // silently sign out an otherwise-valid wallet session.
      if (walletSessionReauthenticationRequired(error)) this.clearSession();
      throw error;
    }
    return payload;
  }
}

export const apiClient = new MattMineApiClient();
export { SESSION_STORAGE_KEY };
