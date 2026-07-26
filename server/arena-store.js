import { ApiError, assertApi } from './errors.js';
import { compareArenaScores } from './arena-settlement.js';

export const ARENA_SEED_CAP_RAW = '10000000000000000000000000';
const DAY_MS = 86_400_000;

export class MemoryArenaStore {
  constructor() {
    this.kind = 'memory';
    this.days = new Map();
    this.entries = new Map();
    this.paymentKeys = new Map();
    this.runs = new Map();
    this.events = new Map();
    this.bestScores = new Map();
    this.snapshots = new Map();
    this.settlementDrafts = new Map();
    this.adminDrafts = new Map();
    this.queue = Promise.resolve();
  }

  async init() {
    return this;
  }

  async close() {}

  async healthCheck() {
    return { ok: true, kind: this.kind };
  }

  async ensureDay(config) {
    return this.#mutate(() => {
      let day = this.days.get(config.day);
      if (!day) {
        day = normalizeDay(config);
        this.days.set(day.day, day);
      }
      return clone(day);
    });
  }

  async scheduleDay(config) {
    return this.#mutate(() => {
      const existing = this.days.get(config.day);
      const day = normalizeDay({ ...(existing || {}), ...config, status: 'scheduled' });
      this.days.set(day.day, day);
      return clone(day);
    });
  }

  async getDay(day) {
    await this.queue;
    return clone(this.days.get(day) || null);
  }

  async reconcileDay(dayKey, accounting) {
    return this.#mutate(() => {
      const day = this.days.get(dayKey);
      assertApi(day, 404, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
      const entryPoolRaw = rawAmount(accounting.entryPoolRaw, true, 'arena_pool_invalid');
      const seedRaw = rawAmount(accounting.seedRaw, true, 'arena_seed_amount_invalid');
      assertApi(BigInt(seedRaw) <= BigInt(ARENA_SEED_CAP_RAW), 409, 'arena_seed_cap_exceeded', 'Onchain Daily Arena seed accounting exceeds the 10,000,000 MATT cap.');
      assertApi(BigInt(entryPoolRaw) >= BigInt(day.entryPoolRaw), 409, 'arena_pool_regressed', 'Onchain Daily Arena entry accounting cannot decrease.');
      day.entryPoolRaw = entryPoolRaw;
      day.seedRaw = seedRaw;
      day.entryCount = Math.max(day.entryCount, safeInteger(accounting.entryCount));
      if (Number.isSafeInteger(accounting.chainStatus)) {
        day.chainStatus = accounting.chainStatus;
        if (accounting.chainStatus > 0) day.configurationState = 'confirmed';
        if (accounting.chainStatus === 2) day.status = 'settled';
        if (accounting.chainStatus === 3) day.status = 'cancelled';
        if (
          accounting.chainStatus === 1 &&
          ['scheduled', 'open'].includes(accounting.status)
        ) {
          day.status = accounting.status;
        }
      }
      return clone(day);
    });
  }

  async confirmEntry(record) {
    return this.#mutate(() => {
      const existingId = this.paymentKeys.get(record.paymentKey);
      if (existingId) {
        const existing = this.entries.get(existingId);
        assertApi(existing.address === record.address, 409, 'arena_payment_already_owned', 'This Arena payment belongs to another wallet.');
        return { entry: clone(existing), alreadyConfirmed: true };
      }
      assertApi(!this.entries.has(record.entryId), 409, 'arena_entry_exists', 'This Arena entry already exists.');
      const day = this.days.get(record.day);
      assertApi(day, 409, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
      assertApi(record.amountRaw === day.feeRaw, 422, 'arena_fee_mismatch', 'The confirmed Arena payment does not match the immutable daily fee.');
      const entry = normalizeEntry(record);
      this.entries.set(entry.entryId, entry);
      this.paymentKeys.set(entry.paymentKey, entry.entryId);
      return { entry: clone(entry), alreadyConfirmed: false };
    });
  }

  async unusedEntries(address, day) {
    await this.queue;
    return [...this.entries.values()]
      .filter((entry) => entry.address === address && entry.day === day && !entry.runId)
      .sort((left, right) => left.confirmedAt - right.confirmedAt || left.transactionHash.localeCompare(right.transactionHash))
      .map(clone);
  }

  async consumeEntry(address, day, entryId, run) {
    return this.#mutate(() => {
      const active = [...this.runs.values()].find((candidate) =>
        candidate.address === address && candidate.status === 'active'
      );
      assertApi(!active, 409, 'arena_run_active', 'Finish or expire the active Daily Arena run first.');
      const candidates = [...this.entries.values()]
        .filter((entry) => entry.address === address && entry.day === day && !entry.runId)
        .sort((left, right) => left.confirmedAt - right.confirmedAt || left.transactionHash.localeCompare(right.transactionHash));
      const entry = entryId ? this.entries.get(entryId) : candidates[0];
      assertApi(entry && entry.address === address && entry.day === day, 404, 'arena_entry_missing', 'The Daily Arena entry was not found.');
      assertApi(!entry.runId, 409, 'arena_entry_consumed', 'This Daily Arena entry has already been used.');
      entry.runId = run.runId;
      entry.consumedAt = run.startedAt;
      this.runs.set(run.runId, normalizeRun({ ...run, entryId: entry.entryId, entryTransactionHash: entry.transactionHash }));
      this.events.set(run.runId, []);
      return { entry: clone(entry), run: clone(this.runs.get(run.runId)) };
    });
  }

  async getRun(runId) {
    await this.queue;
    return clone(this.runs.get(runId) || null);
  }

  async activeRun(address) {
    await this.queue;
    return clone([...this.runs.values()].find((run) =>
      run.address === address && run.status === 'active'
    ) || null);
  }

  async getEvents(runId) {
    await this.queue;
    return clone(this.events.get(runId) || []);
  }

  async appendEvents(runId, expectedThroughSeq, events, patch) {
    return this.#mutate(() => {
      const run = this.runs.get(runId);
      assertApi(run, 404, 'arena_run_missing', 'The Daily Arena run was not found.');
      assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
      assertApi(run.throughSeq === expectedThroughSeq, 409, 'arena_checkpoint_stale', 'The Daily Arena checkpoint is stale.');
      const transcript = this.events.get(runId) || [];
      transcript.push(...clone(events));
      this.events.set(runId, transcript);
      Object.assign(run, patch);
      return clone(run);
    });
  }

  async expireRun(runId, timestamp) {
    return this.#mutate(() => {
      const run = this.runs.get(runId);
      if (run?.status === 'active') {
        run.status = 'expired';
        run.finishedAt = timestamp;
      }
      return clone(run || null);
    });
  }

  async finishRun(runId, result, timestamp) {
    return this.#mutate(() => {
      const run = this.runs.get(runId);
      assertApi(run, 404, 'arena_run_missing', 'The Daily Arena run was not found.');
      if (run.status === 'finished') return { run: clone(run), alreadyFinished: true };
      assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
      run.status = 'finished';
      run.finishedAt = timestamp;
      run.result = clone(result);
      const key = `${run.day}:${run.address}`;
      const candidate = scoreRecord(run);
      const current = this.bestScores.get(key);
      if (!current || compareArenaScores(candidate, current) < 0) this.bestScores.set(key, candidate);
      return { run: clone(run), alreadyFinished: false };
    });
  }

  async leaderboard(day, suspendedAddresses = [], now = Date.now()) {
    const dayEnd = dayEndMs(day);
    const contest = this.days.get(day);
    if (contest?.chainStatus === 3) {
      return leaderboardDocument(contest, [], true, dayEnd);
    }
    await this.queue;
    const snapshot = this.snapshots.get(day);
    if (snapshot) return clone(snapshot);
    const suspended = new Set(suspendedAddresses);
    const rows = [...this.bestScores.values()]
      .filter((entry) => entry.day === day && !suspended.has(entry.address))
      .sort(compareArenaScores)
      .map((entry, index) => ({
        ...clone(entry),
        rank: index + 1,
        entries: this.#walletEntryCount(entry.address, day)
      }));
    const current = this.days.get(day);
    const closed = dayEnd <= now;
    return leaderboardDocument(
      closed && ['scheduled', 'open'].includes(current?.status)
        ? { ...current, status: 'closed' }
        : current,
      rows,
      false,
      0
    );
  }

  async finalizeDay(day, suspendedAddresses = []) {
    return this.#mutate(() => {
      const existing = this.snapshots.get(day);
      if (existing) return clone(existing);
      const contest = this.days.get(day);
      assertApi(contest, 404, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
      assertApi(contest.chainStatus !== 3, 409, 'arena_day_cancelled', 'A cancelled Daily Arena day cannot be finalized for settlement.');
      const suspended = new Set(suspendedAddresses);
      const rows = [...this.bestScores.values()]
        .filter((entry) => entry.day === day && !suspended.has(entry.address))
        .sort(compareArenaScores)
        .map((entry, index) => ({
          ...clone(entry),
          rank: index + 1,
          entries: this.#walletEntryCount(entry.address, day)
        }));
      contest.status = contest.chainStatus === 2 ? 'settled' : 'finalized';
      contest.finalizedAt = dayEndMs(day);
      const snapshot = leaderboardDocument(contest, rows, true, contest.finalizedAt);
      this.snapshots.set(day, snapshot);
      return clone(snapshot);
    });
  }

  async playerStatus(address, day) {
    await this.queue;
    const entries = [...this.entries.values()].filter((entry) => entry.address === address && entry.day === day);
    const runs = [...this.runs.values()].filter((run) => run.address === address && run.day === day);
    const best = this.bestScores.get(`${day}:${address}`) || null;
    return {
      day,
      confirmedEntries: entries.length,
      unusedAttempts: entries.filter((entry) => !entry.runId).length,
      runCount: runs.length,
      activeRun: clone(runs.find((run) => run.status === 'active') || null),
      best: clone(best)
    };
  }

  async saveSettlementDraft(day, draft) {
    return this.#mutate(() => {
      const existing = this.settlementDrafts.get(day);
      if (existing) return { draft: clone(existing), alreadyCreated: true };
      this.settlementDrafts.set(day, clone(draft));
      return { draft: clone(draft), alreadyCreated: false };
    });
  }

  async getSettlementDraft(day) {
    await this.queue;
    return clone(this.settlementDrafts.get(day) || null);
  }

  async saveAdminDraft(key, draft) {
    return this.#mutate(() => {
      const existing = this.adminDrafts.get(key);
      if (existing) return { draft: clone(existing), alreadyCreated: true };
      this.adminDrafts.set(key, clone(draft));
      return { draft: clone(draft), alreadyCreated: false };
    });
  }

  async getAdminDraft(key) {
    await this.queue;
    return clone(this.adminDrafts.get(key) || null);
  }

  #mutate(operation) {
    const task = this.queue.then(operation);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  #walletEntryCount(address, day) {
    return [...this.entries.values()].filter((entry) =>
      entry.address === address && entry.day === day
    ).length;
  }
}

