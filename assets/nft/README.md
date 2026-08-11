# MATT Mine NFT render pack

This directory is the editable source of truth for the fixed 1254 x 1254 NFT renderer.

`layer-manifest.json` maps on-chain equipment `definitionId` values to render files. The server draws the backpack underlay, chooses a level-based base render, replaces it with an armor base when armor is equipped, and then draws the backpack's front straps/tanks, helmet, and weapon above the Miner. Damaged armor uses the faint red flash settings from the manifest and provides no armor power until repaired.

The recommended V1 definition IDs are:

- Weapons: 101-105
- Crystal Hauler backpack: 201
- Helmets: 301-305
- Armor: 401-405

All live overlay files have real transparency and remain on a 1254 x 1254 canvas. Weapon `*-held-overlay-v2.png` files include the gripping glove so the shaft visibly passes through the Miner's fist. Their sibling chroma files are editable green-screen masters and are not referenced by the live renderer.

Armor intentionally uses the original full-character render as a base replacement. This preserves exact alignment and detail. The transparent equipment layers still appear above it, so an equipped helmet, pickaxe, and backpack remain visible on the Miner NFT and in game.
