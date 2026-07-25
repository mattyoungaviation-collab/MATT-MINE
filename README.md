# MATT Mine

**Dig deep. Fight hard. Get out alive.**

MATT Mine is a standalone browser action roguelite built in a separate Git repository so its gameplay can be tested before merging into MATT Token Live.

## v0.3 combat-depth loop

- Explore a newly generated network of seven connected mine chambers every depth.
- Enter combat rooms that seal behind the player until every enemy is defeated.
- Unlock Pocket Dynamite by clearing a combat room and restock it through later victories.
- Recover the Crystal Blaster from the Prospector Cache and manage its regenerating energy.
- Switch between the MATT Pickaxe, Pocket Dynamite, and Crystal Blaster during a run.
- Fight five enemy roles: charging slimes, diving bats, ambushing crawlers, front-armored beetles, and exploding miners.
- Face a three-phase Mine Guardian with ground slams, crystal volleys, reinforcements, radial barrages, and an exposed final-phase weak point.
- Hear generated cave ambience, weapon sounds, impacts, room alarms, explosions, and Guardian tension audio without external sound assets.
- Mine stone, copper, gold, glowing rich veins, and rare MATT crystals.
- Dash through danger with temporary invulnerability and a visible recharge meter.
- Gain XP and build a run using twelve upgrades, including Mining Drones, Blast Boots, and Prospector Luck.
- Defeat the Guardian, return to the entrance lift, and extract or descend for a larger multiplier.
- Keep all projected loot when extracting, or only 35% after being knocked out.
- Spend banked nuggets on permanent browser-saved upgrades.

## Run locally on Windows

1. Clone or download the repository.
2. Open PowerShell inside the `MATT-MINE` folder.
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
- Attack: hold the left mouse button or `Space`
- Dash: `Shift`
- MATT Pickaxe: `1`
- Pocket Dynamite: `2`
- Crystal Blaster: `3`

### Mobile

- Move: virtual joystick
- Attack: large action button
- Dash: blue arrow button
- Switch weapons: three weapon buttons above the action button
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

1. Replace canvas placeholder art with original sprite sheets and mine tiles.
2. Add controller support, volume controls, accessibility settings, and authored music.
3. Add seeded daily challenges, quests, achievements, and a weekly leaderboard.
4. Move persistence and score validation to a server.
5. Add Founder access, cosmetics, seasonal progression, and payments.
6. Add Ronin wallet ownership checks and MATT utility.
7. Merge the stable game route into MATT Token Live.
