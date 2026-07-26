import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { utcWeekKey } from '../src/game/economy.js';
import { defaultServerState, normalizeServerState } from './state.js';

const { Pool } = pg;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export class MemoryDatabase {
  constructor(initialState = defaultServerState()) {
    this.kind = 'memory';
    this.state = normalizeServerState(initialState);
    this.queue = Promise.resolve();
  }

  async init() {
    return this;
  }

  async read() {
    await this.queue;
    return structuredClone(this.state);
  }

  async transact(mutator) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      this.state = normalizeServerState(draft);
      await this.persist();
      return structuredClone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persist() {}

  async healthCheck() {
    return { ok: true, kind: this.kind };
  }

  async close() {}
}

export class JsonFileDatabase extends MemoryDatabase {
  constructor(filePath, options = {}) {
    super(options.initialState);
    this.kind = 'json-file';
    this.filePath = filePath;
    this.now = options.now || Date.now;
    this.initialized = false;
    this.recoveredFile = null;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeServerState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.recoveredFile = `${this.filePath}.corrupt-${this.now()}`;
        await rename(this.filePath, this.recoveredFile).catch(() => undefined);
      }
      this.state = defaultServerState();
      await this.persist();
    }
    this.initialized = true;
    return this;
  }

  async read() {
    await this.init();
    return super.read();
  }

  async transact(mutator) {
    await this.init();
    return super.transact(mutator);
  }

  async persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}

export class PostgresDatabase {
  constructor(connectionString, options = {}) {
    if (!options.pool && (typeof connectionString !== 'string' || !connectionString.trim())) {
      throw new TypeError('A PostgreSQL connection string is required.');
    }
    this.kind = 'postgresql';
    this.pool = options.pool || new Pool({
      connectionString,
      max: positiveInteger(options.maxConnections, 10),
      idleTimeoutMillis: positiveInteger(options.idleTimeoutMillis, 30_000),
      connectionTimeoutMillis: positiveInteger(options.connectionTimeoutMillis, 10_000),
      ...(options.ssl ? { ssl: { rejectUnauthorized: options.rejectUnauthorized === true } } : {})
    });
    this.ownsPool = !options.pool;
    this.now = options.now || Date.now;
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
    await createPostgresSchema(this.pool);
    const client = await this.pool.connect();
    const timestamp = this.now();
    const currentWeek = utcWeekKey(timestamp);
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO matt_mine_state (id, data)
         VALUES (1, $1::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(defaultServerState())]
      );
      const selected = await client.query('SELECT data FROM matt_mine_state WHERE id = 1 FOR UPDATE');
      const rawState = parseJsonValue(selected.rows[0]?.data);
      const state = normalizeServerState(rawState);
      const transaction = new PostgresLeaderboardTransaction(client);
      let stateChanged = rawState?.version !== state.version;

      for (const run of Object.values(state.runs)) {
        if (run.status === 'finished' && run.result) {
          await transaction.recordFinishedRun(run);
        } else {
          await transaction.upsertRun(run);
        }
      }

