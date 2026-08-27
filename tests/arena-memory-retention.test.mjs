import test from 'node:test';
import assert from 'node:assert/strict';

import { PostgresDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { defaultServerState, defaultWalletState, normalizeServerState } from '../server/state.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const TOKEN_HASH = 'a'.repeat(64);

test('archived legacy runs discard duplicated mine snapshots while active runs remain resumable', () => {
  const oversizedSnapshot = { id: 'snapshot_arena_large', depths: [{ map: { cells: 'x'.repeat(250_000) } }] };
  const baseRun = {
    id: 'run_111111111111111111111111',
    tokenHash: TOKEN_HASH,
    address: ADDRESS,
    mode: 'paid',
    seed: 'seed',
    day: '2026-08-02',
    week: '2026-07-27',
    startedAt: 1,
    expiresAt: 2,
    characterId: 'matt',
    competitionSlotId: 'pass',
    competitionSnapshot: oversizedSnapshot,
    tuning: { _competitionSnapshot: oversizedSnapshot },
    playerProfile: { meta: { armor: 20 } }
  };
  const state = normalizeServerState({
    runs: {
      active: { ...baseRun, id: 'run_222222222222222222222222', status: 'active' },
      finished: {
        ...baseRun,
        status: 'finished',
        finishedAt: 3,
        result: { score: 100, extracted: true }
      }
    }
  });

  assert.equal(state.runs.active.tuning._competitionSnapshot.depths[0].map.cells.length, 250_000);
  assert.equal(state.runs.finished.tuning, undefined);
  assert.equal(state.runs.finished.playerProfile, undefined);
  assert.deepEqual(state.runs.finished.competitionSnapshot, { id: 'snapshot_arena_large' });
  assert.deepEqual(state.runs.finished.result, { score: 100, extracted: true });
  assert.ok(JSON.stringify(state.runs.finished).length < 2_000);
});

test('Arena authentication reads only its session, wallet, and operations from PostgreSQL', async () => {
  const wallet = defaultWalletState(ADDRESS, 1);
  const session = {
    tokenHash: TOKEN_HASH,
    address: ADDRESS,
    type: 'player',
    createdAt: 1,
    expiresAt: 99_999
  };
  const operations = defaultServerState().operations;
  const queries = [];
  const pool = {
    async query(sql, params) {
      queries.push({ sql, params });
      assert.doesNotMatch(sql, /^SELECT data FROM matt_mine_state/i);
      return { rows: [{ session, wallet, operations }] };
    },
    async end() {}
  };
  const database = new PostgresDatabase(null, { pool, normalizedMigrationsEnabled: false });
  database.initialized = true;

  const state = await database.readArenaPlayerState(TOKEN_HASH);

  assert.equal(state.sessions[TOKEN_HASH].address, ADDRESS);
  assert.equal(state.wallets[ADDRESS].address, ADDRESS);
  assert.deepEqual(state.operations, operations);
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /data->'sessions'->\$1/);
  await database.close();
});

test('public mine projection includes live Endless entry configuration and operations', async () => {
  const source = defaultServerState();
  source.endlessCompetition.operations.newEntriesEnabled = false;
  source.endlessCompetition.configVersions[1].config.entry = {
    ...source.endlessCompetition.configVersions[1].config.entry,
    paidEnabled: true,
    mattPrice: 2_500_000
  };
  const queries = [];
  const pool = {
    async query(sql) {
      queries.push(sql);
      return { rows: [{
        competition_studio: source.competitionStudio,
        operations: source.operations,
        endless_competition: source.endlessCompetition,
        wallets: source.wallets
      }] };
    },
    async end() {}
  };
  const database = new PostgresDatabase(null, { pool, normalizedMigrationsEnabled: false });
  database.initialized = true;
  const state = await database.readPublicMineState();
  assert.equal(state.endlessCompetition.operations.newEntriesEnabled, false);
  assert.equal(state.endlessCompetition.configVersions[1].config.entry.mattPrice, 2_500_000);
  assert.match(queries[0], /data->'endlessCompetition'/);
  await database.close();
});

test('concurrent Arena leaderboard requests share one database and chain snapshot', async () => {
  let stateReads = 0;
  let leaderboardReads = 0;
  const database = {
    async readPublicMineState() {
      stateReads += 1;
      return normalizeServerState({});
    }
  };
  const arenaService = {
    async leaderboard() {
      leaderboardReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { day: '2026-08-02', rows: [] };
    }
  };
  const service = new MattMineService(database, { arenaService });

  const results = await Promise.all(Array.from({ length: 30 }, () => service.arenaLeaderboard('2026-08-02')));

  assert.equal(results.length, 30);
  assert.equal(stateReads, 1);
  assert.equal(leaderboardReads, 1);
  assert.notEqual(results[0], results[1]);
});
