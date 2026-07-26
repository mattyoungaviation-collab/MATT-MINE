const SESSION_STORAGE_KEY = 'matt-mine-server-session-v1';

export class MattMineApiError extends Error {
  constructor(message, status = 0, code = 'request_failed') {
    super(message);
    this.name = 'MattMineApiError';
    this.status = status;
    this.code = code;
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

  async publicPaymentStatus() {
    const response = await this.request('/api/payments/public-status');
    return response.status;
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

  async startRun(mode) {
    const response = await this.request('/api/runs/start', {
      method: 'POST',
      authenticated: true,
      body: { mode }
    });
    return response.run;
  }

  async finishRun(runId, runToken, result) {
    return this.request('/api/runs/finish', {
      method: 'POST',
      authenticated: true,
      body: { runId, runToken, result }
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

  async purchaseUpgrade(upgradeId) {
    return this.request('/api/profile/upgrades', {
      method: 'POST',
      authenticated: true,
      body: { upgradeId }
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
      if (response.status === 401) this.clearSession();
      throw new MattMineApiError(
        payload?.error?.message || `Server request failed (${response.status}).`,
        response.status,
        payload?.error?.code || 'request_failed'
      );
    }
    return payload;
  }
}

export const apiClient = new MattMineApiClient();
export { SESSION_STORAGE_KEY };
