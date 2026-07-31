# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite and daily Web3 competition on Ronin. It has its own launch website, wallet identity, separate Free and Pass leaderboards, live Pass and paid-run payments, verified contracts, and a production persistence path independent from MATT Hub.

## v3.3 Admin authority

- Make the authenticated Admin Command Center the canonical source for mine operations, tuning, Competition Studio versions, loadouts, and mutable player state.
- Apply saved tuning and newly published Competition Studio versions immediately to every new run, including MATT Arena.
- Preserve the exact map, character, loadout, and tuning inside active runs so server replay remains deterministic.
- Let Admin immediately end every active run in one mine, or end one player’s active runs while applying an audited state correction.
- Restore any prior immutable competition version immediately without editing historical scores, confirmed payments, or published on-chain claims.
- Render every public mine card from the same server-selected map, character, and starting weapon used by gameplay.

See [`docs/ADMIN_AUTHORITY_V33.md`](docs/ADMIN_AUTHORITY_V33.md).

## v3.2 independent depth layouts

- Give every playable mine five independently authored depth maps.
- Switch Depth 1–5 directly inside Competition Studio without changing another depth.
- Copy the previous depth as a starting point or reset only the selected depth.
- Validate all five layouts before one immutable competition version can be published.
- Let players preview every depth from a mine card while the ten-second briefing shows Depth 1.
- Select the exact authored layout whenever gameplay descends and bind the complete depth sequence to deterministic Arena replay.
- Migrate legacy single-map drafts and snapshots safely into five independent layouts.

## v3.1 Competition Studio

- Present Practice, MATT Arena, Daily, Pass, and Seven-Day mines together in one clear 3-by-2 mine hub, with PvP visibly reserved as coming soon.
- Open each competition card to inspect its exact map, loadout, rules, and dedicated leaderboard before entering.
- Show the selected server-owned mine map for a minimum of ten seconds before gameplay begins.
- Let authorized administrators visually draw rooms and connections, drag exact enemy, ore, loot, hazard, boss, extraction, and player placements, and configure starting loadouts.
- Save editable drafts and publish immutable, SHA-256-addressed competition snapshots for future time windows.
- Bind authored snapshots to runs and deterministic Arena replay so client changes cannot alter layouts, rewards, scores, or paid competition results.
- Persist all Studio drafts and versions in the existing versioned server state and Postgres production store.

PvP remains display-only and cannot be configured, published, entered, scored, or rewarded. No MATT contract or payment rule is changed by this release.

See [`docs/COMPETITION_STUDIO_V31.md`](docs/COMPETITION_STUDIO_V31.md).

## v3.0 production expansion

- Tune every real Guardian attack independently across all three phases with deterministic, per-boss cooldown scheduling and completed-run telemetry.
- Increase the configurable Pass Chest default to 250,000 server-ledger nuggets with atomic opening and duplicate-cosmetic rules.
- Add server-owned playable characters, unlocks, purchases, Admin grants, balance controls, and character usage telemetry.
- Add wallet-saved controller remapping, dead zones, aiming, vibration, menu navigation, controller-safe pause, and resume.
- Add a rewardless, entitled Beta Testing mine with developer controls and audited tester access.
- Add server-owned Weekly and Endless competition engines, immutable snapshots, scaling, and separate rankings.
- Add one-run revive and verified advertisement reward interfaces that remain fail-closed until production verifiers are configured.
- Migrate existing state to version 11 without losing profiles, cosmetics, controls, run history, payments, or claims.

Weekly, Endless, paid revive, and advertisement rewards remain unavailable in production until their explicit replay/payment/provider validation blockers are satisfied. No MATT is burned.

See [`docs/PRODUCTION_EXPANSION_V30.md`](docs/PRODUCTION_EXPANSION_V30.md).

## v2.6 production game control

- Add a Nitrado-style Game Tuning panel for Practice, Free, Pass, and Daily Arena lobbies.
- Fine-tune player movement and health, every weapon, enemy families, Guardian behavior, room dimensions, ore, XP, scoring, and knockout rules.
- Snapshot settings into every run so changing future rules cannot alter an active or completed run.
- Apply tuning immediately to every new run while preserving the exact pinned rules of runs already in progress.
- Search permanent miner names or wallet addresses, inspect individual activity, and grant audited nuggets, Pass XP, chests, or cosmetics.
- Let every miner create unique keyboard controls and save them to their server profile.

