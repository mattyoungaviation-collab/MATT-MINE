# MATT Mine v3.0 production expansion

## Architecture

The browser renders gameplay and submits bounded run input/results. The server owns wallets, character inventory, tuning snapshots, beta entitlements, nugget balances, chest inventory, controller profiles, competitive attempts, audit history, and all reward decisions. PostgreSQL remains the production store; memory and JSON stores retain compatible development behavior.

Guardian scheduling is deterministic per Guardian. Each boss owns its own global, repeated-attack, summon, and per-attack cooldowns. Only the real `slam`, `volley`, `radial`, and `summon` attacks are configurable. Run snapshots preserve tuning, character stats, Weekly stage rules, and Endless season rules.

No feature in this release burns MATT.

## Admin Command Center

The Game Tuning tab now includes expandable controls for Boss Phase 1, 2, and 3 and each phase's real attacks:

- health thresholds, attack/damage speed, movement, chase pressure, summon timing and cap;
- enable, weight, cooldown, damage, projectile speed/count/spread/range, wind-up, and duration per attack;
- safe numeric ranges, descriptions, current values, and audited reasons.

The Expansion tab includes searchable structured sections:

- Chest Rewards
- Death and Revives
- Controller Defaults
- Advertisement Rewards
- Beta Testing
- Weekly Competition
- Endless Mode
- Playable Characters

Expansion presets can be exported as JSON, imported for review, or reset to safe defaults. The server rejects unknown sections, fields, characters, and unsafe values before saving. Every applied change requires a reason and creates an audit record.

Admin can grant/revoke Beta access and character ownership. Player inspection includes permanent identity, address, ledger, activity, character history, and progression. The overview includes aggregate Guardian and character telemetry.

## Gameplay systems

### Guardian

Normal Practice, Free, and Pass presets migrate from a 1.0 to 2.25 Guardian health multiplier when they still use the prior untouched value. This targets a readable roughly 30-second encounter for the fixed balance test without guaranteeing an exact duration. Daily Arena keeps its reviewed legacy 1.0 value.

Completed runs record encounter duration, phase time, damage dealt/received, attacks by type, boss instances, and deaths during the encounter.

### Beta Testing

Beta is a separate mode. It never changes Practice. It requires both the server feature switch and a wallet entitlement. It awards no nuggets, MATT, Pass XP, achievements, public score, or permanent progression.

The in-game developer panel can change depth/room/boss/phase, health, level, invulnerability, weapons, damage, armor, movement, dash, talents, enemy types/counts/AI, debug overlays, and deterministic seed display. Configurations can be copied or loaded as validated JSON.

### Pass Chest

The default base reward is 250,000 nuggets. The server atomically validates inventory, opening limit, deterministic bonus, cosmetic rules, and an idempotent append-only ledger credit. Simultaneous or repeated openings cannot create extra rewards.

### Controller

The Gamepad API supports left-stick movement, right-stick aiming, attacks, three weapon selections, dash, interaction, pause, menu movement, confirm, and back. Players can remap buttons and save dead zone, sensitivity, vibration, active controller, and mapping to their wallet profile. Menu focus is visible and a disconnected active controller pauses the run with a resumable overlay.

### Characters

MATT, Ronke, ADL Dyno, Axie, and Orc are server-defined. Health, movement, dash, Pickaxe, mining speed, Blaster, energy, armor, magnet, luck, passive text, price, Pass/progression requirements, assets, and enabled status are editable.

The server validates ownership and enabled status before every selection and run. Nugget purchases use the append-only ledger. Pass and progression unlocks are server-issued. Weekly competition may lock one character for every player.

### Weekly competition

The engine supports one to seven UTC stages, one attempt per wallet/day, deterministic seeds, immutable opened-stage tuning, locked character rules, daily results, completion count, cumulative score, elapsed tie-breaks, and earliest completion. Admin can preview all seven seeds and snapshots.

### Endless

Endless continues beyond depth five. Its immutable season snapshot controls capped compounded health, damage and speed, boss interval/count, room growth, and multiplier growth. Ranking order is deepest depth, score, bosses, then survival time.

## Intentional release blockers

These switches are off by default and cannot be exposed as live production rewards without their required verifier:

- **Paid revive:** requires exact on-chain RON payment verification and deterministic server death-state validation. The prepared interface preserves run ID/state, limits payment reuse, restores full health, and adds configured invulnerability.
- **Advertisement bonus:** requires a signed provider completion or server-to-server verifier. Browser callbacks alone never award nuggets.
- **Weekly and Endless:** require a deterministic server replay validator before Admin can enable them or accept a result. Their snapshots, engines, UI, persistence, previews, and ranking tests are present, but client-reported scores cannot activate them.

No contract deployment or transaction is part of v3.0.

## Migration

Server state version is 11.

- Existing profile balances are retained and still receive exactly one idempotent `MIGRATION` ledger row when needed.
- Existing upgrades, Pass XP/rewards, cosmetics, keybindings, runs, leaderboards, payment receipts, and reward claims are preserved.
- Wallet expansion state is initialized with MATT ownership, safe controller defaults, empty beta/ad/revive history, and no destructive resets.
- New competition and revive-payment stores default empty.
- PostgreSQL's run-mode check is migrated idempotently to accept `beta`, `weekly`, and `endless`; existing normalized run and score tables remain intact.
- Normal untouched Guardian health moves to 2.25 for Practice/Free/Pass. Daily Arena remains unchanged.

## Manual validation

1. Run `npm install`.
2. Run `npm test`.
3. Run `npm run contracts:compile`.
4. Start with `npm run dev`.
5. Sign in, open Profile → Controls, remap a controller, save, reload, and confirm it persists.
6. In Admin, inspect Expansion, search fields, export a preset, load it for review, and confirm a written reason is required to save.
7. Enable Beta, grant a test wallet, enter Beta, use developer controls, finish, and confirm no profile/ledger/leaderboard progress changed.
8. Grant test chest inventory, open once, and confirm one 250,000 default ledger credit and no second opening.
9. Verify Weekly/Endless, paid revive, and ad activation attempts return their explicit verifier blockers in a normal production configuration.

## Rollback

1. Keep the previous Render version available.
2. Disable Beta and chest opening in Admin before rollback.
3. Do not delete or rewrite PostgreSQL data.
4. Redeploy the prior application commit.
5. The prior server ignores additive version-11 fields; normalized Free/Pass score tables and all historical payments/claims remain unchanged.
6. If returning to v3.0, the idempotent state and PostgreSQL migrations safely run again without duplicating nugget balances.
