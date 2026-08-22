# NFT V2 launch economy presets

Status: candidate configuration for Treasury, Game Economy, Security, and legal review. Nothing in this document authorizes an on-chain transaction.

## Release rule

Every economic change is a versioned release decision. Do not type an improvised value into Admin.

An approved preset record must contain:

- preset name and semantic version;
- exact map ID, content hash, and version ID;
- five phase-XP values;
- mineable-unit ceiling, conversion rate, payout ceiling, and timeout;
- repair and six chest prices;
- minimum, wallet-daily, and global-daily withdrawal limits;
- expected run volume and maximum daily Crystal banking;
- MATT/USD reference source, price, and UTC timestamp for MATT-denominated purchases;
- approvers, execution transaction hashes, and post-write readback;
- stop thresholds and rollback route.

Active runs retain their snapshotted rules. New values affect only runs opened after the new route is confirmed.

## Units

- Mined Crystal units are in-game integers.
- Conversion rate is MATT Crystal token wei per mined unit. MATT Crystals use 18 decimals.
- Maximum payout is a hard safety ceiling, not a promised reward.
- The contract applies the smallest of carried value, map conversion, payout ceiling, and its immutable ceiling.
- Death then applies the selected Miner's fixed retention percentage.
- Gameplay-bank Crystals are internal contract credit until a successful withdrawal mints the wallet token.

For a run:

~~~text
carried_units = min(replayed_mined_units, effective_carry_capacity)
gross_crystals = min(carried_units * conversion_rate, maximum_payout)
extraction_bank = gross_crystals
death_bank = floor(gross_crystals * death_retention_bps / 10,000)
~~~

Practice does not use this formula. It always awards zero Miner XP and zero MATT Crystals.

## Candidate launch preset: conservative-v1

These are proposed initial values, not live-state claims.

| Setting | Practice | MATT Arena | Pass Mine |
| --- | ---: | ---: | ---: |
| Miner required | No | Yes | Yes |
| Phase XP | 0 / 0 / 0 / 0 / 0 | 10 / 15 / 20 / 25 / 30 | 15 / 20 / 25 / 30 / 35 |
| Perfect extraction XP | 0 | 100 | 125 |
| Mineable-unit ceiling | 0 | 3,750 | 3,750 |
| Crystals per mined unit | 0 | 0.0025 | 0.005 |
| Conversion rate raw | 0 | 2,500,000,000,000,000 | 5,000,000,000,000,000 |
| Maximum payout | 0 | 10 Crystals | 20 Crystals |
| Maximum payout raw | 0 | 10,000,000,000,000,000,000 | 20,000,000,000,000,000,000 |
| Run timeout | Client-only | 7,200 seconds | 7,200 seconds |

The maximum effective carry capacity described by the V2 specification is 3,750 units. At that carry:

- MATT Arena banks at most 9.375 Crystals on extraction.
- Pass Mine banks at most 18.75 Crystals on extraction.
- The proposed 10 and 20 Crystal payout ceilings leave only a narrow rounding margin.

At the Level 1 base capacity of 750:

- MATT Arena banks 1.875 Crystals on extraction.
- Pass Mine banks 3.75 Crystals on extraction.

Before approving a map with the 3,750-unit ceiling, prove that the authoritative settlement submits carried units after the carry cap. If replay submits total mined units before the cap, keep the map's larger mineable ceiling and rely on the much smaller payout ceiling.

## XP pacing

The fixed Level 100 target is 360,000 banked XP.

- Arena at 100 XP for twenty perfect extractions per day reaches the target in 180 days.
- Pass at 125 XP for twenty perfect extractions per day reaches the target in 144 days.

This is an upper-bound activity scenario, not a player promise. Raising Pass XP also accelerates entry into Level 100 passive rewards. Economy approval must model that future passive liability before increasing XP.

Phase XP must be positive for an enabled reward map. Practice stays outside NFT Settlement and must never receive a nonzero phase array.

## Withdrawal presets

Use lower active limits than the immutable ceilings during rollout.

| Stage | Minimum withdrawal | Wallet daily limit | Global daily limit |
| --- | ---: | ---: | ---: |
| Staff canary | 100 Crystals | 500 Crystals | 5,000 Crystals |
| Closed beta | 100 Crystals | 500 Crystals | 25,000 Crystals |
| Public initial | 100 Crystals | 1,000 Crystals | 100,000 Crystals |
| Expanded | Separate approval | Separate approval | Separate approval |

The contract's immutable ceilings remain much higher. They are disaster bounds, not launch targets.

If the beta needs to exercise a withdrawal before an ordinary tester reaches the minimum, use a designated test Miner and a documented canary settlement. Do not lower the public minimum temporarily without a versioned decision and readback.

Never raise a withdrawal limit because the current limit is nearly full until:

1. every bank credit and mint reconciles;
2. no duplicated or unexplained event exists;
3. the daily emission budget is still valid;
4. Treasury and Security approve the higher exposure.

## Repair and chest pricing

