import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PostgresDatabase } from '../server/database.js';
import { SERVER_STATE_VERSION } from '../server/constants.js';
import {
  isTransientPostgresError,
  retryTransientPostgres
} from '../server/postgres-resilience.js';
import { defaultServerState, defaultWalletState } from '../server/state.js';

const START = Date.UTC(2026, 6, 25, 12, 0, 0);
const ADDRESS = '0x1111111111111111111111111111111111111111';
const OTHER_ADDRESS = '0x2222222222222222222222222222222222222222';
const SUSPENDED_ADDRESS = '0x3333333333333333333333333333333333333333';

test('idle PostgreSQL connection errors are reported without crashing the server', async () => {
  const pool = new EventEmitter();
  const reported = [];
  const database = new PostgresDatabase(null, {
    pool,
    onPoolError(error) {
      reported.push(error.message);
      throw new Error('simulated telemetry outage');
    }
  });

  assert.doesNotThrow(() => {
    pool.emit('error', new Error('Connection terminated unexpectedly'));
  });
  assert.deepEqual(reported, ['Connection terminated unexpectedly']);

  await database.close();
  assert.equal(pool.listenerCount('error'), 0);
});

test('checked-out PostgreSQL client errors are guarded and never become uncaught events', async () => {
  const pool = new EventEmitter();
  const client = new EventEmitter();
  const reported = [];
  const database = new PostgresDatabase(null, {
    pool,
    onPoolError(error) {
      reported.push(error.message);
    }
  });

  pool.emit('connect', client);
  assert.doesNotThrow(() => {
    client.emit('error', new Error('Connection terminated unexpectedly'));
  });
  assert.deepEqual(reported, ['Connection terminated unexpectedly']);
  client.emit('end');
  assert.equal(client.listenerCount('error'), 0);

  await database.close();
  assert.equal(pool.listenerCount('connect'), 0);
  assert.equal(client.listenerCount('error'), 0);
});

test('PostgreSQL recovery failures retry reads but never retry non-transient errors', async () => {
  let attempts = 0;
  const delays = [];
  const result = await retryTransientPostgres(async () => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('the database system is in recovery mode');
      error.code = '57P03';
      throw error;
    }
    return 'recovered';
  }, {
    maxAttempts: 4,
    baseDelayMs: 10,
    sleep: async (delayMs) => delays.push(delayMs)
  });

  assert.equal(result, 'recovered');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(isTransientPostgresError({ code: '57P03' }), true);
  assert.equal(isTransientPostgresError(new Error('bad SQL syntax')), false);
});

test('PostgreSQL startup retries an interrupted recovery without replacing server state', async () => {
  let initializationAttempts = 0;
  const pool = createRecordingPool({
    handler(normalized) {
      if (normalized.startsWith('CREATE TABLE IF NOT EXISTS MATT_MINE_STATE')) {
        initializationAttempts += 1;
        if (initializationAttempts === 1) {
          const error = new Error('the database system is in recovery mode');
          error.code = '57P03';
          throw error;
        }
      }
      return undefined;
    }
  });
  const database = await new PostgresDatabase(null, {
    pool,
    startupRetryAttempts: 3,
    retryBaseDelayMs: 0,
    retrySleep: async () => undefined
  }).init();

  assert.equal(initializationAttempts, 2);
  assert.equal((await database.read()).version, SERVER_STATE_VERSION);
});

test('PostgreSQL initialization migrates legacy finished runs into normalized run and score tables', async () => {
  const legacyRunId = `run_${'a'.repeat(24)}`;
  const state = defaultServerState();
  state.wallets[ADDRESS] = defaultWalletState(ADDRESS, START);
  state.runs[legacyRunId] = finishedRun({
    id: legacyRunId,
    address: ADDRESS,
    score: 1_250
  });
  state.runs.corrupt = { id: 'bad-run', status: 'finished', result: { score: 99_999 } };
  const recordedRuns = [];
  const recordedDailyScores = [];
  const pool = createRecordingPool({
    state,
    handler(normalized, params) {
      if (normalized.startsWith('INSERT INTO MATT_MINE_RUNS')) {
        recordedRuns.push(params);
        return { rows: [] };
      }
      if (normalized.startsWith('INSERT INTO MATT_MINE_DAILY_SCORES')) {
        recordedDailyScores.push(params);
        return { rows: [] };
      }
      return undefined;
    }
  });

  const database = await new PostgresDatabase(null, {
    pool,
    now: () => START
  }).init();
  const persisted = await database.read();

  assert.equal(recordedRuns.length, 1);
  assert.equal(recordedRuns[0][0], legacyRunId);
  assert.equal(recordedRuns[0][2], ADDRESS);
  assert.equal(recordedRuns[0][14], 1_250);
  assert.equal(recordedDailyScores.length, 1);
  assert.deepEqual(recordedDailyScores[0].slice(0, 5), [
    '2026-07-20',
    '2026-07-25',
    'free',
    ADDRESS,
    1_250
  ]);
  assert.equal(persisted.runs[legacyRunId].result.score, 1_250);
  assert.equal(persisted.runs.corrupt.id, 'bad-run');
  assert.equal(persisted.version, SERVER_STATE_VERSION);
  assert.equal(
    pool.queries.some(({ normalized }) =>
      normalized.includes('CREATE TABLE IF NOT EXISTS MATT_MINE_WEEKLY_SNAPSHOT_ENTRIES')
    ),
    true
  );
  const dailyUpsert = pool.queries.find(({ normalized }) =>
    normalized.startsWith('INSERT INTO MATT_MINE_DAILY_SCORES')
  );
  assert.match(dailyUpsert.normalized, /EXCLUDED\.BEST_SCORE > MATT_MINE_DAILY_SCORES\.BEST_SCORE/);
});

