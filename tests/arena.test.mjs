import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256
} from 'viem';
import {
  ARENA_EVENT_TYPES,
  ARENA_MAX_EVENTS,
  ARENA_MAX_TICKS,
  ARENA_TICK_MS,
  ARENA_TRANSCRIPT_VERSION,
  buildArenaChallenge,
  hashArenaEvent,
  normalizeArenaEvent,
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
  RONIN_ARENA_DEPLOYMENT,
  RoninArenaChain
} from '../server/arena-chain.js';
import {
  ARENA_REPLAY_READY,
  DailyArenaService
} from '../server/arena-service.js';
import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { defaultProfile } from '../src/game/storage.js';

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

test('production Arena deployment constants pin the exact verified Ronin contract', () => {
  assert.equal(RONIN_ARENA_DEPLOYMENT.chainId, 2020);
  assert.equal(RONIN_ARENA_DEPLOYMENT.contract, '0x506f969279F8264fd629BBB0Df861Ab91343b12C');
  assert.equal(RONIN_ARENA_DEPLOYMENT.runtimeCodeHash, '0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a');
  assert.equal(RONIN_ARENA_DEPLOYMENT.treasurySafe, '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc');
  assert.equal(RONIN_ARENA_DEPLOYMENT.emergencyPauser, '0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4');
  assert.equal(RONIN_ARENA_DEPLOYMENT.temporaryDeployer, '0xeED0491B506C78EA7fD10988B1E98A3C88e1C630');
});

test('Arena startup accepts only the pinned bytecode, token, Safe roles, pauser, and paused entries', async () => {
  const code = '0x6001600055';
  const roleValues = {
    DEFAULT_ADMIN_ROLE: `0x${'0'.repeat(64)}`,
    TREASURY_ROLE: `0x${'1'.repeat(64)}`,
    SETTLER_ROLE: `0x${'2'.repeat(64)}`,
    PRICER_ROLE: `0x${'3'.repeat(64)}`,
    PAUSER_ROLE: `0x${'4'.repeat(64)}`
  };
  const pauser = address(99);
  const expectedRoleAccounts = new Map([
    [roleValues.DEFAULT_ADMIN_ROLE, SAFE],
    [roleValues.TREASURY_ROLE, SAFE],
    [roleValues.SETTLER_ROLE, SAFE],
    [roleValues.PRICER_ROLE, SAFE],
    [roleValues.PAUSER_ROLE, pauser]
  ]);
  const client = {
    async getCode() {
      return code;
    },
    async readContract({ functionName, args = [] }) {
      if (functionName === 'matt') return TOKEN;
      if (functionName === 'seedTreasury') return SAFE;
      if (functionName === 'entriesPaused') return true;
      if (functionName === 'settlementPaused') return false;
      if (functionName === 'getOwners') return [SAFE, address(77), address(78)];
      if (functionName === 'getThreshold') return 2n;
      if (roleValues[functionName]) return roleValues[functionName];
      if (functionName === 'hasRole') {
        return expectedRoleAccounts.get(args[0])?.toLowerCase() === args[1].toLowerCase();
      }
      throw new Error(`Unexpected deployment read: ${functionName}`);
    }
  };
  const chain = new RoninArenaChain({
    contractAddress: ARENA,
    expectedContractAddress: ARENA,
    runtimeCodeHash: keccak256(code),
    mattTokenAddress: TOKEN,
    safeAddress: SAFE,
    emergencyPauserAddress: pauser,
    temporaryDeployerAddress: OTHER,
    requireEntriesPaused: true,
    client
  });

  const deployment = await chain.validateDeployment();
  assert.equal(deployment.pinned, true);
  assert.equal(deployment.runtimeCodeHash, keccak256(code));
  assert.equal(deployment.entriesPaused, true);

  const wrongHash = new RoninArenaChain({
    contractAddress: ARENA,
    expectedContractAddress: ARENA,
    runtimeCodeHash: `0x${'f'.repeat(64)}`,
    mattTokenAddress: TOKEN,
    safeAddress: SAFE,
    emergencyPauserAddress: pauser,
    temporaryDeployerAddress: OTHER,
    requireEntriesPaused: true,
    client
  });
  await assert.rejects(
    () => wrongHash.validateDeployment(),
    (error) => error.code === 'arena_contract_code_mismatch'
  );

  const unpaused = new RoninArenaChain({
    contractAddress: ARENA,
    expectedContractAddress: ARENA,
    runtimeCodeHash: keccak256(code),
    mattTokenAddress: TOKEN,
    safeAddress: SAFE,
    emergencyPauserAddress: pauser,
    temporaryDeployerAddress: OTHER,
    requireEntriesPaused: true,
    client: {
      ...client,
      async readContract(input) {
        if (input.functionName === 'entriesPaused') return false;
        return client.readContract(input);
      }
    }
  });
  await assert.rejects(
    () => unpaused.validateDeployment(),
    (error) => error.code === 'arena_entries_not_paused'
  );
});

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