export class PostgresArenaStore {
  constructor(databaseOrPool) {
    this.kind = 'postgresql';
    this.pool = databaseOrPool?.pool || databaseOrPool;
    assertApi(this.pool?.query && this.pool?.connect, 500, 'arena_database_invalid', 'Daily Arena PostgreSQL storage requires a connection pool.');
    this.initialized = false;
    this.initPromise = null;
  }

  async init() {
    if (this.initialized) return this;
    if (!this.initPromise) {
      this.initPromise = createArenaPostgresSchema(this.pool).catch((error) => {
        this.initPromise = null;
        throw error;
      });
    }
    await this.initPromise;
    this.initialized = true;
    return this;
  }

  async close() {}

  async healthCheck() {
    await this.init();
    await this.pool.query('SELECT 1 FROM matt_mine_arena.days LIMIT 1');
    return { ok: true, kind: this.kind };
  }

  async ensureDay(config) {
    await this.init();
    const day = normalizeDay(config);
    await this.pool.query(
      `INSERT INTO matt_mine_arena.days (
         day_key, day_id, snapshot_at_ms, fee_raw, seed_raw, seed_cap_raw,
         deterministic_seed, transcript_version, status, chain_status,
         configuration_state, created_at_ms
       ) VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (day_key) DO NOTHING`,
      [day.day, day.dayId, day.snapshotAt, day.feeRaw, day.seedRaw, day.seedCapRaw,
        day.deterministicSeed, day.transcriptVersion, day.status, day.chainStatus,
        day.configurationState, day.createdAt]
    );
    return this.getDay(day.day);
  }

