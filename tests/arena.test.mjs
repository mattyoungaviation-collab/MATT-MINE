import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData
} from 'viem';
import {
  ARENA_EVENT_TYPES,
  ARENA_TRANSCRIPT_VERSION,
  buildArenaChallenge,
  hashArenaEvent,
  replayArenaTranscript
} from '../server/arena-engine.js';
import {
  ARENA_SETTLEMENT_ABI,
  ARENA_WINNER_WEIGHTS_BPS,
  allocateArenaPool,
  compareArenaScores,
  createArenaSettlementDraft
} from '../server/arena-settlement.js';
import {
  ARENA_SEED_CAP_RAW,
  MemoryArenaStore,
  PostgresArenaStore,
  createArenaPostgresSchema
} from '../server/arena-store.js';
import {
  ARENA_ERC20_ABI,
  DAILY_ARENA_ABI,
  RoninArenaChain
} from '../server/arena-chain.js';
import {
  ARENA_REPLAY_READY,
  DailyArenaService
} from '../server/arena-service.js';
import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';

const DAY = '2026-07-25';
const NEXT_DAY = '2026-07-26';
const FEE_RAW = (25_000n * 10n ** 18n).toString();
const PLAYER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ARENA = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const SAFE = '0x5555555555555555555555555555555555555555';
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

test('Daily Arena payout weights are the exact requested top-ten schedule', () => {
  assert.deepEqual(ARENA_WINNER_WEIGHTS_BPS, [
    3_000, 1_800, 1_200, 800, 700, 600, 550, 500, 450, 400
  ]);
  assert.equal(ARENA_WINNER_WEIGHTS_BPS.reduce((sum, value) => sum + value, 0), 10_000);
  const pool = 100_000n;
  const entries = Array.from({ length: 10 }, (_, index) => ({
    address: address(index + 1),
    score: 100 - index
  }));
  const allocations = allocateArenaPool(pool, entries);
  assert.deepEqual(allocations.map((entry) => BigInt(entry.amountRaw)), [
    30_000n, 18_000n, 12_000n, 8_000n, 7_000n,
    6_000n, 5_500n, 5_000n, 4_500n, 4_000n
  ]);
});

test('fewer winners are normalized and every raw-unit remainder goes to rank one', () => {
  const allocations = allocateArenaPool(101n, [
    { address: PLAYER, score: 2 },
    { address: OTHER, score: 1 }
  ]);
  assert.equal(allocations[0].amountRaw, '64');
  assert.equal(allocations[1].amountRaw, '37');
  assert.equal(allocations.reduce((sum, entry) => sum + BigInt(entry.amountRaw), 0n), 101n);
});

test('Arena tie sorting follows all six fields in the specified order', () => {
  const baseline = score({ entryTransactionHash: HASH_B });
  const cases = [
    score({ score: baseline.score + 1 }),
    score({ depth: baseline.depth + 1 }),
    score({ guardianTimeMs: baseline.guardianTimeMs - 1 }),
    score({ damageTaken: baseline.damageTaken - 1 }),
    score({ elapsedMs: baseline.elapsedMs - 1 }),
    score({ entryTransactionHash: HASH_A })
  ];
  for (const winner of cases) {
    const sorted = [baseline, winner].sort(compareArenaScores);
    assert.equal(sorted[0], winner);
  }
});

test('daily encounter manifests are deterministic and day-seed-specific', () => {
  const first = buildArenaChallenge('a'.repeat(64));
  const again = buildArenaChallenge('a'.repeat(64));
  const different = buildArenaChallenge('b'.repeat(64));
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, different);
  assert.equal(first.version, ARENA_TRANSCRIPT_VERSION);
  assert.equal(first.depths.length, 5);
});

