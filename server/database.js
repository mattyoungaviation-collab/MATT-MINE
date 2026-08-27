import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { utcWeekKey } from '../src/game/economy.js';
import { defaultServerState, normalizeServerState } from './state.js';
import {
  guardPostgresPool,
  retryTransientPostgres
} from './postgres-resilience.js';
import {
  backfillNormalizedState,
  runNormalizedMigrations,
  validateNormalizedState
} from './normalized-persistence.js';
import {
  backfillEndlessState,
  backfillEndlessStateOnce,
  persistEndlessCheckpoint,
  persistEndlessConfig,
  persistEndlessLeaderboardEntry,
  persistEndlessPayment,
  persistEndlessRun,
  validateEndlessState
} from './endless-persistence.js';

const { Pool } = pg;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const NFT_LIFECYCLE_LOCK_KEYS = Object.freeze([0x4d415454, 0x4d494e45]);

export class MemoryDatabase {
  constructor(initialState = defaultServerState()) {
    this.kind = 'memory';
    this.state = normalizeServerState(initialState);
    this.queue = Promise.resolve();
    this.nftLifecycleGate = new AsyncReadWriteGate();
  }

  async init() {
    return this;
  }

  async read() {
    await this.queue;
    return structuredClone(this.state);
  }

  async readPublicMineState() {
    return this.read();
  }

  async readArenaPlayerState() {
    return this.read();
  }

  async readEndlessRunReview() {
    return null;
  }

  async readEndlessPlayerRuns() {
    return null;
  }

  async readEndlessPlayerSummary() {
    return null;
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

  async withNftLifecycleStart(operation) {
    return this.nftLifecycleGate.withShared(operation);
  }

  async withNftLifecycleMutation(operation) {
    return this.nftLifecycleGate.withExclusive(operation);
  }

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
    const poolOptions = {
      connectionString,
      max: positiveInteger(options.maxConnections, 10),
      idleTimeoutMillis: positiveInteger(options.idleTimeoutMillis, 30_000),
      connectionTimeoutMillis: positiveInteger(options.connectionTimeoutMillis, 10_000),
      keepAlive: true,
      keepAliveInitialDelayMillis: positiveInteger(options.keepAliveInitialDelayMillis, 10_000),
      ...(options.ssl ? { ssl: { rejectUnauthorized: options.rejectUnauthorized === true } } : {})
    };
    this.pool = options.pool || new Pool(poolOptions);
    this.ownsPool = !options.pool;
    // Advisory locks are session-scoped. Holding one on the normal request
    // pool while the protected operation performs its own reads/transactions
    // can exhaust a small pool and deadlock every NFT start. Production gets a
    // dedicated one-connection lock pool; injected test pools may provide one
    // explicitly and otherwise use the process-local gate below.
    this.nftLifecycleLockPool = options.nftLifecycleLockPool || (
      this.ownsPool
        ? new Pool({ ...poolOptions, max: 1, application_name: 'matt-mine-nft-lifecycle-lock' })
        : null
    );
    this.ownsNftLifecycleLockPool = this.ownsPool && !options.nftLifecycleLockPool;
    this.nftLifecycleGate = new AsyncReadWriteGate();
    this.normalizedMigrationsEnabled = options.normalizedMigrationsEnabled ?? this.ownsPool;
    this.now = options.now || Date.now;
    this.initialized = false;
    this.initPromise = null;
    this.startupRetryAttempts = positiveInteger(options.startupRetryAttempts, 90);
    this.queryRetryAttempts = positiveInteger(options.queryRetryAttempts, 5);
    this.retryBaseDelayMs = nonNegativeInteger(options.retryBaseDelayMs, 100);
    this.retryMaxDelayMs = positiveInteger(options.retryMaxDelayMs, 2_000);
    this.retrySleep = options.retrySleep;
    const reportPoolError = typeof options.onPoolError === 'function'
      ? options.onPoolError
      : (error) => {
          console.error(
            '[MATT Mine] PostgreSQL connection failed; the pool will replace it.',
            error?.message || error
          );
        };
    this.poolGuard = guardPostgresPool(this.pool, { onError: reportPoolError });
    this.nftLifecycleLockPoolGuard = this.ownsNftLifecycleLockPool
      ? guardPostgresPool(this.nftLifecycleLockPool, { onError: reportPoolError })
      : null;
  }

