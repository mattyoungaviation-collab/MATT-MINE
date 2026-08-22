# MATT Mine closed beta runbook

Status: operational release candidate. This runbook does not authorize a contract transaction, a public sale, paid competition, or public reward activation.

## Purpose

The closed beta proves that a real player can complete the full production path without losing a paid entitlement, locking a Miner, receiving the wrong XP or Crystal amount, or being left without a documented recovery path.

The beta is complete only when both conditions are true:

1. Product behavior is understandable on representative desktop and mobile devices.
2. Every economic state change reconciles across the browser, server database, Ronin transaction receipt, NFT metadata, and Admin audit history.

The rewardless developer Beta Mine is useful for combat tuning, but it does not test the NFT V2 economy. Economic beta cases must use an explicitly allowlisted canary route with conservative limits and real production-shaped settlement.

## Required roles

Assign names before the first session. One person may fill more than one non-conflicting role, but the Reward Signer and Game Operator remain separate wallets.

| Role | Responsibility |
| --- | --- |
| Release commander | Owns go, hold, rollback, and incident decisions |
| Game operator | Starts and settles approved canary runs |
| Reward signer custodian | Protects the independent signing key and verifies signer health |
| Treasury reviewer | Verifies prices, limits, balances, and withdrawal reconciliation |
| Emergency pauser | Can stop the affected on-chain module without broader authority |
| Support lead | Owns tester communication, run lookup, and evidence collection |
| Security lead | Reviews anomalies, wallet reports, replay rejections, and key exposure |
| Recorder | Maintains the run ledger, decisions, defects, and evidence links |

No release commander may waive a critical security or conservation failure without a written accepted-risk decision from the accountable owner.

## Cohort and environment

- Use 25 to 100 invited testers.
- Include injected Ronin Wallet and WalletConnect users.
- Include current iPhone Safari, Android Chrome, desktop Chrome, Firefox, Edge, and Safari where available.
- Include low-powered mobile devices and at least two common desktop resolutions.
- Include new wallets, returning wallets, one-Miner wallets, and multi-Miner wallets.
- Keep public indexing, broad invitations, and unrestricted paid entry disabled.
- Give each tester a support identifier that is not their legal name.
- Never request a seed phrase or private key.

Use three cohorts:

1. Staff canary: 5 to 10 operators, all cases, minimal economic amounts.
2. Trusted beta: 20 to 40 invited players, supervised economic cases.
3. Release candidate: up to 100 players, normal product flow under the approved launch caps.

Advance one cohort at a time. A critical incident returns the beta to the previous safe cohort.

## Entry gate

Record evidence for every item.

- [ ] Exact commit, deployment ID, UTC start time, and environment are recorded.
- [ ] Timelocked Settlement implementation is executed, source verified, and independently checked.
- [ ] Contract implementation slots and active map versions match the release record.
- [ ] Reward Signer and Game Operator addresses are different and hold only their intended roles.
- [ ] Operator, Keeper, and Emergency Pauser RON balances exceed the approved reserves.
- [ ] Both VRF consumers are registered and the subscription is funded.
- [ ] Database backup completed; restore drill evidence is current.
- [ ] Practice remains available if every economic module is paused.
- [ ] Per-mine entries, results, payments, and rewards switches were exercised.
- [ ] The complete 1,000-Miner marketplace validator passes.
- [ ] Launch economy preset, daily bank budget, withdrawal limits, and stop thresholds are approved.
- [ ] Terms, Privacy, disclosures, and applicable competition rules have counsel approval.
- [ ] Support and incident channels have an assigned owner for the entire session.
- [ ] Monitoring receives current database, RPC, metadata, contract, role, RON, VRF, run, and economy signals.
- [ ] A synthetic critical signal reaches the on-call recipient and is acknowledged.

Run the validator from a trusted workstation. Supply RPC credentials through the environment or secret manager, not command history:

~~~text
node scripts/validate-nft-marketplace.mjs --origin https://matt-mine.onrender.com --public-origin https://mattmine.com --from 1 --to 1000 --concurrency 8 --expect-initial-state --json
~~~

After tokens begin progressing or transferring, omit the initial-state flag but continue validating all metadata and images. Supply the expected sales wallet only while the inventory is intentionally held by that wallet.

Run the standalone release checks:

~~~text
node --test tests/nft-marketplace-validation.test.mjs tests/operations-monitor.test.mjs
~~~

## Test ledger

For every test record:

- case ID and tester ID;
- wallet address;
- Miner ID and equipment token IDs;
- mine and active map version;
- browser, operating system, screen size, and wallet connection method;
- server run ID, on-chain run ID, and all transaction hashes;
- expected and observed XP, mined units, banked Crystals, Armor state, and Backpack state;
- start, result, confirmation, and metadata-refresh times;
- result: pass, fail, blocked, or not applicable;
- screenshots or exported logs with secrets removed;
- defect or incident ID.