test('preview replay derives the score from stored events and never accepts a summary', () => {
  const challenge = buildArenaChallenge('c'.repeat(64));
  const events = [
    { seq: 1, tick: 150, type: 'ore_broken', targetId: 11 },
    { seq: 2, tick: 300, type: 'ore_broken', targetId: 12 },
    { seq: 3, tick: 450, type: 'ore_broken', targetId: 13 },
    { seq: 4, tick: 600, type: 'enemy_killed', targetId: 20 },
    { seq: 5, tick: 750, type: 'damage_taken', amount: 4.4 },
    { seq: 6, tick: 900, type: 'guardian_defeated', targetId: 99 },
    { seq: 7, tick: 1_050, type: 'extract' }
  ];
  const result = replayArenaTranscript(challenge, events, { requireTerminal: true });
  const expected = challenge.depths[0].ores.slice(0, 3).reduce((sum, ore) => sum + ore.value, 0) +
    challenge.depths[0].enemies[0].value +
    challenge.depths[0].guardian.value;
  assert.equal(result.score, expected);
  assert.equal(result.projected, expected);
  assert.equal(result.extracted, true);
  assert.equal(result.damageTaken, 4);
  assert.equal(result.elapsedMs, 1_050);
});

test('preview replay rejects duplicated targets, impossible clocks, and post-terminal events', () => {
  const challenge = buildArenaChallenge('d'.repeat(64));
  assert.throws(
    () => replayArenaTranscript(challenge, [
      { seq: 1, tick: 100, type: 'ore_broken', targetId: 1 },
      { seq: 2, tick: 250, type: 'enemy_killed', targetId: 1 }
    ]),
    (error) => error.code === 'arena_target_reused'
  );
  assert.throws(
    () => replayArenaTranscript(challenge, [
      { seq: 1, tick: 100, type: 'knockout' },
      { seq: 2, tick: 250, type: 'damage_taken', amount: 1 }
    ]),
    (error) => error.code === 'arena_event_after_terminal'
  );
  assert.throws(
    () => replayArenaTranscript(challenge, [
      { seq: 1, tick: 2_000_000, type: 'knockout' }
    ]),
    (error) => error.code === 'arena_event_field_invalid'
  );
});

test('transcript hashes bind ordering and normalized event contents', () => {
  const start = 'e'.repeat(64);
  const event = { seq: 1, tick: 100, type: 'knockout' };
  const first = hashArenaEvent(start, event);
  assert.equal(first, hashArenaEvent(start, event));
  assert.notEqual(first, hashArenaEvent(start, { ...event, tick: 101 }));
});

test('Memory Arena storage confirms unlimited one-payment attempts idempotently', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.reconcileDay(DAY, {
    entryPoolRaw: (30n * BigInt(FEE_RAW)).toString(),
    seedRaw: '0',
    entryCount: 30
  });
  for (let index = 0; index < 30; index += 1) {
    const hash = `0x${index.toString(16).padStart(64, '0')}`;
    const stored = await store.confirmEntry(entryRecord(index, hash));
    assert.equal(stored.alreadyConfirmed, false);
  }
  const retry = await store.confirmEntry(entryRecord(0, `0x${'0'.repeat(64)}`));
  assert.equal(retry.alreadyConfirmed, true);
  assert.equal((await store.unusedEntries(PLAYER, DAY)).length, 30);
  assert.equal((await store.getDay(DAY)).entryPoolRaw, (30n * BigInt(FEE_RAW)).toString());
});

test('a confirmed payment cannot be replayed by another wallet', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.confirmEntry(entryRecord(1, HASH_A));
  await assert.rejects(
    () => store.confirmEntry({ ...entryRecord(1, HASH_A), address: OTHER }),
    (error) => error.code === 'arena_payment_already_owned'
  );
});

test('each entry is consumed once and only the wallet best run ranks', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.reconcileDay(DAY, {
    entryPoolRaw: (2n * BigInt(FEE_RAW)).toString(),
    seedRaw: '100',
    entryCount: 2
  });
  await store.confirmEntry(entryRecord(1, HASH_A));
  await store.confirmEntry(entryRecord(2, HASH_B));
  await store.consumeEntry(PLAYER, DAY, 'arena_entry_1', runRecord('arena_run_1', 1_000));
  await store.finishRun('arena_run_1', replayResult({ score: 100 }), 2_000);
  await store.consumeEntry(PLAYER, DAY, 'arena_entry_2', runRecord('arena_run_2', 3_000));
  await store.finishRun('arena_run_2', replayResult({ score: 200 }), 4_000);
  const status = await store.playerStatus(PLAYER, DAY);
  assert.equal(status.confirmedEntries, 2);
  assert.equal(status.unusedAttempts, 0);
  assert.equal(status.best.score, 200);
  const board = await store.leaderboard(DAY, [], Date.parse(`${DAY}T12:00:00Z`));
  assert.equal(board.rows.length, 1);
  assert.equal(board.rows[0].runId, 'arena_run_2');
  assert.equal(board.prizePoolRaw, (2n * BigInt(FEE_RAW) + 100n).toString());
});

