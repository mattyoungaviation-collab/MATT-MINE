import { ApiError, assertApi } from './errors.js';

export class MemoryRewardStore {
  constructor(options = {}) {
    this.snapshots = new Map();
    this.drafts = new Map();
    for (const snapshot of options.snapshots || []) {
      this.snapshots.set(snapshotKey(snapshot.mode, snapshot.week), structuredClone(snapshot));
    }
  }

  async init() {
    return this;
  }

  async finalizedSnapshot(mode, week) {
    return structuredClone(this.snapshots.get(snapshotKey(mode, week)) || null);
  }

  async createDraft(plan, timestamp) {
    assertApi(!this.drafts.has(plan.id), 409, 'reward_draft_exists', 'A reward draft already exists for this board and week.');
    const stored = {
      ...structuredClone(plan),
      status: 'draft',
      createdAt: timestamp,
      approvedAt: 0,
      publishedAt: 0,
      publicationTransactionHash: '',
      approvals: ['primary']
    };
    this.drafts.set(stored.id, stored);
    return structuredClone(stored);
  }

  async approveDraft(id, timestamp) {
    const draft = this.drafts.get(id);
    assertApi(draft, 404, 'reward_draft_missing', 'The reward draft was not found.');
    if (draft.status === 'approved') return structuredClone(draft);
    assertApi(draft.status === 'draft', 409, 'reward_draft_not_pending', 'This reward draft is no longer awaiting approval.');
    draft.status = 'approved';
    draft.approvedAt = timestamp;
    draft.approvals.push('independent');
    return structuredClone(draft);
  }

  async markPublished(id, transactionHash, timestamp) {
    const draft = this.drafts.get(id);
    assertApi(draft, 404, 'reward_draft_missing', 'The reward draft was not found.');
    draft.status = 'published';
    draft.publishedAt = timestamp;
    draft.publicationTransactionHash = transactionHash || draft.publicationTransactionHash;
    return structuredClone(draft);
  }

  async getDraft(id) {
    return structuredClone(this.drafts.get(id) || null);
  }

  async listDrafts() {
    return [...this.drafts.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((draft) => structuredClone(draft));
  }

  async playerRewards(address) {
    const normalized = String(address || '').toLowerCase();
    return [...this.drafts.values()]
      .filter((draft) => draft.entries.some((entry) => entry.address === normalized))
      .map((draft) => {
        const entry = draft.entries.find((candidate) => candidate.address === normalized);
        return publicPlayerReward(draft, entry);
      })
      .sort((left, right) => right.week.localeCompare(left.week));
  }
}

export class PostgresRewardStore {
  constructor(database) {
    if (!database?.pool) throw new TypeError('PostgreSQL reward storage requires a database pool.');
    this.database = database;
    this.pool = database.pool;
    this.initialized = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initialized) return this;
    if (!this.initPromise) {
      this.initPromise = this.#initialize().catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
    this.initialized = true;
    return this;
  }

