import { createHash, timingSafeEqual } from 'node:crypto';
import { getAddress } from 'viem';
import { HARD_MAX_BOARD_MATT } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { MATT_MINE_ADMIN_CONTRACTS } from './admin-controls.js';
import { createSafeTransactionBuilderFile } from './safe-transaction-builder.js';
import {
  createRewardPlan,
  normalizeRewardMode,
  normalizeRewardWeek
} from './reward-plan.js';

const DAY_SECONDS = 24 * 60 * 60;

export class RewardManager {
  constructor(options = {}) {
    this.store = options.store;
    this.chain = options.chain;
    this.now = options.now || Date.now;
    this.adminKey = String(options.adminKey || '');
    this.approverKey = String(options.approverKey || '');
    this.publicationEnabled = options.publicationEnabled === true;
    this.maxBoardMatt = boundedBoardCap(options.maxBoardMatt);
  }

  async init() {
    await this.store?.init?.();
    return this;
  }

  publicConfig() {
    return {
      available: Boolean(this.store && this.chain),
      publicationEnabled: this.publicationEnabled,
      maxBoardMatt: this.maxBoardMatt,
      ...(this.chain?.publicConfig?.() || {})
    };
  }

  async createDraft(adminKey, input = {}) {
    this.assertPrimary(adminKey);
    this.assertAvailable();
    const mode = normalizeRewardMode(input.mode);
    const week = normalizeRewardWeek(input.week);
    const claimDays = normalizeClaimDays(input.claimDays);
    const snapshot = await this.store.finalizedSnapshot(mode, week);
    assertApi(snapshot, 409, 'leaderboard_not_finalized', 'The requested board does not have an immutable weekly snapshot yet.');
    const plan = createRewardPlan({
      snapshot,
      poolMatt: input.poolMatt,
      claimDeadline: Math.floor(this.now() / 1000) + claimDays * DAY_SECONDS,
      maxBoardMatt: this.maxBoardMatt
    });
    return this.store.createDraft(plan, this.now());
  }

  async approveDraft(approverKey, id) {
    this.assertIndependent(approverKey);
    this.assertAvailable();
    await this.store.approveDraft(normalizeDraftId(id), this.now());
    const draft = await this.requireDraft(id);
    const publication = await this.chain.publicationTransactions(draft);
    const transactions = Array.isArray(publication) ? publication : publication.transactions;
    const safeTransactionBuilderFile = createSafeTransactionBuilderFile(transactions, {
      chainId: 2020,
      createdAt: this.now(),
      safeAddress: MATT_MINE_ADMIN_CONTRACTS.safe,
      name: `MATT Mine rewards: ${draft.id}`,
      description: `Fund and publish the independently approved ${draft.mode} reward epoch.`
    });
    return {
      draft,
      broadcastReady: this.publicationEnabled,
      safety: this.publicationEnabled
        ? `Pilot publication is enabled and capped at ${this.maxBoardMatt.toLocaleString('en-US')} MATT per board.`
        : 'DRY RUN: publication is disabled. These Safe transactions are previews and should not be executed.',
      [this.publicationEnabled ? 'safeTransactions' : 'safeTransactionPreview']: transactions,
      safeTransactionBuilderFile,
      safeFileName: `matt-mine-${draft.id}-safe.json`,
      ...(publication?.vault ? { vault: publication.vault } : {})
    };
  }

  async syncDraft(adminKey, id, transactionHash = '') {
    this.assertPrimary(adminKey);
    this.assertAvailable();
    const draft = await this.requireDraft(id);
    assertApi(
      ['approved', 'published'].includes(draft.status),
      409,
      'reward_draft_not_approved',
      'The reward draft requires independent approval first.'
    );
    const status = await this.chain.epochStatus(draft);
    assertApi(status.published, 409, 'reward_epoch_not_onchain', 'Ronin does not contain the exact approved reward epoch yet.');
    const updated = await this.store.markPublished(
      draft.id,
      normalizeOptionalTransactionHash(transactionHash),
      this.now()
    );
    return { draft: updated, chain: status };
  }

  async listDrafts(adminKey) {
    this.assertPrimary(adminKey);
    this.assertAvailable();
    const drafts = await this.store.listDrafts();
    return {
      publicationEnabled: this.publicationEnabled,
      maxBoardMatt: this.maxBoardMatt,
      drafts: drafts.map(adminRewardDraft)
    };
  }