Do not put session tokens, signatures, cookies, private RPC URLs, or private keys in the ledger.

## Required scenarios

### Access and navigation

- [ ] CB-001: A new player starts Practice from Home without a wallet.
- [ ] CB-002: Practice ends with zero Miner XP, zero MATT Crystals, and no NFT mutation.
- [ ] CB-003: Injected Ronin Wallet sign-in succeeds after the non-transactional message.
- [ ] CB-004: WalletConnect desktop and mobile handoff both succeed.
- [ ] CB-005: Rejecting account access or the sign-in message returns to a usable screen.
- [ ] CB-006: Wrong network produces a clear Ronin Mainnet instruction and no paid action.
- [ ] CB-007: Account switching clears the prior wallet's Miner, balance, and session state.
- [ ] CB-008: A wallet with multiple Miners can select the intended Miner by number.

### Miner and loadout

- [ ] CB-020: Every owned Miner shows the correct ID, level, evolution, traits, and run-lock state.
- [ ] CB-021: Equip and unequip each of the six equipment slots.
- [ ] CB-022: An item equipped to another Miner cannot be reused.
- [ ] CB-023: A loadout change refreshes Miner and Equipment metadata.
- [ ] CB-024: A run-locked Miner cannot change loadout or repair; wallet-scoped withdrawal still follows only the Bank's pause, balance, minimum, and daily-limit rules.
- [ ] CB-025: Transfer an equipped Miner in the designated test environment and verify custody follows it.
- [ ] CB-026: Wallet-owned banked gameplay Crystals do not transfer with the Miner.

### Extraction and death

- [ ] CB-040: Start authorization binds player, Miner, map, loadout, nonce, and deadline.
- [ ] CB-041: A complete extraction banks the approved cumulative phase XP exactly once.
- [ ] CB-042: A partial extraction banks only the completed-phase XP.
- [ ] CB-043: Extraction banks the exact converted Crystal amount within carry and payout caps.
- [ ] CB-044: Extraction preserves healthy Armor and the equipped Backpack.
- [ ] CB-045: Death banks zero session XP.
- [ ] CB-046: Death applies the Miner's exact Crystal-retention percentage with deterministic rounding.
- [ ] CB-047: Death damages equipped Armor and removes its shield effect.
- [ ] CB-048: Death burns the equipped Backpack and no other equipment.
- [ ] CB-049: Duplicate result submission cannot duplicate XP, Crystals, damage, or burns.
- [ ] CB-050: A lost HTTP response after a confirmed settlement recovers the processed run.

### Recovery

- [ ] CB-060: Refresh during an active run restores the correct pinned run or presents the approved recovery action.
- [ ] CB-061: Browser crash does not create a second paid entitlement or second on-chain run.
- [ ] CB-062: Player abandonment clearly warns that it settles as death.
- [ ] CB-063: Orphan recovery unlocks only a Miner owned by the signed-in wallet.
- [ ] CB-064: Admin wallet lookup and mine-wide lookup identify every stale server run.
- [ ] CB-065: Admin termination is reconciled against the on-chain Miner lock before support closes the case.
- [ ] CB-066: Arena lost-token release consumes the original entry and records no score.
- [ ] CB-067: Database or RPC interruption returns a retryable error and does not invent success.

### Bank, repair, chests, and passive rewards

- [ ] CB-080: Bank balance increases by the settlement receipt amount.
- [ ] CB-081: Below-minimum, above-balance, wallet-limit, and global-limit withdrawals fail safely.
- [ ] CB-082: A valid withdrawal debits the bank and mints the same token amount exactly once.
- [ ] CB-083: Armor repair charges the displayed MATT price and restores the shield.
- [ ] CB-084: Chest purchase charges the displayed MATT price and pins one VRF request.
- [ ] CB-085: Chest fulfillment mints exactly one item from the approved slot pool.
- [ ] CB-086: A delayed chest follows the original retry or refund path without rerolling.
- [ ] CB-087: Level 100 requests one permanent passive rate and cannot reroll it.
- [ ] CB-088: Activity expires after the approved window and resumes without retroactive earnings.
- [ ] CB-089: Daily passive payout is correct across ownership changes and UTC boundaries.

### Operations and security

- [ ] CB-100: Each mine can pause new entries while active results remain recoverable.
- [ ] CB-101: Settlement, Bank, Chest, and Passive Rewards pause independently.
- [ ] CB-102: A stale or unauthorized Admin step-up cannot change protocol settings.
- [ ] CB-103: Reward Signer alone cannot settle and Game Operator alone cannot invent a result.
- [ ] CB-104: Low RON, low VRF funding, failed settlement, stale run, rejected-run spike, and RPC outage each trigger an alert.
- [ ] CB-105: Metadata validation failure blocks listing approval.
- [ ] CB-106: Logs contain request and run correlation but no secrets or full sensitive payloads.
- [ ] CB-107: Restore from backup preserves economic obligations and processed-run protection.

