# MATT Mine Competition Studio v3.1

Competition Studio is the server-authoritative map and loadout system for MATT Mine's five playable mine slots.

## Player flow

The public mine hub always shows six cards in a three-by-two layout:

1. Practice Mine
2. MATT Arena
3. Daily Mine
4. Pass Mine
5. Seven-Day Mine
6. PvP — coming soon

Opening a competitive card shows that mine's exact authored map and its own leaderboard. Practice has no leaderboard. Choosing a playable mine opens a full-screen loading view of that same map for at least ten seconds before the run starts.

PvP is intentionally display-only. The server rejects PvP configuration, publication, entry, scoring, and rewards.

## Admin workflow

The Admin Command Center includes a Competition Studio tab.

1. Choose one of the five playable mine slots.
2. Draw, move, resize, rename, and connect rooms.
3. Place the player spawn, Guardian, extraction lift, enemies, ore, loot, and hazards at exact coordinates.
4. Inspect and edit the selected room or object.
5. Set the character, available weapons, starting weapon, health, ammunition, drones, safe-start duration, upgrades, and attempt limit.
6. Validate the complete configuration.
7. Save the editable draft.
8. Choose a future start and end time and publish.

Published versions are immutable. Updating the draft cannot change a scheduled or active competition.

## Authority and persistence

- Drafts and published snapshots live in the existing versioned server state.
- Production stores that state in Postgres through the current durable store.
- Every published snapshot receives a stable SHA-256 hash.
- Runs copy the resolved snapshot ID, hash, map, loadout, rules, and tuning at start.
- The game materializes only the server-returned map for ranked modes.
- Deterministic Arena replay receives the same resolved Arena snapshot.
- Scores remain subject to the existing replay, wallet, entitlement, payment, suspension, and submission checks.
- Existing contracts, MATT routing, verified payment rules, and the no-burn policy are unchanged.

## Map object support

Competition Studio can place:

- one player spawn;
- one or more Guardians;
- an extraction lift;
- slimes, bats, crawlers, crystal beetles, exploders, and spitters;
- stone, copper, gold, and MATT crystal deposits;
- weapon caches, treasure caches, health, and authored upgrade pickups;
- rockfall and crystal-field hazards.

Objects are validated against room boundaries, required objectives, supported quantities, loadout rules, date windows, and per-slot restrictions before publication.

## Migration

Server state version 13 adds `competitionStudio`. Older states normalize into safe starter drafts and remain compatible with existing profiles, balances, sessions, payments, runs, leaderboards, claims, and contract records.

## Operations

The public endpoints are:

- `GET /api/mines`
- `GET /api/mines/:slot`

The authenticated Admin endpoints are:

- `GET /api/admin/competition-studio`
- `PUT /api/admin/competition-studio/:slot/draft`
- `POST /api/admin/competition-studio/:slot/publish`

Publishing requires an audit reason. Admin test runs are local-only, carry the authored map and loadout, use a shortened loading preview, and cannot submit scores or rewards.