      await rebuildWeeklyScores(client);
      await finalizeClosedLeaderboards(
        client,
        currentWeek,
        timestamp,
        suspendedAddresses(state)
      );
      if (stateChanged) {
        await client.query(
          `UPDATE matt_mine_state
           SET data = $1::jsonb, updated_at = NOW()
           WHERE id = 1`,
          [JSON.stringify(state)]
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async read() {
    await this.init();
    const result = await this.pool.query('SELECT data FROM matt_mine_state WHERE id = 1');
    return normalizeServerState(parseJsonValue(result.rows[0]?.data));
  }

  async transact(mutator) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT data FROM matt_mine_state WHERE id = 1 FOR UPDATE');
      const draft = normalizeServerState(parseJsonValue(selected.rows[0]?.data));
      const transaction = new PostgresLeaderboardTransaction(client);
      const result = await mutator(draft, transaction);
      const currentWeek = utcWeekKey(this.now());
      await finalizeClosedLeaderboards(
        client,
        currentWeek,
        this.now(),
        suspendedAddresses(draft)
      );
      const normalized = normalizeServerState(draft);
      await client.query(
        `UPDATE matt_mine_state
         SET data = $1::jsonb, updated_at = NOW()
         WHERE id = 1`,
        [JSON.stringify(normalized)]
      );
      await client.query('COMMIT');
      return structuredClone(result);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async healthCheck() {
    const startedAt = Date.now();
    await this.init();
    await this.pool.query('SELECT 1');
    return {
      ok: true,
      kind: this.kind,
      latencyMs: Date.now() - startedAt
    };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async leaderboard(mode, week, viewerAddress, options = {}) {
    await this.init();
    const suspended = normalizeAddressList(options.suspendedAddresses);
    const snapshot = await this.pool.query(
      `SELECT finalized_at, participant_count, total_score, run_count
       FROM matt_mine_weekly_snapshots
       WHERE week_key = $1 AND mode = $2`,
      [week, mode]
    );

    if (snapshot.rows.length) {
      const rows = await this.pool.query(
        `SELECT rank, address, score
         FROM matt_mine_weekly_snapshot_entries
         WHERE week_key = $1 AND mode = $2 AND rank <= 100
         ORDER BY rank`,
        [week, mode]
      );
      const player = await this.pool.query(
        `SELECT rank, score
         FROM matt_mine_weekly_snapshot_entries
         WHERE week_key = $1 AND mode = $2 AND address = $3`,
        [week, mode, viewerAddress]
      );
      return formatLeaderboard({
        mode,
        week,
        rows: rows.rows,
        player: player.rows[0],
        viewerAddress,
        finalizedAt: snapshot.rows[0].finalized_at,
        participantCount: snapshot.rows[0].participant_count,
        totalScore: snapshot.rows[0].total_score,
        runCount: snapshot.rows[0].run_count
      });
    }

    const rows = await this.pool.query(
      `WITH ranked AS (
         SELECT
           ROW_NUMBER() OVER (ORDER BY weekly_score DESC, address ASC)::INTEGER AS rank,
           address,
           weekly_score AS score
         FROM matt_mine_weekly_scores
         WHERE week_key = $1
           AND mode = $2
           AND NOT (address = ANY($3::TEXT[]))
           AND weekly_score > 0
       )
       SELECT rank, address, score
       FROM ranked
       WHERE rank <= 100
       ORDER BY rank`,
      [week, mode, suspended]
    );
    const player = await this.pool.query(
      `WITH ranked AS (
         SELECT
           ROW_NUMBER() OVER (ORDER BY weekly_score DESC, address ASC)::INTEGER AS rank,
           address,
           weekly_score AS score
         FROM matt_mine_weekly_scores
         WHERE week_key = $1
           AND mode = $2
           AND NOT (address = ANY($3::TEXT[]))
           AND weekly_score > 0
       )
       SELECT rank, score
       FROM ranked
       WHERE address = $4`,
      [week, mode, suspended, viewerAddress]
    );
    const metadata = await this.pool.query(
      `SELECT
         COUNT(*)::INTEGER AS participant_count,
         COALESCE(SUM(weekly_score), 0) AS total_score,
         (
           SELECT COUNT(*)
           FROM matt_mine_runs
           WHERE week_key = $1
             AND mode = $2
             AND status = 'finished'
             AND NOT (address = ANY($3::TEXT[]))
         ) AS run_count
       FROM matt_mine_weekly_scores
       WHERE week_key = $1
         AND mode = $2
         AND NOT (address = ANY($3::TEXT[]))
         AND weekly_score > 0`,
      [week, mode, suspended]
    );
    return formatLeaderboard({
      mode,
      week,
      rows: rows.rows,
      player: player.rows[0],
      viewerAddress,
      participantCount: metadata.rows[0]?.participant_count ?? 0,
      totalScore: metadata.rows[0]?.total_score ?? 0,
      runCount: metadata.rows[0]?.run_count ?? 0
    });
  }

  async playerScores(address, week) {
    await this.init();
    const result = await this.pool.query(
      `SELECT mode, weekly_score
       FROM matt_mine_weekly_scores
       WHERE week_key = $1 AND address = $2 AND mode IN ('free', 'paid')`,
      [week, address]
    );
    const scores = { free: 0, paid: 0 };
    for (const row of result.rows) {
      if (row.mode in scores) scores[row.mode] = safeIntegerValue(row.weekly_score);
    }
    return scores;
  }

  async finalizeLeaderboards(currentWeek, suspended = [], timestamp = this.now()) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await finalizeClosedLeaderboards(
        client,
        currentWeek,
        timestamp,
        normalizeAddressList(suspended)
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

class PostgresLeaderboardTransaction {
  constructor(client) {
    this.client = client;
    this.normalizedLeaderboards = true;
  }

  async upsertRun(run) {
    const result = normalizeRunRecord(run);
    if (!result) return false;
    await this.client.query(
      `INSERT INTO matt_mine_runs (
         run_id, token_hash, address, mode, seed, day_key, week_key, status,
         started_at_ms, expires_at_ms, finished_at_ms, extracted, projected,
         banked, score, depth, kills, ore_broken, elapsed_ms, updated_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, NOW()
       )
       ON CONFLICT (run_id) DO UPDATE SET
         token_hash = EXCLUDED.token_hash,
         address = EXCLUDED.address,
         mode = EXCLUDED.mode,
         seed = EXCLUDED.seed,
         day_key = EXCLUDED.day_key,
         week_key = EXCLUDED.week_key,
         status = EXCLUDED.status,
         started_at_ms = EXCLUDED.started_at_ms,
         expires_at_ms = EXCLUDED.expires_at_ms,
         finished_at_ms = EXCLUDED.finished_at_ms,
         extracted = EXCLUDED.extracted,
         projected = EXCLUDED.projected,
         banked = EXCLUDED.banked,
         score = EXCLUDED.score,
         depth = EXCLUDED.depth,
         kills = EXCLUDED.kills,
         ore_broken = EXCLUDED.ore_broken,
         elapsed_ms = EXCLUDED.elapsed_ms,
         updated_at = NOW()`,
      [
        result.id,
        result.tokenHash,
        result.address,
        result.mode,
        result.seed,
        result.day,
        result.week,
        result.status,
        result.startedAt,
        result.expiresAt,
        result.finishedAt,
        result.extracted,
        result.projected,
        result.banked,
        result.score,
        result.depth,
        result.kills,
        result.oreBroken,
        result.elapsedMs
      ]
    );
    return true;
  }

  async recordFinishedRun(run) {
    const stored = await this.upsertRun(run);
    if (!stored || !['free', 'paid'].includes(run.mode) || !run.result) return;
    const score = safeIntegerValue(run.result.score);
    await this.client.query(
      `INSERT INTO matt_mine_daily_scores (
         week_key, day_key, mode, address, best_score, run_id, finished_at_ms, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (week_key, day_key, mode, address) DO UPDATE SET
         best_score = EXCLUDED.best_score,
         run_id = EXCLUDED.run_id,
         finished_at_ms = EXCLUDED.finished_at_ms,
         updated_at = NOW()
       WHERE EXCLUDED.best_score > matt_mine_daily_scores.best_score
          OR (
            EXCLUDED.best_score = matt_mine_daily_scores.best_score
            AND EXCLUDED.finished_at_ms < matt_mine_daily_scores.finished_at_ms
          )`,
      [
        run.week,
        run.day,
        run.mode,
        run.address,
        score,
        run.id,
        safeIntegerValue(run.finishedAt)
      ]
    );
    await updateWeeklyScore(this.client, run.week, run.mode, run.address);
  }

  async storedRunStatus(runId) {
    const result = await this.client.query(
      `SELECT status
       FROM matt_mine_runs
       WHERE run_id = $1`,
      [runId]
    );
    return result.rows[0]?.status || '';
  }
}

async function createPostgresSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_runs (
      run_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      address TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('free', 'paid', 'practice')),
      seed TEXT NOT NULL,
      day_key TEXT NOT NULL,
      week_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'expired')),
      started_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      finished_at_ms BIGINT NOT NULL DEFAULT 0,
      extracted BOOLEAN,
      projected BIGINT,
      banked BIGINT,
      score BIGINT,
      depth INTEGER,
      kills INTEGER,
      ore_broken INTEGER,
      elapsed_ms BIGINT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS matt_mine_runs_wallet_week_idx
    ON matt_mine_runs (address, week_key, mode, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS matt_mine_runs_week_status_idx
    ON matt_mine_runs (week_key, status, expires_at_ms)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_daily_scores (
      week_key TEXT NOT NULL,
      day_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('free', 'paid')),
      address TEXT NOT NULL,
      best_score BIGINT NOT NULL CHECK (best_score >= 0),
      run_id TEXT NOT NULL REFERENCES matt_mine_runs(run_id),
      finished_at_ms BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (week_key, day_key, mode, address)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_weekly_scores (
      week_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('free', 'paid')),
      address TEXT NOT NULL,
      weekly_score BIGINT NOT NULL CHECK (weekly_score >= 0),
      days_count INTEGER NOT NULL CHECK (days_count >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (week_key, mode, address)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS matt_mine_weekly_scores_rank_idx
    ON matt_mine_weekly_scores (week_key, mode, weekly_score DESC, address ASC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_weekly_snapshots (
      week_key TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('free', 'paid')),
      finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      participant_count INTEGER NOT NULL,
      total_score BIGINT NOT NULL,
      run_count BIGINT NOT NULL,
      PRIMARY KEY (week_key, mode)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_weekly_snapshot_entries (
      week_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      rank INTEGER NOT NULL CHECK (rank > 0),
      address TEXT NOT NULL,
      score BIGINT NOT NULL CHECK (score >= 0),
      PRIMARY KEY (week_key, mode, rank),
      UNIQUE (week_key, mode, address),
      FOREIGN KEY (week_key, mode)
        REFERENCES matt_mine_weekly_snapshots(week_key, mode)
        ON DELETE RESTRICT
    )
  `);
}

async function updateWeeklyScore(client, week, mode, address) {
  await client.query(
    `INSERT INTO matt_mine_weekly_scores (
       week_key, mode, address, weekly_score, days_count, updated_at
     )
     SELECT
       $1,
       $2,
       $3,
       COALESCE(SUM(best_score), 0),
       COUNT(*)::INTEGER,
       NOW()
     FROM matt_mine_daily_scores
     WHERE week_key = $1 AND mode = $2 AND address = $3
     ON CONFLICT (week_key, mode, address) DO UPDATE SET
       weekly_score = EXCLUDED.weekly_score,
       days_count = EXCLUDED.days_count,
       updated_at = NOW()`,
    [week, mode, address]
  );
}

async function rebuildWeeklyScores(client) {
  await client.query(
    `INSERT INTO matt_mine_weekly_scores (
       week_key, mode, address, weekly_score, days_count, updated_at
     )
     SELECT
       week_key,
       mode,
       address,
       COALESCE(SUM(best_score), 0),
       COUNT(*)::INTEGER,
       NOW()
     FROM matt_mine_daily_scores
     GROUP BY week_key, mode, address
     ON CONFLICT (week_key, mode, address) DO UPDATE SET
       weekly_score = EXCLUDED.weekly_score,
       days_count = EXCLUDED.days_count,
       updated_at = NOW()`
  );
}

async function finalizeClosedLeaderboards(client, currentWeek, timestamp, suspended) {
  const candidates = await client.query(
    `SELECT DISTINCT week_key, mode
     FROM matt_mine_weekly_scores
     WHERE week_key < $1
       AND NOT EXISTS (
         SELECT 1
         FROM matt_mine_weekly_snapshots
         WHERE matt_mine_weekly_snapshots.week_key = matt_mine_weekly_scores.week_key
           AND matt_mine_weekly_snapshots.mode = matt_mine_weekly_scores.mode
       )
     ORDER BY week_key, mode`,
    [currentWeek]
  );
  for (const candidate of candidates.rows) {
    const weekStartedAt = Date.parse(`${candidate.week_key}T00:00:00.000Z`);
    if (!Number.isFinite(weekStartedAt) || timestamp < weekStartedAt + WEEK_MS) {
      continue;
    }
    const inserted = await client.query(
      `INSERT INTO matt_mine_weekly_snapshots (
         week_key, mode, finalized_at, participant_count, total_score, run_count
       )
       SELECT
         $1,
         $2,
         NOW(),
         COUNT(*)::INTEGER,
         COALESCE(SUM(weekly_score), 0),
         (
           SELECT COUNT(*)
           FROM matt_mine_runs
           WHERE week_key = $1
             AND mode = $2
             AND status = 'finished'
             AND NOT (address = ANY($3::TEXT[]))
         )
       FROM matt_mine_weekly_scores
       WHERE week_key = $1
         AND mode = $2
         AND NOT (address = ANY($3::TEXT[]))
         AND weekly_score > 0
       ON CONFLICT (week_key, mode) DO NOTHING
       RETURNING week_key`,
      [candidate.week_key, candidate.mode, suspended]
    );
    if (!inserted.rows.length) continue;
    await client.query(
      `INSERT INTO matt_mine_weekly_snapshot_entries (
         week_key, mode, rank, address, score
       )
       SELECT
         week_key,
         mode,
         ROW_NUMBER() OVER (ORDER BY weekly_score DESC, address ASC)::INTEGER,
         address,
         weekly_score
       FROM matt_mine_weekly_scores
       WHERE week_key = $1
         AND mode = $2
         AND NOT (address = ANY($3::TEXT[]))
         AND weekly_score > 0
       ORDER BY weekly_score DESC, address ASC`,
      [candidate.week_key, candidate.mode, suspended]
    );
  }
}

function normalizeRunRecord(run = {}) {
  const result = run.result && typeof run.result === 'object' ? run.result : {};
  const id = String(run.id || '');
  const tokenHash = String(run.tokenHash || '');
  const address = String(run.address || '').toLowerCase();
  const mode = String(run.mode || '');
  const seed = String(run.seed || '');
  const day = String(run.day || '');
  const week = String(run.week || '');
  const status = String(run.status || '');
  if (
    !/^run_[a-f0-9]{24}$/.test(id) ||
    !/^[a-f0-9]{64}$/.test(tokenHash) ||
    !/^0x[a-f0-9]{40}$/.test(address) ||
    !['free', 'paid', 'practice'].includes(mode) ||
    !seed ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(week) ||
    !['active', 'finished', 'expired'].includes(status)
  ) {
    return null;
  }
  return {
    id,
    tokenHash,
    address,
    mode,
    seed: seed.slice(0, 200),
    day,
    week,
    status,
    startedAt: safeIntegerValue(run.startedAt),
    expiresAt: safeIntegerValue(run.expiresAt),
    finishedAt: safeIntegerValue(run.finishedAt),
    extracted: typeof result.extracted === 'boolean' ? result.extracted : null,
    projected: nullableInteger(result.projected),
    banked: nullableInteger(result.banked),
    score: nullableInteger(result.score),
    depth: nullableInteger(result.depth),
    kills: nullableInteger(result.kills),
    oreBroken: nullableInteger(result.oreBroken),
    elapsedMs: typeof result.elapsed === 'number' && Number.isFinite(result.elapsed)
      ? Math.max(0, Math.round(result.elapsed * 1000))
      : null
  };
}

function formatLeaderboard({
  mode,
  week,
  rows,
  player,
  viewerAddress,
  finalizedAt = null,
  participantCount = null,
  totalScore = null,
  runCount = null
}) {
  const formattedRows = rows.map((row) => ({
    rank: safeIntegerValue(row.rank),
    address: String(row.address || '').toLowerCase(),
    walletId: abbreviateAddress(row.address),
    score: safeIntegerValue(row.score),
    isPlayer: String(row.address || '').toLowerCase() === viewerAddress,
    verified: true
  }));
  return {
    mode,
    week,
    rows: formattedRows,
    playerRank: safeIntegerValue(player?.rank),
    playerScore: safeIntegerValue(player?.score),
    finalized: Boolean(finalizedAt),
    finalizedAt: finalizedAt ? new Date(finalizedAt).toISOString() : null,
    participantCount: participantCount === null
      ? formattedRows.length
      : safeIntegerValue(participantCount),
    totalScore: totalScore === null ? null : safeIntegerValue(totalScore),
    runCount: runCount === null ? null : safeIntegerValue(runCount)
  };
}

function suspendedAddresses(state) {
  return Object.values(state.wallets || {})
    .filter((wallet) => wallet?.suspended === true)
    .map((wallet) => String(wallet.address || '').toLowerCase())
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address));
}

function normalizeAddressList(addresses) {
  return [...new Set((Array.isArray(addresses) ? addresses : [])
    .map((address) => String(address || '').toLowerCase())
    .filter((address) => /^0x[a-f0-9]{40}$/.test(address)))];
}

function abbreviateAddress(address) {
  const value = String(address || '');
  return value.length >= 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

function nullableInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeIntegerValue(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseJsonValue(value) {
  if (typeof value !== 'string') return value || defaultServerState();
  try {
    return JSON.parse(value);
  } catch {
    return defaultServerState();
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
