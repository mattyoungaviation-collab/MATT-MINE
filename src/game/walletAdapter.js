import { apiClient } from './apiClient.js';

export const MATT_REWARDS_CONTRACT = '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619';
export const MATT_REWARD_CLAIM_SELECTOR = '0x8a23213f';

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

  async purchasePass(transaction) {
    return this.sendPreparedTransaction(transaction);
  }

  async purchasePaidRun(transaction) {
    return this.sendPreparedTransaction(transaction);
  }

  async purchaseArenaEntry(transactions) {
    return this.sendPreparedTransactions(transactions, { allowZeroValue: true });
  }

  async claimArenaRefund(transaction) {
    return this.sendPreparedTransaction(transaction, { allowZeroValue: true });
  }

  async claimReward(transaction) {
    validateRewardClaimTransaction(transaction, {
      requireSelector: Boolean(this.window?.location?.origin)
    });
    return this.sendPreparedTransaction(transaction, {
      allowZeroValue: true,
      verifyBroadcast: true
    });
  }

  async sendPreparedTransactions(transactions, options = {}) {
    const prepared = Array.isArray(transactions) ? transactions : [transactions];
    if (!prepared.length || prepared.length > 3) {
      throw new Error('The server did not provide a valid Arena transaction sequence.');
    }
    const hashes = [];
    for (const transaction of prepared) {
      hashes.push(await this.sendPreparedTransaction(transaction, options));
    }
    return hashes;
  }

  async sendPreparedTransaction(transaction, options = {}) {
    if (!this.player || !this.provider?.request) {
      throw new Error('Sign in with Ronin Wallet before sending this transaction.');
    }
    validatePreparedTransaction(transaction, options);
    const accounts = await this.provider.request({ method: 'eth_requestAccounts' });
    const walletAddress = Array.isArray(accounts) ? accounts[0] : '';
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress || '')) {
      throw new Error('Ronin Wallet did not return a valid account.');
    }
    if (walletAddress.toLowerCase() !== this.player.address?.toLowerCase()) {
      throw new Error('Ronin Wallet is on a different account. Switch to the wallet signed in to MATT Mine, then try again.');
    }
    const chainId = parseChainId(await this.provider.request({ method: 'eth_chainId' }));
    if (chainId !== 2020) throw new Error('Switch Ronin Wallet to Ronin Mainnet.');
    let transactionHash;
    try {
      transactionHash = await this.provider.request({
        method: 'eth_sendTransaction',
        params: [{
          from: this.player.address,
          to: transaction.to,
          value: transaction.value,
          data: transaction.data
        }]
      });
    } catch (error) {
      throw new Error(walletTransactionError(error));
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash || '')) {
      throw new Error('Ronin Wallet did not return a valid transaction hash.');
    }
    await waitForWalletReceipt(this.provider, transactionHash);
    if (options.verifyBroadcast) {
      await verifyBroadcastTransaction(this.provider, transactionHash, transaction);
    }
    return transactionHash;
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

function walletTransactionError(error) {
  const code = Number(error?.code);
  if (code === 4001) return 'The transaction was canceled in Ronin Wallet.';
  const message = String(
    error?.shortMessage ||
    error?.data?.message ||
    error?.message ||
    ''
  ).replace(/^Error:\s*/i, '').trim();
  if (/insufficient funds/i.test(message)) {
    return 'This wallet needs a small amount of RON for network gas.';
  }
  if (/revert|execution reverted/i.test(message)) {
    return 'Ronin rejected the claim during its safety check. Refresh the leaderboard and try again.';
  }
  return message || 'Ronin Wallet could not send the transaction.';
}

export function parseChainId(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^0x[a-fA-F0-9]+$/.test(value)) return Number.parseInt(value, 16);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return Number.NaN;
}

export function validateRewardClaimTransaction(transaction, options = {}) {
  validatePreparedTransaction(transaction, { allowZeroValue: true });
  const target = String(transaction.to || '').toLowerCase();
  const selector = String(transaction.data || '').slice(0, 10).toLowerCase();
  const requireSelector = options.requireSelector !== false;
  if (
    target !== MATT_REWARDS_CONTRACT.toLowerCase() ||
    (requireSelector && selector !== MATT_REWARD_CLAIM_SELECTOR) ||
    BigInt(transaction.value) !== 0n
  ) {
    throw new Error(
      `Blocked an unsafe MATT claim. Expected ${MATT_REWARDS_CONTRACT} / ${MATT_REWARD_CLAIM_SELECTOR}, ` +
      `received ${transaction.to || 'no target'} / ${selector || 'no selector'}. Refresh the game before trying again.`
    );
  }
}

function validatePreparedTransaction(transaction, options = {}) {
  if (
    !transaction ||
    !/^0x[a-fA-F0-9]{40}$/.test(transaction.to || '') ||
    !/^0x[a-fA-F0-9]+$/.test(transaction.value || '') ||
    !/^0x[a-fA-F0-9]*$/.test(transaction.data || '')
  ) {
    throw new Error('The server did not provide a valid MATT Mine transaction.');
  }
  if (!options.allowZeroValue && BigInt(transaction.value) <= 0n) {
    throw new Error('The transaction value must be greater than zero.');
  }
}

async function verifyBroadcastTransaction(provider, transactionHash, expected) {
  let submitted;
  try {
    submitted = await provider.request({
      method: 'eth_getTransactionByHash',
      params: [transactionHash]
    });
  } catch {
    return;
  }
  if (!submitted) return;
  const actualTo = String(submitted.to || '').toLowerCase();
  const actualData = String(submitted.input || submitted.data || '').toLowerCase();
  if (
    actualTo !== String(expected.to || '').toLowerCase() ||
    actualData !== String(expected.data || '').toLowerCase()
  ) {
    const actualSelector = actualData.slice(0, 10) || 'no selector';
    throw new Error(
      `Ronin Wallet broadcast a different transaction: ${submitted.to || 'no target'} / ${actualSelector}. ` +
      `Do not retry. Lock the wallet, disable other wallet extensions, refresh MATT Mine, and sign in again. ` +
      `Transaction ${transactionHash}`
    );
  }
}

async function waitForWalletReceipt(provider, transactionHash, options = {}) {
  const timeoutMs = options.timeoutMs || 120_000;
  const pollMs = options.pollMs || 1_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const receipt = await provider.request({
      method: 'eth_getTransactionReceipt',
      params: [transactionHash]
    });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The Ronin transaction reverted.');
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error('The transaction is still pending. Check Ronin Wallet and refresh shortly.');
}

export const walletAdapter = new RoninWalletAdapter();