  async #initialize() {
    await this.database.init();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matt_mine_reward_drafts (
        draft_id TEXT PRIMARY KEY,
        week_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('free', 'paid')),
        epoch NUMERIC(78, 0) NOT NULL,
        board SMALLINT NOT NULL CHECK (board IN (0, 1)),
        requested_matt BIGINT NOT NULL CHECK (requested_matt > 0),
        requested_raw NUMERIC(78, 0) NOT NULL CHECK (requested_raw > 0),
        allocated_matt BIGINT NOT NULL CHECK (allocated_matt > 0),
        allocated_raw NUMERIC(78, 0) NOT NULL CHECK (allocated_raw > 0),
        unallocated_matt BIGINT NOT NULL CHECK (unallocated_matt >= 0),
        merkle_root TEXT NOT NULL,
        claim_deadline BIGINT NOT NULL,
        participant_count INTEGER NOT NULL,
        snapshot_finalized_at TIMESTAMPTZ NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'published')),
        created_at_ms BIGINT NOT NULL,
        approved_at_ms BIGINT NOT NULL DEFAULT 0,
        published_at_ms BIGINT NOT NULL DEFAULT 0,
        publication_transaction_hash TEXT NOT NULL DEFAULT '',
        UNIQUE (week_key, mode)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matt_mine_reward_entries (
        draft_id TEXT NOT NULL REFERENCES matt_mine_reward_drafts(draft_id) ON DELETE RESTRICT,
        address TEXT NOT NULL,
        rank INTEGER NOT NULL CHECK (rank > 0),
        score BIGINT NOT NULL CHECK (score >= 0),
        amount_matt BIGINT NOT NULL CHECK (amount_matt > 0),
        amount_raw NUMERIC(78, 0) NOT NULL CHECK (amount_raw > 0),
        proof JSONB NOT NULL,
        PRIMARY KEY (draft_id, address),
        UNIQUE (draft_id, rank)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS matt_mine_reward_entries_wallet_idx
      ON matt_mine_reward_entries (address, draft_id)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matt_mine_reward_approvals (
        draft_id TEXT NOT NULL REFERENCES matt_mine_reward_drafts(draft_id) ON DELETE RESTRICT,
        approval_slot TEXT NOT NULL CHECK (approval_slot IN ('primary', 'independent')),
        approved_at_ms BIGINT NOT NULL,
        PRIMARY KEY (draft_id, approval_slot)
      )
    `);
  }

  async finalizedSnapshot(mode, week) {
    await this.init();
    const snapshot = await this.pool.query(
      `SELECT finalized_at, participant_count, total_score, run_count
       FROM matt_mine_weekly_snapshots
       WHERE week_key = $1 AND mode = $2`,
      [week, mode]
    );
    if (!snapshot.rows.length) return null;
    const entries = await this.pool.query(
      `SELECT rank, address, score
       FROM matt_mine_weekly_snapshot_entries
       WHERE week_key = $1 AND mode = $2
       ORDER BY rank`,
      [week, mode]
    );
    return {
      week,
      mode,
      finalized: true,
      finalizedAt: new Date(snapshot.rows[0].finalized_at).toISOString(),
      participantCount: numberValue(snapshot.rows[0].participant_count),
      totalScore: numberValue(snapshot.rows[0].total_score),
      runCount: numberValue(snapshot.rows[0].run_count),
      rows: entries.rows.map((row) => ({
        rank: numberValue(row.rank),
        address: String(row.address || '').toLowerCase(),
        score: numberValue(row.score)
      }))
    };
  }

  async createDraft(plan, timestamp) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO matt_mine_reward_drafts (
           draft_id, week_key, mode, epoch, board, requested_matt, requested_raw,
           allocated_matt, allocated_raw, unallocated_matt, merkle_root,
           claim_deadline, participant_count, snapshot_finalized_at, status, created_at_ms
         )
         VALUES (
           $1, $2, $3, $4::numeric, $5, $6, $7::numeric,
           $8, $9::numeric, $10, $11, $12, $13, $14, 'draft', $15
         )`,
        [
          plan.id,
          plan.week,
          plan.mode,
          plan.epoch,
          plan.board,
          plan.requestedMatt,
          plan.requestedRaw,
          plan.allocatedMatt,
          plan.allocatedRaw,
          plan.unallocatedMatt,
          plan.merkleRoot,
          plan.claimDeadline,
          plan.participantCount,
          plan.snapshotFinalizedAt,
          timestamp
        ]
      );
      for (const entry of plan.entries) {
        await client.query(
          `INSERT INTO matt_mine_reward_entries (
             draft_id, address, rank, score, amount_matt, amount_raw, proof
           )
           VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::jsonb)`,
          [
            plan.id,
            entry.address,
            entry.rank,
            entry.score,
            entry.amountMatt,
            entry.amountRaw,
            JSON.stringify(entry.proof)
          ]
        );
      }
      await client.query(
        `INSERT INTO matt_mine_reward_approvals (draft_id, approval_slot, approved_at_ms)
         VALUES ($1, 'primary', $2)`,
        [plan.id, timestamp]
      );
      await client.query('COMMIT');
      return {
        ...structuredClone(plan),
        status: 'draft',
        createdAt: timestamp,
        approvedAt: 0,
        publishedAt: 0,
        publicationTransactionHash: '',
        approvals: ['primary']
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error?.code === '23505') {
        throw new ApiError(409, 'reward_draft_exists', 'A reward draft already exists for this board and week.');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async approveDraft(id, timestamp) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT status FROM matt_mine_reward_drafts WHERE draft_id = $1 FOR UPDATE`,
        [id]
      );
      assertApi(selected.rows.length, 404, 'reward_draft_missing', 'The reward draft was not found.');
      if (selected.rows[0].status === 'approved') {
        await client.query('COMMIT');
        return { id, status: 'approved' };
      }
      assertApi(selected.rows[0].status === 'draft', 409, 'reward_draft_not_pending', 'This reward draft is no longer awaiting approval.');
      await client.query(
        `INSERT INTO matt_mine_reward_approvals (draft_id, approval_slot, approved_at_ms)
         VALUES ($1, 'independent', $2)`,
        [id, timestamp]
      );
      await client.query(
        `UPDATE matt_mine_reward_drafts
         SET status = 'approved', approved_at_ms = $2
         WHERE draft_id = $1`,
        [id, timestamp]
      );
      await client.query('COMMIT');
      return { id, status: 'approved', approvedAt: timestamp };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markPublished(id, transactionHash, timestamp) {
    await this.init();
    const result = await this.pool.query(
      `UPDATE matt_mine_reward_drafts
       SET status = 'published',
           published_at_ms = $2,
           publication_transaction_hash = CASE WHEN $3 = '' THEN publication_transaction_hash ELSE $3 END
       WHERE draft_id = $1
       RETURNING draft_id`,
      [id, timestamp, transactionHash || '']
    );
    assertApi(result.rows.length, 404, 'reward_draft_missing', 'The reward draft was not found.');
    return this.getDraft(id);
  }

  async getDraft(id) {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM matt_mine_reward_drafts WHERE draft_id = $1`,
      [id]
    );
    if (!result.rows.length) return null;
    const entries = await this.pool.query(
      `SELECT address, rank, score, amount_matt, amount_raw, proof
       FROM matt_mine_reward_entries
       WHERE draft_id = $1
       ORDER BY rank`,
      [id]
    );
    const approvals = await this.pool.query(
      `SELECT approval_slot
       FROM matt_mine_reward_approvals
       WHERE draft_id = $1
       ORDER BY approval_slot`,
      [id]
    );
    return formatDraft(result.rows[0], entries.rows, approvals.rows);
  }

  async listDrafts() {
    await this.init();
    const result = await this.pool.query(
      `SELECT draft_id
       FROM matt_mine_reward_drafts
       ORDER BY created_at_ms DESC
       LIMIT 100`
    );
    return Promise.all(result.rows.map((row) => this.getDraft(row.draft_id)));
  }

  async playerRewards(address) {
    await this.init();
    const result = await this.pool.query(
      `SELECT d.*, e.address, e.rank, e.score, e.amount_matt, e.amount_raw, e.proof
       FROM matt_mine_reward_entries e
       JOIN matt_mine_reward_drafts d ON d.draft_id = e.draft_id
       WHERE e.address = $1
       ORDER BY d.week_key DESC, d.mode`,
      [String(address || '').toLowerCase()]
    );
    return result.rows.map((row) => publicPlayerReward(
      formatDraft(row, [{
        address: row.address,
        rank: row.rank,
        score: row.score,
        amount_matt: row.amount_matt,
        amount_raw: row.amount_raw,
        proof: row.proof
      }], []),
      {
        address: String(row.address).toLowerCase(),
        rank: numberValue(row.rank),
        score: numberValue(row.score),
        amountMatt: numberValue(row.amount_matt),
        amountRaw: String(row.amount_raw),
        proof: jsonValue(row.proof, [])
      }
    ));
  }
}