test('daily replay challenges are deterministic and bind the exact day seed', () => {
  const first = buildArenaChallenge('a'.repeat(64));
  const again = buildArenaChallenge('a'.repeat(64));
  const different = buildArenaChallenge('b'.repeat(64));
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, different);
  assert.equal(first.version, ARENA_TRANSCRIPT_VERSION);
  assert.equal(first.tickMs, 20);
  assert.equal(first.maxEvents, ARENA_MAX_EVENTS);
  assert.equal(first.verificationMode, 'deterministic-input-replay');
});

test('Arena transcript capacity covers every fixed input step of the full 20-minute run', () => {
  const fullRunInputSteps = ARENA_MAX_TICKS / ARENA_TICK_MS;
  assert.equal(fullRunInputSteps, 60_000);
  assert.equal(ARENA_MAX_EVENTS, 61_024);
  assert.ok(ARENA_MAX_EVENTS > fullRunInputSteps);
  assert.doesNotThrow(() => normalizeArenaEvent(
    inputEvent(fullRunInputSteps, ARENA_MAX_TICKS - ARENA_TICK_MS),
    fullRunInputSteps
  ));
  assert.doesNotThrow(() => normalizeArenaEvent({
    seq: fullRunInputSteps + 1,
    tick: ARENA_MAX_TICKS,
    type: 'finish'
  }, fullRunInputSteps + 1));
});

test('Arena replay accepts only an authoritative final-tick auto-extraction', () => {
  const challenge = {
    ...buildArenaChallenge('b'.repeat(64)),
    maxTicks: 40
  };
  const replayed = replayArenaTranscript(challenge, [
    { seq: 1, tick: 40, type: 'command', command: 'time_limit' },
    { seq: 2, tick: 40, type: 'finish' }
  ], { requireTerminal: true });

  assert.equal(replayed.terminal, true);
  assert.equal(replayed.extracted, true);
  assert.equal(replayed.timeLimitReached, true);
  assert.equal(replayed.elapsedMs, 40);

  assert.throws(
    () => replayArenaTranscript(challenge, [
      { seq: 1, tick: 20, type: 'command', command: 'time_limit' },
      { seq: 2, tick: 20, type: 'finish' }
    ], { requireTerminal: true }),
    (error) => error.code === 'arena_time_limit_invalid'
  );
});

test('Daily Arena replay uses the exact Competition Studio character snapshot', () => {
  const replayed = replayArenaTranscript(buildArenaChallenge('c'.repeat(64), {
    playerMaxHealth: 100,
    _competitionSnapshot: {
      loadout: { characterId: 'orc' }
    },
    _competitionCharacter: {
      baseHealth: 165,
      movementSpeed: .82,
      dashCooldown: 1.25,
      dashStrength: .9,
      pickaxeDamage: .78,
      miningSpeed: .9,
      blasterDamage: .72,
      blasterEnergy: 85,
      armor: .14,
      magnetRange: .9,
      luck: .92
    }
  }), []);
  assert.equal(replayed.maximumHealth, 165);
});

