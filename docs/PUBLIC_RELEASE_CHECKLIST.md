# MATT Mine public release checklist

Status: mandatory release gate. An unchecked box means the release is not approved.

This checklist separates technical readiness from authority to perform a transaction, change production, list an NFT, open paid entry, or publish rewards. Those actions require their named human approvals.

## Release record

Complete before review:

| Field | Value |
| --- | --- |
| Release version | |
| Git commit | |
| Build/deployment ID | |
| Release commander | |
| UTC decision window | |
| Ronin network and chain ID | Ronin Mainnet / 2020 |
| Settlement proxy and implementation | |
| Timelock operation ID | |
| Active Arena map version | |
| Active Pass map version | |
| Economy preset version | |
| Rules, Terms, Privacy, and disclosure versions | |
| Rollback deployment and map versions | |
| Evidence folder | |

Every address, hash, amount, and timestamp is copied from a read-only source and independently compared by a second reviewer.

## Gate 0: stop conditions

Proceed only when every statement below is true. Any unchecked or false statement stops the release:

- [ ] No severity-1 or severity-2 incident is open.
- [ ] No contract transaction has an unknown outcome.
- [ ] No Miner is left in an unreconciled server/on-chain lock.
- [ ] No unexplained Crystal credit, withdrawal, equipment burn, or MATT transfer exists.
- [ ] No required private key or session secret is suspected exposed.
- [ ] No required monitor is missing or stale.
- [ ] No counsel-required document or jurisdiction decision is pending.
- [ ] No high-severity audit finding remains unresolved or unaccepted.

If any statement cannot be proved, stop.

## Gate 1: Settlement upgrade and contracts

- [ ] The 48-hour timelock reached its exact executable timestamp.
- [ ] The operation ID, proxy, implementation, calldata, salt, and predecessor match the reviewed schedule.
- [ ] The new implementation has exact source verification.
- [ ] Upgrade execution receipt succeeded on chain 2020.
- [ ] Proxy implementation slot equals the approved implementation.
- [ ] Settlement storage, roles, active runs, and prior map versions remain intact.
- [ ] Per-map phase XP reads correctly for Arena and Pass.
- [ ] New runs snapshot phase XP; existing runs preserve their previous snapshot.
- [ ] Duplicate processing protection still rejects a processed run.
- [ ] Force-abandon timing and death consequences match the specification.
- [ ] Miner, Equipment, Loadout, Crystal Bank, Passive Rewards, Settlement, Chest, and both VRF adapters have expected code.
- [ ] Every source and proxy record is linked in the evidence folder.

Run all read-only Mainnet checks after the upgrade. A successful upgrade transaction alone is not evidence that the system is ready.

## Gate 2: authority and key custody

- [ ] Root/default-admin custody matches the approved governance plan.
- [ ] Reward Signer and Game Operator are different addresses.
- [ ] Config Operator, Keeper, Emergency Pauser, Treasury, and marketplace inventory roles match the role map.
- [ ] Bootstrap routine roles are revoked where the activation plan requires.
- [ ] The game server contains no Root or Treasury private key.
- [ ] Every server key resolves to its configured public address at startup.
- [ ] Hardware or secret-manager custody and backup procedures are documented.
- [ ] Key rotation was rehearsed without exposing secret material.
- [ ] Emergency Pauser can pause each intended module but cannot change unrelated configuration.
- [ ] Treasury Safe owner set and threshold are read live and independently verified.
- [ ] Operator, Keeper, and Pauser RON balances exceed approved reserves.
- [ ] Low-balance alerts reach the assigned on-call owner.

## Gate 3: code, database, and recovery

- [ ] Clean install uses the pinned Node and lockfile versions.
- [ ] JavaScript checks, security lint, formatting check, game tests, contract tests, and browser tests pass.
- [ ] No high dependency vulnerability lacks a documented accepted-risk decision.
- [ ] Production database migration and validation are idempotent.
- [ ] Encrypted off-platform backup is current.
- [ ] Restore drill meets approved RPO and RTO.
- [ ] PostgreSQL interruption returns retryable responses without losing economic state.
- [ ] Unknown transaction outcome is reconciled before retry.
- [ ] Run start and settlement are idempotent across lost HTTP responses.
- [ ] Active pre-deploy runs use their pinned engine, map, traits, and economic values.
- [ ] Server, replay store, and chain run IDs can be correlated.
- [ ] Admin support can find a case by wallet, Miner ID, and run ID.
- [ ] Admin run termination is reconciled to the on-chain Miner lock before closure.
- [ ] Audit and player activity histories capture every support mutation with actor and reason.

Focused release-operations tests:

~~~text
node --test tests/nft-marketplace-validation.test.mjs tests/operations-monitor.test.mjs
~~~

## Gate 4: metadata and marketplace

