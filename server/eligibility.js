import {
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';
import { ApiError } from './errors.js';

const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const RULES_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RECEIPT_TTL_MS = 30 * 60_000;
const PUBLIC_JURISDICTIONS = Object.freeze([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA',
  'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX',
  'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY'
]);
const PUBLIC_JURISDICTION_SET = new Set(PUBLIC_JURISDICTIONS);

export class PaidCompetitionEligibilityPolicy {
  constructor(options = {}) {
    this.counselApproved = options.counselApproved === true;
    this.rulesVersion = String(options.rulesVersion || '').trim();
    this.rulesHash = String(options.rulesHash || '').trim().toLowerCase();
    this.rulesUrl = String(options.rulesUrl || '').trim();
    this.allowedWallets = new Set((options.allowedWallets || [])
      .map((value) => String(value).toLowerCase())
      .filter((value) => ADDRESS_PATTERN.test(value)));
    this.publicModes = new Set((options.publicModes || [])
      .map((value) => String(value).trim().toLowerCase())
      .filter((value) => ['arena', 'paid'].includes(value)));
    this.receiptSecret = String(options.receiptSecret || '');
    this.now = options.now || Date.now;
    this.randomHex = options.randomHex || ((bytes) => randomBytes(bytes).toString('hex'));
  }

  assertEligible(address, context = {}) {
    const normalizedAddress = normalizeAddress(address);
    const mode = normalizeMode(context.mode);
    this.#assertConfigured(mode);
    if (this.publicModes.has(mode)) {
      return this.#issuePublicReceipt(normalizedAddress, mode, context.attestation);
    }
    if (!this.allowedWallets.has(normalizedAddress)) {
      throw new ApiError(403, 'paid_competition_ineligible', 'This wallet is not eligible for paid competition under the configured rules.');
    }
    return {
      eligible: true,
      rulesVersion: this.rulesVersion,
      mode,
      enforcement: 'server_wallet_allowlist'
    };
  }

  verifyReceipt(address, token, context = {}) {
    const normalizedAddress = normalizeAddress(address);
    const mode = normalizeMode(context.mode);
    this.#assertConfigured(mode);
    if (!this.publicModes.has(mode)) {
      return this.assertEligible(normalizedAddress, { mode });
    }
    const payload = this.#decodeReceipt(token);
    const timestamp = this.now();
    if (
      payload.address !== normalizedAddress ||
      payload.mode !== mode ||
      payload.rulesVersion !== this.rulesVersion ||
      payload.rulesHash !== this.rulesHash ||
      payload.rulesUrl !== this.rulesUrl ||
      !PUBLIC_JURISDICTION_SET.has(payload.jurisdiction) ||
      !Number.isSafeInteger(payload.acceptedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.acceptedAt > timestamp + 30_000 ||
      payload.expiresAt < timestamp
    ) {
      throw new ApiError(403, 'paid_competition_eligibility_receipt_invalid', 'The paid competition eligibility receipt is invalid or expired. Review and accept the current rules again.');
    }
    return publicReceiptRecord(payload);
  }

  publicStatus() {
    const publicModeReady = this.publicModes.size === 0 || this.#publicModeReady();
    return {
      configured: this.counselApproved && Boolean(this.rulesVersion) && publicModeReady,
      rulesVersion: this.rulesVersion || null,
      rulesHash: this.rulesHash || null,
      rulesUrl: this.rulesUrl || null,
      enforcement: this.publicModes.size > 0 ? 'public_attestation' : 'server_wallet_allowlist',
      publicModes: [...this.publicModes],
      minimumAge: 18,
      permittedJurisdictions: PUBLIC_JURISDICTIONS,
      legalApprovalRequired: true
    };
  }

  #assertConfigured(mode) {
    if (!this.counselApproved || !this.rulesVersion) {
      throw new ApiError(503, 'paid_competition_eligibility_unconfigured', 'Paid competition is unavailable until counsel-approved eligibility rules are configured. Practice remains available.');
    }
    if (this.publicModes.has(mode) && !this.#publicModeReady()) {
      throw new ApiError(503, 'paid_competition_public_eligibility_unconfigured', 'Public paid competition is unavailable until its approved rules, immutable hash, and receipt signing are configured.');
    }
  }

  #publicModeReady() {
    return RULES_HASH_PATTERN.test(this.rulesHash) && Boolean(this.rulesUrl) && this.receiptSecret.length >= 32;
  }

  #issuePublicReceipt(address, mode, attestation) {
    const timestamp = this.now();
    const normalized = normalizePublicAttestation(attestation, this.rulesVersion, this.rulesHash, timestamp);
    const acceptedAt = normalized.acceptedAt || timestamp;
    const payload = {
      version: 1,
      receiptId: `paid_eligibility_${this.randomHex(16)}`,
      address,
      mode,
      enforcement: 'public_attestation',
      jurisdiction: normalized.jurisdiction,
      rulesVersion: this.rulesVersion,
      rulesHash: this.rulesHash,
      rulesUrl: this.rulesUrl,
      acceptedAt,
      expiresAt: timestamp + RECEIPT_TTL_MS
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = this.#signature(encodedPayload);
    return {
      ...publicReceiptRecord(payload),
      receiptToken: `${encodedPayload}.${signature}`
    };
  }

  #decodeReceipt(token) {
    const [encodedPayload, candidateSignature, extra] = String(token || '').split('.');
    if (!encodedPayload || !candidateSignature || extra) {
      throw new ApiError(403, 'paid_competition_eligibility_receipt_required', 'Review and accept the current paid competition rules before confirming this entry.');
    }
    const expectedSignature = this.#signature(encodedPayload);
    const candidateBuffer = Buffer.from(candidateSignature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (
      candidateBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(candidateBuffer, expectedBuffer)
    ) {
      throw new ApiError(403, 'paid_competition_eligibility_receipt_invalid', 'The paid competition eligibility receipt is invalid or expired. Review and accept the current rules again.');
    }
    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid payload');
      return payload;
    } catch {
      throw new ApiError(403, 'paid_competition_eligibility_receipt_invalid', 'The paid competition eligibility receipt is invalid or expired. Review and accept the current rules again.');
    }
  }

  #signature(encodedPayload) {
    return createHmac('sha256', this.receiptSecret)
      .update(`matt-mine-paid-eligibility.${encodedPayload}`)
      .digest('base64url');
  }
}