test('NFT replay uses equipped armor health without adding legacy profile health', () => {
  const replayed = replayArenaTranscript(buildArenaChallenge('c'.repeat(64), {
    playerMaxHealth: 175
  }), [], {
    mode: 'practice',
    profile: {
      ...defaultProfile(),
      meta: {
        ...defaultProfile().meta,
        health: 10
      }
    },
    nftRun: {
      minerId: 1,
      runId: 42
    }
  });

  assert.equal(replayed.maximumHealth, 175);
});

test('input-only replay deterministically derives a knockout without browser outcomes', () => {
  const challenge = buildArenaChallenge('a'.repeat(64));
  const events = [
    inputEvent(1, 0),
    { seq: 2, tick: 7_240, type: 'finish' }
  ];
  const first = replayArenaTranscript(challenge, events, { requireTerminal: true });
  const again = replayArenaTranscript(challenge, events, { requireTerminal: true });
  assert.deepEqual(first, again);
  assert.equal(first.terminal, true);
  assert.equal(first.extracted, false);
  assert.equal(first.elapsedMs, 7_240);
  assert.equal(first.damageTaken, 112);
});

test('Arena replay accepts a paid revive command only after a verified payment', () => {
  const challenge = buildArenaChallenge('a'.repeat(64));
  const events = [
    inputEvent(1, 0),
    { seq: 2, tick: 7_240, type: 'command', command: 'death' },
    { seq: 3, tick: 7_240, type: 'command', command: 'revive' }
  ];

  assert.throws(
    () => replayArenaTranscript(challenge, events, {
      allowPaidRevive: true,
      confirmedPaidRevives: 0
    }),
    (error) => error.code === 'revive_payment_not_confirmed'
  );

  const revived = replayArenaTranscript(challenge, events, {
    allowPaidRevive: true,
    confirmedPaidRevives: 1,
    reviveInvulnerabilitySeconds: 3
  });
  assert.equal(revived.terminal, false);
  assert.equal(revived.awaitingRevive, false);
  assert.equal(revived.maximumHealth, 100);
});

test('input replay rejects milestones, unaligned clocks, premature finishes, and post-finish input', () => {
  const challenge = buildArenaChallenge('d'.repeat(64));
  assert.throws(
    () => replayArenaTranscript(challenge, [
      { seq: 1, tick: 0, type: 'ore_broken', targetId: 1 }
    ]),
    (error) => error.code === 'arena_event_type_invalid'
  );
  assert.throws(
    () => replayArenaTranscript(challenge, [
      inputEvent(1, 10)
    ]),
    (error) => error.code === 'arena_tick_invalid'
  );
  assert.throws(
    () => replayArenaTranscript(challenge, [
      inputEvent(1, 0),
      { seq: 2, tick: 20, type: 'finish' }
    ], { requireTerminal: true }),
    (error) => error.code === 'arena_run_not_terminal'
  );
});