## v2.5 combat clarity and run control

- Render the official MATT Dyno at a smaller gameplay scale and sample exact sprite cells so adjacent frame fragments never bleed into view.
- Increase base Pickaxe range by 20% and Pickaxe damage by 14%.
- Give the Crystal Blaster 15% more stored charge and set direct Dynamite damage to 75.
- Keep the Guardian hidden until the miner has enough crystals and physically enters the Guardian Vault.
- Add a two-step Abandon Run control that releases server and Daily Arena active-run locks without submitting a score.

## v2.4 official MATT Dyno and Safe Start

- Replace the placeholder miner with the official MATT Dyno, animated across idle, walking, dashing, and attacking poses.
- Give MATT Dyno moving legs, a visible tail, four-direction facing, breathing motion, and animated Pickaxe, Blaster, and Dynamite loadouts.
- Start every run with the Pickaxe equipped while preserving unlocked weapon access.
- Give Free, Pass, and Practice runs a Safe Start grace period before enemies can attack while preserving deterministic Arena replay rules.
- Guarantee zero start-room enemies and keep nearby enemies from attacking through the sanctuary boundary.
- Cap drones at four, cap split Blaster volleys at two beams, enlarge damage numbers, and remove maxed upgrades from future choices.

## v2.3 production lobby experience

- Replace the mixed run-selection layout with four equal, clearly explained play lobbies: Free Daily Mine, Pass Mine, MATT Arena, and Practice Mine.
- Add a seven-room daily mine overview and a three-step how-to-play guide before players enter.
- Use the official Ronin brand mark in the Built on Ronin lockup.
- Standardize text spacing, labels, buttons, and responsive layouts for desktop and mobile.
- Remove public security-preview and local-test language from production-facing screens.

## v2.2 permanent miner identities

- Require every connected wallet to choose one unique, permanent server-owned miner name before entering ranked play.
- Enforce case-insensitive name uniqueness and protect official, staff, and treasury names.
- Let miners upload or replace a validated PNG, JPEG, or WebP profile picture without changing their permanent name.
- Store identity data in the durable server state and serve lightweight cached avatar URLs instead of embedding images in leaderboard payloads.
- Show miner names and profile pictures on the Free, Pass, and Daily Arena leaderboards.
- Stop mining drones from targeting or damaging enemies through cave walls.

## v2.1 combat and progression balance

- Start Free, Pass, and Practice miners with the Crystal Blaster; keep the live deterministic Arena rules unchanged for replay compatibility.
- Turn the Prospector Cache into a three-choice Blaster tuning reward covering capacity, recharge, damage, and multi-bolt volleys.
- Add ranged Spitters, stronger shield-beetle flanking rules, frontal pickaxe recoil, Blaster/drone resistance, and dynamite weakness.
- Expand and strengthen the Guardian encounter with a larger vault, wider evasive volleys, faster pressure, and relentless reinforcements.
- Add persistent music/effects volume controls, mute, a distinct player-damage sound, red hit feedback, clean post-run camera shake, and a four-drone orbit.
- Expand permanent progression to eight upgrade tracks with substantially longer rank caps and escalating server-authoritative nugget costs.

## v2.0 deterministic Daily Arena

- Record normalized movement, aim, attack, dash, weapon, upgrade, descend, and extraction controls at fixed 20ms simulation boundaries.
- Replay those controls through the same deterministic game engine on the server.
- Reject browser milestone events, browser score summaries, unaligned clocks, skipped game boundaries, unavailable upgrades, and premature finish markers.
- Use a canonical zero-upgrade Arena profile so browser-local progression cannot affect competition results.
- Bind every run to one confirmed onchain MATT entry, wallet session, one-time run token, signed checkpoint chain, daily seed, and UTC deadline.
- Enable the Render Arena service while leaving the verified contract entry pause as the final independent activation control.
- Unlock future-day schedule, optional seed, and emergency-pauser transaction generation in the admin command center.

See [`docs/ARENA_ACTIVATION_V20.md`](docs/ARENA_ACTIVATION_V20.md).

## v1.9 verified Arena production wiring

