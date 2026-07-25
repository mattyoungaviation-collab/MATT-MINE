# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite built in a separate Git repository so its gameplay can be tested before merging into MATT Token Live.

## v0.2 playable loop

- Explore a newly generated network of seven connected mine chambers every depth.
- Discover dedicated mining rooms, combat rooms, a treasure cache, the Guardian Vault, and the Lift Station.
- Mine stone, copper, gold, glowing rich veins, and rare MATT crystals.
- Fight slimes, bats, crawlers, and the Mine Guardian.
- Move with acceleration and momentum instead of instant start and stop movement.
- Dash through danger with temporary invulnerability and a visible recharge meter.
- Knock enemies backward and see damage numbers, health bars, hit flashes, debris, and screen shake.
- Watch ore deposits visibly crack as they take damage.
- Gain XP and build a run using twelve upgrades, including Pocket Dynamite, Mining Drones, Blast Boots, and Prospector Luck.
- Collect the required MATT crystals to awaken the Guardian in the far-side vault.
- Defeat the Guardian, return to the entrance lift, and extract or descend for a larger multiplier.
- Keep all projected loot when extracting, or only 35% after being knocked out.
- Spend banked nuggets on permanent browser-saved upgrades.

## Run locally on Windows

1. Extract the ZIP.
2. Open PowerShell inside the extracted `matt-mine` folder.
3. Run:

```powershell
npm run dev
```

4. Open `http://localhost:4173`.

No package installation is required.

Run the automated checks with:

```powershell
npm test
```

## Controls

### Desktop

- Move: `WASD` or arrow keys
- Aim: mouse
- Mine or attack: hold the left mouse button or `Space`
- Dash: `Shift`

### Mobile

- Move: virtual joystick
- Mine or attack: pickaxe button
- Dash: blue arrow button
- Mobile attacks automatically aim toward the nearest target.

## Standalone-to-live integration boundary

The game intentionally does not connect to a wallet yet. `src/game/walletAdapter.js` remains the integration seam for MATT Token Live.

The live merge should provide:

1. A stable wallet-backed player ID.
2. Existing MATT Token Live session authentication.
3. Server-authoritative inventory, progression, purchases, and leaderboard records.
4. Payment or ownership verification outside the real-time gameplay loop.
5. A reward-service endpoint rather than direct client-side token transfers.

Do not trust scores, purchases, rewards, or token balances sent by the browser in production. The current local-storage profile is strictly for gameplay testing.

## Suggested next milestones

1. Add original animated MATT character, enemy, ore, and mine-tile artwork.
2. Add sound effects, music, controller support, and accessibility settings.
3. Add ranged weapons, boss attack patterns, room gates, and more enemy behaviors.
4. Add seeded daily challenges, quests, achievements, and a weekly leaderboard.
5. Move persistence and score validation to a server.
6. Add Founder access, cosmetics, seasonal progression, and wallet integration.
7. Merge the stable game route into MATT Token Live.