test('transcript hashes bind ordering and normalized event contents', () => {
  const start = 'e'.repeat(64);
  const event = inputEvent(1, 0, { attack: true });
  const first = hashArenaEvent(start, event);
  assert.equal(first, hashArenaEvent(start, event));
  assert.notEqual(first, hashArenaEvent(start, { ...event, attack: false }));
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

test('Arena Admin controls can list and expire active runs immediately', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.confirmEntry(entryRecord(1, HASH_A));
  await store.consumeEntry(PLAYER, DAY, 'arena_entry_1', runRecord('arena_run_admin_stop', 1_000));

  assert.deepEqual(
    (await store.activeRuns(PLAYER)).map((run) => run.runId),
    ['arena_run_admin_stop']
  );
  const expired = await store.expireActiveRuns(PLAYER, 2_000);
  assert.deepEqual(expired.map((run) => run.runId), ['arena_run_admin_stop']);
  assert.equal(expired[0].status, 'expired');
  assert.equal((await store.activeRuns(PLAYER)).length, 0);
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

test('an Arena entry is restored only when its NFT transaction definitely never started', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.confirmEntry(entryRecord(1, HASH_A));
  const pending = {
    ...runRecord('arena_run_nft_rollback', 1_000),
    tuning: { _nftRun: { minerId: 1, profile: { minerId: 1 } } }
  };
  await store.consumeEntry(PLAYER, DAY, 'arena_entry_1', pending);
  const rolledBack = await store.rollbackUnstartedNftRun(
    'arena_run_nft_rollback',
    PLAYER,
    2_000
  );
  assert.equal(rolledBack.restored, true);
  assert.equal((await store.unusedEntries(PLAYER, DAY)).length, 1);

  await store.consumeEntry(PLAYER, DAY, 'arena_entry_1', {
    ...pending,
    runId: 'arena_run_nft_started',
    startedAt: 3_000,
    expiresAt: 63_000
  });
  await store.attachNftRun('arena_run_nft_started', PLAYER, {
    minerId: 1,
    runId: `0x${'a'.repeat(64)}`,
    beginTransactionHash: `0x${'b'.repeat(64)}`
  });
  await assert.rejects(
    () => store.rollbackUnstartedNftRun('arena_run_nft_started', PLAYER, 4_000),
    (error) => error.code === 'arena_nft_run_already_started'
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
    /WHEN \$5::smallint=1 AND status='finalized' THEN 'finalized'/
  );
  assert.equal(
    [...updateSql.matchAll(/\$5(?!::smallint)/g)].length,
    0,
    'chain status must be explicitly typed as smallint at every use'
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
      if (functionName === 'balanceOf') return BigInt(FEE_RAW) * 2n;
      if (functionName === 'allowance') return allowance;
      throw new Error(`unexpected read ${functionName}`);
    }
  });
  const chain = arenaChain(client);
  const quote = await chain.quoteEntry(PLAYER, DAY, FEE_RAW);
  assert.deepEqual(quote.transactions.map((transaction) => transaction.kind), ['approve', 'enter']);
  assert.equal(quote.transactions.every((transaction) => transaction.value === '0x0'), true);
  allowance = BigInt(FEE_RAW);
  const approved = await chain.quoteEntry(PLAYER, DAY, FEE_RAW);
  assert.deepEqual(approved.transactions.map((transaction) => transaction.kind), ['enter']);
});

test('Arena quote blocks a wallet below the exact MATT entry fee before opening Ronin Wallet', async () => {
  const balance = BigInt(FEE_RAW) - 1n;
  const client = fakeChainClient({
    readContract({ functionName }) {
      if (functionName === 'getDay') return dayTuple();
      if (functionName === 'entriesPaused') return false;
      if (functionName === 'settlementPaused') return false;
      if (functionName === 'matt') return TOKEN;
      if (functionName === 'balanceOf') return balance;
      if (functionName === 'allowance') return 0n;
      throw new Error(`unexpected read ${functionName}`);
    }
  });

  await assert.rejects(
    () => arenaChain(client).quoteEntry(PLAYER, DAY, FEE_RAW),
    (error) => {
      assert.equal(error.code, 'arena_matt_balance_insufficient');
      assert.equal(error.details.requiredRaw, FEE_RAW);
      assert.equal(error.details.balanceRaw, balance.toString());
      assert.equal(error.details.shortfallRaw, '1');
      assert.match(error.message, /Arena entry costs 25,000 MATT/);
      return true;
    }
  );
});