The isolated MATT Daily Arena is deployed and exact-match verified on Ronin
Mainnet at `0x506f969279F8264fd629BBB0Df861Ab91343b12C`.

Production now pins that exact address and runtime bytecode hash, validates the
official MATT token and all Safe/pauser roles during server startup, and exposes
the proof in the health endpoint. Paid entry remains deliberately disabled and
the contract remains entry-paused until input-only deterministic server replay
ships in a separately reviewed release.

See [`docs/ARENA_PRODUCTION_WIRING_V19.md`](docs/ARENA_PRODUCTION_WIRING_V19.md).

## v1.8 MATT Daily Arena preview

- Add an isolated daily MATT-entry competition without changing the four existing live contracts.
- Let the Treasury Safe schedule a fixed daily entry price from 25,000 to 1,000,000 MATT.
- Allow unlimited entries with no ceiling on the player-funded pool.
- Route 100% of every accepted entry into the immutable daily prize pool: no burn, house fee, or Treasury cut.
- Let the Treasury seed each UTC day with up to 10,000,000 MATT.
- Require each day to be scheduled before it begins and close onchain entry 25 minutes before 00:00 UTC so every accepted payment has time for confirmation and a full run.
- Count only each wallet's best valid daily score and pay at most one top-ten position per wallet.
- Allocate the complete pool using 30% / 18% / 12% / 8% / 7% / 6% / 5.5% / 5% / 4.5% / 4%, normalized when fewer than ten wallets qualify.
- Implement schedule, seed, settlement, and cancellation Safe Transaction Builder JSON generators behind the replay-readiness gate.
- Return the Treasury seed and make every entry refundable if a day is canceled.
- Keep real paid entry hard-disabled at the server release gate until input-only deterministic replay replaces preview milestone telemetry.
- Deploy the isolated Arena contract with player entries paused and block schedule/unpause preparation in this release.
- Keep post-close rankings provisional until an administrator completes moderation and intentionally creates the immutable settlement draft.

See [`docs/DAILY_ARENA_V18.md`](docs/DAILY_ARENA_V18.md).

## v1.7 cinematic mine

- Replace flat arena fills with a detailed top-down mine material built from dark stone, broken rails, amber ore, and violet crystal deposits.
- Render the Mine Guardian as a full cinematic rock-and-crystal creature with phase-aware core lighting and hit feedback.
- Add deeper cave walls, soot-darkened room edges, metal lantern housings, warm flame bloom, crystal bounce light, and drifting atmospheric particles.
- Rebuild the miner with dimensional workwear, helmet lighting, backpack equipment, and clearer weapon silhouettes.
- Upgrade enemy materials, shadows, eye glow, ore clusters, treasure caches, combat gates, and room markings while preserving gameplay readability.
- Package optimized WebP art assets with lazy browser loading and safe fallbacks.

## v1.6 permanent Pass collection

- Deliver all eight Pass levels from server-owned XP into a permanent wallet inventory.
- Unlock the Starter Badge, Gold Trail, Crystal Skin, Founder Frame, Guardian Aura, Ore Reactor title, and Season One Trophy.
- Open the level-three Pass Chest for the exclusive Molten Pickaxe and a configurable 250,000-nugget default award.
- Equip or remove every owned cosmetic through the MATT Mine Loadout screen.
- Show equipped skins, auras, trails, and pickaxes directly during gameplay.
- Show equipped frames, badges, titles, and trophies on server-verified leaderboard rows.
- Preserve owned rewards after the 30-day Pass expires while requiring an active Pass to earn new XP.
- Migrate and sanitize existing production save state into the new inventory format.

## v1.5 live Mine Pass

- Verify each 95 RON Pass purchase against the exact Ronin transaction, approved Pass contract call, purchasing wallet, payment amount, and `PassPurchased` event.
- Store confirmed Pass purchases and progression per wallet in PostgreSQL-backed server state with replay-safe confirmation.
- Award 25 server-owned Pass XP for an active holder's daily Free ranked run and 100 XP for every completed Pass ranked run.
- Return live Pass level, XP progress, and reward-track unlocks instead of displaying browser-only test progression.
- Keep Pass leaderboard access and paid-run credits gated by current onchain Pass ownership.

## v1.4.2 gameplay soundtrack

