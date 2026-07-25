import { apiClient } from './apiClient.js';

export class RoninWalletAdapter {
  constructor(options = {}) {
    this.api = options.api || apiClient;
    this.window = options.window || globalThis.window;
    this.player = null;
    this.provider = null;
    this.onInvalidated = options.onInvalidated || (() => {});
    this.boundAccountsChanged = (accounts) => this.handleAccountsChanged(accounts);
    this.boundChainChanged = () => this.invalidate('Ronin network changed. Sign in again.');
  }

  async restore() {
    if (!this.api.hasSession()) return null;
    try {
      this.player = await this.api.me();
      this.provider = this.window?.ronin?.provider || null;
      this.subscribe();
      return this.player;
    } catch {
      this.api.clearSession();
      this.player = null;
      return null;
    }
  }

  async connect() {
    const config = await this.api.config();
    const provider = this.window?.ronin?.provider;
    if (!provider?.request) {
      throw new Error('Ronin Wallet was not detected. Install the extension or open MATT Mine in the Ronin Wallet browser.');
    }
    this.provider = provider;
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    const address = Array.isArray(accounts) ? accounts[0] : null;
    if (!/^0x[a-fA-F0-9]{40}$/.test(address || '')) throw new Error('Ronin Wallet did not return a valid account.');

    let chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    if (chainId !== config.chainId) {
      await provider.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${config.chainId.toString(16)}` }]
      });
      chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
    }
    if (chainId !== config.chainId) throw new Error(`Switch Ronin Wallet to ${config.chainName}.`);

    const challenge = await this.api.createChallenge(address, chainId, this.window.location.origin);
    const signature = await provider.request({
      method: 'personal_sign',
      params: [challenge.message, address]
    });
    const session = await this.api.verifyChallenge(address, challenge.nonce, signature);
    this.player = session;
    this.subscribe();
    return this.player;
  }

  async signOut() {
    await this.api.signOut();
    this.unsubscribe();
    this.player = null;
  }

  async refresh() {
    this.player = await this.api.me();
    return this.player;
  }

  isConnected() {
    return Boolean(this.player && this.api.hasSession());
  }

  subscribe() {
    this.unsubscribe();
    this.provider?.on?.('accountsChanged', this.boundAccountsChanged);
    this.provider?.on?.('chainChanged', this.boundChainChanged);
  }

  unsubscribe() {
    this.provider?.removeListener?.('accountsChanged', this.boundAccountsChanged);
    this.provider?.removeListener?.('chainChanged', this.boundChainChanged);
  }

  handleAccountsChanged(accounts) {
    const address = Array.isArray(accounts) ? accounts[0]?.toLowerCase() : '';
    if (!address || address !== this.player?.address?.toLowerCase()) {
      this.invalidate('Ronin account changed. Sign in again.');
    }
  }

  invalidate(reason) {
    this.api.clearSession();
    this.unsubscribe();
    this.player = null;
    this.onInvalidated(reason);
  }
}

export function parseChainId(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value)) return Number.parseInt(value, 16);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

export const walletAdapter = new RoninWalletAdapter();