test('post-midnight leaderboard reads stay provisional until settlement finalizes the moderated snapshot', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  for (const [index, wallet, hash, points] of [
    [1, PLAYER, HASH_A, 500],
    [2, OTHER, HASH_B, 400]
  ]) {
    await store.confirmEntry({ ...entryRecord(index, hash), address: wallet });
    await store.consumeEntry(wallet, DAY, `arena_entry_${index}`, {
      ...runRecord(`arena_run_${index}`, 1_000 + index),
      address: wallet
    });
    await store.finishRun(`arena_run_${index}`, replayResult({ score: points }), 2_000 + index);
  }
  const closedAt = Date.parse(`${NEXT_DAY}T00:00:01Z`);
  const provisional = await store.leaderboard(DAY, [PLAYER], closedAt);
  assert.equal(provisional.status, 'closed');
  assert.equal(provisional.closed, true);
  assert.equal(provisional.provisional, true);
  assert.equal(provisional.finalized, false);
  assert.deepEqual(provisional.rows.map((row) => row.address), [OTHER]);

  // A later read with a different moderation view must not be frozen by the
  // first GET. Only the settlement path calls finalizeDay.
  const unmoderated = await store.leaderboard(DAY, [], closedAt + 10_000);
  assert.equal(unmoderated.finalized, false);
  assert.deepEqual(unmoderated.rows.map((row) => row.address), [PLAYER, OTHER]);

  const snapshot = await store.finalizeDay(DAY, [PLAYER]);
  assert.equal(snapshot.finalized, true);
  assert.equal(snapshot.provisional, false);
  assert.deepEqual(snapshot.rows.map((row) => row.address), [OTHER]);
  const repeated = await store.leaderboard(DAY, [], closedAt + 100_000);
  assert.deepEqual(repeated, snapshot);
});

test('PostgreSQL post-midnight leaderboard GET performs no snapshot transaction or writes', async () => {
  const queries = [];
  let connectCalls = 0;
  const pool = {
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (/FROM matt_mine_arena\.days WHERE day_key=\$1/.test(text)) {
        return { rows: [postgresDayRow()] };
      }
      if (/FROM matt_mine_arena\.snapshots s/.test(text)) return { rows: [] };
      if (/ROW_NUMBER\(\) OVER/.test(text)) return { rows: [] };
      if (/COUNT\(\*\)::integer AS participant_count/.test(text)) {
        return { rows: [{ participant_count: 0 }] };
      }
      throw new Error(`Unexpected leaderboard query: ${text}`);
    },
    async connect() {
      connectCalls += 1;
      throw new Error('A read-only leaderboard must not open a snapshot transaction.');
    }
  };
  const store = new PostgresArenaStore(pool);
  store.initialized = true;
  const result = await store.leaderboard(
    DAY,
    [],
    Date.parse(`${NEXT_DAY}T00:00:01Z`)
  );
  assert.equal(result.status, 'closed');
  assert.equal(result.provisional, true);
  assert.equal(result.finalized, false);
  assert.equal(connectCalls, 0);
  assert.equal(queries.every((sql) => /^\s*SELECT/i.test(sql)), true);
});

test('PostgreSQL reconciliation preserves a finalized snapshot until onchain Safe settlement', async () => {
  let updateSql = '';
  const pool = {
    async query(sql) {
      updateSql = String(sql);
      return {
        rows: [postgresDayRow({
          status: 'finalized',
          chain_status: 1,
          finalized_at_ms: Date.parse(`${NEXT_DAY}T00:00:00Z`)
        })]
      };
    },
    async connect() {
      throw new Error('reconcileDay should not acquire a transaction client.');
    }
  };
  const store = new PostgresArenaStore(pool);
  store.initialized = true;
  const result = await store.reconcileDay(DAY, {
    entryPoolRaw: '0',
    seedRaw: '0',
    entryCount: 0,
    chainStatus: 1,
    status: 'finalized'
  });

  assert.match(
    updateSql,
    /WHEN \$5=1 AND status='finalized' THEN 'finalized'/
  );
  assert.equal(result.status, 'finalized');
  assert.equal(result.chainStatus, 1);
});

