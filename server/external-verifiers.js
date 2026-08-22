import { DirectRoninTransferVerifier } from './direct-ronin-transfer-verifier.js';

export class DisabledRevivePaymentVerifier {
  publicStatus() { return { configured: false, enabled: false, blocker: 'exact_onchain_revive_verifier_required' }; }
  async verifyPayment() {
    throw Object.assign(new Error('Exact on-chain revive payment verification is required.'), { code: 'revive_payment_verifier_missing' });
  }
}

export class DirectRoninRevivePaymentVerifier {
  constructor(options = {}) {
    this.recipient = String(options.recipient || '');
    this.verifier = options.verifier || new DirectRoninTransferVerifier(options);
    if (!/^0x[a-fA-F0-9]{40}$/.test(this.recipient)) throw new TypeError('A valid revive Treasury recipient is required.');
  }

  publicStatus() {
    return { configured: true, enabled: true, asset: 'RON', recipient: this.recipient.toLowerCase(), verification: 'exact-direct-transfer' };
  }

  transactionForPayment(amountWei) {
    const transfer = { asset: 'RON', amountAtomic: String(amountWei), recipient: this.recipient };
    return typeof this.verifier.transactionForTransfer === 'function'
      ? this.verifier.transactionForTransfer(transfer)
      : this.verifier.transactionForQuote(transfer);
  }

  async verifyPayment({ transactionHash, address, amountWei }) {
    const verified = await this.verifier.verifyExactTransfer(transactionHash, address, {
      asset: 'RON', amountAtomic: String(amountWei), recipient: this.recipient
    });
    return {
      transactionHash: verified.transactionHash,
      amountWei: verified.amountAtomic,
      recipient: verified.recipient,
      blockNumber: verified.blockNumber,
      transactionBlockAt: verified.transactionBlockAt
    };
  }
}

export function calculateDeathRetention(eligibleScore, percentage) {
  const score = Number(eligibleScore);
  const rate = Number(percentage);
  if (!Number.isSafeInteger(score) || score < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('invalid_death_retention_input');
  const retained = Math.floor(score * rate / 100);
  return { earned: score, retained, lost: score - retained };
}