function formatDraft(row, entries, approvals) {
  return {
    id: row.draft_id,
    week: row.week_key,
    mode: row.mode,
    epoch: String(row.epoch),
    board: numberValue(row.board),
    requestedMatt: numberValue(row.requested_matt),
    requestedRaw: String(row.requested_raw),
    allocatedMatt: numberValue(row.allocated_matt),
    allocatedRaw: String(row.allocated_raw),
    unallocatedMatt: numberValue(row.unallocated_matt),
    merkleRoot: row.merkle_root,
    claimDeadline: numberValue(row.claim_deadline),
    participantCount: numberValue(row.participant_count),
    snapshotFinalizedAt: new Date(row.snapshot_finalized_at).toISOString(),
    status: row.status,
    createdAt: numberValue(row.created_at_ms),
    approvedAt: numberValue(row.approved_at_ms),
    publishedAt: numberValue(row.published_at_ms),
    publicationTransactionHash: row.publication_transaction_hash || '',
    approvals: approvals.map((approval) => approval.approval_slot),
    entries: entries.map((entry) => ({
      address: String(entry.address || '').toLowerCase(),
      rank: numberValue(entry.rank),
      score: numberValue(entry.score),
      amountMatt: numberValue(entry.amount_matt),
      amountRaw: String(entry.amount_raw),
      proof: jsonValue(entry.proof, [])
    }))
  };
}

function publicPlayerReward(draft, entry) {
  return {
    id: draft.id,
    week: draft.week,
    mode: draft.mode,
    epoch: draft.epoch,
    board: draft.board,
    status: draft.status,
    merkleRoot: draft.merkleRoot,
    claimDeadline: draft.claimDeadline,
    publishedAt: draft.publishedAt,
    address: entry.address,
    rank: entry.rank,
    score: entry.score,
    amountMatt: entry.amountMatt,
    amountRaw: entry.amountRaw,
    proof: structuredClone(entry.proof)
  };
}

function snapshotKey(mode, week) {
  return `${week}:${mode}`;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function jsonValue(value, fallback) {
  if (Array.isArray(value)) return structuredClone(value);
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}