test('closed weekly leaderboards are snapshotted once and read from immutable snapshot rows', async () => {
  const state = defaultServerState();
  state.wallets[SUSPENDED_ADDRESS] = {
    ...defaultWalletState(SUSPENDED_ADDRESS, START),
    suspended: true
  };
  let snapshotCreated = false;
  let snapshotEntryWrites = 0;
  const pool = createRecordingPool({
    state,
    handler(normalized, params) {
      if (normalized.startsWith('SELECT DISTINCT WEEK_KEY, MODE FROM MATT_MINE_WEEKLY_SCORES')) {
        return { rows: [{ week_key: '2026-07-13', mode: 'free' }] };
      }
      if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SNAPSHOTS')) {
        assert.deepEqual(params.slice(0, 3), [
          '2026-07-13',
          'free',
          [SUSPENDED_ADDRESS]
        ]);
        if (snapshotCreated) return { rows: [] };
        snapshotCreated = true;
        return { rows: [{ week_key: '2026-07-13' }] };
      }
      if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SNAPSHOT_ENTRIES')) {
        snapshotEntryWrites += 1;
        assert.deepEqual(params[2], [SUSPENDED_ADDRESS]);
        return { rows: [] };
      }
      if (normalized.startsWith('SELECT FINALIZED_AT, PARTICIPANT_COUNT')) {
        return {
          rows: [{
            finalized_at: '2026-07-20T00:00:00.000Z',
            participant_count: 2,
            total_score: '4200',
            run_count: '9'
          }]
        };
      }
      if (
        normalized.startsWith('SELECT RANK, ADDRESS, SCORE') &&
        normalized.includes('RANK <= 100')
      ) {
        return {
          rows: [
            { rank: 1, address: ADDRESS, score: '2500' },
            { rank: 2, address: OTHER_ADDRESS, score: '1700' }
          ]
        };
      }
      if (
        normalized.startsWith('SELECT RANK, SCORE') &&
        normalized.includes('MATT_MINE_WEEKLY_SNAPSHOT_ENTRIES')
      ) {
        return { rows: [{ rank: 2, score: '1700' }] };
      }
      return undefined;
    }
  });
  const database = await new PostgresDatabase(null, {
    pool,
    now: () => START
  }).init();

  await database.finalizeLeaderboards(
    '2026-07-20',
    [SUSPENDED_ADDRESS],
    START
  );
  const leaderboard = await database.leaderboard(
    'free',
    '2026-07-13',
    OTHER_ADDRESS,
    { suspendedAddresses: [SUSPENDED_ADDRESS] }
  );

  assert.equal(snapshotEntryWrites, 1);
  assert.equal(leaderboard.finalized, true);
  assert.equal(leaderboard.finalizedAt, '2026-07-20T00:00:00.000Z');
  assert.equal(leaderboard.participantCount, 2);
  assert.equal(leaderboard.totalScore, 4_200);
  assert.equal(leaderboard.runCount, 9);
  assert.equal(leaderboard.playerRank, 2);
  assert.equal(leaderboard.playerScore, 1_700);
  assert.deepEqual(leaderboard.rows.map((row) => row.walletId), [
    '0x1111…1111',
    '0x2222…2222'
  ]);
});

test('weekly snapshots finalize immediately after the leaderboard timer reaches zero', async () => {
  const oneHourAfterWeekClose = Date.UTC(2026, 6, 20, 1, 0, 0);
  let snapshotWrites = 0;
  let snapshotEntryWrites = 0;
  const pool = createRecordingPool({
    handler(normalized) {
      if (normalized.startsWith('SELECT DISTINCT WEEK_KEY, MODE FROM MATT_MINE_WEEKLY_SCORES')) {
        return { rows: [{ week_key: '2026-07-13', mode: 'paid' }] };
      }
      if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SNAPSHOTS')) {
        snapshotWrites += 1;
        return { rows: [{ week_key: '2026-07-13' }] };
      }
      if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SNAPSHOT_ENTRIES')) {
        snapshotEntryWrites += 1;
        return { rows: [] };
      }
      return undefined;
    }
  });

  await new PostgresDatabase(null, {
    pool,
    now: () => oneHourAfterWeekClose
  }).init();

  assert.equal(snapshotWrites, 1);
  assert.equal(snapshotEntryWrites, 1);
});

