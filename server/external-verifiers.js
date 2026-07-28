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