function normalizePublicAttestation(input, rulesVersion, rulesHash, timestamp) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(403, 'paid_competition_attestation_required', 'Public Arena entry requires the eligibility and Official Rules attestations.');
  }
  const jurisdiction = String(input.jurisdiction || '').trim().toUpperCase().replace(/^US-/, '');
  if (!PUBLIC_JURISDICTION_SET.has(jurisdiction)) {
    throw new ApiError(403, 'paid_competition_jurisdiction_ineligible', 'Public Arena entry is limited to players physically located in an approved U.S. state or the District of Columbia.');
  }
  if (input.age18OrOlder !== true) {
    throw new ApiError(403, 'paid_competition_age_ineligible', 'Public Arena players must be at least 18 years old.');
  }
  if (input.locatedInJurisdiction !== true) {
    throw new ApiError(403, 'paid_competition_location_attestation_required', 'Confirm that you are physically located in the selected approved jurisdiction.');
  }
  if (input.notProhibited !== true) {
    throw new ApiError(403, 'paid_competition_prohibited_activity_attestation_required', 'Confirm that sanctions, court orders, fraud, automation, cheating, and other legal prohibitions do not apply.');
  }
  if (
    input.acceptedRules !== true ||
    String(input.rulesVersion || '') !== rulesVersion ||
    String(input.rulesHash || '').toLowerCase() !== rulesHash
  ) {
    throw new ApiError(403, 'paid_competition_rules_acceptance_required', 'Read and accept the exact current Official Rules version before purchasing an Arena entry.');
  }
  const acceptedAt = Number.isSafeInteger(input.acceptedAt) && input.acceptedAt > 0 && input.acceptedAt <= timestamp
    ? input.acceptedAt
    : 0;
  return { jurisdiction, acceptedAt };
}

function normalizeAddress(address) {
  const normalized = String(address || '').toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) {
    throw new ApiError(401, 'paid_competition_wallet_invalid', 'A valid signed-in wallet is required for paid competition.');
  }
  return normalized;
}

function normalizeMode(mode) {
  const normalized = String(mode || 'paid').trim().toLowerCase();
  return ['arena', 'paid'].includes(normalized) ? normalized : 'paid';
}

function publicReceiptRecord(payload) {
  return {
    eligible: true,
    receiptId: payload.receiptId,
    rulesVersion: payload.rulesVersion,
    rulesHash: payload.rulesHash,
    rulesUrl: payload.rulesUrl,
    mode: payload.mode,
    enforcement: 'public_attestation',
    jurisdiction: payload.jurisdiction,
    acceptedAt: payload.acceptedAt,
    expiresAt: payload.expiresAt
  };
}
