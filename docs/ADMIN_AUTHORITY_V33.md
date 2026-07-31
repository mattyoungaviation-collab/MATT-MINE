# MATT Mine Admin Authority v3.3

The authenticated Admin Command Center is the canonical control surface for mutable MATT Mine state. Browser state is never trusted to create scores, balances, rewards, purchases, entitlements, or competitive results.

## Immediate controls

An authorized Admin can act immediately, with a required written reason and audit record:

- pause or resume entries, results, payments, and rewards independently for each mine;
- enable whole-site maintenance;
- save lobby tuning for Practice, Daily, Pass, and MATT Arena;
- publish the current Competition Studio draft to new runs;
- restore any prior published mine version;
- terminate every active run in one mine;
- terminate one player’s active runs and apply an exact mutable-state correction;
- revoke sessions, suspend or restore a wallet, restore a legitimate Free attempt, and award supported server-owned items.

There is no 24-hour Admin hold on these controls. A blank Competition Studio start time means “now.”

## Exact run source

When a run starts, the server pins:

- mine slot and run mode;
- Competition Studio snapshot ID and fingerprint;
- all five authored depth maps;
- character and character statistics;
- starting weapon and available loadout;
- lobby tuning;
- deterministic seed and competition period;
- server-owned player profile data needed for validation.

Admin changes affect the next new run. They do not silently mutate a run already being replayed. If Admin must take control immediately, the explicit **End Active Runs** action invalidates those runs first.

## Player-facing consistency

The public mine hub resolves the same live Competition Studio snapshot used by the server. Each card and mine detail display the live name, map, character, starting weapon, entry state, rules, and leaderboard for that slot. Draft changes remain private until Admin applies a live version.

## Facts that remain protected

Admin authority does not rewrite external or historical facts:

- confirmed on-chain payments and transfers;
- already consumed paid entries or run credits;
- completed deterministic replay records and finished leaderboard scores;
- published Merkle roots or player claims;
- Safe approvals and contract-enforced permissions;
- immutable Competition Studio history.

Corrections are additive and audited. Historical facts are preserved so payment accounting, replay review, and reward obligations remain reconcilable.

## Recovery procedure

1. Pause the affected mine surface.
2. End its active runs if the current state cannot safely continue.
3. Correct tuning, map, loadout, or player state.
4. Apply a reviewed Competition Studio version if the map or loadout changed.
5. Test through Practice.
6. Resume only the controls that are ready.
7. Verify the Admin audit entry and public mine card.