Prices are paid in MATT and must be derived from an approved, timestamped MATT/USD reference. Do not preserve a stale MATT token amount merely because it was deployed previously.

Candidate targets from the V2 specification:

| Action | Target |
| --- | ---: |
| Armor repair | USD 1 equivalent |
| Pickaxe chest | USD 2 equivalent |
| Blaster chest | USD 2 equivalent |
| Dynamite chest | USD 2 equivalent |
| Helmet chest | USD 2 equivalent |
| Armor chest | USD 5 equivalent |
| Backpack chest | USD 5 equivalent |

Calculation:

~~~text
MATT amount = round_up(target USD / approved MATT USD price, approved token increment)
raw amount = MATT amount * 10^18
~~~

The release record must name the price source, retrieval time, rounding increment, and reviewer. If the source is stale, unavailable, or materially divergent from another liquid source, do not change prices.

Chest odds and equipment definitions require a separate supply and expected-value review. A USD target alone does not prove that a chest is economically safe or fair.

## Daily Crystal budget

Approve a daily banking budget before enabling reward settlements:

~~~text
daily budget =
  sum for each mine(
    maximum eligible starts
    * maximum payout per run
    * expected settlement success allowance
  )
  + passive payout allowance
~~~

Use the hard maximum, not the average outcome, for the safety budget. Model extractions and deaths separately for forecasting, but do not use expected deaths to justify a safety cap.

Candidate rollout budgets:

| Stage | Reward-bearing starts | Banked gameplay-Crystal stop threshold |
| --- | ---: | ---: |
| Staff canary | Explicit named run list | 500 Crystals per UTC day |
| Closed beta | Allowlisted cohort cap | 5,000 Crystals per UTC day |
| Public initial | Approved traffic cap | 80% of the approved daily budget |

MATT Arena currently permits repeated entries by design. If no reviewed traffic or entry cap bounds Crystal-bearing Arena starts, keep its Crystal route closed. A withdrawal ceiling limits daily minting but does not limit accumulated bank liability.

## Alert and stop thresholds

Pause new reward-bearing starts when any condition occurs:

- one incorrect Crystal or XP settlement;
- one duplicate credit, withdrawal, burn, or passive assignment;
- one settlement failure with unknown chain outcome;
- any unreconciled on-chain Miner lock beyond its recovery age;
- daily Crystal banking reaches 80% of budget;
- global withdrawal usage reaches 80% of its active limit;
- non-cheat result rejection reaches 5% over a rolling hour;
- Settlement, Bank, role, signer, RPC, metadata, or VRF health becomes unknown;
- Operator or Keeper RON falls below the approved reserve.

At 100% of the daily budget, reward settlements are a critical incident. Do not simply increase the budget.

## Preset approval packet

Before execution, produce a machine-readable or tabular packet with:

1. Current on-chain values read at a named block.
2. Proposed values and exact raw integers.
3. Difference for every field.
4. Maximum per-run and per-day exposure before and after.
5. XP-to-Level-100 pacing before and after.
6. Withdrawal capacity before and after.
7. MATT/USD price evidence and purchase-price math.
8. Active map and rollback map version IDs.
9. Transaction order and partial-failure procedure.
10. Treasury, Security, Game Economy, and Release approvals.

The existing economy update sends multiple transactions sequentially. After each receipt, read every affected field. If a later write fails, stop and treat the state as a partial rollout; do not report the preset as applied.

## Execution order

1. Pause new reward-bearing entries.
2. Allow safe active results to settle.
3. Record active runs and their pinned map versions.
4. Read and archive current protocol values.
5. Apply Bank, repair, and chest changes in the approved order.
6. Approve the new versioned map without retiring the rollback map.
7. Set and read back that map's phase XP.
8. Route new runs to the new version.
9. Re-run live protocol, role, metadata, and operations checks.
10. Open only the next approved cohort.

Do not retire the prior map merely to make the Admin screen cleaner. Retirement is permanent and active runs may still depend on the previous version.

## Rollback

- Pause new entries first.
- Preserve result settlement when settlement is safe; otherwise Miners may remain locked.
- Route new runs back to the last approved, non-retired map.
- Reapply the last approved Bank and purchase-price values with exact readback.
- Reconcile all runs opened under the changed preset.
- Record why the stop threshold fired and whether any player-facing correction is required.
- Require a new approval packet before resuming.

Rollback never deletes run history, rewrites a confirmed payment, reduces banked XP, or fabricates a Crystal adjustment.

## Expansion rule

Hold conservative-v1 for at least seven clean UTC days after public canary begins. Expansion requires:

- all closed-beta exit criteria;
- no unresolved severity-1 or severity-2 incident;
- complete server-to-chain conservation reports;
- stable extraction, death, and rejection distributions;
- withdrawal capacity below 80%;
- passive-reward liability included in the next budget;
- a newly approved preset version.

Change one economic dimension at a time. Do not raise conversion, payout, XP, entry capacity, and withdrawal limits in the same observation window.