test('the 10M MATT seed metadata cap is enforced without a player-pool cap', async () => {
  const store = await new MemoryArenaStore().init();
  await assert.rejects(
    () => store.ensureDay(dayRecord({ seedRaw: (BigInt(ARENA_SEED_CAP_RAW) + 1n).toString() })),
    (error) => error.code === 'arena_seed_cap_exceeded'
  );
  const hugePlayerPool = 50_000_000n * 10n ** 18n;
  await store.ensureDay(dayRecord());
  await store.reconcileDay(DAY, {
    entryPoolRaw: hugePlayerPool.toString(),
    seedRaw: ARENA_SEED_CAP_RAW,
    entryCount: 5_000_000
  });
  assert.equal((await store.getDay(DAY)).entryPoolRaw, hugePlayerPool.toString());
});

test('PostgreSQL migration uses an isolated schema and migration-safe creation', async () => {
  const statements = [];
  const pool = {
    async query(sql) {
      statements.push(String(sql));
      return { rows: [] };
    }
  };
  await createArenaPostgresSchema(pool);
  const sql = statements.join('\n');
  assert.match(sql, /CREATE SCHEMA IF NOT EXISTS matt_mine_arena/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS matt_mine_arena\.days/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS matt_mine_arena\.entries/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS matt_mine_arena\.runs/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS matt_mine_arena\.events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS matt_mine_arena\.snapshots/);
  assert.doesNotMatch(sql, /CHECK\s*\(\s*entry_count\s*<=/i);
});

test('Arena quote emits exact approval only when needed, then enter(dayId)', async () => {
  let allowance = 0n;
  const client = fakeChainClient({
    readContract({ functionName }) {
      if (functionName === 'getDay') return dayTuple();
      if (functionName === 'entriesPaused') return false;
      if (functionName === 'settlementPaused') return false;
      if (functionName === 'matt') return TOKEN;
      if (functionName === 'allowance') return allowance;
      throw new Error(`unexpected read ${functionName}`);
    }
  });
  const chain = arenaChain(client);
  const quote = await chain.quoteEntry(PLAYER, DAY, FEE_RAW);
  assert.deepEqual(quote.transactions.map((transaction) => transaction.kind), ['approve', 'enter']);
  assert.equal(quote.transactions.every((transaction) => transaction.value === '0'), true);
  allowance = BigInt(FEE_RAW);
  const approved = await chain.quoteEntry(PLAYER, DAY, FEE_RAW);
  assert.deepEqual(approved.transactions.map((transaction) => transaction.kind), ['enter']);
});

test('Arena confirmation verifies enter calldata and the exact ContestEntered log', async () => {
  const eventAbi = DAILY_ARENA_ABI.find((item) => item.type === 'event' && item.name === 'ContestEntered');
  const dayId = BigInt(Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 86_400_000));
  const topics = encodeEventTopics({
    abi: [eventAbi],
    eventName: 'ContestEntered',
    args: { dayId, entryNumber: 7n, wallet: PLAYER }
  });
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }],
    [BigInt(FEE_RAW), BigInt(FEE_RAW)]
  );
  const client = fakeChainClient({
    waitForTransactionReceipt: async () => ({
      status: 'success',
      to: ARENA,
      blockNumber: 123n,
      logs: [{
        address: ARENA,
        topics,
        data,
        logIndex: 4,
        blockNumber: 123n,
        transactionHash: HASH_A
      }]
    }),
    getTransaction: async () => ({
      from: PLAYER,
      to: ARENA,
      value: 0n,
      input: encodeFunctionData({
        abi: DAILY_ARENA_ABI,
        functionName: 'enter',
        args: [dayId]
      })
    })
  });
  const verified = await arenaChain(client).verifyEntryPurchase(HASH_A, PLAYER, DAY, FEE_RAW);
  assert.equal(verified.paymentKey, `${HASH_A}:4`);
  assert.equal(verified.entryNumber, '7');
  assert.equal(verified.amountRaw, FEE_RAW);
});

