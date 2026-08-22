import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PostgresDatabase } from '../server/database.js';

function singleConnectionPool(queryLog = [], options = {}) {
  const events = new EventEmitter();
  let inUse = false;
  const client = {
    async query(sql, params) {
      queryLog.push({ sql, params });
      if (options.failPattern?.test(sql)) throw options.failure;
      return { rows: [] };
    },
    release(error) {
      options.releaseErrors?.push(error);
      inUse = false;
    }
  };

  return {
    async connect() {
      if (inUse) throw new Error('single-connection pool exhausted');
      inUse = true;
      return client;
    },
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events)
  };
}

test('Postgres NFT lifecycle locks never consume the normal request pool', async () => {
  const mainPool = singleConnectionPool();
  const lockQueries = [];
  const lockPool = singleConnectionPool(lockQueries);
  const database = new PostgresDatabase(null, {
    pool: mainPool,
    nftLifecycleLockPool: lockPool,
    normalizedMigrationsEnabled: false
  });
  database.initialized = true;

  const result = await database.withNftLifecycleStart(async () => {
    const requestClient = await mainPool.connect();
    requestClient.release();
    return 'started';
  });

  assert.equal(result, 'started');
  assert.equal(lockQueries.length, 2);
  assert.match(lockQueries[0].sql, /pg_advisory_lock_shared/);
  assert.match(lockQueries[1].sql, /pg_advisory_unlock_shared/);
});

test('Postgres discards a lifecycle connection when advisory unlock fails', async () => {
  const unlockError = new Error('database connection dropped during unlock');
  const releaseErrors = [];
  const database = new PostgresDatabase(null, {
    pool: singleConnectionPool(),
    nftLifecycleLockPool: singleConnectionPool([], {
      failPattern: /pg_advisory_unlock/,
      failure: unlockError,
      releaseErrors
    }),
    normalizedMigrationsEnabled: false
  });
  database.initialized = true;

  await assert.rejects(
    () => database.withNftLifecycleMutation(async () => 'updated'),
    unlockError
  );
  assert.equal(releaseErrors.length, 1);
  assert.equal(releaseErrors[0], unlockError);
});