- Play `Ore Reactor` as looping background music during every Free, Pass, and Practice run.
- Keep menu screens quiet and stop/reset the track on extraction, knockout, runtime failure, or return to menu.
- Preserve generated combat effects and Guardian audio over the soundtrack.

## v1.4.1 combat and live-copy polish

- Remove test-reward language from the production leaderboard and require a connected Ronin Wallet for live claims.
- Use swept projectile collision so fast Crystal Blaster and Guardian shots cannot tunnel through cave walls during long frames.
- Give the Crystal Blaster, dynamite, and Guardian projectiles explicit maximum travel ranges.
- Increase Guardian awareness, keep aggro after detection, predict player movement, and contain the Guardian inside its vault.

## v1.4 live reward settlement hardening

- Finalize immutable weekly leaderboard snapshots as soon as the UTC countdown reaches zero.
- Close new ranked entries during the final five minutes so an unfinished run cannot cross the immutable snapshot boundary; Practice stays available.
- Enable production reward publication while preserving independent approval and Treasury Safe execution.
- Run live Ronin preflight checks for vault pause state, duplicate epochs, available vault funding, and Treasury Safe MATT balance before creating a publication file.
- Generate reward-vault funding as one ordered MATT approval and vault-funding Safe batch, preventing the missing-approval failure that produces Safe `GS013`.
- Keep the non-adjustable 5,000,000 MATT per-board ceiling and 1,500,000 MATT first-place ceiling.

## v1.2 reward settlement

- Convert immutable weekly snapshots into deterministic OpenZeppelin Merkle reward proofs.
- Allocate the complete approved board pool across eligible top-ten players using a 30% / 18% / 12% / 8% / 7% / 6% / 5.5% / 5% / 4.5% / 4% schedule, normalized when fewer than ten wallets qualify.
- Require separate primary and independent approval secrets.
- Prepare exact approve, fund, and publish transactions for the existing Treasury Safe without storing a publisher key on the server.
- Verify the exact root, allocation, and deadline on Ronin before exposing claims.
- Give included players a server-prepared, player-signed Ronin Wallet claim transaction.
- Use a non-adjustable 5,000,000 MATT per-board ceiling; first place can receive at most 30%, or 1,500,000 MATT.

See [`docs/REWARD_PIPELINE_V12.md`](docs/REWARD_PIPELINE_V12.md).

## v1.1 permanent leaderboard storage

- Store every server-issued run in a dedicated PostgreSQL run table.
- Maintain separate daily-best and weekly-total score tables for the Free and Pass leaderboards.
- Copy existing JSON-backed production runs into the normalized tables automatically and idempotently.
- Dual-write the legacy state during the first normalized release so an immediate application rollback does not discard scores.
- Read production profile totals and leaderboards from the normalized score tables.
- Exclude suspended wallets from live rankings and from final snapshots.
- Preserve completed weekly rankings in immutable snapshot and snapshot-entry tables.
- Finalize the closed week at the UTC boundary after ranked entry closes for the final five minutes.
- Allow authenticated historical leaderboard reads by Monday UTC week key.

## v1.0 standalone launch

- Add a complete standalone MATT Mine website with original hero artwork, responsive sections, gameplay explanation, Free/Pass comparison, economy flow, roadmap, verified-contract directory, and launch disclosures.
- Keep the playable action roguelite inside the same fast, dependency-light application.
- Make the public site the default screen while preserving direct access to Practice, run selection, leaderboards, Pass, upgrades, and wallet login.
- Hide local admin test controls automatically outside localhost.
- Read the approved 95 RON Pass and 10 RON paid-run prices through a public, read-only server route before wallet sign-in.
- Move production state to PostgreSQL when `DATABASE_URL` is configured while retaining JSON storage for local development.
- Serialize state changes inside PostgreSQL transactions so receipt confirmation and paid-run credit consumption remain atomic.
- Add production health reporting, safer proxy-origin detection, asset caching, Render Blueprint configuration, and a container build.
- Keep MATT reward claims disabled until competition moderation and reward publication are ready.

## v0.9 live Pass and paid-run integration