test('settlement draft is one exact settleDay Safe call and preserves raw sum', () => {
  const pool = 123_456_789n;
  const entries = [
    { address: PLAYER, score: 2 },
    { address: OTHER, score: 1 }
  ];
  const draft = createArenaSettlementDraft({
    day: DAY,
    contractAddress: ARENA,
    safeAddress: SAFE,
    poolRaw: pool,
    entries,
    createdAt: 1_000
  });
  assert.equal(draft.safe.transactions.length, 1);
  assert.equal(draft.safe.transactions[0].to.toLowerCase(), ARENA.toLowerCase());
  assert.equal(draft.allocations.reduce((sum, entry) => sum + BigInt(entry.amountRaw), 0n), pool);
  assert.equal(
    draft.transaction.data.slice(0, 10),
    encodeFunctionData({
      abi: ARENA_SETTLEMENT_ABI,
      functionName: 'settleDay',
      args: [0n, [], []]
    }).slice(0, 10)
  );
});

test('paid Arena entry is hard-disabled even when environment asks for live mode', async () => {
  assert.equal(ARENA_REPLAY_READY, false);
  const store = await new MemoryArenaStore().init();
  const chain = {
    contractAddress: ARENA,
    mattTokenAddress: TOKEN,
    publicConfig: () => ({ chainId: 2020, contract: ARENA, mattToken: TOKEN }),
    healthCheck: async () => ({ ok: true }),
    dayStatus: async () => ({
      status: 1,
      scheduled: true,
      entriesPaused: false,
      entryFeeRaw: FEE_RAW,
      entryCount: '0',
      entryPoolRaw: '0',
      seededRaw: '0'
    }),
    quoteEntry: async () => {
      throw new Error('must not reach chain quote');
    }
  };
  const arena = await new DailyArenaService({
    store,
    chain,
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  }).init();
  assert.equal(arena.publicConfig().enabled, false);
  assert.equal(arena.publicConfig().liveBlocker, 'input_replay_not_ready');
  await assert.rejects(
    () => arena.quoteEntry(PLAYER, {}),
    (error) => error.code === 'arena_live_disabled'
  );
});

test('all executable Arena configuration paths stay blocked behind the replay release gate', async () => {
  const store = await new MemoryArenaStore().init();
  const chain = fakeArenaAdapter(() => unscheduledChainDay());
  const arena = await new DailyArenaService({
    store,
    chain,
    receiptSecret: 'r'.repeat(64),
    safeAddress: SAFE,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  }).init();
  await assert.rejects(
    () => arena.prepareDay({
      day: NEXT_DAY,
      feeMatt: '25000',
      seedMatt: '0',
      reason: 'Unsafe zero-seed schedule'
    }),
    (error) => error.code === 'arena_schedule_security_gate'
  );
  await assert.rejects(
    () => arena.prepareDay({
      day: NEXT_DAY,
      feeMatt: '25000',
      seedMatt: '1',
      reason: 'Unsafe seeded schedule'
    }),
    (error) => error.code === 'arena_schedule_security_gate'
  );
  await assert.rejects(
    () => arena.prepareSeedTopUp(NEXT_DAY, {
      seedMatt: '1',
      reason: 'Unsafe seed top-up'
    }),
    (error) => error.code === 'arena_seed_security_gate'
  );
  await assert.rejects(
    () => arena.prepareControl('unpause-entries', 'Unsafe activation'),
    (error) => error.code === 'arena_unpause_security_gate'
  );
});

test('current prepared configuration becomes open when status 1 is confirmed, then syncs settled/cancelled distinctly', async () => {
  const store = await new MemoryArenaStore().init();
  await store.scheduleDay(dayRecord({
    status: 'scheduled',
    chainStatus: 0,
    configurationState: 'prepared'
  }));
  let status = 1;
  const chain = fakeArenaAdapter(() => scheduledChainDay({ status }));
  const arena = arenaService(store, chain, Date.parse(`${DAY}T12:00:00Z`));
  const open = await arena.config(DAY);
  assert.equal(open.status, 'open');
  assert.equal(open.chainStatus, 1);
  assert.equal(open.configurationState, 'confirmed');
  status = 2;
  const settled = await arena.config(DAY);
  assert.equal(settled.status, 'settled');
  assert.equal(settled.chainStatus, 2);
  status = 3;
  const cancelled = await arena.config(DAY);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.chainStatus, 3);
});

