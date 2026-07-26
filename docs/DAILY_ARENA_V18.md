# MATT Daily Arena v1.8

MATT Daily Arena is a separate, player-funded daily competition. It does not modify or replace the live Pass, Paid Runs, Swap Executor, or Rewards contracts.

## Locked economic rules

- One UTC day is one Arena.
- The Treasury sets the entry price before the day starts.
- The entry price must be from 25,000 to 1,000,000 MATT.
- Entries are unlimited.
- The player-funded pool has no ceiling.
- Every accepted entry is reserved for that day's winners.
- The Treasury can seed a day cumulatively with up to 10,000,000 MATT.
- Nothing is burned and the Arena takes no house fee.
- Only one result per wallet can rank: its best accepted daily score.
- The complete pool is paid to up to ten eligible wallets.
- Onchain entry closes 25 minutes before 00:00 UTC, reserving 20 minutes for a full run and five minutes for confirmation.

Payout weights are:

| Rank | Weight |
|---:|---:|
| 1 | 30% |
| 2 | 18% |
| 3 | 12% |
| 4 | 8% |
| 5 | 7% |
| 6 | 6% |
| 7 | 5.5% |
| 8 | 5% |
| 9 | 4.5% |
| 10 | 4% |

If fewer than ten wallets qualify, only the occupied weights are used and normalized to 100%. Integer rounding dust is assigned to first place so the exact raw MATT pool is distributed.

## Contract custody

`MattMineDailyArena` is a non-upgradeable, isolated escrow contract.

It:

- accepts the exact scheduled MATT entry amount;
- deploys with player entries paused so publishing the address cannot accept MATT;
- records every entry with a unique onchain entry number;
- rejects entries after the onchain 25-minute cutoff before transferring MATT;
- keeps a global reserved-balance ledger across all active and canceled days;
- rejects fee-on-transfer deposits through exact balance accounting;
- prevents reserved prize or refund MATT from being recovered as excess;
- caps only the Treasury seed, never player entries;
- requires every settlement winner to have entered that day;
- rejects duplicate winners and any allocation that does not equal the exact pool;
- transfers prizes directly to winners after settlement;
- returns the seed to the configured Treasury and enables exact per-wallet refunds after cancellation;
- supports separate entry and settlement emergency pauses;
- allows the seed-funding Treasury destination and `TREASURY_ROLE` to rotate only during a full pause with no reserved MATT.

That rotation does not migrate `DEFAULT_ADMIN_ROLE`. A complete Safe migration must separately grant the new Safe default admin, verify it onchain, and revoke the old Safe through standard `AccessControl` transactions.

The intended production role model is:

| Role | Intended controller |
|---|---|
| Default admin | MATT Mine 2-of-3 Treasury Safe |
| Treasury | MATT Mine 2-of-3 Treasury Safe |
| Settler | MATT Mine 2-of-3 Treasury Safe |
| Pricer | MATT Mine 2-of-3 Treasury Safe |
| Emergency pauser | Separate low-balance emergency wallet |

The settlement contract intentionally does not calculate game scores. The Safe transaction is the final reviewed authorization boundary and displays the complete winner list and exact raw amounts before signing.

## Daily operating flow

1. Before 00:00 UTC, an administrator selects the next UTC day, entry price, optional seed, and written reason.
2. The server produces ordered Safe Transaction Builder JSON:
   - schedule the day;
   - approve the exact seed when needed;
   - seed the day.
3. Two Safe signers inspect and execute that file.
4. Players approve MATT when required and call `enter(dayId)`.
5. The server verifies the exact `ContestEntered` receipt before granting one attempt.
6. Each accepted entry grants one attempt; buying another entry grants another attempt.
7. At 00:00 UTC, entry and scoring close; leaderboard reads remain provisional.
8. Administrators finish anti-cheat review and suspend ineligible wallets.
9. The explicit settlement action freezes the moderated best score per eligible wallet into one immutable snapshot.
10. The server allocates the exact onchain pool and exports one settlement Safe JSON file.
11. Two Safe signers compare the day, pool, winner addresses, and raw amounts before execution.