  async init() {
    if (this.initialized) return this;
    if (!this.initPromise) {
      this.initPromise = this.retryTransient(
        () => this.#initialize(),
        {
          maxAttempts: this.startupRetryAttempts,
          label: 'database startup'
        }
      ).catch((error) => {
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
    if (this.normalizedMigrationsEnabled) await runNormalizedMigrations(this.pool);
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
      const transaction = new PostgresLeaderboardTransaction(client, {
        endlessPersistenceEnabled: this.normalizedMigrationsEnabled
      });
      let stateChanged = rawState?.version !== state.version;

      for (const run of Object.values(state.runs)) {
        if (run.status === 'finished' && run.result) {
          await transaction.recordFinishedRun(run);
        } else {
          await transaction.upsertRun(run);
        }
      }

      await rebuildWeeklyScores(client);
      await transaction.syncLeaderboardOverrides(state.leaderboardOverrides);
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
      if (this.normalizedMigrationsEnabled) {
        await backfillEndlessStateOnce(client, state.endlessCompetition);
      }
      // Staged migration: the legacy row remains authoritative. The durable
      // cutover switch controls whether normalized projections are also
      // written in this transaction.
      if (
        this.normalizedMigrationsEnabled &&
        await normalizedDualWriteEnabled(client)
      ) {
        await backfillNormalizedState(client, state, { timestamp });
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
    const result = await this.query(
      'SELECT data FROM matt_mine_state WHERE id = 1'
    );
    return normalizeServerState(parseJsonValue(result.rows[0]?.data));
  }

  async readPublicMineState() {
    await this.init();
    const result = await this.query(
      `SELECT data->'competitionStudio' AS competition_studio,
              data->'operations' AS operations,
              data->'endlessCompetition' AS endless_competition,
              data->'wallets' AS wallets
       FROM matt_mine_state WHERE id = 1`
    );
    const row = result.rows[0] || {};
    return normalizeServerState({
      competitionStudio: parseJsonValue(row.competition_studio),
      operations: parseJsonValue(row.operations),
      endlessCompetition: parseJsonValue(row.endless_competition),
      wallets: parseJsonValue(row.wallets)
    });
  }

  async readArenaPlayerState(tokenHash) {
    await this.init();
    const result = await this.query(
      `SELECT data->'sessions'->$1 AS session,
              data->'wallets'->(data->'sessions'->$1->>'address') AS wallet,
              data->'operations' AS operations
       FROM matt_mine_state WHERE id = 1`,
      [tokenHash]
    );
    const row = result.rows[0] || {};
    const session = parseJsonValue(row.session);
    const wallet = parseJsonValue(row.wallet);
    return normalizeServerState({
      sessions: session ? { [tokenHash]: session } : {},
      wallets: session?.address && wallet ? { [session.address]: wallet } : {},
      operations: parseJsonValue(row.operations)
    });
  }

  async readEndlessRunReview(runId) {
    await this.init();
    if (!this.normalizedMigrationsEnabled) return null;
    const [run, phases, integrity, payment, settlements] = await Promise.all([
      this.query('SELECT run_payload FROM matt_mine_endless.runs WHERE run_id=$1', [runId]),
      this.query(
        `SELECT checkpoint_payload FROM matt_mine_endless.phase_checkpoints
         WHERE run_id=$1 ORDER BY phase`,
        [runId]
      ),
      this.query(
        `SELECT event_payload FROM matt_mine_endless.integrity_events
         WHERE run_id=$1 ORDER BY created_at_ms`,
        [runId]
      ),
      this.query('SELECT payment_payload FROM matt_mine_endless.entry_payments WHERE run_id=$1', [runId]),
      this.query(
        `SELECT transaction_hash,phase,transaction_type,recorded_at_ms
         FROM matt_mine_endless.settlement_transactions WHERE run_id=$1 ORDER BY recorded_at_ms`,
        [runId]
      )
    ]);
    if (!run.rows[0]) return null;
    return {
      run: parseJsonValue(run.rows[0].run_payload),
      phases: phases.rows.map((row) => parseJsonValue(row.checkpoint_payload)),
      integrityEvents: integrity.rows.map((row) => parseJsonValue(row.event_payload)),
      payment: parseJsonValue(payment.rows[0]?.payment_payload),
      settlementTransactions: settlements.rows.map((row) => ({
        transactionHash: row.transaction_hash,
        phase: safeIntegerValue(row.phase),
        type: row.transaction_type,
        recordedAt: safeIntegerValue(row.recorded_at_ms)
      }))
    };
  }

  async readEndlessPlayerRuns(address, limit = 100) {
    await this.init();
    if (!this.normalizedMigrationsEnabled) return null;
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const result = await this.query(
      `SELECT run_payload FROM matt_mine_endless.runs
       WHERE address=$1 AND status <> 'active'
       ORDER BY COALESCE(finished_at_ms,updated_at_ms) DESC
       LIMIT $2`,
      [String(address || '').toLowerCase(), boundedLimit]
    );
    return result.rows.map((row) => parseJsonValue(row.run_payload)).filter(Boolean);
  }

  async readEndlessPlayerSummary(address) {
    await this.init();
    if (!this.normalizedMigrationsEnabled) return null;
    const result = await this.query(
      `SELECT COUNT(*) AS total_runs,
              COUNT(*) FILTER (WHERE status IN ('banked','knocked_out')) AS verified_runs,
              COUNT(*) FILTER (WHERE status='banked') AS banked_runs,
              COUNT(*) FILTER (WHERE status='knocked_out') AS knockouts,
              COUNT(*) FILTER (WHERE status='abandoned') AS abandoned_runs,
              MAX(score) AS highest_score,MAX(completed_phases) AS deepest_phase,
              MAX(COALESCE((run_payload #>> '{manifest,capability,rating}')::numeric,0)) AS highest_capability,
              SUM(COALESCE((run_payload->>'crystalsMined')::numeric,0)) AS crystals_mined,
              SUM(crystals_banked) AS crystals_banked,
              SUM(COALESCE((run_payload->>'requiredKills')::numeric,0) + COALESCE((run_payload->>'bossKills')::numeric,0)) AS enemies_defeated,
              SUM(COALESCE((run_payload->>'bossKills')::numeric,0)) AS guardians_defeated,
              SUM(COALESCE((run_payload->>'oreBroken')::numeric,0)) AS ore_broken,
              SUM(COALESCE((run_payload->>'minerXpEarned')::numeric,0)) AS miner_xp_earned,
              SUM(miner_xp_banked) AS miner_xp_banked,
              SUM(GREATEST(0,COALESCE(finished_at_ms,updated_at_ms)-started_at_ms)) AS total_duration_ms,
              MAX(GREATEST(0,COALESCE(finished_at_ms,updated_at_ms)-started_at_ms)) AS longest_run_ms,
              SUM(score) AS total_score,SUM(completed_phases) AS total_phases
       FROM matt_mine_endless.runs WHERE address=$1 AND status <> 'active'`,
      [String(address || '').toLowerCase()]
    );
    const row = result.rows[0] || {};
    const totalRuns = Number(row.total_runs || 0);
    const number = (key) => Number(row[key] || 0);
    return {
      totalRuns,
      verifiedRuns: number('verified_runs'),
      bankedRuns: number('banked_runs'),
      knockouts: number('knockouts'),
      abandonedRuns: number('abandoned_runs'),
      highestScore: number('highest_score'),
      deepestPhase: number('deepest_phase'),
      highestCapability: number('highest_capability'),
      crystalsMined: number('crystals_mined'),
      crystalsBanked: number('crystals_banked'),
      enemiesDefeated: number('enemies_defeated'),
      guardiansDefeated: number('guardians_defeated'),
      oreBroken: number('ore_broken'),
      minerXpEarned: number('miner_xp_earned'),
      minerXpBanked: number('miner_xp_banked'),
      totalDurationMs: number('total_duration_ms'),
      longestRunMs: number('longest_run_ms'),
      averageScore: totalRuns ? Math.round(number('total_score') / totalRuns) : 0,
      averagePhase: totalRuns ? Math.round(number('total_phases') / totalRuns * 100) / 100 : 0,
      averageCrystalsBanked: totalRuns ? Math.round(number('crystals_banked') / totalRuns * 100) / 100 : 0
    };
  }

  async query(sql, params = []) {
    await this.init();
    return this.retryTransient(
      () => this.pool.query(sql, params),
      { maxAttempts: this.queryRetryAttempts, label: 'database query' }
    );
  }

  async retryTransient(operation, options = {}) {
    return retryTransientPostgres(operation, {
      maxAttempts: options.maxAttempts,
      baseDelayMs: this.retryBaseDelayMs,
      maxDelayMs: this.retryMaxDelayMs,
      ...(this.retrySleep ? { sleep: this.retrySleep } : {}),
      onRetry: (error, retry) => {
        console.warn(
          `[MATT Mine] PostgreSQL ${options.label || 'operation'} unavailable; retrying ` +
          `${retry.nextAttempt}/${retry.maxAttempts} in ${retry.delayMs}ms.`,
          error?.code || error?.message || error
        );
      }
    });
  }

  async withNftLifecycleStart(operation) {
    return this.#withNftLifecycleLock('shared', operation);
  }

  async withNftLifecycleMutation(operation) {
    return this.#withNftLifecycleLock('exclusive', operation);
  }

  async #withNftLifecycleLock(mode, operation) {
    await this.init();
    if (!this.nftLifecycleLockPool) {
      return mode === 'shared'
        ? this.nftLifecycleGate.withShared(operation)
        : this.nftLifecycleGate.withExclusive(operation);
    }

    // A single process never needs more than one dedicated advisory-lock
    // connection. Cross-instance shared/exclusive behavior is still enforced
    // by PostgreSQL, while the request pool remains completely available to
    // the protected operation.
    return this.nftLifecycleGate.withExclusive(async () => {
      const client = await this.nftLifecycleLockPool.connect();
      let locked = false;
      let releaseError = null;
      const shared = mode === 'shared';
      try {
        try {
          await client.query(
            `SELECT pg_advisory_lock${shared ? '_shared' : ''}($1,$2)`,
            NFT_LIFECYCLE_LOCK_KEYS
          );
        } catch (error) {
          releaseError = error;
          throw error;
        }
        locked = true;
        return await operation();
      } finally {
        try {
          if (locked) {
            try {
              await client.query(
                `SELECT pg_advisory_unlock${shared ? '_shared' : ''}($1,$2)`,
                NFT_LIFECYCLE_LOCK_KEYS
              );
            } catch (error) {
              releaseError = error;
              throw error;
            }
          }
        } finally {
          // A failed unlock leaves a session-scoped lock in an unknown state.
          // Passing the error makes node-postgres destroy that connection
          // instead of returning a poisoned session to the dedicated pool.
          client.release(releaseError || undefined);
        }
      }
    });
  }

  async transact(mutator) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT data FROM matt_mine_state WHERE id = 1 FOR UPDATE');
      const draft = normalizeServerState(parseJsonValue(selected.rows[0]?.data));
      const transaction = new PostgresLeaderboardTransaction(client, {
        endlessPersistenceEnabled: this.normalizedMigrationsEnabled
      });
      const result = await mutator(draft, transaction);
      await transaction.syncLeaderboardOverrides(draft.leaderboardOverrides);
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
      if (
        this.normalizedMigrationsEnabled &&
        await normalizedDualWriteEnabled(client)
      ) {
        await backfillNormalizedState(client, normalized, { timestamp: this.now() });
      }
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
    // This is a liveness probe. Do not stack normal request retries here or a
    // short database failover can make the web service itself look dead.
    await this.pool.query('SELECT 1');
    return {
      ok: true,
      kind: this.kind,
      latencyMs: Date.now() - startedAt
    };
  }

  async close() {
    if (this.ownsNftLifecycleLockPool) await this.nftLifecycleLockPool.end();
    if (this.ownsPool) await this.pool.end();
    this.nftLifecycleLockPoolGuard?.close();
    this.poolGuard.close();
  }

  async backfillNormalized() {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT data FROM matt_mine_state WHERE id=1 FOR SHARE');
      const state = normalizeServerState(parseJsonValue(selected.rows[0]?.data));
      await backfillNormalizedState(client, state, { timestamp: this.now() });
      await backfillEndlessState(client, state.endlessCompetition);
      const normalizedValidation = await validateNormalizedState(client, state);
      const endlessValidation = await validateEndlessState(client, state.endlessCompetition);
      await client.query('COMMIT');
      return {
        ...normalizedValidation,
        ok: normalizedValidation.ok && endlessValidation.ok,
        endless: endlessValidation
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async validateNormalized() {
    await this.init();
    const state = await this.read();
    const [normalized, endless] = await Promise.all([
      validateNormalizedState(this.pool, state),
      validateEndlessState(this.pool, state.endlessCompetition)
    ]);
    return { ...normalized, ok: normalized.ok && endless.ok, endless };
  }

  async beginPaymentOperation(operation) {
    await this.init();
    try {
      await this.query(
        `INSERT INTO matt_mine_normalized.payment_operations
          (idempotency_key, request_hash, address, purpose, quote_id, transaction_hash,
           state, created_at_ms, updated_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$7)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [operation.idempotencyKey, operation.requestHash, operation.address,
          operation.purpose, operation.quoteId || null, operation.transactionHash || null,
          operation.timestamp]
      );
    } catch (error) {
      // A transaction hash or purpose/quote uniqueness conflict is reconciled
      // by reading the durable owner below; it must never trigger a transfer.
      if (error?.code !== '23505') throw error;
    }
    const result = await this.query(
      `SELECT * FROM matt_mine_normalized.payment_operations
       WHERE idempotency_key=$1 OR transaction_hash=$2
       ORDER BY (idempotency_key=$1) DESC LIMIT 1`,
      [operation.idempotencyKey, operation.transactionHash || null]
    );
    return result.rows[0] || null;
  }

  async advancePaymentOperation(idempotencyKey, state, options = {}) {
    const timestampColumn = {
      chain_verified: 'chain_verified_at_ms',
      ledger_credited: 'ledger_credited_at_ms',
      completed: 'completed_at_ms'
    }[state];
    const timestampAssignment = timestampColumn ? `, ${timestampColumn}=$3` : '';
    const result = await this.query(
      `UPDATE matt_mine_normalized.payment_operations
       SET state=$2, updated_at_ms=$3${timestampAssignment},
           completed_response=COALESCE($4::jsonb, completed_response),
           error_code=COALESCE($5, error_code)
       WHERE idempotency_key=$1 AND state <> 'completed'
       RETURNING *`,
      [idempotencyKey, state, options.timestamp || this.now(),
        options.response === undefined ? null : JSON.stringify(options.response),
        options.errorCode || null]
    );
    if (result.rows[0]) return result.rows[0];
    const existing = await this.query(
      'SELECT * FROM matt_mine_normalized.payment_operations WHERE idempotency_key=$1',
      [idempotencyKey]
    );
    return existing.rows[0] || null;
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
  constructor(client, options = {}) {
    this.client = client;
    this.normalizedLeaderboards = true;
    this.endlessPersistenceEnabled = options.endlessPersistenceEnabled === true;
  }

  async upsertEndlessConfig(record, active = false) {
    if (!this.endlessPersistenceEnabled) return false;
    return persistEndlessConfig(this.client, record, active);
  }

  async upsertEndlessRun(run) {
    if (!this.endlessPersistenceEnabled) return false;
    return persistEndlessRun(this.client, run);
  }

  async insertEndlessCheckpoint(run, verification) {
    if (!this.endlessPersistenceEnabled) return false;
    return persistEndlessCheckpoint(this.client, run, verification);
  }

  async upsertEndlessPayment(run, paymentRecord = null) {
    if (!this.endlessPersistenceEnabled) return false;
    return persistEndlessPayment(this.client, run, paymentRecord);
  }

  async upsertEndlessLeaderboard(entry, run = null) {
    if (!this.endlessPersistenceEnabled) return false;
    return persistEndlessLeaderboardEntry(this.client, entry, run);
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

  async syncLeaderboardOverrides(overrides = {}) {
    const rows = Object.values(overrides || {}).filter((entry) =>
      entry &&
      ['free', 'paid'].includes(entry.mode) &&
      typeof entry.week === 'string' &&
      typeof entry.address === 'string' &&
      Number.isSafeInteger(entry.score)
    );
    if (!rows.length) return;
    await this.client.query(
      `INSERT INTO matt_mine_weekly_scores (
         week_key, mode, address, weekly_score, days_count, updated_at
       )
       SELECT
         item.week,
         item.mode,
         LOWER(item.address),
         item.score,
         CASE WHEN item.score > 0 THEN 1 ELSE 0 END,
         NOW()
       FROM jsonb_to_recordset($1::jsonb) AS item(
         week TEXT, mode TEXT, address TEXT, score BIGINT
       )
       ON CONFLICT (week_key, mode, address) DO UPDATE SET
         weekly_score = EXCLUDED.weekly_score,
         days_count = EXCLUDED.days_count,
         updated_at = NOW()`,
      [JSON.stringify(rows.map(({ week, mode, address, score }) => ({ week, mode, address, score })))]
    );
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
      mode TEXT NOT NULL CHECK (mode IN ('free', 'paid', 'practice', 'beta', 'weekly', 'endless')),
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
    DO $$
    DECLARE constraint_name TEXT;
    BEGIN
      SELECT conname INTO constraint_name
      FROM pg_constraint
      WHERE conrelid = 'matt_mine_runs'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%mode%'
        AND pg_get_constraintdef(oid) NOT LIKE '%beta%';
      IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE matt_mine_runs DROP CONSTRAINT %I', constraint_name);
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'matt_mine_runs'::regclass
          AND conname = 'matt_mine_runs_mode_check'
      ) THEN
        ALTER TABLE matt_mine_runs
          ADD CONSTRAINT matt_mine_runs_mode_check
          CHECK (mode IN ('free', 'paid', 'practice', 'beta', 'weekly', 'endless'));
      END IF;
    END $$;
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

async function normalizedDualWriteEnabled(client) {
  const result = await client.query(
    `SELECT dual_write_enabled
     FROM matt_mine_normalized.cutover_state
     WHERE singleton=TRUE`
  );
  return result.rows[0]?.dual_write_enabled === true;
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
    !['free', 'paid', 'practice', 'beta', 'weekly', 'endless'].includes(mode) ||
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

class AsyncReadWriteGate {
  constructor() {
    this.activeReaders = 0;
    this.activeWriter = false;
    this.waiting = [];
  }

  async withShared(operation) {
    await this.#acquire('shared');
    try {
      return await operation();
    } finally {
      this.activeReaders -= 1;
      this.#drain();
    }
  }

  async withExclusive(operation) {
    await this.#acquire('exclusive');
    try {
      return await operation();
    } finally {
      this.activeWriter = false;
      this.#drain();
    }
  }

  #acquire(mode) {
    if (
      this.waiting.length === 0 &&
      !this.activeWriter &&
      (mode === 'shared' || this.activeReaders === 0)
    ) {
      if (mode === 'shared') this.activeReaders += 1;
      else this.activeWriter = true;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push({ mode, resolve }));
  }

  #drain() {
    if (this.activeWriter || this.activeReaders > 0 || this.waiting.length === 0) return;
    if (this.waiting[0].mode === 'exclusive') {
      this.activeWriter = true;
      this.waiting.shift().resolve();
      return;
    }
    while (this.waiting[0]?.mode === 'shared') {
      this.activeReaders += 1;
      this.waiting.shift().resolve();
    }
  }
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

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