test('reviewed snapshot remains finalized while its onchain Safe settlement is pending', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({
    chainStatus: 1,
    configurationState: 'confirmed'
  }));
  await store.finalizeDay(DAY, []);
  const arena = arenaService(
    store,
    fakeArenaAdapter(() => scheduledChainDay({ status: 1 })),
    Date.parse(`${NEXT_DAY}T00:00:01Z`)
  );

  const pendingSafe = await arena.config(DAY);
  assert.equal(pendingSafe.status, 'finalized');
  assert.equal(pendingSafe.chainStatus, 1);
});

test('unscheduled current day returns a configured security-preview document instead of throwing', async () => {
  const store = await new MemoryArenaStore().init();
  const arena = arenaService(
    store,
    fakeArenaAdapter(() => unscheduledChainDay()),
    Date.parse(`${DAY}T12:00:00Z`)
  );
  const config = await arena.config(DAY);
  assert.equal(config.status, 'unscheduled');
  assert.equal(config.enabled, false);
  assert.equal(config.previewAvailable, true);
  assert.equal(config.liveBlocker, 'input_replay_not_ready');
  assert.equal(config.feeRaw, '0');
});

test('stale active run from a prior UTC day expires before a new attempt consumes its entry', async () => {
  const previous = '2026-07-24';
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({
    day: previous,
    snapshotAt: Date.parse(`${DAY}T00:00:00Z`)
  }));
  await store.confirmEntry({
    ...entryRecord(1, HASH_A),
    day: previous
  });
  await store.consumeEntry(PLAYER, previous, 'arena_entry_1', {
    ...runRecord('arena_run_previous', Date.parse(`${previous}T12:00:00Z`)),
    day: previous,
    expiresAt: Date.parse(`${previous}T12:20:00Z`)
  });
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(2, HASH_B));
  const arena = arenaService(
    store,
    fakeArenaAdapter(() => scheduledChainDay()),
    Date.parse(`${DAY}T12:00:00Z`)
  );
  arena.liveEnabled = true; // Test the future replay-ready path behind the release gate.
  const started = await arena.startRun(PLAYER);
  assert.match(started.run.runId, /^arena_run_/);
  assert.equal((await store.getRun('arena_run_previous')).status, 'expired');
  assert.equal((await store.activeRun(PLAYER)).runId, started.run.runId);
});

test('entry cutoff reserves run TTL plus confirmation buffer and confirmation stays bound to its event day across midnight', async () => {
  const cutoffStore = await new MemoryArenaStore().init();
  await cutoffStore.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  let quoteCalled = false;
  const cutoffChain = fakeArenaAdapter(() => scheduledChainDay(), {
    quoteEntry: async () => {
      quoteCalled = true;
      return { transactions: [] };
    }
  });
  const cutoffArena = arenaService(
    cutoffStore,
    cutoffChain,
    Date.parse(`${DAY}T23:36:00Z`)
  );
  cutoffArena.liveEnabled = true;
  await assert.rejects(
    () => cutoffArena.quoteEntry(PLAYER),
    (error) => error.code === 'arena_entry_cutoff'
  );
  assert.equal(quoteCalled, false);

  const midnightStore = await new MemoryArenaStore().init();
  const eventTime = Date.parse(`${DAY}T23:34:00Z`);
  const midnightChain = fakeArenaAdapter(
    (day) => scheduledChainDay({ day }),
    {
      verifyEntryPurchase: async () => ({
        paymentKey: `${HASH_A}:1`,
        transactionHash: HASH_A,
        logIndex: 1,
        blockNumber: '10',
        address: PLAYER,
        day: DAY,
        dayId: Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 86_400_000),
        entryNumber: '1',
        amountRaw: FEE_RAW,
        totalPoolRaw: FEE_RAW,
        blockTimestampMs: eventTime
      })
    }
  );
  const midnightArena = arenaService(
    midnightStore,
    midnightChain,
    Date.parse(`${NEXT_DAY}T00:01:00Z`)
  );
  midnightArena.liveEnabled = true;
  const confirmed = await midnightArena.confirmEntry(PLAYER, HASH_A);
  assert.equal(confirmed.entry.day, DAY);
  assert.equal((await midnightStore.unusedEntries(PLAYER, DAY)).length, 1);
  assert.equal((await midnightStore.unusedEntries(PLAYER, NEXT_DAY)).length, 0);
});

