# NFT V2 predeployment release record

This file defines the code state that must exist before the first Ronin Mainnet deployment transaction.

## Contract system

- Maximum 1,000 Miners; all mint with identical Level 1 base traits.
- Six equipment slots: Armor, Pickaxe, Blaster, Dynamite, Helmet, Backpack.
- Equipped gear is held with the Miner and follows a Miner sale.
- Armor is a shield, becomes damaged on death, provides zero protection while damaged, and uses an adjustable MATT repair price.
- Backpack adds fixed carry capacity and burns on death.
- Extraction banks phase XP and converted Crystals; death banks zero session XP and applies the Miner’s fixed retention percentage.
- Level 100 permanently assigns a weighted 5–50 Crystals/hour rate once.
- Passive earnings accrue only after verified weekly play and are paid to the owner at the UTC boundary with prorating.
- Player EIP-712 run authorization, independent server Reward Signer, server Operator, immutable active-run snapshot, one-time nonces, and processed-run replay protection are enforced.
- Map conversion and payout are admin configurable inside immutable 100,000-token per-unit/per-run ceilings; withdrawals have immutable wallet/global ceilings.
- UUPS upgrades require the fixed 48-hour upgrade timelock.

## Game and server

- Public flow: Main Page → Select Miner → Select Loadout → Enter Mines → Select Mine.
- Practice Mine: public, no NFT required, no XP, no Crystals.
- MATT Arena and Pass Mine: owned Miner required; selected traits are pinned into both gameplay and deterministic server replay.
- Retired Daily/Seven-Day/Endless mine choices are rejected by the server and removed from the player flow.
- Refresh recovery preserves active NFT runs; abandonment settles as on-chain death.
- A lost HTTP response after confirmed settlement is idempotently recovered using the stored on-chain run ID.
- Metadata exposes V2 base/effective traits, all equipment slots, armor state, Crystals/hour, and earning status.
- Existing pixel assets are incorporated for Armor, Pickaxe, Helmet, and Backpack. Blaster and Dynamite are fully functional traits/items and explicitly marked render-pending until approved art is added later.

## Admin Console

- Existing Competition Studio remains the map builder and authoritative replay snapshot source.
- Mine Operations exposes exactly Practice, MATT Arena, and Pass Mine.
- Game Balance controls remaining server gameplay modifiers that apply to new runs and server replay.
- NFT V2 Protocol reads live values directly from Ronin and can update repair price, withdrawal limits, all six chest prices, approve/reroute versioned maps, and permanently retire a map.
- Every NFT V2 mutation requires wallet session, CSRF protection, a fresh Admin wallet step-up signature, a written reason, a dedicated Config Operator key, on-chain `CONFIG_ROLE`, transaction confirmation, and an append-only audit entry.
- Active map routing is persisted in server state version 18 and restored exactly across restarts.

## Safe launch posture

- Render ships with metadata, gameplay, and NFT Admin switches disabled.
- The production config contains no private key.
- Deployment is deterministic and nonce-locked, writes an atomic recovery manifest, checks all proxy implementation slots, and leaves all seven gameplay modules paused.
- Source verification and activation are separate steps.
- Crystal mint authority and Ronin Launchpad minter address are activation prerequisites, not deployment assumptions.
- No NFT images or metadata art update requires a new collection contract; approved render assets can be added later through the versioned metadata service.
