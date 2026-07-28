import { assertApi } from './errors.js';

export class MemoryCompetitiveReplayStore {
  constructor() {
    this.kind = 'memory';
    this.runs = new Map();
    this.events = new Map();
    this.queue = Promise.resolve();
  }

  async init() { return this; }
  async close() {}
  async healthCheck() { return { ok: true, kind: this.kind }; }

  async createRun(run) {
    return this.#mutate(() => {
      const existing = this.runs.get(run.runId);
      if (existing) return clone(existing);
      this.runs.set(run.runId, clone(run));
      this.events.set(run.runId, []);
      return clone(run);
    });
  }

  async getRun(runId) {
    await this.queue;
    return clone(this.runs.get(runId) || null);
  }

  async getEvents(runId) {
    await this.queue;
    return clone(this.events.get(runId) || []);
  }

  async appendEvents(runId, expectedSequence, events, patch) {
    return this.#mutate(() => {
      const run = this.runs.get(runId);
      assertApi(run, 404, 'competitive_transcript_missing', 'The competitive transcript was not found.');
      assertApi(run.status === 'active', 409, 'competitive_transcript_closed', 'The competitive transcript is closed.');
      assertApi(run.throughSeq === expectedSequence, 409, 'competitive_checkpoint_stale', 'The competitive checkpoint is stale.');
      const stored = this.events.get(runId) || [];
      stored.push(...clone(events));
      this.events.set(runId, stored);
      Object.assign(run, clone(patch));
      return clone(run);
    });
  }

  async closeRun(runId, status = 'finished') {
    return this.#mutate(() => {
      const run = this.runs.get(runId);
      if (run) run.status = status;
      return clone(run || null);
    });
  }

  #mutate(operation) {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export class PostgresCompetitiveReplayStore {
  constructor(database) {
    assertApi(database?.pool, 500, 'competitive_store_pool_missing', 'PostgreSQL is required for the competitive replay store.');
    this.kind = 'postgresql';
    this.pool = database.pool;
  }

  async init() {
    await this.pool.query(`
      CREATE SCHEMA IF NOT EXISTS matt_mine_competitive;
      CREATE TABLE IF NOT EXISTS matt_mine_competitive.runs (
        run_id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        mode TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at_ms BIGINT NOT NULL,
        expires_at_ms BIGINT NOT NULL,
        through_seq INTEGER NOT NULL DEFAULT 0,
        through_tick INTEGER NOT NULL DEFAULT 0,
        transcript_hash TEXT NOT NULL,
        checkpoint_signature TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS competitive_runs_address_status
        ON matt_mine_competitive.runs(address,status);
      CREATE TABLE IF NOT EXISTS matt_mine_competitive.events (
        run_id TEXT NOT NULL REFERENCES matt_mine_competitive.runs(run_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        event_json JSONB NOT NULL,
        event_hash TEXT NOT NULL,
        received_at_ms BIGINT NOT NULL,
        PRIMARY KEY(run_id,seq)
      );
    `);
    return this;
  }

  async close() {}
  async healthCheck() {
    await this.pool.query('SELECT 1 FROM matt_mine_competitive.runs LIMIT 1');
    return { ok: true, kind: this.kind };
  }

  async createRun(run) {
    await this.pool.query(
      `INSERT INTO matt_mine_competitive.runs (
         run_id,address,mode,token_hash,status,started_at_ms,expires_at_ms,
         through_seq,through_tick,transcript_hash,checkpoint_signature
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(run_id) DO NOTHING`,
      [run.runId, run.address, run.mode, run.tokenHash, run.status, run.startedAt,
        run.expiresAt, run.throughSeq, run.throughTick, run.transcriptHash,
        run.checkpointSignature]
    );
    return this.getRun(run.runId);
  }

  async getRun(runId) {
    const result = await this.pool.query(
      'SELECT * FROM matt_mine_competitive.runs WHERE run_id=$1',
      [runId]
    );
    return result.rows[0] ? formatRun(result.rows[0]) : null;
  }

  async getEvents(runId) {
    const result = await this.pool.query(
      'SELECT event_json FROM matt_mine_competitive.events WHERE run_id=$1 ORDER BY seq',
      [runId]
    );
    return result.rows.map((row) => (
      typeof row.event_json === 'string' ? JSON.parse(row.event_json) : row.event_json
    ));
  }

  async appendEvents(runId, expectedSequence, events, patch) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        'SELECT * FROM matt_mine_competitive.runs WHERE run_id=$1 FOR UPDATE',
        [runId]
      );
      assertApi(selected.rows[0], 404, 'competitive_transcript_missing', 'The competitive transcript was not found.');
      const run = formatRun(selected.rows[0]);
      assertApi(run.status === 'active', 409, 'competitive_transcript_closed', 'The competitive transcript is closed.');
      assertApi(run.throughSeq === expectedSequence, 409, 'competitive_checkpoint_stale', 'The competitive checkpoint is stale.');
      for (const event of events) {
        await client.query(
          `INSERT INTO matt_mine_competitive.events
           (run_id,seq,tick,event_json,event_hash,received_at_ms)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
          [runId, event.seq, event.tick, JSON.stringify(event), event.eventHash, event.receivedAt]
        );
      }
      await client.query(
        `UPDATE matt_mine_competitive.runs SET
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

  async closeRun(runId, status = 'finished') {
    await this.pool.query(
      `UPDATE matt_mine_competitive.runs SET status=$2
       WHERE run_id=$1 AND status='active'`,
      [runId, status]
    );
    return this.getRun(runId);
  }
}

function formatRun(row) {
  return {
    runId: row.run_id,
    address: row.address,
    mode: row.mode,
    tokenHash: row.token_hash,
    status: row.status,
    startedAt: Number(row.started_at_ms),
    expiresAt: Number(row.expires_at_ms),
    throughSeq: Number(row.through_seq),
    throughTick: Number(row.through_tick),
    transcriptHash: row.transcript_hash,
    checkpointSignature: row.checkpoint_signature
  };
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}
