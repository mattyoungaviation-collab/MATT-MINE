import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import pg from 'pg';
import { defaultServerState, normalizeServerState } from './state.js';

const { Pool } = pg;

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
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS matt_mine_state (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(
      `INSERT INTO matt_mine_state (id, data)
       VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(defaultServerState())]
    );
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
      const result = await mutator(draft);
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