test('leaderboard counts every eligible wallet while returning top ten and per-wallet entry totals', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  for (let index = 1; index <= 11; index += 1) {
    const wallet = address(index);
    const hash = `0x${index.toString(16).padStart(64, '0')}`;
    await store.confirmEntry({ ...entryRecord(index, hash), address: wallet });
    if (index === 1) {
      const extraHash = `0x${'f'.repeat(63)}1`;
      await store.confirmEntry({
        ...entryRecord(100, extraHash),
        address: wallet
      });
    }
    await store.consumeEntry(wallet, DAY, `arena_entry_${index}`, {
      ...runRecord(`arena_run_${index}`, 1_000 + index),
      address: wallet
    });
    await store.finishRun(`arena_run_${index}`, replayResult({ score: 1_000 - index }), 2_000 + index);
  }
  const board = await store.leaderboard(DAY, [], Date.parse(`${DAY}T12:00:00Z`));
  assert.equal(board.participantCount, 11);
  assert.equal(board.rows.length, 10);
  assert.equal(board.rows[0].entries, 2);
});

test('independent pause controls require the emergency pauser directly and Arena admin actions enter the main audit log', async () => {
  const store = await new MemoryArenaStore().init();
  const chain = fakeArenaAdapter(() => unscheduledChainDay({
    entriesPaused: false,
    settlementPaused: false
  }));
  const arena = arenaService(store, chain, Date.parse(`${DAY}T12:00:00Z`));
  const control = await arena.prepareControl('pause-entries', 'Emergency competition pause');
  assert.equal(control.action, 'pause-entries');
  assert.equal(control.safe, null);
  assert.equal(control.transactions.length, 1);
  assert.match(control.requiredSigner, /emergency pauser/i);

  const database = new MemoryDatabase();
  const service = new MattMineService(database, {
    adminKey: 'arena-admin-secret',
    arenaService: arena,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  });
  await service.prepareArenaControl(
    'arena-admin-secret',
    'pause-entries',
    { reason: 'Emergency competition pause' }
  );
  const audit = await service.adminAudit('arena-admin-secret', {
    action: 'ARENA_CONTROL_PREPARED'
  });
  assert.equal(audit.entries.length, 1);
});

function dayRecord(overrides = {}) {
  return {
    day: DAY,
    snapshotAt: Date.parse(`${NEXT_DAY}T00:00:00Z`),
    feeRaw: FEE_RAW,
    seedRaw: '0',
    deterministicSeed: 'f'.repeat(64),
    transcriptVersion: ARENA_TRANSCRIPT_VERSION,
    status: 'open',
    entryPoolRaw: '0',
    entryCount: 0,
    createdAt: 1,
    ...overrides
  };
}

function entryRecord(index, transactionHash) {
  return {
    entryId: `arena_entry_${index}`,
    paymentKey: `${transactionHash}:${index}`,
    transactionHash,
    logIndex: index,
    blockNumber: String(100 + index),
    day: DAY,
    address: PLAYER,
    amountRaw: FEE_RAW,
    confirmedAt: 100 + index
  };
}

function runRecord(runId, startedAt) {
  return {
    runId,
    day: DAY,
    address: PLAYER,
    tokenHash: '1'.repeat(64),
    receiptSignature: '2'.repeat(64),
    status: 'active',
    startedAt,
    expiresAt: startedAt + 60_000,
    throughSeq: 0,
    throughTick: 0,
    transcriptHash: '3'.repeat(64),
    checkpointSignature: '4'.repeat(64)
  };
}

function replayResult(overrides = {}) {
  return {
    terminal: true,
    extracted: true,
    score: 100,
    projected: 100,
    depth: 1,
    guardianTimeMs: 1_000,
    damageTaken: 0,
    elapsedMs: 2_000,
    kills: 1,
    oreBroken: 3,
    eventCount: 5,
    ...overrides
  };
}