  async scheduleDay(config) {
    await this.init();
    const day = normalizeDay({ ...config, status: 'scheduled' });
    await this.pool.query(
      `INSERT INTO matt_mine_arena.days (
         day_key, day_id, snapshot_at_ms, fee_raw, seed_raw, seed_cap_raw,
         deterministic_seed, transcript_version, status, chain_status,
         configuration_state, created_at_ms
       ) VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7,$8,'scheduled',$9,$10,$11)
       ON CONFLICT (day_key) DO UPDATE SET
         fee_raw=EXCLUDED.fee_raw, seed_raw=EXCLUDED.seed_raw,
         deterministic_seed=EXCLUDED.deterministic_seed,
         transcript_version=EXCLUDED.transcript_version,
         chain_status=EXCLUDED.chain_status,
         configuration_state=EXCLUDED.configuration_state`,
      [day.day, day.dayId, day.snapshotAt, day.feeRaw, day.seedRaw, day.seedCapRaw,
        day.deterministicSeed, day.transcriptVersion, day.chainStatus,
        day.configurationState, day.createdAt]
    );
    return this.getDay(day.day);
  }

  async getDay(day) {
    await this.init();
    const result = await this.pool.query('SELECT * FROM matt_mine_arena.days WHERE day_key=$1', [day]);
    return result.rows[0] ? formatDayRow(result.rows[0]) : null;
  }

  async reconcileDay(day, accounting) {
    await this.init();
    const seedRaw = rawAmount(accounting.seedRaw, true, 'arena_seed_amount_invalid');
    assertApi(BigInt(seedRaw) <= BigInt(ARENA_SEED_CAP_RAW), 409, 'arena_seed_cap_exceeded', 'Onchain Daily Arena seed accounting exceeds the 10,000,000 MATT cap.');
    const result = await this.pool.query(
      `UPDATE matt_mine_arena.days SET
         entry_pool_raw=$2::numeric,seed_raw=$3::numeric,
         entry_count=GREATEST(entry_count,$4),
         chain_status=$5::smallint,
         configuration_state=CASE WHEN $5::smallint>0 THEN 'confirmed' ELSE configuration_state END,
         status=CASE
           WHEN $5::smallint=2 THEN 'settled'
           WHEN $5::smallint=3 THEN 'cancelled'
           WHEN $5::smallint=1 AND status='finalized' THEN 'finalized'
           WHEN $5::smallint=1 AND $6 IN ('scheduled','open') THEN $6
           ELSE status
         END
       WHERE day_key=$1 AND entry_pool_raw <= $2::numeric
       RETURNING *`,
      [day, rawAmount(accounting.entryPoolRaw, true, 'arena_pool_invalid'), seedRaw,
        safeInteger(accounting.entryCount), safeChainStatus(accounting.chainStatus),
        ['scheduled', 'open'].includes(accounting.status) ? accounting.status : 'scheduled']
    );
    assertApi(result.rows[0], 409, 'arena_pool_regressed', 'Onchain Daily Arena entry accounting cannot decrease.');
    return formatDayRow(result.rows[0]);
  }

