# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite and daily Web3 competition prototype. It remains isolated from MATT Token Live until gameplay, economy rules, server validation, and contracts are production-ready.

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
npm run dev
```

Open `http://localhost:4173`.

No package installation is required. Node.js 20 or newer is required.

Run all checks with:

```powershell
npm test
```

## Important test-mode boundary

v0.4 does not send real RON, swap real MATT, connect a wallet, or pay real claims. The UI deliberately labels these actions as local tests. Browser storage is not trustworthy for production balances, passes, entitlements, scores, rewards, or admin actions.

The future production build must provide:

1. Ronin wallet-backed identity and session authentication.
2. Verified pass and paid-run transactions.
3. A verified RON-to-MATT swap executor with slippage and deadline protection.
4. Server-issued run entitlements.
5. Server-authoritative scoring and anti-cheat review.
6. Immutable weekly reward publication and onchain claims.
7. 2-of-3 multisig control for treasury and major contract administration, with no timelock.

See [`docs/ECONOMY_V1.md`](docs/ECONOMY_V1.md) and [`contracts/README.md`](contracts/README.md).
