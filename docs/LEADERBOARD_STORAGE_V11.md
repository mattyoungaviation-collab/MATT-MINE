# MATT Mine v1.1 — Permanent Leaderboard Storage

MATT Mine v1.1 moves production run and leaderboard history into dedicated PostgreSQL tables. The existing `matt_mine_state` record remains available for wallet profiles, sessions, entitlements, administration, and first-release rollback compatibility.

## Production tables

| Table | Purpose |
|---|---|
| `matt_mine_runs` | Every server-issued Free, Pass, and Practice run with its verified result |
| `matt_mine_daily_scores` | One best official score per wallet, UTC day, and leaderboard |
| `matt_mine_weekly_scores` | Sum of each wallet's daily-best scores for one UTC week |
| `matt_mine_weekly_snapshots` | Immutable metadata for a finalized Free or Pass week |
| `matt_mine_weekly_snapshot_entries` | Permanent ranked wallet and score entries for a finalized week |
| `matt_mine_state` | Wallet profiles, login records, entitlements, administration, and the temporary rollback-compatible run copy |

All run creation, completion, daily-best replacement, weekly-total recalculation, entitlement consumption, and state updates happen inside PostgreSQL transactions.

## Automatic migration

The first v1.1 server startup:

1. Creates the normalized tables and indexes with `IF NOT EXISTS`.
2. Locks the existing `matt_mine_state` row.
3. Copies every retained legacy run into `matt_mine_runs`.
4. Rebuilds daily-best and weekly scores from verified finished runs.
5. Preserves the legacy state copy during the v1.1 expansion release.
6. Commits the migration atomically.

The process is idempotent. Restarting or redeploying the service cannot duplicate a run or daily score.

The legacy copy is intentionally retained for the first release so Render can roll the application back without hiding current scores. Normalized tables are authoritative for v1.1 leaderboard reads and retain history beyond the legacy state limit.

## Weekly scoring

- Free and Pass scores are always separate.
- Each wallet contributes only its best verified score per UTC day.
- Weekly score is the sum of those daily bests.
- Practice runs never enter score tables.
- Suspended wallets are excluded from live rankings.
- Live results return the top 100 plus the requesting wallet's rank and score.

## Permanent snapshots

A closed week remains editable during a 24-hour moderation window. MATT Mine also waits for every unexpired run from that week to finish or expire.

After those conditions are satisfied, the next server transaction creates:

- One immutable Free snapshot.
- One immutable Pass snapshot.
- Permanent ranked entries for every eligible participant.
- Participant, total-score, and run-count metadata.

Snapshot inserts use primary-key conflict protection and never overwrite an existing finalized week.

## Historical API

The current authenticated route remains:

```text
GET /api/leaderboards?mode=free
GET /api/leaderboards?mode=paid
```

Historical snapshots use the Monday UTC week key:

```text
GET /api/leaderboards?mode=free&week=2026-07-20
GET /api/leaderboards?mode=paid&week=2026-07-20
```

Future dates, invalid dates, and non-Monday dates are rejected.

## Render deployment

No manual database command or new Render service is required.

After this release is merged into `main`, the existing Render Blueprint deploy:

1. Starts the updated server.
2. Runs the schema creation and migration.
3. Preserves existing users, payment entitlements, and scores.
4. Reports health version `11`.

Verify:

```text
https://matt-mine.onrender.com/api/health
```

Expected critical fields:

```json
{
  "ok": true,
  "version": 11,
  "database": {
    "ok": true,
    "kind": "postgresql"
  },
  "chainId": 2020,
  "paymentsEnabled": true
}
```

MATT reward claims remain disabled. Permanent leaderboard snapshots do not automatically publish a reward root or transfer tokens.
