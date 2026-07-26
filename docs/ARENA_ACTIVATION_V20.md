# MATT Daily Arena activation v2.0

## Production state

- Ronin Mainnet contract: `0x506f969279F8264fd629BBB0Df861Ab91343b12C`
- Treasury Safe: `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`
- Emergency-pauser wallet: `0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4`
- Official MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- Entry range: 25,000 to 1,000,000 MATT
- Treasury seed cap: 10,000,000 MATT per UTC day
- Player-funded pool: uncapped
- Entry and seed distribution: 100% to the daily winner pool

## Replay authority

The browser submits no kills, ore results, damage totals, Guardian result, score,
depth, or payout. It submits normalized fixed-step controls only. The server:

1. verifies the wallet session, confirmed entry receipt, unused entry, run token,
   signed checkpoint chain, event order, wall clock, and UTC deadline;
2. runs the controls through the same seeded game engine at 20ms steps;
3. validates offered upgrades and legal descent/extraction boundaries;
4. derives knockout or extraction, score, depth, damage, time, kills, and ore
   from the replayed terminal state; and
5. keeps only each wallet's best verified daily run on the leaderboard.

## First live-day order

Do these steps in order. Do not unpause first.

1. Merge and deploy v2.0.
2. Confirm `/api/health` reports:
   - `arena.enabled: true`
   - `arena.liveRequested: true`
   - `arena.replayReady: true`
   - `arena.deployment.pinned: true`
   - `arena.deployment.entriesPaused: true`
3. In the admin command center, select a future UTC day.
4. Set an entry price from 25,000 to 1,000,000 MATT.
5. Optionally set a seed from 0 to 10,000,000 MATT.
6. Download the schedule Safe JSON.
7. Import it into the Treasury Safe and collect two signer approvals.
8. Execute the Safe batch before the selected UTC day begins.
9. Confirm the admin page reports the same onchain day, fee, and seed.
10. Download the `unpause-entries` direct transaction JSON.
11. Connect the emergency-pauser wallet and execute `unpauseEntries()` on:
    `0x506f969279F8264fd629BBB0Df861Ab91343b12C`.
12. Confirm health now reports `deployment.entriesPaused: false`.
13. Buy one controlled entry, complete one run, and verify its score appears.

## Emergency response

The emergency-pauser wallet can call `pauseEntries()` immediately. Pausing new
entries does not erase confirmed attempts. Settlement can be paused separately.
If a day cannot be completed safely, the Treasury Safe can cancel it; the seed
returns to the seed Treasury and every entrant receives an aggregated refund.
