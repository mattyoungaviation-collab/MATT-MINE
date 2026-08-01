import { ApiError } from './errors.js';

export class PaidCompetitionEligibilityPolicy {
  constructor(options = {}) {
    this.counselApproved = options.counselApproved === true;
    this.rulesVersion = String(options.rulesVersion || '').trim();
    this.allowedWallets = new Set((options.allowedWallets || [])
      .map((value) => String(value).toLowerCase())
      .filter((value) => /^0x[a-f0-9]{40}$/.test(value)));
  }

  assertEligible(address, context = {}) {
    if (!this.counselApproved || !this.rulesVersion) {
      throw new ApiError(503, 'paid_competition_eligibility_unconfigured', 'Paid competition is unavailable until counsel-approved eligibility rules are configured. Practice remains available.');
    }
    if (!this.allowedWallets.has(String(address).toLowerCase())) {
      throw new ApiError(403, 'paid_competition_ineligible', 'This wallet is not eligible for paid competition under the configured rules.');
    }
    return { eligible: true, rulesVersion: this.rulesVersion, mode: context.mode || 'paid' };
  }

  publicStatus() {
    return {
      configured: this.counselApproved && Boolean(this.rulesVersion),
      rulesVersion: this.rulesVersion || null,
      enforcement: 'server_wallet_allowlist',
      legalApprovalRequired: true
    };
  }
}
