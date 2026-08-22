# MATT Mine NFT v1 deployment

## Current authority

`0xF79913cB83Cc9CABD95D0ba9250103fbb939f984` is the full-control administrator for every NFT v1 contract and the owner of the dedicated VRF adapter.

That address can grant and revoke roles, replace the game and redemption signers, change prices and withdrawal limits, update metadata, configure equipment pools, pause, unpause, and transfer administration. The existing emergency wallet also receives pause-only authority so it can stop activity quickly without gaining control over configuration or funds.

Player payments continue to route to the existing Treasury Safe vault:

`0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`

The approved server role map is:

- Game operator: `0x112C8a89bfAb3f19D7ceADf7433Fd8D253cFe4D3`
- Run signer: `0x61FC35192964Fa4b50D915261419e9D2Ba369708`
- Crystal-redemption signer: `0xecc7de9071F271183fE31fF8B1246FfD8C751d0e`

These addresses have no administrative authority. `0xF799...f984` can replace or revoke them. Their private keys belong only in the production secret manager and must never be committed.

The canonical dynamic metadata host is `https://matt-mine.onrender.com`:

- Miner token metadata: `https://matt-mine.onrender.com/api/nft/miners/{tokenId}.json`
- Equipment token metadata: `https://matt-mine.onrender.com/api/nft/equipment/{tokenId}.json`
- Miner collection metadata: `https://matt-mine.onrender.com/api/nft/contracts/miners.json`
- Equipment collection metadata: `https://matt-mine.onrender.com/api/nft/contracts/equipment.json`

## Existing Ronin dependencies

- Network: Ronin Mainnet, chain `2020`
- MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- MATT Crystals: `0x2D2034e55900D285dc05d30a0c14846D7a30285B`
- VRF coordinator: `0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda`
- VRF subscription: `44587871477121098669588994745676805184143715799081698934925948057858200430032`
- VRF key hash: copy the active Ronin gas-lane key hash into the private deployment configuration.

The old Slots VRF adapter is not reused. NFT chests deploy a dedicated adapter and add it as a second consumer on the existing subscription.

## Contracts in this release

- `MattMiner`: fixed 1,000-Miner ERC-721 collection with permanent XP, levels, evolution, and prestige XP.
- `MattEquipment`: ERC-721 weapons, backpacks, helmets, and armor. Companions are excluded.
- `MattLoadout`: custody for equipped NFTs so they follow the Miner when it is sold.
- `MattChest`: escrowed MATT chest payments and verifiable random minting.
- `MattGameSettlement`: server-signed phase XP, extraction, death, backpack burn, and armor damage.
- `MattCrystalRedemption`: signed in-game balance redemption into the existing Crystal token.
- `MattMineVRFV25Adapter`: dedicated Ronin VRF V2.5 consumer adapter.

Loadout, Chest, Settlement, and Redemption always deploy paused. Deployment never mints a Miner, funds a contract, enables Crystal minting, or opens gameplay.

## Final value still required

Copy the example configuration:

```powershell
Copy-Item ".\contracts\config\ronin-nft.example.json" ".\contracts\config\ronin-nft.json"
```

The server roles, metadata URLs, equipment definition IDs, and render assets are locked. Fill only the launch MATT-denominated prices:

1. MATT-denominated prices for the approved USD targets at launch:
   - repair: `$0.35`
   - weapon chest: `$2`
   - helmet chest: `$2`
   - common armor chest: `$2`
   - rare armor chest: `$5`
   - mythic armor chest: `$15`
   - backpack: `$5`

The V1 definition IDs are locked to:

- Weapons: common `101`, uncommon `102`, rare `103`, mythic `104`, legendary `105`
- Crystal Hauler backpack: `201`
- Helmets: common `301`, uncommon `302`, rare `303`, mythic `304`, legendary `305`
- Armor: common/125 HP `401`, uncommon/150 HP `402`, rare/175 HP `403`, mythic/195 HP `404`, legendary/200 HP `405`

The deployable render source of truth is `assets/nft/layer-manifest.json`. Five complete loadout proofs are in `assets/nft/previews/`.

The three server roles must use separate addresses from the full-control admin and emergency pauser. Private keys never enter the JSON file or source control.

## Local and read-only validation

```powershell
npm.cmd ci
npm.cmd run contracts:compile
npm.cmd run test:contracts
npm.cmd run contracts:validate-nft:ronin
```

The validator fails unless the official MATT, Crystal, VRF, admin, vault, metadata, prices, withdrawal limits, and separated roles are complete. It reads Ronin but broadcasts no transaction.

## Guarded deployment

Store a new low-balance deployment key in the existing encrypted Hardhat keystore. The deployer must not be the admin, vault, pauser, operator, or either signer.

```powershell
cd ".\contracts"
npx.cmd hardhat keystore set RONIN_DEPLOYER_PRIVATE_KEY
cd ".."
```

Run the deployment only after an independent audit and configuration review:

```powershell
$env:MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS = "0xAPPROVED_LOW_BALANCE_DEPLOYER"
$env:MATT_MINE_NFT_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V1_TO_RONIN_MAINNET"
npm.cmd run contracts:deploy-nft:ronin
Remove-Item Env:MATT_MINE_NFT_MAINNET_CONFIRMATION
Remove-Item Env:MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS
```

The checkpoint manifest is written to `contracts/deployments/nft-ronin.json`. It is ignored by Git and must be backed up securely.

## Required post-deployment actions

While every gameplay-facing contract remains paused, `0xF799…f984` must:

1. Set the new Chest as the dedicated VRF adapter consumer.
2. Add the adapter to the existing coordinator subscription.
3. Grant the Redemption contract permission to mint the existing Crystal token.
4. Grant Settlement the Miner progression role.
5. Grant Loadout the Miner metadata role.
6. Grant Chest the Equipment mint role.
7. Grant Loadout the Equipment loadout, state, and burner roles.
8. Grant Settlement the Loadout game role.
9. Set all chest prices, backpack configuration, and definition pools.
10. Verify exact-match source, constructors, roles, token addresses, vault, metadata, and paused state.

Only after every readback matches the approved deployment record should `0xF799…f984` unpause Loadout, Chest, Settlement, and Redemption.

## Application activation

The server defaults to `MATT_MINE_NFT_ENABLED=false`. After contracts are fully configured and verified, record all seven deployed addresses in the environment, deploy the server integration release, test one controlled Miner and each equipment flow, and then enable the feature.

The retired browser currency is not part of NFT V2. MATT Crystal banking and Miner progression remain the only gameplay progression systems.
