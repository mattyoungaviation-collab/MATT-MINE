# MATT Mine Competition Studio v3.3

Competition Studio is the server-authoritative map and loadout system for MATT Mine's five playable mine slots. Version 3.2 gives each slot five independent depth layouts.

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
2. Select Depth 1–5. Each depth is an independent map.
3. Draw, move, resize, rename, and connect rooms.
4. Place the player spawn, Guardian, extraction lift, enemies, ore, loot, and hazards at exact coordinates.
5. Inspect and edit the selected room or object.
6. Copy the previous depth when useful, or reset only the selected depth.
7. Set the character, available weapons, starting weapon, health, ammunition, drones, safe-start duration, upgrades, and attempt limit.
8. Validate all five depths.
9. Save the editable draft.
10. Leave the optional start blank to apply all five maps immediately, or deliberately choose a future start.

Published versions are immutable. Updating the draft cannot change a scheduled or active competition. Admin can use **Make Live Now** on any prior version; the server creates a new audited immutable version and applies it to new runs immediately.

## Authority and persistence

- Drafts and published snapshots live in the existing versioned server state.
- Production stores that state in Postgres through the current durable store.
- Every published snapshot receives a stable SHA-256 hash.
- Runs copy the resolved snapshot ID, hash, five depth maps, loadout, rules, and tuning at start.
- The game materializes only the matching server-returned depth map for ranked modes.
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

Server state version 14 upgrades `competitionStudio` to five independent depth maps. Legacy single-map drafts and snapshots are cloned safely into Depths 1–5 and remain compatible with existing profiles, balances, sessions, payments, runs, leaderboards, claims, and contract records.

## Operations

The public endpoints are:

- `GET /api/mines`
- `GET /api/mines/:slot`

The authenticated Admin endpoints are:

- `GET /api/admin/competition-studio`
- `PUT /api/admin/competition-studio/:slot/draft`
- `POST /api/admin/competition-studio/:slot/publish`
- `POST /api/admin/competition-studio/:slot/versions/:snapshot/activate`

Publishing requires an audit reason. Admin test runs are local-only, carry the authored map and loadout, use a shortened loading preview, and cannot submit scores or rewards.