test('live normalized leaderboards return top rows, player rank, and wallet weekly totals', async () => {
  const pool = createRecordingPool({
    handler(normalized, params) {
      if (normalized.startsWith('SELECT FINALIZED_AT, PARTICIPANT_COUNT')) {
        return { rows: [] };
      }
      if (normalized.startsWith('WITH RANKED AS') && normalized.includes('RANK <= 100')) {
        assert.deepEqual(params[2], [SUSPENDED_ADDRESS]);
        return {
          rows: [
            { rank: 1, address: ADDRESS, score: '9000' },
            { rank: 2, address: OTHER_ADDRESS, score: '7500' }
          ]
        };
      }
      if (normalized.startsWith('WITH RANKED AS') && normalized.includes('WHERE ADDRESS = $4')) {
        return { rows: [{ rank: 2, score: '7500' }] };
      }
      if (normalized.startsWith('SELECT MODE, WEEKLY_SCORE')) {
        return {
          rows: [
            { mode: 'free', weekly_score: '7500' },
            { mode: 'paid', weekly_score: '12000' }
          ]
        };
      }
      if (normalized.startsWith('SELECT COUNT(*)::INTEGER AS PARTICIPANT_COUNT')) {
        return {
          rows: [{
            participant_count: 2,
            total_score: '16500',
            run_count: '12'
          }]
        };
      }
      return undefined;
    }
  });
  const database = await new PostgresDatabase(null, {
    pool,
    now: () => START
  }).init();

  const leaderboard = await database.leaderboard(
    'free',
    '2026-07-20',
    OTHER_ADDRESS,
    { suspendedAddresses: [SUSPENDED_ADDRESS] }
  );
  const scores = await database.playerScores(OTHER_ADDRESS, '2026-07-20');

  assert.equal(leaderboard.finalized, false);
  assert.equal(leaderboard.playerRank, 2);
  assert.equal(leaderboard.playerScore, 7_500);
  assert.equal(leaderboard.participantCount, 2);
  assert.equal(leaderboard.totalScore, 16_500);
  assert.equal(leaderboard.runCount, 12);
  assert.deepEqual(scores, { free: 7_500, paid: 12_000 });
});

function finishedRun({
  id,
  address,
  mode = 'free',
  day = '2026-07-25',
  week = '2026-07-20',
  score
}) {
  return {
    id,
    tokenHash: 'a'.repeat(64),
    address,
    mode,
    seed: `MATT-MINE-${day}-${mode.toUpperCase()}`,
    day,
    week,
    status: 'finished',
    startedAt: START - 60_000,
    expiresAt: START + 2_640_000,
    finishedAt: START,
    result: {
      extracted: true,
      projected: score,
      banked: score,
      score,
      depth: 2,
      kills: 12,
      oreBroken: 8,
      elapsed: 60
    }
  };
}

function createRecordingPool(options = {}) {
  let data = structuredClone(options.state || defaultServerState());
  const transactionLog = [];
  const queries = [];

  async function query(sql, params = []) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
    queries.push({ normalized, params: structuredClone(params) });
    const handled = options.handler?.(normalized, params);
    if (handled !== undefined) return handled;
    if (
      normalized.startsWith('CREATE TABLE')
      || normalized.startsWith('CREATE INDEX')
      || normalized.startsWith('DO $$')
    ) {
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO MATT_MINE_STATE')) {
      if (!data) data = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (normalized.startsWith('SELECT DATA FROM MATT_MINE_STATE')) {
      return { rows: [{ data: structuredClone(data) }] };
    }
    if (normalized.startsWith('UPDATE MATT_MINE_STATE')) {
      data = JSON.parse(params[0]);
      return { rows: [] };
    }
    if (normalized.startsWith('INSERT INTO MATT_MINE_WEEKLY_SCORES')) return { rows: [] };
    if (normalized.startsWith('SELECT DISTINCT WEEK_KEY, MODE FROM MATT_MINE_WEEKLY_SCORES')) {
      return { rows: [] };
    }
    if (normalized === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) {
      transactionLog.push(normalized);
      return { rows: [] };
    }
    throw new Error(`Unexpected fake PostgreSQL query: ${normalized}`);
  }

  return {
    queries,
    transactionLog,
    query,
    async connect() {
      return { query, release() {} };
    },
    async end() {}
  };
}
