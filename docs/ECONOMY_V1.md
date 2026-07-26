# MATT Mine Economy v1

This document records the approved v0.4 rules implemented by the standalone test build.

## Player tiers

### Free tier

- One official Free Leaderboard run per wallet per UTC day.
- The daily reset is 00:00 UTC.
- Pass holders retain the free daily run.
- Practice runs are unlimited and never earn MATT.

### MATT Mine Pass

- Thirty days of premium access from purchase or extension.
- The test default matches the deployed 95 RON launch price and is adjustable by the Price Manager.
- An active pass unlocks paid ranked runs and the Pass Leaderboard.
- Pass purchases are modeled as 50% development RON, 30% market-purchased MATT for pass rewards, and 20% marketing RON.

### Paid ranked runs

- Test default: 10 RON per run.
- Active pass required.
- Maximum ten purchases and ten used attempts per UTC day by default.
- Only the best paid score from each day contributes to the weekly Pass Leaderboard.
- Each purchase models an immediate RON-to-MATT conversion.
- Purchased MATT routing: 70% current Pass pool, 20% future rewards, 10% reserve, 0% burned.

## Leaderboards

- Free and Pass competitions are separate.
- Weekly score is the sum of each day's best official score.
- Official daily mines use deterministic date-and-tier seeds.
- Preview rivals in v0.4 are local test data only.
- Production scores must be server-authoritative and anti-cheat verified.

## Initial reward pools

- Free weekly pool: 2,500,000 MATT.
- Pass weekly base pool: 5,000,000 MATT.
- Pass paid-run purchases add MATT to the current Pass pool.
- Reward estimates are not final until an authorized publisher creates the weekly reward epoch.

## Admin model

- Treasury Admin: weekly pool settings and treasury oversight.
- Game Admin: routine configuration and local test reset.
- Reward Publisher: immutable weekly reward publication.
- Competition Moderator: wallet suspension and restoration.
- Price Manager: pass, paid-run, and MATT quote controls.
- Emergency Pauser: immediate pause of ranked runs, pass sales, paid runs, and claims.
- Production treasury and major contract actions require the approved 2-of-3 multisig.
- There is no timelock.
- All local economy and admin actions are recorded in the audit log.

## v0.4 safety boundary

No real RON or MATT moves in v0.4. Browser storage is used only to test product flow and rules. Production must replace the local economy adapter with wallet transactions, verified swap execution, server-issued run entitlements, server-authoritative scoring, and a claim contract.
