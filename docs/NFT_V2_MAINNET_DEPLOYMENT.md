# MATT Mine NFT V2 — Ronin Mainnet Deployment Runbook

Release: `matt-mine-nft-v2-ronin`
Chain: Ronin Mainnet (`2020`)
Root/deployer: `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`
Key alias: `NUGG_DEPLOYER_PRIVATE_KEY`

This runbook deliberately separates deployment, verification, and activation. Deployment creates an empty, fully configured, paused suite. It does not mint an NFT, enable a chest, accept a run, or turn on the server integration.

## Approved dependencies

- MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- MATT Crystals: `0x2D2034e55900D285dc05d30a0c14846D7a30285B`
- Ronin VRF V2.5 coordinator: `0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda`
- VRF subscription: `44587871477121098669588994745676805184143715799081698934925948057858200430032`
- VRF key hash: `0x01753ec79fbf37f6332977d62f25c6d701b11bac255d7e79674fd2886622b0cc`
- Solidity: `0.8.28`, optimizer `200`, EVM target `london`

The final local configuration is `contracts/config/ronin-nft-v2.json`. It is intentionally ignored by Git; the reviewed template is `contracts/config/ronin-nft-v2.example.json`.

## Stage 1 — final no-write preflight

From the repository root:

```powershell
powershell.exe -NoExit -ExecutionPolicy Bypass -File ".\contracts\scripts\run-nft-v2-mainnet-preflight.ps1"
```

The wrapper checks JavaScript, source policy, the optimized Solidity build, all game/server tests, all contract tests, live token/VRF dependencies, the encrypted `0xF799` signer, deterministic addresses, pending nonce, gas estimates, and RON buffer. It broadcasts nothing.

## Stage 2 — paused deterministic deployment

Only after Stage 1 passes:

```powershell
powershell.exe -NoExit -ExecutionPolicy Bypass -File ".\contracts\scripts\run-nft-v2-mainnet-deploy.ps1"
```

The script deploys the following 14 contracts in a nonce-locked order:

1. Upgrade Timelock
2. Miner ERC-721
3. Equipment ERC-721
4. Chest VRF adapter
5. Passive Reward VRF adapter
6. Loadout
7. Crystal Bank implementation
8. Crystal Bank proxy
9. Passive Rewards implementation
10. Passive Rewards proxy
11. Game Settlement implementation
12. Game Settlement proxy
13. Chest implementation
14. Chest proxy

It then configures internal least-privilege roles, all 30 immutable definition pools, six chest prices, two versioned maps, and both adapter consumers. Every gameplay module remains paused and both collections remain empty.

The recoverable checkpoint is written atomically to `contracts/deployments/nft-v2-ronin.json`. Never delete or hand-edit that manifest during deployment. If RPC or PowerShell closes, rerun the same wrapper; it recovers confirmed addresses and stops on any nonce or configuration drift.

## Stage 3 — source and proxy verification

```powershell
powershell.exe -NoExit -ExecutionPolicy Bypass -File ".\contracts\scripts\run-nft-v2-mainnet-verify.ps1"
```

All exact constructor arguments and implementations are submitted to Ronin Sourcify, followed by the complete read-only on-chain check. The suite remains paused.

## Stage 4 — activation readiness

Activation is intentionally blocked until all of these are true:

- Ronin Launchpad provides the final Miner minter address.
- The VRF subscription is funded and remains owned by `0xF799`.
- The existing Crystal token’s AccessControl administrator can grant `MINTER_ROLE` to the new Crystal Bank and Passive Rewards proxies.
- Game/Config Operator `0x112C8a89bfAb3f19D7ceADf7433Fd8D253cFe4D3` has at least `0.05 RON`.
- Passive Keeper `0xecc7de9071F271183fE31fF8B1246FfD8C751d0e` has at least `0.05 RON`.
- Reward Signer `0x61FC35192964Fa4b50D915261419e9D2Ba369708` remains separate from the transaction-sending operator.
- The deployment manifest status is `verified_paused`.

The current read-only audit found that `0xF799` owns the Crystal proxy but does not presently hold its `DEFAULT_ADMIN_ROLE`; a simulated `grantRole` reverts. This does **not** block the safe paused deployment. It does block activation and is checked before the activation script can broadcast its first transaction.

After the authority is restored and the Launchpad address is final:

```powershell
powershell.exe -NoExit -ExecutionPolicy Bypass -File ".\contracts\scripts\run-nft-v2-mainnet-activate.ps1"
```

The wrapper performs a no-write activation rehearsal first. Only an exact second confirmation assigns external roles, revokes routine `0xF799` roles, and unpauses the suite.

## Server activation order

Do not enable the Render switches until contract activation is confirmed.

1. Copy exact proxy and collection addresses plus map version IDs from the manifest into Render.
2. Store dedicated Operator, Reward Signer, and Config Operator keys only as Render secrets.
3. Set `MATT_MINE_NFT_ENABLED=true` and validate metadata first.
4. Set `MATT_MINE_NFT_GAMEPLAY_ENABLED=true` only after live start/death/extraction replay tests.
5. Set `MATT_MINE_NFT_ADMIN_CONTROLS_ENABLED=true` only after `CONFIG_ROLE` is verified for the dedicated Config Operator.

The server refuses startup for wrong chains, wrong key/address pairs, shared Operator/Signer wallets, missing roles, paused settlement, retired maps, or mismatched contract versions.

## Emergency behavior

- Before activation: leave the contracts paused; no rollback transaction is required.
- Partial deployment: rerun the deterministic deploy wrapper using the unchanged manifest and deployer nonce sequence.
- Failed verification: do not activate; fix verification tooling only, without redeploying.
- Failed activation preflight: nothing has been broadcast; fix the named external authority or fuel issue.
- Post-activation emergency: the dedicated Pauser pauses affected modules. Never delete the manifest or rotate roles during an incident without an on-chain snapshot.

References: [Ronin deployment](https://docs.roninchain.com/developers/smart-contracts/deploy), [Ronin verification](https://docs.roninchain.com/developers/smart-contracts/verify), [Ronin contract guidelines](https://docs.roninchain.com/developers/smart-contracts/guidelines), [Ronin Gold Standard](https://docs.roninchain.com/developers/gold-standard).