- [ ] All 1,000 Miners exist and the expected inventory ownership is proven before sale.
- [ ] Every initial Miner has the approved identical Level 1 traits.
- [ ] Every metadata name matches its token ID.
- [ ] Every metadata record contains the required unique attributes.
- [ ] Every Miner image is PNG, 960 by 960 pixels, below 1,000,000 bytes, and returns a valid ETag.
- [ ] Both contract metadata records pass.
- [ ] All manifest assets exist and use approved artwork.
- [ ] Every on-chain token URI exactly matches the final metadata origin, token path, and numeric revision query.
- [ ] The validator fetched every exact on-chain token URI and proved its response matches both the canonical endpoint and authoritative `traitsOf` state.
- [ ] Contract URI uses the final HTTPS metadata origin.
- [ ] Chain ID 2020 was proved before any contract inventory read.
- [ ] Images and metadata load from an external non-admin network.
- [ ] Metadata updates after XP, evolution, equip, unequip, Armor damage, repair, activity, and passive-rate assignment.
- [ ] Marketplace refresh behavior was verified for ERC-4906 events.
- [ ] Collection name, description, banner, royalty receiver, royalty basis points, and external link are correct.
- [ ] A small controlled listing and purchase completed before broad inventory listing.
- [ ] Marketplace inventory wallet is separate from operational and governance wallets.

Complete collection validator:

~~~text
node scripts/validate-nft-marketplace.mjs --origin https://matt-mine.onrender.com --public-origin https://mattmine.com --token-uri-origin https://matt-mine.onrender.com --from 1 --to 1000 --concurrency 8 --expect-initial-state --json
~~~

`--origin` is the server being queried, `--public-origin` is the required origin for player-facing image and external URLs, and `--token-uri-origin` is the origin permanently returned by the on-chain `tokenURI` and `contractURI` functions. They are intentionally separate controls: current contract configuration points token URIs at Render while metadata advertises the public `mattmine.com` origin. RPC URL, Miner address, and expected inventory wallet should come from the protected environment. Remove the initial-state assertion after legitimate progression or sales begin.

## Gate 5: player journey

- [ ] Home to Practice works without a wallet.
- [ ] Home to wallet connection, Miner selection, loadout, mine selection, run, results, Bank, and replay is continuous.
- [ ] Rewarded mines require the selected owned Miner.
- [ ] Practice repeatedly states no XP and no MATT Crystals.
- [ ] Wallet rejection, message rejection, wrong network, unsupported provider, and RPC outage have clear recovery.
- [ ] Account switching clears prior-wallet data.
- [ ] Multi-Miner selection uses the intended ID.
- [ ] Refresh during a run preserves or safely recovers the run.
- [ ] Abandonment clearly discloses death consequences before confirmation.
- [ ] Results distinguish mined units, banked gameplay Crystals, and withdrawn MATT CRYSTALS tokens.
- [ ] Withdrawal shows minimum, available balance, wallet limit, global-limit behavior, network fee, and transaction result.
- [ ] Armor damage, repair, Backpack burn, and loadout lock are understandable.
- [ ] Desktop keyboard, controller, portrait mobile, and touch controls pass.
- [ ] Supported browsers meet accessibility, focus, contrast, and touch-target checks.
- [ ] Public player guide, FAQ content, support route, and scam warning are easy to find.

## Gate 6: economy

- [ ] A versioned launch preset is approved by Game Economy, Treasury, Security, and Release.
- [ ] Current on-chain values and proposed raw values are archived at a named block.
- [ ] Arena and Pass phase XP values and Level-100 pacing are documented.
- [ ] Maximum payout reflects a safety bound, not an advertised guarantee.
- [ ] Maximum daily banking includes worst-case starts and passive liability.
- [ ] Repair and chest prices have a timestamped MATT/USD source and calculation.
- [ ] Chest odds, item supply, and expected value have independent review.
- [ ] Minimum, wallet-daily, and global-daily withdrawal limits are conservative.
- [ ] Arena repeated-entry exposure has an approved traffic or entry cap.
- [ ] Crystal banking and withdrawal alerts fire at 80% of approved limits.
- [ ] Partial multi-transaction economy updates have a stop-and-readback procedure.
- [ ] Prior approved map remains available for rollback and is not retired.
- [ ] No economy expansion is scheduled inside the initial observation window.

See [LAUNCH_ECONOMY_PRESETS.md](LAUNCH_ECONOMY_PRESETS.md).

## Gate 7: closed beta

- [ ] At least 25 distinct invited testers participated.
- [ ] At least 500 total runs completed.
- [ ] At least 100 reward-bearing settlements include both extraction and death.
- [ ] Wallet connection success is at least 98%.
- [ ] Settlement success is at least 99.5%.
- [ ] Non-cheat rejection rate is below 1%.
- [ ] No run remains stuck beyond its approved recovery age.
- [ ] Withdrawal, repair, chest, VRF, metadata refresh, and transfer cases passed.
- [ ] D1 and D7 retention are reported with cohort sizes.
- [ ] Seven consecutive UTC days stayed within the approved Crystal budget.
- [ ] Every incident and failed test has an owner and disposition.
- [ ] Beta completion record is signed by Release, Treasury, and Security.

