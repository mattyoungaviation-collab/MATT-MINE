# MATT Mine production hardening

Status: implementation candidate, not yet production-ready. No contract was deployed, no transaction was broadcast, no production database was accessed, and no Render setting was changed by this work.

## Protected production facts

- Ronin Mainnet chain ID: `2020`.
- MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`.
- Treasury Safe: `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`, exactly 2-of-3.
- Daily Arena: `0x506f969279F8264fd629BBB0Df861Ab91343b12C`.
- MATT is never burned. The paid-run contract routes MATT 70/20/10 and no reviewed contract calls a burn path.
- Existing wallets, identities, balances, ledger entries, receipts, runs, maps, scores, rewards, and addresses remain in the legacy row throughout the staged migration.

## Issue and fix register

### 1. Persistence

The legacy PostgreSQL implementation locks and rewrites `matt_mine_state.id=1`. Migrations `001` through `004` add normalized wallets, identities, avatars, sessions, challenges, runs, checkpoints, entitlements, purchases, revives, balances, append-only ledger, claims, used hashes, payment/Admin operations, mine operations, tuning versions, Competition Studio drafts/snapshots, activity, audit, and Arena recovery records. Migration `004` preserves distinct published snapshot IDs when later publishing windows reuse identical content. `PostgresDatabase` applies checksummed migrations and dual-writes normalized projections in the same transaction while retaining the legacy row as the read authority.

Commands:

- `npm run db:migrate`
- `npm run db:migrate:dry-run`
- `npm run db:backfill`
- `npm run db:validate`
- `npm run db:reconcile`
- `npm run db:rollback:dry-run`
- `npm run db:rollback -- --apply`

The rollback is deliberately lossless: it selects the legacy read source and disables dual write; runtime startup and transactions honor that switch without replaying the normalized backfill. It never drops normalized or financial tables. Activity and audit tables are indexed for cursor/time pagination. Archival must copy old rows to encrypted immutable storage and set `archived_at`; financial rows must never be truncated.

Remaining risk: the application read path is intentionally still legacy-first for this PR. Row-scoped normalized command handlers must replace the compatibility projection before cutover to `read_source=normalized`. Until then, the global row remains a contention point even though normalized copies and database uniqueness protections exist.

### 2. Payments and idempotency

The normalized schema supplies durable operation keys, request hashes, stored responses, unique transaction hashes, unique payment keys, and saga states `reserved`, `chain_verified`, `ledger_credited`, `completed`, `invalid`, and `needs_reconciliation`. Nugget purchase and Practice confirmation now advance those durable states, and retrying a completed matching operation returns its stored response. The reconciliation command and Admin reconciliation API list incomplete operations and paid-but-not-resumed revives. Transaction hashes are retained.

Nugget ledger credits remain append-only and idempotent. Confirmation distinguishes retryable infrastructure/confirmation failures from invalid payments. A confirming transaction remains reserved.

Remaining risk: the existing nugget economy JSONB store and legacy wallet row are still separate transactions. The normalized saga makes partial completion durable and visible, but automatic asynchronous reconciliation and conversion to a single row-scoped PostgreSQL transaction remain required before financial activation. Do not enable paid nugget features during the compatibility phase.

### 3. Paid revives

Repeated confirmation of the same transaction for the same run returns the stored response. A transaction used by another run is rejected. The exact death replay checkpoint and authoritative player state are persisted. `/api/revives/resume` restores the same run after refresh and records `resumedAt`. Quote validity uses the transaction block timestamp with a two-minute clock/reorg grace around the signed quote window. Admin reconciliation reports paid-but-not-resumed revives. Infrastructure errors remain retryable and are not labeled invalid payments.

### 4. Competitive replay and Arena conservation

Every competitive event batch is normalized, clock/density bounded, replayed before a new checkpoint is signed, and its authoritative result is stored. Finish consumes only the latest accepted authoritative state. Run records bind build commit, engine version, replay schema, map snapshot/hash, tuning hash, profile snapshot, and Pass multipliers. Legacy active records can hydrate their immutable snapshot from the preserved main run state.

The unsafe recovery branch behavior was removed. Invalid commands, tampering, malformed input, missing terminal input, stale checkpoints, and replay mismatches never restore an Arena entry. Only the explicit internal codes `arena_replay_worker_unavailable`, `arena_replay_timeout`, and `arena_engine_version_unavailable` may return a resume response, and that response resumes the original run without clearing its entry. A partial unique index permits at most one finished run per entry and permanent recovery records preserve lineage.

Remaining risk: batch validation currently replays the accepted prefix plus delta because the game engine has no stable deserialize API. The accepted authoritative result avoids another full replay at finish, but true delta-only worker-isolated replay is not complete. Keep event limits and rate limits conservative; do not claim replay scalability until worker isolation and stable engine serialization land.

### 5. Gameplay parity

Browser and server use `MattMineGame`, the published Competition Studio snapshot, depth-specific maps, placed objects, character/loadout, profile snapshot, seed, tuning, upgrade choices, and revive state. `competitionMapForDepth` selects each independently published layout. Legacy `ranged` is normalized to the shared `spitter` registry value. Arena permanent upgrades are ignored only when the published loadout disables them. Pass multipliers default to one and apply exactly 2x to XP and nuggets.

Studio test runs remain `admin-test-*` Practice-only and do not have official payment, reward, or score submission paths. Snapshot resolution returns no live snapshot after expiry instead of silently activating an expired snapshot.

### 6. Admin security

The Admin master key field and `sessionStorage` transport were removed. Admins authenticate with a Ronin signature through the normal wallet challenge, then exchange the player session for a 15-minute `HttpOnly; Secure; SameSite=Strict; Path=/` cookie. The exact allowlist is `MATT_MINE_ADMIN_WALLETS`. Mutations require a CSRF token. Suspension, balance awards, publication, Competition Studio publication/activation, and transaction-package generation require a fresh wallet step-up signature valid for five minutes. Logout revokes the durable session. The emergency key remains a server-only compatibility credential for trusted non-browser operator calls.

Readiness calls live Safe `getOwners()` and `getThreshold()` and blocks startup/readiness unless there are exactly three unique owners and threshold two. Onchain actions create unsigned Safe JSON and never report a broadcast.

Remaining risk: older service methods still label some audit actors `SERVER_ADMIN`. New cookie sessions preserve the actor address, but every legacy mutation must be converted to pass that actor explicitly before actor-specific audit coverage is complete.

### 7. Web security

Browser mutations enforce configured exact Origin and `Sec-Fetch-Site`; trusted emergency server calls use server credentials without weakening browser checks. Admin cookies are HttpOnly and CSRF-protected. Rate limits emit 429 with `Retry-After`. CSP remains restrictive and contains no `unsafe-inline`.

The security lint forbids browser Admin secret transport and prevents the reviewed `innerHTML` baseline from growing. New code must use DOM creation and `textContent`.

Remaining risk: 106 reviewed legacy template sinks remain. Trusted Types is not enabled because those sinks would currently break the UI. Each sink must be migrated to DOM construction or a narrowly typed/sanitized template before enabling `require-trusted-types-for 'script'`. Distributed PostgreSQL rate-limit buckets and validated Render proxy IP parsing also remain cutover work.

### 8. RPC reliability

`RONIN_RPC_URLS` configures ordered endpoints. Safe reads use timeouts, ordered failover, failure counters, circuit opening/cooldown, and redacted health state. Unsafe RPC methods, including transaction broadcast, are refused by the shared read pool. Player transactions are never retried or rebroadcast.

Remaining risk: reward-chain RPC still needs migration to the shared pool; Arena, payments, nugget payments, and revives use it.

### 9. Health, observation, and backups

- `/api/live`: process-only liveness with version and commit.
- `/api/ready`: database, replay/Arena and chain readiness; returns 503 when degraded.
- `/api/health`: compatibility endpoint.
- `npm run db:backup`: streams `pg_dump --format=custom` directly through `age`; unencrypted output is refused.

HTTP requests emit structured JSON containing a generated or validated request ID, method, path, status, duration, and a one-way truncated client identifier. Request bodies and security credentials are never logged. Never log private keys, full bearer/cookie values, Admin secrets, CSRF tokens, or signatures. Correlate incidents by request ID and the durable run, quote, or transaction records. Required alert thresholds: readiness failure for two minutes; DB pool over 80% for five minutes; p95 query over 500 ms; p95 replay over two seconds; any unknown COMMIT; any paid-but-not-credited item older than five minutes; any paid revive not resumed after 30 minutes; any Arena conservation violation; contract balance below the configured settlement obligation.

Remaining risk: a production metrics exporter, domain-level correlation fields, and alert integration are not implemented in this PR. The requested DB/replay/payment/claim/contract metric instruments remain required before production-ready status.

### 10. Contract safety review

No deployment or contract mutation is part of this change. Static review confirms:

- Pass and paid-run prices have seven-day onchain cooldowns and immutable min/max bounds.
- Arena `scheduleDay` requires a future day and enforces fee bounds.
- Arena settlement trusts the Safe-controlled settler to submit the server-reviewed winners and amounts.
- At most ten winners are accepted.
- Settlement is atomic: any transfer or validation failure reverts the entire call.
- Contract pause state and server mine-operation pause state are independent and displayed separately.
- MATT burn behavior remains zero.

The historical deployment hash compatibility helper recognizes the old one-of-three configuration hash, but current configuration and live readiness require exactly two-of-three. This does not change the deployed contracts or Safe.

### 11. CI and testing

CI tests Node 22.16 and Node 24 separately, locked install, game/server tests, contract tests, production compilation, lint, formatting, syntax/checkJs, PostgreSQL migrations/backfill/lossless rollback, Playwright browser security, dependency audit, Gitleaks, and CodeQL. PostgreSQL uses a real temporary service.

Remaining test gaps: unknown-COMMIT fault injection, begin/write/commit disconnect matrix, load/concurrency thresholds, and worker-isolation replay tests need dedicated harnesses. They must be green before production-ready status.

### 12. Eligibility

Paid Pass/Arena competition is denied in production unless `MATT_MINE_ELIGIBILITY_COUNSEL_APPROVED=true`, a rules version is supplied, and the wallet is on the server allowlist. Practice remains available. This is an enforcement hook, not a legal conclusion. Jurisdiction, age, official rules, privacy and consumer requirements need counsel approval.

## Environment variables

New variables:

- `RONIN_RPC_URLS`: ordered comma-separated Ronin read endpoints.
- `MATT_MINE_RPC_TIMEOUT_MS`: per-endpoint timeout; default 10000.
- `MATT_MINE_ADMIN_WALLETS`: exact comma-separated Admin addresses.
- `MATT_MINE_ELIGIBILITY_COUNSEL_APPROVED`: must remain false until counsel approval.
- `MATT_MINE_ELIGIBILITY_RULES_VERSION`: immutable approved rules identifier.
- `MATT_MINE_ELIGIBLE_PAID_WALLETS`: server-controlled eligible wallet allowlist.
- `MATT_MINE_BACKUP_AGE_RECIPIENT`: age public recipient for encrypted backups.
- `MATT_MINE_BACKUP_DIRECTORY`: operator-selected off-platform staging path.
- `RENDER_GIT_COMMIT` or `GIT_COMMIT`: health/replay build correlation.

Existing secrets remain server-side. Never put them in `VITE_*`, HTML, JS, query strings, screenshots, or support tickets.

## Migration order

1. Take and verify an encrypted off-platform backup. Record restore checksum and object-retention policy.
2. Deploy migrations only with paid features paused. Run `db:migrate`.
3. Run repeatable `db:backfill` until counts stabilize.
4. Run `db:validate`; investigate every discrepancy. Do not cut over with any financial mismatch.
5. Deploy compatibility application with legacy reads and dual writes.
6. Observe at least one full competition/payment reconciliation window.
7. Separately approve normalized read cutover in a later change.
8. Separately reactivate financial features after readiness, counsel and Safe checks.

## Rollback order

1. Pause server payment entry points; do not pause reconciliation workers.
2. Preserve transaction hashes and in-flight operations.
3. Run `db:rollback:dry-run` and capture output.
4. Apply the lossless rollback to legacy reads/dual-write off.
5. Deploy the prior compatible application.
6. Reconcile chain-verified operations before considering reactivation.
7. Never drop the normalized schema or truncate ledger/audit/payment history.

## Backups, PITR, RPO and RTO

Enable Render PostgreSQL PITR/backups through an approved operator after confirming plan support; do not infer that the current plan includes the required retention. Target RPO is five minutes with WAL/PITR and daily encrypted off-platform dumps. Target RTO is two hours.

Off-platform procedure: run `db:backup` from a restricted host; upload the `.dump.age` object to a separate provider with versioning, immutability and access logging; verify decryptability and `pg_restore --list`; delete only the restricted-host staging copy after checksum confirmation. Keep the age private key offline and separate from Render.

Quarterly restore drill: create an isolated empty PostgreSQL instance; decrypt; restore without owner/ACL; run migrations; run `db:validate`; compare wallet, run, receipt, reward and ledger counts/hashes; execute read-only smoke tests; record actual RPO/RTO; destroy the isolated instance under the approved retention policy.

## Incident procedure

1. Pause only affected entry/payment/reward controls; never delete receipts or return entries automatically.
2. Capture commit, request ID, run/quote IDs and transaction hashes without secrets/signatures.
3. Check `/api/live`, `/api/ready`, DB pool, RPC circuits and Safe owner/threshold response.
4. Run read-only `db:reconcile`; classify paid-not-credited, credited-not-finalized, duplicate, unknown-COMMIT and stale reserved states.
5. For chain-verified items, never release or expire the reservation. Complete ledger/finalization exactly once by idempotency key.
6. Resume the original Arena/revive run where possible. Invalid gameplay never receives recovery.
7. Require step-up Admin signature and permanent audit for manual reconciliation.
8. Publish a player-facing status without transaction details or wallet PII.
