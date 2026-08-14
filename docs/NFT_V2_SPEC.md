# MATT Mine NFT V2 specification

Status: **design locked — local V2 implementation complete, contracts not deployed**

This document is the canonical source of truth for the clean NFT V2 redesign. It supersedes the undeployed NFT V1 prototype. V2 is designed first; the game and server will then be rebuilt around the approved contracts.

## Network and existing assets

- Target network: Ronin.
- Production rehearsal network: Saigon Testnet.
- Miner standard: Ronin-compatible ERC-721 using the Mavis Launchpad mint pattern.
- Equipment standard: one ERC-721 collection covering all approved equipment slots.
- Currency assets: the existing MATT and MATT Crystals ERC-20 tokens; V2 does not deploy replacements.
- Production MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d` (`MATT`, 18 decimals, fixed supply, no owner, mint, tax, pause, blacklist, or transfer restriction).
- Production MATT Crystals: `0x2D2034e55900D285dc05d30a0c14846D7a30285B` (`MATT CRYSTALS` / `CRYSTALS`, 18 decimals, UUPS proxy owned by the approved bootstrap root).
- Mainnet activation must use the Crystal token's `grantMinter(address)` path to authorize only the V2 Crystal Bank and Passive Rewards proxies.

## Miner collection and mint

- Permanent maximum supply: **1,000 Miners**.
- Every newly minted Miner begins at Level 1 with identical gameplay traits and identical base artwork.
- Miners are minted directly to buyers through Mavis Launchpad. The collection is not pre-minted to the Treasury.
- Launchpad is granted a narrow mint-only permission.
- Mint payment currency: **RON only**.
- Target mint price: **$10 USD worth of RON**, represented by an operator-updated RON amount.
- There is no per-wallet mint limit.
- There is currently no reserved team allocation; all remaining supply is publicly mintable.
- Miner and Equipment secondary sales target a **5% creator royalty** routed to the Treasury.
- The operator may update the exact RON mint price to maintain the $10 target, with every change emitted on-chain.
- Mavis Launchpad integration must use the production-supported Ronin interface confirmed during implementation.

## Miner traits

All authoritative gameplay values are readable on-chain and exposed in marketplace metadata.

| Trait | Level 1 | Level 100 | Rule |
|---|---:|---:|---|
| Base Health | 50 HP | 150 HP | Smooth predetermined progression |
| Armor | 0 | Equipped Armor value | Separate shield depleted before Health |
| Pickaxe Attack | 15 | 35 | Smooth predetermined progression |
| Blaster Attack | 5 | 30 | Smooth predetermined progression |
| Dynamite Attack | 20 | 80 | Smooth predetermined progression |
| Heal | 10 HP | 50 HP | Applied on phase completion or health pickup; cannot exceed max Health |
| Base Carry Capacity | 750 in-game Crystals | 1,500 in-game Crystals | Smooth predetermined progression; Backpack bonus is applied afterward |
| Crystal Death Retention | 10% | 50% | Smooth predetermined progression |
| Crystals per Hour | 0 | Permanent VRF result | Assigned once after reaching Level 100 |

The level-based traits use fixed-point precision so every level can make measurable progress and Level 100 lands exactly on the approved maximum. Equipment bonuses are added after calculating the Miner’s level traits.

## XP and leveling

- Maximum level: **100**.
- Level 100 requires exactly **360,000 banked XP**.
- The target is approximately 180 days at 20 complete five-phase extractions per day.
- Total XP thresholds follow the quadratic curve:

  `threshold(level) = floor(360000 * (level - 1)^2 / 99^2)`

- Phase XP is fixed:

| Phase completed | Phase XP | Session running total |
|---|---:|---:|
| 1 | 10 | 10 |
| 2 | 15 | 25 |
| 3 | 20 | 45 |
| 4 | 25 | 70 |
| 5 | 30 | 100 |

- XP earned inside a run is provisional.
- Extraction after any completed phase banks the session XP permanently onto the Miner.
- Death or force-abandon banks zero session XP.
- Previously banked XP can never be reduced.

## Evolution artwork

Only the Miner’s base form evolves. Equipment remains in separate removable render layers.

| Level | Base evolution |
|---|---|
| 1 | Rookie Miner |
| 10 | Apprentice Miner |
| 25 | Crystal Hunter |
| 35 | Veteran Miner |
| 50 | Vault Raider |
| 75 | Elite Miner |
| 100 | Mine Legend |

## Equipment collection and loadout

Each Miner has exactly six equipment slots:

1. Armor
2. Pickaxe
3. Blaster
4. Dynamite
5. Helmet
6. Backpack

Equipment uses five fixed rarity tiers: Common, Uncommon, Rare, Mythic, and Legendary. Bonuses are fixed by slot and rarity; equipment has no randomized stat range.

| Rarity | Armor shield | Pickaxe | Blaster | Dynamite | Helmet Health | Backpack capacity |
|---|---:|---:|---:|---:|---:|---:|
| Common | +25 HP | +2 | +2 | +5 | +5 HP | +25% |
| Uncommon | +50 HP | +4 | +4 | +10 | +10 HP | +50% |
| Rare | +75 HP | +6 | +6 | +15 | +15 HP | +75% |
| Mythic | +100 HP | +8 | +8 | +20 | +20 HP | +100% |
| Legendary | +150 HP | +10 | +10 | +25 | +25 HP | +150% |

- Base Carry Capacity is a Miner level trait that progresses smoothly from 750 in-game Crystals at Level 1 to exactly 1,500 at Level 100.
- Its exact whole-unit formula is `floor(750 + (750 * (level - 1) / 99))`.
- A Backpack applies its fixed percentage after the Miner’s level-derived Base Carry Capacity is calculated.
- Effective Carry Capacity uses deterministic integer rounding down and is snapshotted when a run begins.
- At Level 100, effective capacity ranges from 1,875 with a Common Backpack to 3,750 with a Legendary Backpack.
- Equipment supply is unlimited. Scarcity comes from the public rarity odds rather than a supply cap.
- Duplicates are allowed and tradable.
- Equipped NFTs remain attached when the Miner is sold; the buyer gains control of every equipped NFT.
- Unequipped NFTs remain in their holder’s wallet and may be sold separately.
- Miner metadata lists the equipped token IDs, effective traits, and combined render.

## Armor, Backpack, repair, and death

- Armor is a separate shield pool consumed before Base Health during a run.
- A healthy Armor NFT supplies the fixed shield value in the equipment table.
- Extraction does not damage Armor or destroy a Backpack.
- Death changes equipped Armor to a persistent **Damaged** state.
- Damaged Armor remains equippable and tradable but supplies zero shield HP.
- Damaged state must be visible in Equipment and Miner metadata and artwork.
- A damaged Armor NFT may be unequipped and sold without repair.
- Repair costs a server-adjusted amount targeting **$1 USD worth of MATT** and routes payment to the Treasury.
- Death removes and permanently burns the equipped Backpack NFT.
- Pickaxe, Blaster, Dynamite, and Helmet are not damaged by death.

## Equipment chests

- Equipment enters circulation through six slot-specific randomized chests: Armor, Pickaxe, Blaster, Dynamite, Helmet, and Backpack.
- Chest payment currency: **MATT**.
- One chest produces exactly one Equipment NFT for its selected slot.
- Every result uses Ronin VRF and permanent on-chain proof.
- Administrator or server rerolls are forbidden.
- A purchased request records its configuration version so later changes cannot alter an outstanding roll.
- The buyer’s MATT payment remains escrowed inside the Chest contract while VRF is pending.
- A successful fulfillment atomically finalizes the request, mints Equipment, and transfers the escrowed MATT to Treasury.
- If Ronin VRF has not fulfilled a chest request within 24 hours, the buyer may claim a full MATT refund.
- A refunded request is permanently canceled before funds are returned and can never fulfill or mint Equipment later.
- Refund cancellation also clears the adapter's outstanding-consumer bookkeeping; a coordinator result arriving afterward is recorded and safely discarded without minting.
- A request fulfilled before its refund transaction is processed is no longer refundable.
- Chest VRF requests cannot be rerolled. Retry operations continue the original pinned request and randomness context.
- The Ronin VRF subscription must be funded and verified before Chest activation. Its funding health is monitored operationally rather than funded from player escrow.
- Shared rarity probabilities:

| Rarity | Probability |
|---|---:|
| Common | 68% |
| Uncommon | 18% |
| Rare | 8% |
| Mythic | 5% |
| Legendary | 1% |

- Target prices, represented by server-adjusted MATT amounts:

| Chest | USD target |
|---|---:|
| Pickaxe | $2 |
| Blaster | $2 |
| Dynamite | $2 |
| Helmet | $2 |
| Armor | $5 |
| Backpack | $5 |

## Runs and active locks

- A player selects a Miner, equipment, and mine, then signs an EIP-712 run-start authorization.
- The signature is free for the player; the server submits the transaction and pays RON gas.
- The contract verifies current ownership, creates a unique run ID, snapshots mutable run settings, and locks the Miner plus equipped equipment.
- A locked Miner cannot transfer, change equipment, or start a second run.
- Only the matching run ID may settle the run.
- Every extraction or death settlement requires two independent server authorities:
  - a Reward Signer signs the exact EIP-712 result; and
  - a Game Operator submits the matching settlement transaction and pays its RON gas.
- Neither server key can settle a run or create gameplay rewards alone.
- The signed result binds the chain ID, settlement contract, run ID, player wallet, Miner ID, snapshotted map version, outcome, completed phases, mined Crystal units, nonce, and deadline.
- Every settlement authorization is single-use and protected against replay across runs, contracts, and networks.
- Extraction and death settlement atomically apply XP, Crystal banking, equipment consequences, and unlock state.
- After a server-adjustable timeout with a launch default of two hours, the owner may force-abandon an unsettled run.
- Force-abandon is treated as death: zero session XP, zero session Crystals, damaged Armor, burned Backpack, then immediate unlock.

## Maps and per-run Crystal conversion

- Maps are authored off-chain, validated by the server, and represented on-chain by an immutable map hash and version.
- An administrator must approve the exact map version before players can start runs on it.
- Each approved map version independently defines:
  - the number of mineable in-game Crystal units available in a fresh run;
  - the MATT Crystal conversion rate for one mined in-game Crystal;
  - the maximum MATT Crystal value that may be carried from that run;
  - the immutable map content hash and version identifier.
- The permanent contract-wide safety ceiling is **100,000 MATT Crystals bankable per run**, allowing high-value event maps.
- The permanent conversion-rate ceiling is **100,000 MATT Crystals per one in-game Crystal**.
- Every normal or event map may set a lower per-run maximum, but no approved map version may exceed the contract-wide ceiling.
- Crystal allocations are fresh for every run; players do not compete for a shared map-wide pool.
- A map conversion rate may be fractional, such as 0.25 MATT Crystal per in-game Crystal.
- Conversion rates are stored in the existing MATT Crystal token’s smallest units, preserving its native decimal precision without floating-point arithmetic.
- The first normal launch map defaults to **0.01 MATT Crystal per in-game Crystal**. Admin may configure every approved map version independently.
- At run start, the contract snapshots the approved map version and all of its settings. Later map changes cannot affect an active run.
- The contract first limits mined in-game Crystal units by the run’s snapshotted Miner-and-Backpack Effective Carry Capacity.
- Before death-retention rules are applied, the run’s carried token value is calculated as:

  `min(mined in-game Crystal units, Effective Carry Capacity) * snapshotted MATT Crystal conversion rate`

- Settlement rounds the final converted amount down to the nearest MATT Crystal token unit deterministically.

- Changing a conversion rate requires approving a new map version. Historical and active run snapshots remain unchanged.
- Every map approval, retirement, and configuration version must emit a complete on-chain event.

## Gameplay Crystal bank and withdrawals

- Gameplay Crystals are credited to an on-chain bank rather than minted after every run.
- The bank balance belongs to the wallet that played the run, not to the Miner NFT.
- Extraction banks 100% of carried Crystals up to the snapshotted capacity.
- Death banks the Miner’s current Crystal Death Retention percentage of carried Crystals, with explicit deterministic rounding.
- The contract deducts a withdrawal from the on-chain bank and mints the same amount of the existing MATT Crystals token to that wallet atomically.
- Withdrawal minimum and daily maximum are server-adjustable and emit public configuration events.
- The launch withdrawal minimum is **100 MATT Crystals** and is Admin-configurable, subject to never exceeding the active per-wallet daily maximum.
- The server-adjustable daily withdrawal maximum cannot exceed the permanent contract ceiling of **1,000,000 MATT Crystals per wallet per UTC day**.
- The launch daily withdrawal maximum is **100,000 MATT Crystals per wallet per UTC day** and is configurable through Admin up to the permanent ceiling.
- Gameplay withdrawals also share an Admin-configurable global mint limit for each UTC day.
- The global counter covers all gameplay-bank withdrawals across all wallets and cannot exceed an immutable contract-wide ceiling.
- The immutable global gameplay-withdrawal ceiling is **100,000,000 MATT Crystals per UTC day**.
- The launch active global gameplay-withdrawal limit is **10,000,000 MATT Crystals per UTC day**.
- Admin may lower or raise the active global limit within that ceiling; every change emits an on-chain configuration event.
- If either a wallet or global daily limit is reached, unwithdrawn Crystals remain safely banked and become withdrawable when capacity is available on a later UTC day.
- Completed withdrawals cannot be replayed.
- The server pays gas for run-start and run-settlement transactions. Players initially pay gas for chests, repairs, loadout changes, and withdrawals; gas sponsorship may be added later without changing economic rules.
- At V2 launch, withdrawn MATT Crystals may be held or sold. A future, separately reviewed consumable module may accept MATT Crystals without changing the locked Miner trait and Equipment bonus rules.

## Level 100 passive Crystal earnings

- A Miner below Level 100 earns zero passive Crystals.
- The first successful Level 100 transition requests Ronin VRF exactly once.
- A Level-100 rate request is never cancelable or rerollable; failed delivery keeps the original assignment request pending for safe retries until fulfilled.
- VRF permanently assigns one whole-number Crystals-per-Hour rate. It cannot be changed, rerolled, or reassigned.
- Weighted distribution:

| Permanent rate | Probability |
|---|---:|
| 5–9/hour | 10% |
| 10–19/hour | 35% |
| 20–30/hour | 40% |
| 31–39/hour | 10% |
| 40–49/hour | 4% |
| Exactly 50/hour | 1% |

- Within each multi-value band, the exact whole number is uniformly selected.
- Expected rate is approximately 21.6 Crystals per hour.
- Earnings begin at the exact timestamp when VRF assigns the rate.
- The first 00:00 UTC payment is prorated from the assignment timestamp.
- A Miner earns only while active. Any verified extraction or death renews activity for exactly seven rolling days.
- Starting or force-abandoning a run does not renew activity.
- Earnings stop at the exact activity expiration and restart without retroactive credit after the next qualifying settlement.
- The wallet that owned the Miner at exactly 00:00 UTC receives that day’s payment. Intraday ownership is not prorated.
- Transfer checkpoints preserve the correct midnight owner even if the keeper submits later.
- Missed keeper processing remains owed; each Miner/day payout can execute only once.
- The Keeper begins bounded payout batches at 00:00 UTC. A batch may process at most 100 Miners.
- If a payout remains unprocessed for one hour, any address may execute the same permissionless catch-up path; recipients and amounts remain entirely contract-derived.
- The activity timer and permanent rate transfer with the Miner.
- Metadata exposes Earning Status as `NOT ELIGIBLE`, `EARNING`, or `INACTIVE`, plus rate, last verified play, and active-until timestamp.

## Transfer behavior

The following state belongs to the Miner NFT and transfers to every future owner:

- banked XP and level;
- all level-derived traits;
- evolution stage;
- Crystal Death Retention;
- permanent Crystals-per-Hour result;
- remaining earning-activity time;
- every equipped NFT and its state.

Wallet-owned banked gameplay Crystals do not transfer with the Miner.

## Marketplace and future items

- Miner and Equipment NFTs are standard tradable ERC-721 assets.
- Marketplace listings may settle in MATT or USDC when supported by the selected Ronin marketplace. Sale price, offer currency, and order settlement remain marketplace concerns rather than privileged V2 contract settings.
- Equipped Equipment cannot be listed separately because it is held in Loadout custody; it transfers economically with the Miner. The Miner owner may unequip it outside a run and then list it separately.
- Future consumables use a new or timelocked module and cannot silently rewrite the permanent Miner supply cap, XP curve, rarity odds, fixed Equipment bonuses, or an assigned Level-100 passive rate.

## Roles and authority

- Initial deployment authority and Treasury: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`.
- At initial deployment, this address holds Root Administrator, Treasury, Reward Signer, Game Operator, Keeper, and Emergency Pauser authority.
- Every role is independently transferable so dedicated production wallets can replace the initial shared holder later.
- Gameplay cannot be publicly unpaused while Reward Signer and Game Operator resolve to the same address.
- Root administrator: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`, able to revoke and replace all routine roles.
- Mavis Launchpad: Miner mint only.
- Chest: Equipment mint only.
- Reward Signer: signs exact EIP-712 run results but cannot submit or settle them alone.
- Game Operator: submits matching run-start and settlement transactions, configures maps and operational limits, and updates MATT/RON prices, but cannot invent a settlement without the Reward Signer.
- Keeper: midnight passive payments and VRF delivery retries.
- Emergency pauser: immediate pause authority without Treasury or configuration authority.
- Treasury: receives Miner mint revenue, chest revenue, repair payments, and creator royalties.
- Only the Crystal Bank and Passive Rewards contracts receive mint authority on the existing MATT Crystal token. No server, keeper, operator, or externally owned account receives direct token-mint authority.
- Locked XP curves, equipment bonuses, rarity probabilities, and a Miner’s assigned passive rate are not editable by routine server roles.

All configuration changes and privileged actions must emit complete events. Routine keys cannot grant roles, replace the root administrator, change official token contracts, or redirect Treasury ownership. Contracts deploy paused so role separation and production configuration can be verified before public activation.

The existing MATT Crystals token is an external upgradeable dependency. Its owner can upgrade, pause, blacklist, or change its minter set independently of the V2 module timelock. V2 cannot remove that authority from an already deployed token; production governance must secure the Crystal owner and treat any Crystal-token change as a protocol-level change.

## Upgrade and emergency policy

- Miner and Equipment ERC-721 ownership contracts are permanently non-upgradeable.
- Gameplay settlement, Chest, Crystal Bank, and passive payout modules use governed upgradeable proxies.
- Only the `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984` root authority may schedule and execute an upgrade.
- Every upgrade has a public 48-hour delay between scheduling and execution.
- Routine server, keeper, and operator keys cannot upgrade any module.
- The emergency pauser may pause immediately but cannot upgrade, reconfigure economics, move Treasury funds, or unpause without the required governing authority.
- A deliberate Root-approved UUPS upgrade can change the future behavior of Settlement, Chest, Crystal Bank, or Passive Rewards after the 48-hour notice period. Therefore phase-XP awards, the per-run and withdrawal ceilings, chest odds, and the unassigned passive-rate distribution are immutable to routine server configuration but not immune to an explicit governance upgrade.
- The 1,000 Miner supply cap, Miner level thresholds and derived traits, already assigned passive rates, Equipment bonuses and state, Loadout custody rules, and the 48-hour delay itself live in non-upgradeable contracts and cannot be rewritten through a module upgrade.

## Metadata and media availability

- Miner and Equipment contracts support ERC-4906 metadata refresh events.
- Dynamic metadata and combined Miner renders are served by the MATT Mine metadata service.
- Base evolution artwork and immutable equipment layer assets are pinned to IPFS with at least two independent pinning providers.
- Metadata retains IPFS-backed asset references so ownership media is not dependent on one application server.
- Metadata changes caused by level, equipment, damage, repair, activity, or passive-rate assignment emit the appropriate refresh event.

## Release gates

- Unit, integration, invariant, fuzz, authorization-replay, custody, economic-cap, pause, upgrade-delay, and hostile-token tests must pass locally.
- The complete suite is deployed paused and rehearsed on Saigon before any Mainnet deployment.
- An independent smart-contract security review is required before Mainnet public activation.
- Mainnet contracts deploy paused, are source-verified and configured, and remain paused until role separation, token permissions, VRF funding, metadata, and all read-only checks pass.

## Remaining implementation inputs

1. Dedicated production role addresses that will eventually replace the initial shared role holder.
2. The exact production Mavis Launchpad interface and royalty path confirmed against current Ronin documentation.
3. Saigon and Mainnet VRF subscription identifiers and coordinator configuration.
4. IPFS content identifiers and redundant pinning-provider configuration for final production artwork.
5. Exact game cooldown, ammunition, pickup, and combat calculations built around the locked on-chain traits.