test('Arena refund quote emits a wallet-valid zero-value transaction', async () => {
  const client = fakeChainClient({
    readContract({ functionName }) {
      if (functionName === 'refundableMatt') return BigInt(FEE_RAW);
      throw new Error(`unexpected read ${functionName}`);
    }
  });
  const quote = await arenaChain(client).quoteRefund(PLAYER, DAY);
  assert.equal(quote.refundRaw, FEE_RAW);
  assert.equal(quote.transaction.kind, 'claim_refund');
  assert.equal(quote.transaction.value, '0x0');
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

test('reviewed input replay enables paid Arena only when live mode is explicitly requested', async () => {
  assert.equal(ARENA_REPLAY_READY, true);
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
    quoteEntry: async () => ({ transactions: [{ to: ARENA, data: '0x', value: '0' }] })
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
  assert.equal(arena.publicConfig().enabled, true);
  assert.equal(arena.publicConfig().replayReady, true);
  assert.equal(arena.publicConfig().verificationMode, 'deterministic-input-replay');
  assert.equal(arena.publicConfig().maxTranscriptEvents, ARENA_MAX_EVENTS);
  assert.equal(arena.publicConfig().roundDurationSeconds, 20 * 60);
  assert.equal(arena.publicConfig().finalizationGraceSeconds, 5 * 60);
  assert.equal(arena.publicConfig().runTtlSeconds, 25 * 60);
  assert.equal(arena.publicConfig().entryCutoffSeconds, 25 * 60);
  const quote = await arena.quoteEntry(PLAYER, {});
  assert.equal(quote.quote.transactions.length, 1);
});

test('reviewed replay release unlocks schedule and emergency unpause preparation', async () => {
  const store = await new MemoryArenaStore().init();
  const chain = fakeArenaAdapter(() => unscheduledChainDay());
  const arena = await new DailyArenaService({
    store,
    chain,
    receiptSecret: 'r'.repeat(64),
    safeAddress: SAFE,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  }).init();
  const prepared = await arena.prepareDay({
    day: NEXT_DAY,
    feeMatt: '25000',
    seedMatt: '1',
    reason: 'First deterministic replay Arena'
  });
  assert.equal(prepared.transactions.length, 3);

  const controlStore = await new MemoryArenaStore().init();
  const controlArena = new DailyArenaService({
    store: controlStore,
    chain: fakeArenaAdapter(() => scheduledChainDay({ entriesPaused: true })),
    receiptSecret: 'r'.repeat(64),
    safeAddress: SAFE,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  });
  await controlArena.init();
  const unpause = await controlArena.prepareControl('unpause-entries', 'Activate deterministic replay');
  assert.equal(unpause.transaction.to, ARENA);
  assert.equal(unpause.requiredSigner, 'Daily Arena emergency pauser EOA');
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
  assert.equal(config.liveBlocker, 'arena_live_not_requested');
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

test('abandoning a Daily Arena run consumes its entry but releases the active-run lock without a score', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(1, HASH_A));
  const arena = await new DailyArenaService({
    store,
    chain: fakeArenaAdapter(() => scheduledChainDay()),
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  }).init();

  const started = await arena.startRun(PLAYER);
  const abandoned = await arena.abandonRun(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.status, 'expired');
  assert.equal(await store.activeRun(PLAYER), null);
  assert.equal((await store.leaderboard(DAY)).rows.length, 0);
  assert.equal((await store.unusedEntries(PLAYER, DAY)).length, 0);
});

test('a signed-in wallet can release a stranded Daily Arena run without its lost run token', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(1, HASH_A));
  const arena = await new DailyArenaService({
    store,
    chain: fakeArenaAdapter(() => scheduledChainDay()),
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => Date.parse(`${DAY}T12:00:00Z`)
  }).init();

  const started = await arena.startRun(PLAYER);
  const released = await arena.abandonActiveRun(PLAYER);
  assert.equal(released.runId, started.run.runId);
  assert.equal(released.status, 'expired');
  assert.equal(released.entryConsumed, true);
  assert.equal(await store.activeRun(PLAYER), null);
  assert.equal((await store.unusedEntries(PLAYER, DAY)).length, 0);
  await assert.rejects(
    () => arena.abandonActiveRun(PLAYER),
    (error) => error.code === 'arena_active_run_missing'
  );
});