See [CLOSED_BETA_RUNBOOK.md](CLOSED_BETA_RUNBOOK.md).

## Gate 8: monitoring and incident response

- [ ] Database health and latency are current.
- [ ] NFT RPC reachability and latency are current.
- [ ] Metadata validator result and age are current.
- [ ] Settlement, Bank, Chest, and Passive Rewards pause states match the release plan.
- [ ] Reward Signer, Operator, Config Operator, Keeper, and Pauser roles are verified.
- [ ] Operator, Keeper, and Pauser RON balances are monitored.
- [ ] VRF funding, consumers, pending requests, and oldest-request age are monitored.
- [ ] Active, aged, rejected, and failed-settlement runs are monitored.
- [ ] Crystal banking, withdrawals, limit utilization, and passive payouts reconcile daily.
- [ ] Alerts have severity, owner, runbook, deduplication key, and acknowledgement.
- [ ] Synthetic critical alerts reached the real on-call route.
- [ ] Status page and player communication templates are ready.
- [ ] Incident commander can pause one mine or one economic surface.
- [ ] Practice remains available during an economic pause.
- [ ] Evidence preservation and post-incident review procedures are assigned.

The standalone evaluator in [operations-monitor.js](../server/operations-monitor.js) fails closed when a required public-release signal is absent. It still needs a scheduled collector and an approved alert-delivery integration before this gate can pass.

## Gate 9: legal, privacy, and support

- [ ] Counsel approved Terms of Service and effective date.
- [ ] Counsel approved Privacy Policy, retention schedule, and rights-request process.
- [ ] Counsel approved NFT and token disclosures.
- [ ] Competition rules match actual entry, scoring, payout, refund, eligibility, and dispute behavior.
- [ ] Age, location, sanctions, and prohibited-activity enforcement match counsel's direction.
- [ ] Public self-attestation limitations are understood and accepted by counsel.
- [ ] Refund, cancellation, technical-failure, and gas-fee treatment are disclosed.
- [ ] No copy promises profit, value, availability, or rewards.
- [ ] Tax, regulatory, and marketplace risks are disclosed.
- [ ] Contact addresses and response owners are active.
- [ ] Data collection, logs, wallet records, and third-party processors match the Privacy Policy.
- [ ] Draft notices have been replaced by approved public versions.

Files under legal that still say draft or counsel review required must never be linked as effective terms.

## Gate 10: go/no-go review

Required approvers:

| Owner | Decision | Name | UTC timestamp | Evidence |
| --- | --- | --- | --- | --- |
| Engineering | | | | |
| Security | | | | |
| Game Economy | | | | |
| Treasury | | | | |
| Operations | | | | |
| Support | | | | |
| Legal counsel | | | | |
| Release commander | | | | |

The Release Commander records one decision: GO, HOLD, or NO-GO. Silence is not approval.

## Staged public launch

### Phase A: Practice

- [ ] Publish Practice and public documentation.
- [ ] Keep reward-bearing entry closed.
- [ ] Observe wallet-free gameplay, browser errors, and support load for 24 hours.

### Phase B: marketplace canary

- [ ] List only the approved small inventory batch.
- [ ] Verify purchase, ownership indexing, metadata, royalties, and Miner selection.
- [ ] Hold for at least 24 hours without a critical issue.

### Phase C: reward canary

- [ ] Open only the approved allowlisted cohort and economic preset.
- [ ] Keep Chest and Passive Rewards paused unless their separate cases passed.
- [ ] Reconcile every settlement and withdrawal during the canary window.

### Phase D: controlled public

- [ ] Open the approved public capacity.
- [ ] Make no economic expansion for seven clean UTC days.
- [ ] Keep rollback maps, deployment, database backup, and pausers ready.

## Post-launch checks

At 1 hour:

- [ ] Reconcile starts, results, on-chain locks, XP, and Crystal credits.
- [ ] Review errors, rejections, RPC latency, and support contacts.

At 24 hours:

- [ ] Reconcile MATT payments, Crystal banking, withdrawals, chests, and passive events.
- [ ] Verify metadata and marketplace refreshes.
- [ ] Record stop-threshold utilization.

At 72 hours:

- [ ] Review extraction/death distribution by map, device, and Miner level.
- [ ] Review wallet connection, completion, recovery, and D1 metrics.
- [ ] Decide hold, rollback, or continue; do not expand yet.

At 7 days:

- [ ] Complete Treasury and Security conservation reports.
- [ ] Review D7, incident history, support load, and economy budget.
- [ ] Require a new approval packet for any capacity or economy increase.
