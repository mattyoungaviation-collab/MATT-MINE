# MATT Mine Endless architecture

MATT Mine Endless is a permanent fourth mine, separate from the three authored Competition Studio slots. It is Miner-NFT gated and starts with free entry. Every run freezes its server-selected run seed, Miner profile, configuration version, reward configuration, and phase manifest.

## Trust and fairness

- `src/game/endlessMine.js` is the shared deterministic generator and validator used by the browser and server.
- A phase seed binds the run ID, random server run seed, configuration version, generator version, and phase number.
- Each generated phase has an exact integer point budget. Difficulty uses a separate budget and cannot silently change the maximum leaderboard opportunity.
- Generated rooms, corridors, objects, identifiers, boss gate, point ledger, and economy metadata are validated before a phase is issued.
- The Guardian unlocks only after every required natural enemy is defeated. Crystals, summons, reinforcements, and respawns are not boss keys.
- The server reconstructs the manifest and validates ordered semantic events against immutable object IDs. Duplicate kills, ore, crystals, checkpoints, and out-of-order boss events are rejected.
- Every accepted phase advances an HMAC-signed rolling SHA-256 checkpoint chain. Checkpoints retain the generated and consumed IDs, score breakdown, elapsed time, carry result, and integrity evidence.

## Long runs

Runs checkpoint after every phase. Heartbeats are lightweight and extend the disconnect window without resubmitting the phase. Reconnect counts are bounded per phase and run, phase history is bounded, and the current manifest can always be reconstructed. The supported phase ceiling is 1,000,000; it is a technical safety boundary rather than a practical gameplay ending.

## Economy and NFT progression

The default production state does not guess token economics. Entry is free. CRYSTALS and Miner XP stay fail-closed until Admin publishes a non-empty economy version and real conversion/XP values, and the server has a configured settlement adapter. Active runs retain their frozen values when a later version is published.

`contracts/src/nftv2/MattV2EndlessSettlement.sol` is the dedicated V2-compatible on-chain settlement module. It is separate because adding deep-run logic to the deployed V2 settlement exceeds the EVM contract-size ceiling. The module reuses the existing Miner lock, loadout/death handling, Miner XP, verified activity, passive rewards, and Crystal Bank. It supports sequential signed checkpoints beyond five phases, frozen per-run XP, wallet/NFT daily XP caps, carry clipping, daily CRYSTALS emission caps, replay protection, and inactivity-based owner recovery.

The contract must be deployed, granted the existing progression/lock/game/credit/activity roles, configured with audited economy values, and connected through the server settlement adapter before Admin can enable irreversible Endless rewards. The mode remains playable and leaderboard-capable while rewards are closed.

## Admin and Smart Engine

Admin publishes immutable versions rather than mutating active runs. Controls are grouped into launch, entry, exact scoring, difficulty, generation, rewards, integrity, leaderboards, and Smart Engine sections. Run review exposes phase depth, score, heartbeat, checkpoint digest, and integrity flags.

Smart Engine reads verified runs and emits bounded recommendations. It never applies a recommendation or changes live configuration automatically.
