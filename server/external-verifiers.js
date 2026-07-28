import { createHmac, timingSafeEqual } from 'node:crypto';
import { DirectRoninNuggetPaymentVerifier } from './nugget-payment-verifier.js';

export class DisabledAdvertisementVerifier {
  publicStatus() {
    return { configured: false, enabled: false, blocker: 'signed_provider_verifier_required' };
  }

  async verifyCompletion() {
    throw Object.assign(new Error('A signed advertisement provider verifier is required.'), {
      code: 'advertisement_provider_disabled'
    });
  }
}

export class DisabledRevivePaymentVerifier {
  publicStatus() {
    return { configured: false, enabled: false, blocker: 'exact_onchain_revive_verifier_required' };
  }

  async verifyPayment() {
    throw Object.assign(new Error('Exact on-chain revive payment verification is required.'), {
      code: 'revive_payment_verifier_missing'
    });
  }
}

export class DirectRoninRevivePaymentVerifier {
  constructor(options = {}) {
    this.recipient = String(options.recipient || '');
    this.verifier = options.verifier || new DirectRoninNuggetPaymentVerifier(options);
    if (!/^0x[a-fA-F0-9]{40}$/.test(this.recipient)) {
      throw new TypeError('A valid revive Treasury recipient is required.');
    }
  }

  publicStatus() {
    return {
      configured: true,
      enabled: true,
      asset: 'RON',
      recipient: this.recipient.toLowerCase(),
      verification: 'exact-direct-transfer'
    };
  }

  transactionForPayment(amountWei) {
    return this.verifier.transactionForQuote({
      asset: 'RON',
      amountAtomic: String(amountWei),
      recipient: this.recipient
    });
  }

  async verifyPayment({ transactionHash, address, amountWei }) {
    const verified = await this.verifier.verifyExactTransfer(
      transactionHash,
      address,
      {
        asset: 'RON',
        amountAtomic: String(amountWei),
        recipient: this.recipient
      }
    );
    return {
      transactionHash: verified.transactionHash,
      amountWei: verified.amountAtomic,
      recipient: verified.recipient,
      blockNumber: verified.blockNumber
    };
  }
}

export class HmacAdvertisementVerifier {
  constructor(options = {}) {
    this.secret = String(options.secret || '');
    this.provider = String(options.provider || 'server-signed').slice(0, 80);
    if (this.secret.length < 32) throw new TypeError('Advertisement verification secret must contain at least 32 characters.');
  }

  publicStatus() {
    return {
      configured: true,
      enabled: true,
      provider: this.provider,
      verification: 'hmac-sha256'
    };
  }

  async verifyCompletion(completion, expected = {}) {
    const token = String(completion?.token || completion || '');
    const [encoded, signature] = token.split('.');
    if (!encoded || !/^[a-f0-9]{64}$/.test(signature || '')) {
      throw verifierError('advertisement_completion_invalid');
    }
    const expectedSignature = createHmac('sha256', this.secret).update(encoded).digest('hex');
    if (!safeEqual(signature, expectedSignature)) throw verifierError('advertisement_signature_invalid');
    let payload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw verifierError('advertisement_completion_invalid');
    }
    if (
      payload.provider !== this.provider ||
      !/^[a-zA-Z0-9:_-]{8,160}$/.test(String(payload.completionId || '')) ||
      String(payload.address || '').toLowerCase() !== String(expected.address || '').toLowerCase() ||
      String(payload.runId || '') !== String(expected.runId || '') ||
      !Number.isSafeInteger(payload.expiresAt) ||
      !Number.isFinite(payload.percent)
    ) {
      throw verifierError('advertisement_completion_mismatch');
    }
    return {
      completionId: payload.completionId,
      expiresAt: payload.expiresAt,
      percent: payload.percent,
      provider: payload.provider
    };
  }
}

export function calculateAdvertisementBonus(serverRecordedReward, percent) {
  const reward = Number(serverRecordedReward);
  const rate = Number(percent);
  if (!Number.isSafeInteger(reward) || reward < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error('invalid_advertisement_bonus_input');
  }
  return Math.floor(reward * rate / 100);
}

export function calculateDeathRetention(eligibleNuggets, percentage) {
  const nuggets = Number(eligibleNuggets);
  const rate = Number(percentage);
  if (!Number.isSafeInteger(nuggets) || nuggets < 0 || !Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new Error('invalid_death_retention_input');
  }
  return {
    earned: nuggets,
    retained: Math.floor(nuggets * rate / 100),
    lost: nuggets - Math.floor(nuggets * rate / 100)
  };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifierError(code) {
  return Object.assign(new Error(code), { code });
}