test('Daily Arena defers full replay for input-only batches and replays command barriers', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(1, HASH_A));
  const timestamp = Date.parse(`${DAY}T12:00:00Z`);
  const arena = await new DailyArenaService({
    store,
    chain: fakeArenaAdapter(() => scheduledChainDay()),
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => timestamp
  }).init();
  const started = await arena.startRun(PLAYER);
  const readEvents = store.getEvents.bind(store);
  let replayReads = 0;
  store.getEvents = async (...args) => {
    replayReads += 1;
    return readEvents(...args);
  };

  const checkpoint = await arena.appendEvents(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    previousCheckpoint: started.run.checkpoint,
    events: [inputEvent(1, 20)]
  });
  assert.equal(replayReads, 0);
  await assert.rejects(
    arena.appendEvents(PLAYER, {
      runId: started.run.runId,
      runToken: started.run.runToken,
      previousCheckpoint: checkpoint.checkpoint,
      events: [inputEvent(2, 0)]
    }),
    (error) => error.code === 'arena_tick_regressed'
  );
  assert.equal(replayReads, 0);
  await assert.rejects(
    arena.appendEvents(PLAYER, {
      runId: started.run.runId,
      runToken: started.run.runToken,
      previousCheckpoint: checkpoint.checkpoint,
      events: [{ seq: 2, tick: 20, type: 'command', command: 'extract' }]
    }),
    (error) => error.code === 'arena_guardian_required'
  );
  assert.equal(replayReads, 1);
  assert.equal((await store.getRun(started.run.runId)).throughSeq, 1);
});

test('Daily Arena preserves a knockout and resumes only after paid-revive confirmation', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(1, HASH_A));
  let timestamp = Date.parse(`${DAY}T12:00:00Z`);
  let reviveState = { revives: [] };
  const arena = await new DailyArenaService({
    store,
    chain: fakeArenaAdapter(() => scheduledChainDay()),
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => timestamp,
    getPaidReviveState: async () => reviveState,
    getTuning: async () => ({})
  }).init();

  const started = await arena.startRun(PLAYER, {
    paidRevivesEnabled: true,
    reviveLimitPerRun: 1,
    reviveInvulnerabilitySeconds: 3
  });
  assert.equal(started.run.mode, 'arena');
  assert.equal(started.run.paidReviveEligible, true);
  assert.equal(started.run.reviveLimitPerRun, 1);
  assert.equal(started.run.reviveInvulnerabilitySeconds, 3);

  timestamp += 7_360;
  const knockedOut = await arena.appendEvents(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    previousCheckpoint: started.run.checkpoint,
    events: [
      inputEvent(1, 0),
      { seq: 2, tick: 7_360, type: 'command', command: 'death' }
    ]
  });
  const verified = await arena.validatePaidReviveDeath(
    PLAYER,
    started.run.runId,
    { checkpoint: knockedOut.checkpoint }
  );
  assert.equal(verified.reviveRun.paidReviveEligible, true);
  assert.equal(verified.playerState.health, 0);

  const reviveEvent = {
    runId: started.run.runId,
    runToken: started.run.runToken,
    previousCheckpoint: knockedOut.checkpoint,
    events: [{ seq: 3, tick: 7_360, type: 'command', command: 'revive' }]
  };
  await assert.rejects(
    () => arena.appendEvents(PLAYER, reviveEvent),
    (error) => error.code === 'revive_payment_not_confirmed'
  );

  reviveState = { revives: [{ transactionHash: HASH_B }] };
  const resumed = await arena.appendEvents(PLAYER, reviveEvent);
  assert.equal(resumed.acceptedEvents, 1);
  assert.equal(resumed.checkpoint.throughSeq, 3);
});