- Connect the verified Ronin Mainnet Pass and Paid Runs contracts to Ronin Wallet.
- Keep real transactions off by default behind an explicit server environment switch.
- Read current Pass status, contract prices, pause state, and daily purchase count directly from Ronin.
- Build every transaction server-side against the approved contract addresses.
- Fetch a fresh Katana quote with 5% slippage protection and a five-minute deadline.
- Require the server to verify the successful transaction, wallet, contract, function call, and `PaidRunPurchased` event.
- Store each confirmed purchase as a one-time server entitlement that cannot be replayed.
- Require an active onchain Pass when a paid ranked run starts.
- Count only the best paid score from each UTC day on the separate Pass leaderboard.
- Keep MATT claims disabled.

## v0.8 production contract release

- Add non-upgradeable Pass, paid-run, swap, and reward contracts for Ronin Mainnet.
- Use the existing fixed-supply MATT token; no replacement token and no burn.
- Fix paid-run swaps to the approved Katana WRON → MATT route with minimum-output and deadline protection.
- Route pass RON 50/30/20 and paid-run MATT 70/20/10.
- Publish separate Free and Pass reward epochs with duplicate-claim and active-allocation protection.
- Require a deployed contract-admin multisig and separate routine roles.
- Deploy conventionally with no CREATE2 vanity salt, proxy, or timelock.
- Validate Ronin protocol addresses onchain before deployment.
- Store the temporary deployment key in Hardhat's encrypted keystore.
- Checkpoint deployments, remove the temporary executor admin, and verify all source through Sourcify v2 on Ronin chain 2020.
- Deploy and exact-match verify all four contracts, then validate their roles, destinations, prices, limits, and empty starting balances.

## v0.7 Ronin Mainnet readiness

- Lock wallet authentication to Ronin Mainnet chain `2020`.
- Remove the testnet runtime path and network configuration.
- Automatically request a switch to Ronin Mainnet before requesting the login signature.
- Keep the login message non-transactional: signing does not spend RON or MATT.
- Expose an explicit server safety flag showing that Mainnet transactions remain disabled.
- Keep paid runs, Pass purchases, RON-to-MATT swaps, and MATT claims disabled.

## v0.6 Ronin identity and verified competition

- Connect through the injected Ronin Wallet provider.
- Authenticate with a short-lived, one-use sign-in challenge bound to the wallet, chain, and website origin.
- Keep raw session tokens in session storage only and persist only their server-side hashes.
- Store profiles, entitlements, runs, suspensions, scores, and audit events on the server.
- Issue opaque, one-use run tokens for ranked Free and connected Practice runs.
- Enforce one Free ranked run per wallet per UTC day on the server.
- Reject reused, expired, mismatched, malformed, and structurally impossible run submissions.
- Keep Free leaderboard totals server-backed and separated from local sandbox Pass data.
- Recover safely from a corrupt server data file by quarantining it and creating a validated store.
- Preserve Practice access for suspended wallets while blocking their ranked access.
- Keep paid runs, RON swaps, and real MATT claims deliberately disabled.

## v0.5 resilience and stress testing

- Keep the animation loop alive after an unexpected update or render error and return the player to a safe menu state.
- Clear held keyboard, pointer, and mobile inputs when a run stops unexpectedly.
- Repair corrupt or malformed profile and economy saves with validated defaults.
- Cover the Pickaxe, Pocket Dynamite, Crystal Blaster, enemy projectile, wall collision, and expired-projectile paths with regression tests.
- Keep Free and Pass leaderboard totals separate and count only the best score from each day.
- Credit knocked-out ranked runs only for secured, banked nuggets rather than projected extraction loot.
- Block suspended wallets from ranked access, paid-run purchases, and ranked score submission while preserving Practice mode.
- Reject unknown settings, malformed values, and cross-role changes in the local admin controls.

## v0.4 playable economy

- Choose between Free Ranked, Pass Ranked, and unlimited Practice runs.
- Receive one official Free Leaderboard attempt per wallet every UTC day.
- Activate a simulated 30-day MATT Mine Pass priced in administrator-configured RON.
- Purchase simulated paid-run credits at 10 RON by default, with an active pass required.
- Enforce the daily paid-run cap and count only the best paid score each day.
- Compete on separate weekly Free and Pass leaderboards.
- Use deterministic daily mine seeds so official competitors receive the same mine for their tier.
- Track the Free pool, Pass base pool, MATT purchased by run fees, future rewards, and reserve allocation.
- Route paid-run MATT 70% to the current Pass pool, 20% to future rewards, and 10% to reserve.
- Burn zero MATT.
- Earn pass XP and preview the premium reward track.
- Publish immutable local test reward epochs and record one test claim per epoch.
- Use role-separated local admin controls with immediate pausing, price management, pool management, moderation, and audit logging.
- Preserve the approved three-owner Treasury Safe production model with its operator-selected threshold and no timelock.