  async confirmEntry(record) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query('SELECT * FROM matt_mine_arena.entries WHERE payment_key=$1 FOR UPDATE', [record.paymentKey]);
      if (existing.rows[0]) {
        const entry = formatEntryRow(existing.rows[0]);
        assertApi(entry.address === record.address, 409, 'arena_payment_already_owned', 'This Arena payment belongs to another wallet.');
        await client.query('COMMIT');
        return { entry, alreadyConfirmed: true };
      }
      const contest = await client.query('SELECT fee_raw FROM matt_mine_arena.days WHERE day_key=$1 FOR UPDATE', [record.day]);
      assertApi(contest.rows[0], 409, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
      assertApi(String(contest.rows[0].fee_raw) === record.amountRaw, 422, 'arena_fee_mismatch', 'The confirmed Arena payment does not match the immutable daily fee.');
      const entry = normalizeEntry(record);
      await client.query(
        `INSERT INTO matt_mine_arena.entries (
           entry_id,payment_key,transaction_hash,log_index,block_number,day_key,address,
           amount_raw,confirmed_at_ms,consumed_at_ms,run_id
         ) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7,$8::numeric,$9,0,'')`,
        [entry.entryId, entry.paymentKey, entry.transactionHash, entry.logIndex, entry.blockNumber,
          entry.day, entry.address, entry.amountRaw, entry.confirmedAt]
      );
      await client.query('COMMIT');
      return { entry, alreadyConfirmed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error?.code === '23505') throw new ApiError(409, 'arena_entry_exists', 'This Arena entry already exists.');
      throw error;
    } finally {
      client.release();
    }
  }

  async unusedEntries(address, day) {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM matt_mine_arena.entries
       WHERE address=$1 AND day_key=$2 AND run_id=''
       ORDER BY confirmed_at_ms, transaction_hash`,
      [address, day]
    );
    return result.rows.map(formatEntryRow);
  }

  async consumeEntry(address, day, entryId, run) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const active = await client.query(
        `SELECT run_id FROM matt_mine_arena.runs
         WHERE address=$1 AND status='active' FOR UPDATE`,
        [address]
      );
      assertApi(!active.rows.length, 409, 'arena_run_active', 'Finish or expire the active Daily Arena run first.');
      const entryResult = await client.query(
        `SELECT * FROM matt_mine_arena.entries
         WHERE address=$1 AND day_key=$2 AND run_id=''
           AND ($3='' OR entry_id=$3)
         ORDER BY confirmed_at_ms, transaction_hash LIMIT 1 FOR UPDATE`,
        [address, day, entryId || '']
      );
      assertApi(entryResult.rows[0], 404, 'arena_entry_missing', 'The Daily Arena entry was not found.');
      const entry = formatEntryRow(entryResult.rows[0]);
      const storedRun = normalizeRun({ ...run, entryId: entry.entryId, entryTransactionHash: entry.transactionHash });
      await client.query(
        `INSERT INTO matt_mine_arena.runs (
           run_id,entry_id,day_key,address,entry_transaction_hash,token_hash,
           receipt_signature,status,started_at_ms,expires_at_ms,finished_at_ms,
           through_seq,through_tick,transcript_hash,checkpoint_signature,tuning,result
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9,0,0,0,$10,$11,$12::jsonb,NULL)`,
        [storedRun.runId, storedRun.entryId, storedRun.day, storedRun.address,
          storedRun.entryTransactionHash, storedRun.tokenHash, storedRun.receiptSignature,
          storedRun.startedAt, storedRun.expiresAt, storedRun.transcriptHash, storedRun.checkpointSignature,
          JSON.stringify(storedRun.tuning || {})]
      );
      await client.query(
        `UPDATE matt_mine_arena.entries SET run_id=$2,consumed_at_ms=$3 WHERE entry_id=$1`,
        [entry.entryId, storedRun.runId, storedRun.startedAt]
      );
      await client.query('COMMIT');
      entry.runId = storedRun.runId;
      entry.consumedAt = storedRun.startedAt;
      return { entry, run: storedRun };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getRun(runId) {
    await this.init();
    const result = await this.pool.query('SELECT * FROM matt_mine_arena.runs WHERE run_id=$1', [runId]);
    return result.rows[0] ? formatRunRow(result.rows[0]) : null;
  }

  async activeRun(address) {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM matt_mine_arena.runs
       WHERE address=$1 AND status='active'
       ORDER BY started_at_ms DESC LIMIT 1`,
      [address]
    );
    return result.rows[0] ? formatRunRow(result.rows[0]) : null;
  }

  async getEvents(runId) {
    await this.init();
    const result = await this.pool.query(
      'SELECT event_json FROM matt_mine_arena.events WHERE run_id=$1 ORDER BY seq',
      [runId]
    );
    return result.rows.map((row) => typeof row.event_json === 'string' ? JSON.parse(row.event_json) : row.event_json);
  }

  async appendEvents(runId, expectedThroughSeq, events, patch) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT * FROM matt_mine_arena.runs WHERE run_id=$1 FOR UPDATE', [runId]);
      assertApi(selected.rows[0], 404, 'arena_run_missing', 'The Daily Arena run was not found.');
      const run = formatRunRow(selected.rows[0]);
      assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
      assertApi(run.throughSeq === expectedThroughSeq, 409, 'arena_checkpoint_stale', 'The Daily Arena checkpoint is stale.');
      for (const event of events) {
        await client.query(
          `INSERT INTO matt_mine_arena.events
           (run_id,seq,tick,event_type,target_id,amount,event_json,event_hash,received_at_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
          [runId, event.seq, event.tick, event.type, event.targetId || '',
            event.amount || 0, JSON.stringify(event), event.eventHash, event.receivedAt]
        );
      }
      await client.query(
        `UPDATE matt_mine_arena.runs SET
           through_seq=$2,through_tick=$3,transcript_hash=$4,checkpoint_signature=$5
         WHERE run_id=$1`,
        [runId, patch.throughSeq, patch.throughTick, patch.transcriptHash, patch.checkpointSignature]
      );
      await client.query('COMMIT');
      return { ...run, ...clone(patch) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async expireRun(runId, timestamp) {
    await this.init();
    await this.pool.query(
      `UPDATE matt_mine_arena.runs SET status='expired',finished_at_ms=$2
       WHERE run_id=$1 AND status='active'`,
      [runId, timestamp]
    );
    return this.getRun(runId);
  }

  async finishRun(runId, result, timestamp) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query('SELECT * FROM matt_mine_arena.runs WHERE run_id=$1 FOR UPDATE', [runId]);
      assertApi(selected.rows[0], 404, 'arena_run_missing', 'The Daily Arena run was not found.');
      const run = formatRunRow(selected.rows[0]);
      if (run.status === 'finished') {
        await client.query('COMMIT');
        return { run, alreadyFinished: true };
      }
      assertApi(run.status === 'active', 409, 'arena_run_not_active', 'The Daily Arena run is no longer active.');
      await client.query(
        `UPDATE matt_mine_arena.runs SET status='finished',finished_at_ms=$2,result=$3::jsonb
         WHERE run_id=$1`,
        [runId, timestamp, JSON.stringify(result)]
      );
      const candidate = scoreRecord({ ...run, status: 'finished', finishedAt: timestamp, result });
      const best = await client.query(
        `SELECT * FROM matt_mine_arena.best_scores WHERE day_key=$1 AND address=$2 FOR UPDATE`,
        [run.day, run.address]
      );
      const current = best.rows[0] ? formatScoreRow(best.rows[0]) : null;
      if (!current || compareArenaScores(candidate, current) < 0) {
        await client.query(
          `INSERT INTO matt_mine_arena.best_scores (
             day_key,address,run_id,score,depth,guardian_time_ms,damage_taken,
             elapsed_ms,entry_transaction_hash,finished_at_ms
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (day_key,address) DO UPDATE SET
             run_id=EXCLUDED.run_id,score=EXCLUDED.score,depth=EXCLUDED.depth,
             guardian_time_ms=EXCLUDED.guardian_time_ms,damage_taken=EXCLUDED.damage_taken,
             elapsed_ms=EXCLUDED.elapsed_ms,entry_transaction_hash=EXCLUDED.entry_transaction_hash,
             finished_at_ms=EXCLUDED.finished_at_ms`,
          [candidate.day, candidate.address, candidate.runId, candidate.score, candidate.depth,
            candidate.guardianTimeMs, candidate.damageTaken, candidate.elapsedMs,
            candidate.entryTransactionHash, candidate.finishedAt]
        );
      }
      await client.query('COMMIT');
      return { run: { ...run, status: 'finished', finishedAt: timestamp, result: clone(result) }, alreadyFinished: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async leaderboard(day, suspendedAddresses = [], now = Date.now()) {
    await this.init();
    const dayRecord = await this.getDay(day);
    if (dayRecord?.chainStatus === 3) {
      return leaderboardDocument(dayRecord, [], true, dayEndMs(day));
    }
    const snapshot = await this.pool.query(
      `SELECT s.*,d.status
       FROM matt_mine_arena.snapshots s
       JOIN matt_mine_arena.days d ON d.day_key=s.day_key
       WHERE s.day_key=$1`,
      [day]
    );
    if (snapshot.rows[0]) {
      const rows = await this.pool.query(
        `SELECT se.*,
           (SELECT COUNT(*)::integer FROM matt_mine_arena.entries e
            WHERE e.day_key=se.day_key AND e.address=se.address) AS entry_count
         FROM matt_mine_arena.snapshot_entries se
         WHERE se.day_key=$1 ORDER BY se.rank`,
        [day]
      );
      return formatSnapshot(snapshot.rows[0], rows.rows);
    }
    const contest = await this.getDay(day);
    const rows = await this.#rankedRows(day, suspendedAddresses);
    const participantCount = await eligibleParticipantCount(this.pool, day, suspendedAddresses);
    const closed = dayEndMs(day) <= now;
    return leaderboardDocument(
      closed && ['scheduled', 'open'].includes(contest?.status)
        ? { ...contest, status: 'closed' }
        : contest,
      rows,
      false,
      0,
      participantCount
    );
  }

  async finalizeDay(day, suspendedAddresses = []) {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT s.*,d.status
         FROM matt_mine_arena.snapshots s
         JOIN matt_mine_arena.days d ON d.day_key=s.day_key
         WHERE s.day_key=$1 FOR UPDATE OF s`,
        [day]
      );
      if (existing.rows[0]) {
        const rows = await client.query(
          `SELECT se.*,
             (SELECT COUNT(*)::integer FROM matt_mine_arena.entries e
              WHERE e.day_key=se.day_key AND e.address=se.address) AS entry_count
           FROM matt_mine_arena.snapshot_entries se
           WHERE se.day_key=$1 ORDER BY se.rank`,
          [day]
        );
        await client.query('COMMIT');
        return formatSnapshot(existing.rows[0], rows.rows);
      }
      const selected = await client.query('SELECT * FROM matt_mine_arena.days WHERE day_key=$1 FOR UPDATE', [day]);
      assertApi(selected.rows[0], 404, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
      const contest = formatDayRow(selected.rows[0]);
      assertApi(contest.chainStatus !== 3, 409, 'arena_day_cancelled', 'A cancelled Daily Arena day cannot be finalized for settlement.');
      const ranked = await rankedRowsQuery(client, day, suspendedAddresses);
      const participantCount = await eligibleParticipantCount(client, day, suspendedAddresses);
      const finalizedAt = dayEndMs(day);
      await client.query(
        `INSERT INTO matt_mine_arena.snapshots (
           day_key,finalized_at_ms,participant_count,entry_count,entry_pool_raw,
           seed_raw,prize_pool_raw
         ) VALUES ($1,$2,$3,$4,$5::numeric,$6::numeric,$7::numeric)`,
        [day, finalizedAt, participantCount, contest.entryCount, contest.entryPoolRaw,
          contest.seedRaw, (BigInt(contest.entryPoolRaw) + BigInt(contest.seedRaw)).toString()]
      );
      for (const row of ranked) {
        await client.query(
          `INSERT INTO matt_mine_arena.snapshot_entries (
             day_key,rank,address,run_id,score,depth,guardian_time_ms,damage_taken,
             elapsed_ms,entry_transaction_hash,finished_at_ms
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [day, row.rank, row.address, row.runId, row.score, row.depth, row.guardianTimeMs,
            row.damageTaken, row.elapsedMs, row.entryTransactionHash, row.finishedAt]
        );
      }
      await client.query(
        `UPDATE matt_mine_arena.days SET
           status=CASE WHEN chain_status=2 THEN 'settled' ELSE 'finalized' END,
           finalized_at_ms=$2
         WHERE day_key=$1`,
        [day, finalizedAt]
      );
      await client.query('COMMIT');
      return leaderboardDocument({
        ...contest,
        status: contest.chainStatus === 2 ? 'settled' : 'finalized',
        finalizedAt
      }, ranked, true, finalizedAt, participantCount);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async playerStatus(address, day) {
    await this.init();
    const [entries, runs, best] = await Promise.all([
      this.pool.query(
        `SELECT COUNT(*)::integer AS total,
                COUNT(*) FILTER (WHERE run_id='')::integer AS unused
         FROM matt_mine_arena.entries WHERE address=$1 AND day_key=$2`,
        [address, day]
      ),
      this.pool.query(
        `SELECT * FROM matt_mine_arena.runs WHERE address=$1 AND day_key=$2 ORDER BY started_at_ms DESC`,
        [address, day]
      ),
      this.pool.query(
        `SELECT * FROM matt_mine_arena.best_scores WHERE address=$1 AND day_key=$2`,
        [address, day]
      )
    ]);
    const formattedRuns = runs.rows.map(formatRunRow);
    return {
      day,
      confirmedEntries: Number(entries.rows[0]?.total || 0),
      unusedAttempts: Number(entries.rows[0]?.unused || 0),
      runCount: formattedRuns.length,
      activeRun: formattedRuns.find((run) => run.status === 'active') || null,
      best: best.rows[0] ? formatScoreRow(best.rows[0]) : null
    };
  }

  async saveSettlementDraft(day, draft) {
    await this.init();
    const result = await this.pool.query(
      `INSERT INTO matt_mine_arena.settlement_drafts (day_key,draft_json,created_at_ms)
       VALUES ($1,$2::jsonb,$3) ON CONFLICT (day_key) DO NOTHING RETURNING day_key`,
      [day, JSON.stringify(draft), draft.createdAt || Date.now()]
    );
    return {
      draft: result.rows.length ? clone(draft) : await this.getSettlementDraft(day),
      alreadyCreated: !result.rows.length
    };
  }

  async getSettlementDraft(day) {
    await this.init();
    const result = await this.pool.query('SELECT draft_json FROM matt_mine_arena.settlement_drafts WHERE day_key=$1', [day]);
    const value = result.rows[0]?.draft_json;
    return value ? clone(typeof value === 'string' ? JSON.parse(value) : value) : null;
  }

  async saveAdminDraft(key, draft) {
    await this.init();
    const result = await this.pool.query(
      `INSERT INTO matt_mine_arena.admin_drafts
       (draft_key,draft_json,created_at_ms)
       VALUES ($1,$2::jsonb,$3)
       ON CONFLICT (draft_key) DO NOTHING RETURNING draft_key`,
      [key, JSON.stringify(draft), draft.createdAt || Date.now()]
    );
    return {
      draft: result.rows.length ? clone(draft) : await this.getAdminDraft(key),
      alreadyCreated: !result.rows.length
    };
  }

  async getAdminDraft(key) {
    await this.init();
    const result = await this.pool.query(
      'SELECT draft_json FROM matt_mine_arena.admin_drafts WHERE draft_key=$1',
      [key]
    );
    const value = result.rows[0]?.draft_json;
    return value ? clone(typeof value === 'string' ? JSON.parse(value) : value) : null;
  }

  async #rankedRows(day, suspended) {
    return rankedRowsQuery(this.pool, day, suspended);
  }
}

export async function createArenaPostgresSchema(pool) {
  await pool.query('CREATE SCHEMA IF NOT EXISTS matt_mine_arena');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.days (
      day_key TEXT PRIMARY KEY,
      day_id INTEGER NOT NULL UNIQUE,
      snapshot_at_ms BIGINT NOT NULL,
      fee_raw NUMERIC(78,0) NOT NULL CHECK (fee_raw > 0),
      seed_raw NUMERIC(78,0) NOT NULL CHECK (seed_raw >= 0),
      seed_cap_raw NUMERIC(78,0) NOT NULL CHECK (seed_cap_raw = 10000000000000000000000000),
      deterministic_seed TEXT NOT NULL CHECK (deterministic_seed ~ '^[a-f0-9]{64}$'),
      transcript_version TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled','open','finalized','settled','cancelled')),
      chain_status SMALLINT NOT NULL DEFAULT 0 CHECK (chain_status BETWEEN 0 AND 3),
      configuration_state TEXT NOT NULL DEFAULT 'prepared'
        CHECK (configuration_state IN ('prepared','confirmed')),
      entry_pool_raw NUMERIC(78,0) NOT NULL DEFAULT 0 CHECK (entry_pool_raw >= 0),
      entry_count INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
      created_at_ms BIGINT NOT NULL,
      finalized_at_ms BIGINT NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    ALTER TABLE matt_mine_arena.days
      DROP CONSTRAINT IF EXISTS days_status_check`);
  await pool.query(`
    ALTER TABLE matt_mine_arena.days
      ADD CONSTRAINT days_status_check
      CHECK (status IN ('scheduled','open','finalized','settled','cancelled'))`);
  await pool.query(`
    ALTER TABLE matt_mine_arena.days
      ADD COLUMN IF NOT EXISTS chain_status SMALLINT NOT NULL DEFAULT 0
        CHECK (chain_status BETWEEN 0 AND 3)`);
  await pool.query(`
    ALTER TABLE matt_mine_arena.days
      ADD COLUMN IF NOT EXISTS configuration_state TEXT NOT NULL DEFAULT 'prepared'
        CHECK (configuration_state IN ('prepared','confirmed'))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.entries (
      entry_id TEXT PRIMARY KEY,
      payment_key TEXT NOT NULL UNIQUE,
      transaction_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL CHECK (log_index >= 0),
      block_number NUMERIC(78,0) NOT NULL,
      day_key TEXT NOT NULL REFERENCES matt_mine_arena.days(day_key),
      address TEXT NOT NULL,
      amount_raw NUMERIC(78,0) NOT NULL CHECK (amount_raw > 0),
      confirmed_at_ms BIGINT NOT NULL,
      consumed_at_ms BIGINT NOT NULL DEFAULT 0,
      run_id TEXT NOT NULL DEFAULT '',
      UNIQUE (transaction_hash, log_index)
    )`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS entries_wallet_day_unused_idx
    ON matt_mine_arena.entries(address,day_key,confirmed_at_ms) WHERE run_id=''`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.runs (
      run_id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL UNIQUE REFERENCES matt_mine_arena.entries(entry_id),
      day_key TEXT NOT NULL REFERENCES matt_mine_arena.days(day_key),
      address TEXT NOT NULL,
      entry_transaction_hash TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      receipt_signature TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active','finished','expired','rejected')),
      started_at_ms BIGINT NOT NULL,
      expires_at_ms BIGINT NOT NULL,
      finished_at_ms BIGINT NOT NULL DEFAULT 0,
      through_seq INTEGER NOT NULL DEFAULT 0,
      through_tick INTEGER NOT NULL DEFAULT 0,
      transcript_hash TEXT NOT NULL,
      checkpoint_signature TEXT NOT NULL,
      tuning JSONB NOT NULL DEFAULT '{}'::jsonb,
      result JSONB
    )`);
  await pool.query(`ALTER TABLE matt_mine_arena.runs ADD COLUMN IF NOT EXISTS tuning JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_wallet_idx
    ON matt_mine_arena.runs(address) WHERE status='active'`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.events (
      run_id TEXT NOT NULL REFERENCES matt_mine_arena.runs(run_id),
      seq INTEGER NOT NULL CHECK (seq > 0),
      tick INTEGER NOT NULL CHECK (tick >= 0),
      event_type TEXT NOT NULL,
      target_id TEXT NOT NULL DEFAULT '',
      amount INTEGER NOT NULL DEFAULT 0,
      event_json JSONB NOT NULL,
      event_hash TEXT NOT NULL,
      received_at_ms BIGINT NOT NULL,
      PRIMARY KEY (run_id,seq)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.best_scores (
      day_key TEXT NOT NULL REFERENCES matt_mine_arena.days(day_key),
      address TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE REFERENCES matt_mine_arena.runs(run_id),
      score BIGINT NOT NULL CHECK (score >= 0),
      depth INTEGER NOT NULL,
      guardian_time_ms BIGINT NOT NULL,
      damage_taken BIGINT NOT NULL,
      elapsed_ms BIGINT NOT NULL,
      entry_transaction_hash TEXT NOT NULL,
      finished_at_ms BIGINT NOT NULL,
      PRIMARY KEY(day_key,address)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.snapshots (
      day_key TEXT PRIMARY KEY REFERENCES matt_mine_arena.days(day_key),
      finalized_at_ms BIGINT NOT NULL,
      participant_count INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      entry_pool_raw NUMERIC(78,0) NOT NULL,
      seed_raw NUMERIC(78,0) NOT NULL,
      prize_pool_raw NUMERIC(78,0) NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.snapshot_entries (
      day_key TEXT NOT NULL REFERENCES matt_mine_arena.snapshots(day_key),
      rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
      address TEXT NOT NULL,
      run_id TEXT NOT NULL,
      score BIGINT NOT NULL,
      depth INTEGER NOT NULL,
      guardian_time_ms BIGINT NOT NULL,
      damage_taken BIGINT NOT NULL,
      elapsed_ms BIGINT NOT NULL,
      entry_transaction_hash TEXT NOT NULL,
      finished_at_ms BIGINT NOT NULL,
      PRIMARY KEY(day_key,rank),
      UNIQUE(day_key,address)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.settlement_drafts (
      day_key TEXT PRIMARY KEY REFERENCES matt_mine_arena.snapshots(day_key),
      draft_json JSONB NOT NULL,
      created_at_ms BIGINT NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS matt_mine_arena.admin_drafts (
      draft_key TEXT PRIMARY KEY,
      draft_json JSONB NOT NULL,
      created_at_ms BIGINT NOT NULL
    )`);
}

async function rankedRowsQuery(client, day, suspendedAddresses) {
  const result = await client.query(
    `SELECT ROW_NUMBER() OVER (
       ORDER BY b.score DESC,b.depth DESC,b.guardian_time_ms ASC,b.damage_taken ASC,
                b.elapsed_ms ASC,b.entry_transaction_hash ASC
     )::integer AS rank, b.*,
       (SELECT COUNT(*)::integer FROM matt_mine_arena.entries e
        WHERE e.day_key=b.day_key AND e.address=b.address) AS entry_count
     FROM matt_mine_arena.best_scores b
     WHERE b.day_key=$1 AND NOT (b.address=ANY($2::text[]))
     ORDER BY rank LIMIT 10`,
    [day, suspendedAddresses]
  );
  return result.rows.map(formatScoreRow);
}

async function eligibleParticipantCount(client, day, suspendedAddresses) {
  const result = await client.query(
    `SELECT COUNT(*)::integer AS participant_count
     FROM matt_mine_arena.best_scores
     WHERE day_key=$1 AND NOT (address=ANY($2::text[]))`,
    [day, suspendedAddresses]
  );
  return Number(result.rows[0]?.participant_count || 0);
}

function normalizeDay(input) {
  assertApi(/^\d{4}-\d{2}-\d{2}$/.test(input.day || ''), 400, 'arena_day_invalid', 'Use a UTC day in YYYY-MM-DD format.');
  const start = Date.parse(`${input.day}T00:00:00.000Z`);
  const feeRaw = rawAmount(input.feeRaw, false, 'arena_fee_invalid');
  const seedRaw = rawAmount(input.seedRaw ?? '0', true, 'arena_seed_amount_invalid');
  assertApi(BigInt(seedRaw) <= BigInt(ARENA_SEED_CAP_RAW), 400, 'arena_seed_cap_exceeded', 'Daily Arena seed funding cannot exceed 10,000,000 MATT.');
  return {
    day: input.day,
    dayId: Number.isSafeInteger(input.dayId) ? input.dayId : Math.floor(start / DAY_MS),
    snapshotAt: Number.isSafeInteger(input.snapshotAt) ? input.snapshotAt : start,
    feeRaw,
    seedRaw,
    seedCapRaw: ARENA_SEED_CAP_RAW,
    deterministicSeed: String(input.deterministicSeed || ''),
    transcriptVersion: String(input.transcriptVersion || ''),
    status: ['scheduled', 'open', 'finalized', 'settled', 'cancelled'].includes(input.status) ? input.status : 'open',
    chainStatus: safeChainStatus(input.chainStatus),
    configurationState: input.configurationState === 'confirmed' ? 'confirmed' : 'prepared',
    entryPoolRaw: rawAmount(input.entryPoolRaw ?? '0', true, 'arena_pool_invalid'),
    entryCount: safeInteger(input.entryCount),
    createdAt: safeInteger(input.createdAt, Date.now()),
    finalizedAt: safeInteger(input.finalizedAt)
  };
}

function normalizeEntry(input) {
  return {
    entryId: String(input.entryId),
    paymentKey: String(input.paymentKey).toLowerCase(),
    transactionHash: String(input.transactionHash).toLowerCase(),
    logIndex: safeInteger(input.logIndex),
    blockNumber: rawAmount(input.blockNumber, true, 'arena_block_invalid'),
    day: String(input.day),
    address: String(input.address).toLowerCase(),
    amountRaw: rawAmount(input.amountRaw, false, 'arena_fee_invalid'),
    confirmedAt: safeInteger(input.confirmedAt),
    consumedAt: safeInteger(input.consumedAt),
    runId: String(input.runId || '')
  };
}

function normalizeRun(input) {
  return {
    runId: String(input.runId),
    entryId: String(input.entryId),
    day: String(input.day),
    address: String(input.address).toLowerCase(),
    entryTransactionHash: String(input.entryTransactionHash).toLowerCase(),
    tokenHash: String(input.tokenHash),
    receiptSignature: String(input.receiptSignature),
    status: String(input.status || 'active'),
    startedAt: safeInteger(input.startedAt),
    expiresAt: safeInteger(input.expiresAt),
    finishedAt: safeInteger(input.finishedAt),
    throughSeq: safeInteger(input.throughSeq),
    throughTick: safeInteger(input.throughTick),
    transcriptHash: String(input.transcriptHash),
    checkpointSignature: String(input.checkpointSignature),
    tuning: input.tuning && typeof input.tuning === 'object' ? clone(input.tuning) : {},
    result: input.result ? clone(input.result) : null
  };
}

function scoreRecord(run) {
  return {
    day: run.day,
    address: run.address,
    runId: run.runId,
    score: run.result.score,
    depth: run.result.depth,
    guardianTimeMs: run.result.guardianTimeMs,
    damageTaken: run.result.damageTaken,
    elapsedMs: run.result.elapsedMs,
    entryTransactionHash: run.entryTransactionHash,
    finishedAt: run.finishedAt
  };
}

function leaderboardDocument(day, rows, finalized, finalizedAt, participantCount = rows.length) {
  assertApi(day, 404, 'arena_day_missing', 'The Daily Arena snapshot does not exist.');
  const closed = finalized || ['closed', 'settled', 'cancelled', 'finalized'].includes(day.status);
  return {
    day: day.day,
    status: day.status,
    closed,
    provisional: !finalized && day.status === 'closed',
    finalized,
    finalizedAt,
    participantCount,
    entryCount: day.entryCount,
    entryPoolRaw: day.entryPoolRaw,
    seedRaw: day.seedRaw,
    prizePoolRaw: (BigInt(day.entryPoolRaw) + BigInt(day.seedRaw)).toString(),
    rows: rows.slice(0, 10).map(clone)
  };
}

function formatDayRow(row) {
  return normalizeDay({
    day: row.day_key, dayId: Number(row.day_id), snapshotAt: Number(row.snapshot_at_ms),
    feeRaw: String(row.fee_raw), seedRaw: String(row.seed_raw), seedCapRaw: String(row.seed_cap_raw),
    deterministicSeed: row.deterministic_seed, transcriptVersion: row.transcript_version,
    status: row.status, chainStatus: Number(row.chain_status),
    configurationState: row.configuration_state,
    entryPoolRaw: String(row.entry_pool_raw), entryCount: Number(row.entry_count),
    createdAt: Number(row.created_at_ms), finalizedAt: Number(row.finalized_at_ms)
  });
}

function formatEntryRow(row) {
  return normalizeEntry({
    entryId: row.entry_id, paymentKey: row.payment_key, transactionHash: row.transaction_hash,
    logIndex: Number(row.log_index), blockNumber: String(row.block_number), day: row.day_key,
    address: row.address, amountRaw: String(row.amount_raw), confirmedAt: Number(row.confirmed_at_ms),
    consumedAt: Number(row.consumed_at_ms), runId: row.run_id
  });
}

function formatRunRow(row) {
  return normalizeRun({
    runId: row.run_id, entryId: row.entry_id, day: row.day_key, address: row.address,
    entryTransactionHash: row.entry_transaction_hash, tokenHash: row.token_hash,
    receiptSignature: row.receipt_signature, status: row.status,
    startedAt: Number(row.started_at_ms), expiresAt: Number(row.expires_at_ms),
    finishedAt: Number(row.finished_at_ms), throughSeq: Number(row.through_seq),
    throughTick: Number(row.through_tick), transcriptHash: row.transcript_hash,
    checkpointSignature: row.checkpoint_signature,
    tuning: typeof row.tuning === 'string' ? JSON.parse(row.tuning) : row.tuning,
    result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result
  });
}

function formatScoreRow(row) {
  return {
    ...(row.rank ? { rank: Number(row.rank) } : {}),
    day: row.day_key || row.day,
    address: String(row.address).toLowerCase(),
    runId: row.run_id,
    score: Number(row.score),
    depth: Number(row.depth),
    guardianTimeMs: Number(row.guardian_time_ms),
    damageTaken: Number(row.damage_taken),
    elapsedMs: Number(row.elapsed_ms),
    entryTransactionHash: row.entry_transaction_hash,
    finishedAt: Number(row.finished_at_ms),
    entries: Number(row.entry_count || row.entries || 0)
  };
}

function formatSnapshot(row, entries) {
  return {
    day: row.day_key,
    status: row.status || 'finalized',
    finalized: true,
    finalizedAt: Number(row.finalized_at_ms),
    participantCount: Number(row.participant_count),
    entryCount: Number(row.entry_count),
    entryPoolRaw: String(row.entry_pool_raw),
    seedRaw: String(row.seed_raw),
    prizePoolRaw: String(row.prize_pool_raw),
    rows: entries.map(formatScoreRow)
  };
}

function rawAmount(value, allowZero, code) {
  try {
    const parsed = BigInt(value);
    assertApi(allowZero ? parsed >= 0n : parsed > 0n, 400, code, 'A raw MATT amount is outside the supported range.');
    assertApi(parsed < 10n ** 78n, 400, code, 'A raw MATT amount is outside the supported range.');
    return parsed.toString();
  } catch (error) {
    if (error?.code) throw error;
    throw new ApiError(400, code, 'Enter a raw MATT amount as an integer string.');
  }
}

function safeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function safeChainStatus(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 3 ? number : 0;
}

function dayEndMs(day) {
  return Date.parse(`${day}T00:00:00.000Z`) + DAY_MS;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