  async playerRewards(address) {
    this.assertAvailable();
    const player = getAddress(address).toLowerCase();
    const rewards = await this.store.playerRewards(player);
    return Promise.all(rewards.map(async (reward) => {
      if (!['approved', 'published'].includes(reward.status)) {
        return { ...publicReward(reward), chain: { published: false, claimed: false, paused: false } };
      }
      try {
        const chain = await this.chain.epochStatus(reward, player);
        if (chain.published && reward.status !== 'published') {
          await this.store.markPublished(reward.id, '', this.now());
          reward.status = 'published';
          reward.publishedAt = this.now();
        }
        return { ...publicReward(reward), chain };
      } catch {
        return {
          ...publicReward(reward),
          chain: {
            published: reward.status === 'published',
            claimed: false,
            paused: false,
            unavailable: true
          }
        };
      }
    }));
  }

  async prepareClaim(address, id) {
    this.assertAvailable();
    const player = getAddress(address).toLowerCase();
    const rewards = await this.store.playerRewards(player);
    const reward = rewards.find((entry) => entry.id === normalizeDraftId(id));
    assertApi(reward, 404, 'player_reward_missing', 'This wallet has no reward in the requested epoch.');
    const chain = await this.chain.assertClaimable(reward, player);
    return {
      reward: publicReward(reward),
      chain,
      transaction: this.chain.claimTransaction(reward)
    };
  }

  async requireDraft(id) {
    const normalized = normalizeDraftId(id);
    const draft = await this.store.getDraft(normalized);
    assertApi(draft, 404, 'reward_draft_missing', 'The reward draft was not found.');
    return draft;
  }

  assertAvailable() {
    assertApi(this.store && this.chain, 503, 'reward_pipeline_unavailable', 'The production reward pipeline is not configured.');
  }

  assertPrimary(candidate) {
    assertSecret(this.adminKey, candidate, 'admin_key_rejected', 'The primary admin key is invalid.');
  }

  assertIndependent(candidate) {
    assertApi(this.approverKey, 503, 'reward_approver_disabled', 'Independent reward approval is not configured.');
    assertApi(
      !secretsEqual(this.adminKey, this.approverKey),
      503,
      'reward_approver_not_independent',
      'The reward approver key must be different from the primary admin key.'
    );
    assertSecret(this.approverKey, candidate, 'reward_approver_rejected', 'The independent reward approver key is invalid.');
  }
}

function adminRewardDraft(draft) {
  const entries = Array.isArray(draft.entries)
    ? draft.entries
    : Array.isArray(draft.allocations)
      ? draft.allocations
      : [];
  const allocatedMatt = Number(
    draft.allocatedMatt ??
    draft.totalMatt ??
    entries.reduce((sum, entry) => sum + Number(entry.amountMatt || 0), 0)
  );
  return {
    ...draft,
    allocatedMatt: Number.isFinite(allocatedMatt) ? allocatedMatt : 0,
    entries: structuredClone(entries),
    totalMatt: Number.isFinite(allocatedMatt) ? allocatedMatt : 0,
    allocations: structuredClone(entries)
  };
}

function publicReward(reward) {
  return {
    id: reward.id,
    week: reward.week,
    mode: reward.mode,
    epoch: reward.epoch,
    board: reward.board,
    status: reward.status,
    claimDeadline: reward.claimDeadline,
    publishedAt: reward.publishedAt,
    rank: reward.rank,
    score: reward.score,
    amountMatt: reward.amountMatt,
    amountRaw: reward.amountRaw
  };
}

function boundedBoardCap(value) {
  const parsed = Number(value || 100_000);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 100_000;
  return Math.min(parsed, HARD_MAX_BOARD_MATT);
}

function normalizeClaimDays(value) {
  const parsed = Number(value || 30);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 90) {
    throw new ApiError(422, 'invalid_claim_days', 'Claim windows must be from 1 to 90 days.');
  }
  return parsed;
}

function normalizeDraftId(value) {
  const id = String(value || '');
  assertApi(
    /^reward_\d{4}-\d{2}-\d{2}_(free|paid)$/.test(id),
    400,
    'invalid_reward_draft_id',
    'The reward draft identifier is invalid.'
  );
  return id;
}

function normalizeOptionalTransactionHash(value) {
  const hash = String(value || '');
  assertApi(
    !hash || /^0x[a-fA-F0-9]{64}$/.test(hash),
    400,
    'invalid_transaction_hash',
    'The publication transaction hash is invalid.'
  );
  return hash.toLowerCase();
}

function assertSecret(configured, candidate, code, message) {
  assertApi(configured, 503, 'admin_api_disabled', 'Server admin access is not configured.');
  assertApi(
    typeof candidate === 'string' && secretsEqual(configured, candidate),
    401,
    code,
    message
  );
}

function secretsEqual(left, right) {
  const leftHash = Buffer.from(createHash('sha256').update(String(left)).digest('hex'));
  const rightHash = Buffer.from(createHash('sha256').update(String(right)).digest('hex'));
  return leftHash.length === rightHash.length && timingSafeEqual(leftHash, rightHash);
}
