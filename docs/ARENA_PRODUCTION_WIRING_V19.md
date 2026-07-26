# MATT Daily Arena production wiring v1.9

## Verified Ronin deployment

| Field | Production value |
|---|---|
| Network | Ronin Mainnet (chain 2020) |
| Contract | `0x506f969279F8264fd629BBB0Df861Ab91343b12C` |
| Deployment transaction | `0x5808b7ca0a3006bd469ff63a7d89ff7137bf2108ae24561cd40bf90207dcfe32` |
| Deployment block | `58792525` |
| Runtime code hash | `0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a` |
| Source verification | Ronin Explorer exact match |
| MATT token | `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d` |
| Treasury Safe | `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc` |
| Emergency pauser | `0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4` |
| Temporary deployer (all roles removed) | `0xeED0491B506C78EA7fD10988B1E98A3C88e1C630` |

Explorer:

`https://explorer.roninchain.com/address/0x506f969279F8264fd629BBB0Df861Ab91343b12C?tab=contract`

## What v1.9 connects

The Render Blueprint now supplies the public Arena address, expected address,
runtime code hash, MATT token, Treasury Safe, and emergency-pauser address.
Render continues to generate independent private receipt and daily-seed secrets.

On every production start, the server fails closed unless Ronin reports:

- code at the exact approved address;
- the exact pinned runtime bytecode hash;
- the immutable official MATT token;
- the Treasury Safe as seed Treasury, default admin, Treasury, settler, and pricer;
- the separate emergency wallet as pauser; and
- no remaining role on the temporary deployment wallet; and
- player entries still paused while live mode is disabled.

The health endpoint exposes the resulting deployment proof under
`arena.deployment`.

## Render state after merge

The Blueprint must remain:

```text
MATT_MINE_ARENA_CONTRACT_ADDRESS=0x506f969279F8264fd629BBB0Df861Ab91343b12C
MATT_MINE_ARENA_EXPECTED_CONTRACT_ADDRESS=0x506f969279F8264fd629BBB0Df861Ab91343b12C
MATT_MINE_ARENA_RUNTIME_CODE_HASH=0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a
MATT_MINE_ARENA_MATT_ADDRESS=0xa5450417BDCa0BDfB058ffE41205400FfDA1174d
MATT_MINE_ARENA_SAFE_ADDRESS=0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc
MATT_MINE_ARENA_PAUSER_ADDRESS=0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4
MATT_MINE_ARENA_DEPLOYER_ADDRESS=0xeED0491B506C78EA7fD10988B1E98A3C88e1C630
MATT_MINE_ARENA_LIVE=false
```

Check the deployed service:

```powershell
Invoke-RestMethod "https://matt-mine.onrender.com/api/health" |
  ConvertTo-Json -Depth 8
```

Expected Arena signals:

```text
enabled: false
liveRequested: false
replayReady: false
deployment.pinned: true
deployment.entriesPaused: true
```

## Activation boundary

v1.9 connects and verifies production infrastructure; it does not accept Arena
payments. `ARENA_REPLAY_READY` remains compiled as `false`, and the contract
remains entry-paused.

Changing only `MATT_MINE_ARENA_LIVE` cannot activate paid play. A later reviewed
release must replace milestone telemetry with input-only deterministic server
simulation and pass adversarial replay testing. After that release is deployed:

1. Keep entries paused.
2. Enable the reviewed server release and confirm `replayReady: true`.
3. Schedule a future UTC day through the Treasury Safe.
4. Use a controlled entry fee and seed for the first live day.
5. Confirm the server and contract show the identical fee and pool.
6. Have the separate emergency-pauser wallet unpause entries.
7. Monitor every entry, receipt confirmation, run replay, leaderboard update,
   snapshot, and settlement.
8. Pause immediately if any reconciliation or replay check fails.
