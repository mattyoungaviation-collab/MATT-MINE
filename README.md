# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite and daily Web3 competition prototype. It remains isolated from MATT Token Live until gameplay, economy rules, server validation, and contracts are production-ready.

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

## Important live-payment boundary

v0.9 can prepare real Pass and paid-run transactions only when the server operator explicitly enables the Mainnet transaction switch. Every purchase still requires the player to click the purchase button and approve the exact transaction in Ronin Wallet. MATT claims remain disabled. Ranked validation remains a hardened product foundation, not yet a sufficient anti-cheat system for public token payouts.

Before real value is enabled, the production build still requires:

1. Server-authoritative gameplay simulation or equivalent signed event validation.
2. Ongoing monitoring and incident response for the deployed contracts and payment server.
3. A controlled purchase smoke test with complete treasury and token reconciliation.
4. Production database hosting, backups, observability, and distributed rate limiting.
5. Anti-cheat review and payout moderation.
6. Formal security review before materially increasing contract balances or public reward pools.
7. Immutable weekly reward publication and onchain claims.
8. 2-of-3 multisig control for treasury and major contract administration, with no timelock.

See [`docs/LIVE_PAYMENTS_V09.md`](docs/LIVE_PAYMENTS_V09.md), [`docs/CONTRACT_DEPLOYMENT_V08.md`](docs/CONTRACT_DEPLOYMENT_V08.md), [`docs/SECURITY_V07.md`](docs/SECURITY_V07.md), [`docs/ECONOMY_V1.md`](docs/ECONOMY_V1.md), and [`contracts/README.md`](contracts/README.md).