test('paid entry, one-time run token, raw controls, server replay, and leaderboard finish end to end', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord({ chainStatus: 1, configurationState: 'confirmed' }));
  await store.confirmEntry(entryRecord(1, HASH_A));
  let timestamp = Date.parse(`${DAY}T12:00:00Z`);
  const arena = await new DailyArenaService({
    store,
    chain: fakeArenaAdapter(() => scheduledChainDay()),
    receiptSecret: 'r'.repeat(64),
    seedSecret: 's'.repeat(64),
    safeAddress: SAFE,
    liveEnabled: true,
    now: () => timestamp
  }).init();

  const started = await arena.startRun(PLAYER, { passActiveAtStart: true });
  await assert.rejects(
    () => arena.appendEvents(PLAYER, {
      runId: started.run.runId,
      runToken: started.run.runToken,
      previousCheckpoint: started.run.checkpoint,
      events: [{ seq: 1, tick: 0, type: 'ore_broken', targetId: 999 }]
    }),
    (error) => error.code === 'arena_event_type_invalid'
  );

  timestamp += 7_360;
  const appended = await arena.appendEvents(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    previousCheckpoint: started.run.checkpoint,
    events: [
      inputEvent(1, 0),
      { seq: 2, tick: 7_360, type: 'finish' }
    ]
  });
  assert.equal(appended.acceptedEvents, 2);

  const finished = await arena.finishRun(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    checkpoint: appended.checkpoint
  });
  assert.equal(finished.accepted, true);
  assert.equal(finished.result.terminal, true);
  assert.equal(finished.result.extracted, false);
  assert.equal(finished.result.elapsedMs, 7_360);
  assert.equal(finished.result.replayVersion, ARENA_TRANSCRIPT_VERSION);
  assert.deepEqual(finished.progression, {
    runId: started.run.runId,
    passActiveAtStart: true,
    passXpMultiplier: 1
  });
  assert.equal((await store.getRun(started.run.runId)).status, 'finished');

  const retry = await arena.finishRun(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    checkpoint: appended.checkpoint
  });
  assert.equal(retry.alreadyFinished, true);
  assert.deepEqual(retry.progression, finished.progression);

  store.leaderboard = async () => {
    throw Object.assign(new Error('the database system is in recovery mode'), {
      code: '57P03'
    });
  };
  const recoveryRetry = await arena.finishRun(PLAYER, {
    runId: started.run.runId,
    runToken: started.run.runToken,
    checkpoint: appended.checkpoint
  });
  assert.equal(recoveryRetry.accepted, true);
  assert.equal(recoveryRetry.alreadyFinished, true);
  assert.equal(recoveryRetry.result.score, finished.result.score);
  assert.equal(recoveryRetry.leaderboard.temporarilyUnavailable, true);
  assert.equal(recoveryRetry.leaderboard.playerScore, finished.result.score);
});

test('entry cutoff reserves the complete timed run and confirmation stays bound to its event day across midnight', async () => {
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

test('only allowlisted server failures resume the original paid Arena run without restoring its entry', async () => {
  const store = await new MemoryArenaStore().init();
  await store.ensureDay(dayRecord());
  await store.confirmEntry(entryRecord(1, HASH_A));
  await store.consumeEntry(PLAYER, DAY, 'arena_entry_1', runRecord('arena_run_recovery', 1_000));

  const recovered = await store.recoverRejectedRun(
    'arena_run_recovery',
    Object.assign(new Error('Worker unavailable'), { code: 'arena_replay_worker_unavailable' }),
    2_000
  );

  assert.equal(recovered.attemptRestored, false);
  assert.equal(recovered.resumable, true);
  assert.equal(recovered.run.status, 'active');
  assert.equal(recovered.run.result.rejectionCode, 'arena_replay_worker_unavailable');
  assert.equal((await store.unusedEntries(PLAYER, DAY)).length, 0);
  const board = await store.leaderboard(DAY, [], Date.parse(`${DAY}T12:00:00Z`));
  assert.equal(board.rows.length, 0);

  await assert.rejects(
    store.recoverRejectedRun('arena_run_recovery', Object.assign(new Error('Bad command'), { code: 'arena_upgrade_not_offered' }), 3_000),
    (error) => error.code === 'arena_recovery_not_authorized'
  );
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
  'input',
  'command',
  'finish'
]);

function inputEvent(seq, tick, overrides = {}) {
  return {
    seq,
    tick,
    type: 'input',
    moveX: 0,
    moveY: 0,
    aim: null,
    attack: false,
    dash: false,
    weapon: '',
    ...overrides
  };
}