If the day must be canceled, the Safe executes `cancelDay(dayId)`. The contract immediately returns the Treasury seed and entrants claim the exact MATT they paid.

## Server storage

PostgreSQL stores:

- immutable daily fee and seed snapshots;
- confirmed entry receipts and one-use attempt entitlements;
- Arena runs and transcript checkpoints;
- best score per wallet;
- daily leaderboard snapshots;
- settlement drafts.

Confirmed transaction hashes and log indexes are unique, so one payment event cannot create multiple attempts.

## Mandatory security gate

The current browser integration emits signed batches of gameplay milestones. That is useful for exercising storage, receipts, leaderboard ordering, settlement allocation, cancellation, and Safe exports, but a modified browser could still forge plausible outcome milestones.

For that reason:

- `ARENA_REPLAY_READY` is compiled as `false`;
- `MATT_MINE_ARENA_LIVE=true` cannot override it;
- entry quotes, confirmations, run starts, event submissions, and finishes return `arena_live_disabled`;
- schedule-package generation and entry-unpause preparation are also blocked;
- the public screen clearly labels the feature as a security preview;
- no player MATT transaction can be prepared by this release.

Real paid entry must not be activated until a reviewed release deterministically simulates raw movement, aim, attack, dash, and weapon inputs on the server.

## Environment

The preview and administration paths require:

```text
MATT_MINE_ARENA_CONTRACT_ADDRESS=<verified isolated Arena contract>
MATT_MINE_ARENA_RECEIPT_SECRET=<at least 32 random characters>
MATT_MINE_ARENA_SEED_SECRET=<independent random secret>
MATT_MINE_ARENA_SAFE_ADDRESS=0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc
MATT_MINE_ARENA_LIVE=false
```

`MATT_MINE_ARENA_LIVE` must remain `false` for v1.8.

## Isolated deployment tooling

The Arena has its own guarded deployment record at `contracts/deployments/arena-ronin.json`; it never reuses or rewrites the four-contract production record. These commands are intentionally documented for a later reviewed activation and must not be run merely to test this preview:

```powershell
$env:MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS = "0x..."
npm.cmd run contracts:check-arena-deployer:ronin

$env:MATT_MINE_ARENA_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_DAILY_ARENA_TO_RONIN_MAINNET"
npm.cmd run contracts:deploy-arena:ronin
Remove-Item Env:MATT_MINE_ARENA_MAINNET_CONFIRMATION -ErrorAction SilentlyContinue

npm.cmd run contracts:verify-arena:ronin
npm.cmd run contracts:check-arena-deployment:ronin
Remove-Item Env:MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS -ErrorAction SilentlyContinue
```

The deployment preflight binds the encrypted signer to its expected public address, requires a three-times gas estimate buffer, validates the existing live MATT token and 2-of-3 Treasury Safe, and broadcasts nothing. Deployment is resumable from the predicted CREATE address, nonce, and transaction hash. Verification accepts only an exact Sourcify creation and runtime match. None of these commands schedules a day, transfers MATT, or enables paid play.

## Activation checklist for a later release

- Obtain counsel for every jurisdiction where paid Arena entry will be offered.
- Add location and age eligibility enforcement approved by counsel.
- Replace milestone telemetry with input-only deterministic server replay.
- Commission an independent contract and game-server security review.
- Deploy the isolated contract conventionally from the approved deployer.
- Exact-match verify the source on Ronin.
- Confirm all roles, pauses, token address, Treasury address, and empty reserves.
- Exercise schedule, seed, entry, cancellation, refund, and settlement with controlled amounts.
- Reconcile contract MATT balance against `totalReservedMatt`.
- Add monitoring for deposits, pool changes, cancellations, settlements, and failed refunds.
- Enable production paid entry only in a new reviewed release, then have the independent emergency pauser explicitly unpause entries.