## v0.3 action loop retained

- Procedural seven-room mines with mining, combat, treasure, Guardian, and Lift chambers.
- MATT Pickaxe, Pocket Dynamite, and Crystal Blaster.
- Sealed combat rooms and five enemy roles.
- Three-phase Mine Guardian.
- Extraction or deeper-descent choice.
- Permanent browser-saved upgrades.
- Desktop and mobile controls.

## Run locally on Windows

```powershell
npm install
npm run dev
```

Open `http://localhost:4173`.

Node.js 20 or newer is required.

Run all checks with:

```powershell
npm test
```

The homepage is now the default. Choose **Enter Mine** for run selection or **Try Practice** to play immediately without a wallet.

## Deploy the standalone site

The included `render.yaml` creates one Node web service and one PostgreSQL database. Before the first public launch:

1. Set `MATT_MINE_PUBLIC_ORIGIN` to the exact HTTPS site origin, with no trailing slash.
2. Confirm `MATT_MINE_MAINNET_TRANSACTIONS_ENABLED=true` only on the production service.
3. Keep `MATT_MINE_PAYMENT_CONFIRMATIONS=3`.
4. Verify `/api/health` reports `"database":{"ok":true,"kind":"postgresql"}`.
5. Run one controlled Pass and paid-run reconciliation before announcing the URL.

See [`docs/STANDALONE_LAUNCH_V10.md`](docs/STANDALONE_LAUNCH_V10.md) for the deployment and go-live checklist and [`docs/LEADERBOARD_STORAGE_V11.md`](docs/LEADERBOARD_STORAGE_V11.md) for the normalized leaderboard migration.

The production PostgreSQL layer tolerates managed-database restarts without
terminating Node: checked-out clients are guarded, safe reads and startup schema
checks use bounded transient retries, and the health endpoint reports a live but
degraded service until the database reconnects. Payment and state-changing
transactions are not automatically replayed.

## Important live-payment boundary

Pass and paid-run transactions require the player to click the purchase button and approve the exact transaction in Ronin Wallet. v1.2 adds player-signed MATT claims, but only after an immutable snapshot, capped allocation, independent approval, Safe publication, and exact on-chain verification. Production reward publication remains disabled by default.

Before real value is enabled, the production build still requires:

1. Input-only deterministic server replay; signed browser outcome events are not sufficient for paid competition.
2. Jurisdiction, age, and eligibility controls approved by counsel for the paid Arena.
3. Independent security review of the isolated Arena contract and replay server.
4. Ongoing monitoring and incident response for the deployed contracts and payment server.
5. A controlled purchase smoke test with complete treasury and token reconciliation.
6. Production database hosting, backups, observability, and distributed rate limiting.
7. Anti-cheat review and payout moderation.
8. Formal security review before materially increasing contract balances or public reward pools.
9. A full dry run and deliberately small pilot reward epoch before increasing the configured cap.
10. Continued Treasury Safe control for treasury and major contract administration, with no timelock.

See [`docs/LEADERBOARD_STORAGE_V11.md`](docs/LEADERBOARD_STORAGE_V11.md), [`docs/STANDALONE_LAUNCH_V10.md`](docs/STANDALONE_LAUNCH_V10.md), [`docs/LIVE_PAYMENTS_V09.md`](docs/LIVE_PAYMENTS_V09.md), [`docs/CONTRACT_DEPLOYMENT_V08.md`](docs/CONTRACT_DEPLOYMENT_V08.md), [`docs/SECURITY_V07.md`](docs/SECURITY_V07.md), [`docs/ECONOMY_V1.md`](docs/ECONOMY_V1.md), and [`contracts/README.md`](contracts/README.md).
Production operators use the separate, unlinked `/admin.html` command center. See [Admin Command Center](docs/ADMIN_COMMAND_CENTER.md) for permissions, protected fields, and emergency procedures.