## Metrics and definitions

Calculate metrics from server-authoritative events, not browser analytics alone.

| Metric | Definition |
| --- | --- |
| Wallet connection success | Successful wallet sessions divided by explicit connection attempts |
| First-run start | New eligible players who start a run divided by new eligible signed-in players |
| Technical completion | Runs that reach a confirmed settlement or approved abandonment divided by started runs |
| Extraction rate | Confirmed extractions divided by confirmed extraction plus death settlements |
| Stuck-run rate | Runs beyond their approved recovery age divided by started runs |
| Rejection rate | Non-cheat replay or settlement rejections divided by submitted results |
| Settlement success | Correct confirmed settlements divided by settlement attempts |
| D1 retention | Cohort players active on UTC day 1 after their first day divided by first-day players |
| D7 retention | Cohort players active on UTC day 7 divided by first-day players |
| MATT spend | Confirmed MATT transfers by action and wallet, excluding failed or replaced transactions |
| Crystal banking | Sum of contract Crystal-bank credits by outcome and map |
| Crystal withdrawal | Sum of successful Bank withdrawal events |
| Recovery time | Time from first stuck signal to server and on-chain reconciliation |

Extraction and death rates are balance signals, not standalone quality scores. Investigate sudden changes by map, Miner level, device, and client version.

## Exit thresholds

All release thresholds must hold for seven consecutive UTC days:

- At least 25 distinct testers and 500 total runs.
- At least 100 reward-bearing settlements, including 25 extractions and 25 deaths.
- At least 20 successful withdrawals and one tested wallet/global limit rejection.
- Wallet connection success at least 98%.
- Settlement success at least 99.5%.
- Zero incorrect payouts, duplicated settlements, unauthorized state changes, or unreconciled token burns.
- Zero runs left stuck beyond the approved recovery age.
- Non-cheat rejection rate below 1%.
- All 1,000 metadata and image records pass after the final code deployment.
- No unresolved severity-1 or severity-2 incident.
- Crystal banking and withdrawals remain within the approved daily budget.
- Every recovery case has matching server, chain, and audit evidence.

D1 and D7 retention are reported with cohort size and confidence context. They inform product rollout but never excuse a failed safety threshold.

## Incident response

### Severity 1: stop immediately

Examples: wrong recipient or amount, duplicated mint/credit, unauthorized Admin action, signer compromise, loss of processed-run protection, impossible supply change, or inability to pause.

1. Pause new entries in the affected mine.
2. Pause the affected economic contract if settlement itself is unsafe.
3. Preserve result processing when it is safe and required to unlock existing Miners.
4. Record UTC time, actor, reason, affected run IDs, transaction hashes, and balances.
5. Revoke or rotate exposed operational secrets.
6. Reconcile every affected wallet and do not resume during the same incident window.

### Severity 2: hold the cohort

Examples: stuck on-chain Miner, failed settlement, sustained RPC outage, metadata corruption, VRF delay past the critical threshold, or database recovery with unknown outcome.

Stop cohort expansion, preserve evidence, reconcile the chain, and require Release Commander plus Security approval before resuming.

### Severity 3: correct before next cohort

Examples: confusing copy, recoverable layout defect, elevated latency, or isolated supported-device issue with no economic impact.

Track an owner and due date. Do not silently reclassify an economic defect as a product defect.

## Daily operating cadence

At beta opening:

- verify exact deployed commit and public configuration;
- verify every required monitor is current;
- record all operational and VRF balances;
- reconcile prior-day runs, bank credits, withdrawals, chest requests, and passive payouts;
- confirm no unresolved run locks.

Every four hours:

- review settlement failures and rejection codes;
- review active and aged runs;
- compare Crystal banking and withdrawal totals with the budget;
- review RPC, database, VRF, and wallet balances;
- review tester support reports.

At UTC close:

- export an immutable beta summary;
- reconcile server totals to contract events;
- record incident and defect decisions;
- approve, hold, reduce, or expand the next cohort.

## Beta completion record

The final record must contain:

- exact commit and deployment identifiers;
- contract addresses, implementation slots, map versions, and XP arrays;
- approved economy preset and MATT price reference;
- cohort counts, device coverage, and every exit metric;
- full incident and unresolved-defect list;
- metadata validator report;
- operations health report;
- Treasury and Security reconciliation signatures;
- counsel-approved public documents and rules version;
- explicit go or no-go decision with UTC timestamp.