function score(overrides = {}) {
  return {
    address: PLAYER,
    score: 100,
    depth: 2,
    guardianTimeMs: 1_000,
    damageTaken: 10,
    elapsedMs: 2_000,
    entryTransactionHash: HASH_B,
    ...overrides
  };
}

function address(number) {
  return `0x${number.toString(16).padStart(40, '0')}`;
}

function dayTuple() {
  return {
    status: 1,
    entryFeeMatt: BigInt(FEE_RAW),
    entryCount: 0n,
    entryMatt: 0n,
    seededMatt: 0n,
    reservedMatt: 0n,
    settledMatt: 0n,
    refundedMatt: 0n
  };
}

function postgresDayRow(overrides = {}) {
  return {
    day_key: DAY,
    day_id: Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 86_400_000),
    snapshot_at_ms: Date.parse(`${NEXT_DAY}T00:00:00Z`),
    fee_raw: FEE_RAW,
    seed_raw: '0',
    seed_cap_raw: ARENA_SEED_CAP_RAW,
    deterministic_seed: 'f'.repeat(64),
    transcript_version: ARENA_TRANSCRIPT_VERSION,
    status: 'open',
    chain_status: 1,
    configuration_state: 'confirmed',
    entry_pool_raw: '0',
    entry_count: 0,
    created_at_ms: 1,
    finalized_at_ms: 0,
    ...overrides
  };
}

function fakeChainClient(overrides = {}) {
  return {
    readContract: overrides.readContract || (async () => 0n),
    waitForTransactionReceipt: overrides.waitForTransactionReceipt || (async () => {
      throw new Error('not configured');
    }),
    getTransaction: overrides.getTransaction || (async () => {
      throw new Error('not configured');
    })
  };
}

function arenaChain(client) {
  return new RoninArenaChain({
    contractAddress: ARENA,
    mattTokenAddress: TOKEN,
    confirmations: 1,
    client
  });
}

function fakeArenaAdapter(dayFactory, overrides = {}) {
  return {
    contractAddress: ARENA,
    mattTokenAddress: TOKEN,
    publicConfig: () => ({
      chainId: 2020,
      contract: ARENA,
      mattToken: TOKEN
    }),
    healthCheck: async () => ({ ok: true }),
    dayStatus: async (day) => dayFactory(day),
    quoteEntry: overrides.quoteEntry || (async () => ({
      day: DAY,
      dayId: Math.floor(Date.parse(`${DAY}T00:00:00Z`) / 86_400_000),
      amountRaw: FEE_RAW,
      allowanceRaw: FEE_RAW,
      transactions: []
    })),
    verifyEntryPurchase: overrides.verifyEntryPurchase || (async () => {
      throw new Error('entry verification not configured');
    }),
    refundable: overrides.refundable || (async () => '0'),
    quoteRefund: overrides.quoteRefund || (async () => {
      throw new Error('refund quote not configured');
    })
  };
}

function scheduledChainDay(overrides = {}) {
  return {
    day: overrides.day || DAY,
    dayId: Math.floor(Date.parse(`${overrides.day || DAY}T00:00:00Z`) / 86_400_000),
    status: overrides.status ?? 1,
    scheduled: (overrides.status ?? 1) === 1,
    entriesPaused: overrides.entriesPaused ?? false,
    settlementPaused: overrides.settlementPaused ?? false,
    entryFeeRaw: FEE_RAW,
    entryCount: overrides.entryCount ?? '0',
    entryPoolRaw: overrides.entryPoolRaw ?? '0',
    seededRaw: overrides.seededRaw ?? '0',
    reservedRaw: overrides.reservedRaw ?? '0',
    settledRaw: overrides.settledRaw ?? '0',
    refundedRaw: overrides.refundedRaw ?? '0'
  };
}

function unscheduledChainDay(overrides = {}) {
  return {
    ...scheduledChainDay(overrides),
    status: 0,
    scheduled: false,
    entryFeeRaw: '0'
  };
}

function arenaService(store, chain, timestamp) {
  return new DailyArenaService({
    store,
    chain,
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    now: () => timestamp
  });
}

assert.deepEqual(ARENA_EVENT_TYPES, [
  'ore_broken',
  'enemy_killed',
  'damage_taken',
  'guardian_defeated',
  'descend',
  'extract',
  'knockout'
]);
