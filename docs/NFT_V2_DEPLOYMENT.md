# MATT Mine NFT V2 deployment procedure

V2 is not deployed. The first permitted target is Saigon Testnet, and every contract must remain paused after deployment.

Production token mapping verified read-only on Ronin Mainnet on 2026-08-14 and required to be reverified immediately before Mainnet deployment:

- MATT payments: [`0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`](https://explorer.roninchain.com/token/0xa5450417BDCa0BDfB058ffE41205400FfDA1174d)
- MATT Crystal minting: [`0x2D2034e55900D285dc05d30a0c14846D7a30285B`](https://explorer.roninchain.com/token/0x2D2034e55900D285dc05d30a0c14846D7a30285B)

The Crystal contract exposes `grantMinter(address)`, not the Saigon test token's `setMinter(address,bool)`. A future Mainnet deployment script must use the production interface and verify that exactly the V2 Bank and Passive Rewards proxies hold `MINTER_ROLE` before activation.

## Safety gates

Do not deploy V2 to Ronin Mainnet until all of the following are complete:

1. local contract tests pass;
2. the final Mavis Launchpad mint interface is confirmed;
3. the production MATT and MATT Crystal addresses, decimals, ownership, and minter interface are reverified;
4. dedicated Reward Signer and Game Operator wallets are different addresses;
5. both Ronin VRF subscriptions are funded and their adapters are configured;
6. metadata and IPFS assets are live and redundantly pinned;
7. the complete paused suite passes a Saigon lifecycle rehearsal;
8. an independent smart-contract security review is complete.

## Prepare the ignored Saigon configuration

From the repository root:

```powershell
Copy-Item ".\contracts\config\saigon-nft-v2.example.json" ".\contracts\config\saigon-nft-v2.json"
```

Review every value. The approved bootstrap configuration intentionally assigns every initial role and Treasury destination to:

`0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`

This shared bootstrap state cannot activate Game Settlement. Reward Signer and Game Operator must be separated before unpausing.

## Required role end state before activation

| Contract | Authority | Required holder |
|---|---|---|
| Every V2 contract | Default / Root Admin | Approved root governance |
| Miner | Minter | Approved Mavis Launchpad contract only |
| Miner | Progression and Run Lock | Game Settlement proxy only |
| Miner | Passive State | Passive Rewards proxy only |
| Miner | Metadata | Loadout contract only |
| Equipment | Minter | Chest proxy only |
| Equipment | Loadout, State, Burn | Loadout contract only |
| Equipment | Metadata refresh | No routine holder; governance may grant it temporarily for an index refresh |
| Loadout | Game | Game Settlement proxy only |
| Loadout | Config | Dedicated Game Operator / config wallet |
| Crystal Bank | Credit | Game Settlement proxy only |
| Crystal Bank | Config | Dedicated Game Operator / config wallet |
| Passive Rewards | Settlement | Game Settlement proxy only |
| Passive Rewards | Keeper | Dedicated Keeper wallet |
| Game Settlement | Operator and Config | Dedicated Game Operator wallet |
| Game Settlement | Reward Signer | Dedicated Reward Signer address with no Operator role |
| Chest | Config | Dedicated Game Operator / config wallet |
| All pausable modules | Emergency Pauser | Dedicated Emergency Pauser wallet |
| Upgrade Timelock | Owner | Approved root governance only |
| Existing Crystal token | Minter | Crystal Bank and Passive Rewards proxies only |

The bootstrap root must revoke its temporary routine mint, progression, lock, passive-state, metadata, equipment-state, burn, credit, settlement, keeper, operator, config, and pauser roles after the dedicated holders and contract wires are verified. It retains governance through the Default Admin and Upgrade Timelock owner paths.

## Read-only validation

```powershell
npm.cmd run contracts:validate-nft-v2:saigon
```

This validates the config against Saigon without signing or broadcasting a transaction.

## Saigon deployment

The encrypted `NUGG_DEPLOYER_PRIVATE_KEY` must resolve to the approved bootstrap root and should contain only the test RON required for deployment.

```powershell
$env:MATT_MINE_NFT_V2_SAIGON_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V2_TO_SAIGON"
npm.cmd run contracts:deploy-nft-v2:saigon
Remove-Item Env:MATT_MINE_NFT_V2_SAIGON_CONFIRMATION
```

The script is checkpointed in the ignored `contracts/deployments/nft-v2-saigon.json` manifest. It deploys and configures the suite but mints no NFT and unpauses nothing.

## Read-only post-deployment verification

```powershell
npm.cmd run contracts:check-nft-v2:saigon
```

The expected bootstrap result is:

- all contracts have code;
- all ownership and gameplay contracts remain paused;
- Miner and Equipment supplies remain zero;
- all four UUPS modules point to the 48-hour Upgrade Timelock;
- Bank and Passive Rewards are the only gameplay Crystal minters;
- every cap, price, definition version, role wire, and launch-map hash matches config;
- shared bootstrap Reward Signer and Game Operator prevent Settlement activation.

Role separation, source verification, rehearsal minting, lifecycle tests, and eventual activation use separate guarded procedures. They are deliberately not part of the deployment command.

On Mainnet, the newly deployed Bank and Passive Rewards proxy addresses can receive Crystal `MINTER_ROLE` only after those proxy addresses exist. Both grants, and removal of every obsolete gameplay minter, are post-deployment activation gates rather than constructor-time actions.
