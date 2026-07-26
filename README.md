# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite and daily Web3 competition on Ronin. It has its own launch website, wallet identity, separate Free and Pass leaderboards, live Pass and paid-run payments, verified contracts, and a production persistence path independent from MATT Hub.

## v1.2 dry-run reward settlement

- Convert immutable weekly snapshots into deterministic OpenZeppelin Merkle reward proofs.
- Allocate the complete approved board pool across eligible top-ten players using a 30% / 18% / 12% / 8% / 7% / 6% / 5.5% / 5% / 4.5% / 4% schedule, normalized when fewer than ten wallets qualify.
- Require separate primary and independent approval secrets.
- Prepare exact approve, fund, and publish transactions for the existing 2-of-3 Safe without storing a publisher key on the server.
- Verify the exact root, allocation, and deadline on Ronin before exposing claims.
- Give included players a server-prepared, player-signed Ronin Wallet claim transaction.
- Deploy with publication disabled and a non-adjustable 5,000,000 MATT per-board ceiling; first place can receive at most 30%, or 1,500,000 MATT.

See [`docs/REWARD_PIPELINE_V12.md`](docs/REWARD_PIPELINE_V12.md).

## v1.1 permanent leaderboard storage

- Store every server-issued run in a dedicated PostgreSQL run table.
- Maintain separate daily-best and weekly-total score tables for the Free and Pass leaderboards.
- Copy existing JSON-backed production runs into the normalized tables automatically and idempotently.
- Dual-write the legacy state during the first normalized release so an immediate application rollback does not discard scores.
- Read production profile totals and leaderboards from the normalized score tables.
- Exclude suspended wallets from live rankings and from final snapshots.
- Preserve completed weekly rankings in immutable snapshot and snapshot-entry tables.
- Keep a 24-hour moderation window after each UTC week closes before finalizing its snapshot.
- Keep a closed week open while any unexpired official run from that week remains active.
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
- Preserve the approved 2-of-3 multisig production model with no timelock.

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

## Important live-payment boundary

Pass and paid-run transactions require the player to click the purchase button and approve the exact transaction in Ronin Wallet. v1.2 adds player-signed MATT claims, but only after an immutable snapshot, capped allocation, independent approval, Safe publication, and exact on-chain verification. Production reward publication remains disabled by default.

Before real value is enabled, the production build still requires:

1. Server-authoritative gameplay simulation or equivalent signed event validation.
2. Ongoing monitoring and incident response for the deployed contracts and payment server.
3. A controlled purchase smoke test with complete treasury and token reconciliation.
4. Production database hosting, backups, observability, and distributed rate limiting.
5. Anti-cheat review and payout moderation.
6. Formal security review before materially increasing contract balances or public reward pools.
7. A full dry run and deliberately small pilot reward epoch before increasing the configured cap.
8. Continued 2-of-3 multisig control for treasury and major contract administration, with no timelock.

See [`docs/LEADERBOARD_STORAGE_V11.md`](docs/LEADERBOARD_STORAGE_V11.md), [`docs/STANDALONE_LAUNCH_V10.md`](docs/STANDALONE_LAUNCH_V10.md), [`docs/LIVE_PAYMENTS_V09.md`](docs/LIVE_PAYMENTS_V09.md), [`docs/CONTRACT_DEPLOYMENT_V08.md`](docs/CONTRACT_DEPLOYMENT_V08.md), [`docs/SECURITY_V07.md`](docs/SECURITY_V07.md), [`docs/ECONOMY_V1.md`](docs/ECONOMY_V1.md), and [`contracts/README.md`](contracts/README.md).
