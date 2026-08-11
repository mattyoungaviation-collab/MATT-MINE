# MATT Mine NFT v1 Saigon deployment

This is the isolated rehearsal deployment for current Ronin Saigon testnet chain `202601`.
It does not reuse or alter any Ronin mainnet contract.

The suite deploys:

- `MattMineSaigonMatt`: admin-controlled test MATT with 18 decimals.
- `MattMineSaigonCrystal`: admin-controlled test Crystals with 18 decimals.
- `MattMineSaigonRandomness`: operator-fulfilled test randomness for chest rehearsals.
- `MattMiner`, `MattEquipment`, `MattLoadout`, `MattChest`, `MattGameSettlement`, and `MattCrystalRedemption`.

Every owner and default administrator is `0xF79913cB83Cc9CABD95D0ba9250103fbb939f984`.
Loadout, Chest, Settlement, and Redemption deploy paused. No NFT is minted during deployment.

The encrypted `NUGG_DEPLOYER_PRIVATE_KEY` keystore entry is used as the Saigon broadcaster. The
deployment guard requires it to resolve exactly to the approved `0xF799...f984` contract admin.
At least `0.25` test RON is required; obtain it from `https://faucet.roninchain.com` if the guarded
preflight reports a lower balance.

## Validate

```powershell
npm.cmd run contracts:compile
npm.cmd run test:contracts
npm.cmd run contracts:validate-nft:saigon
```

## Deploy

```powershell
$env:MATT_MINE_NFT_SAIGON_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V1_TO_SAIGON"
npm.cmd run contracts:deploy-nft:saigon
Remove-Item Env:MATT_MINE_NFT_SAIGON_CONFIRMATION
```

The encrypted-keystore password is entered only in Hardhat's local terminal prompt. Never paste a
private key, seed phrase, or keystore password into chat or source code.

The resumable manifest is `contracts/deployments/nft-saigon.json`. The deployer preflight is
`contracts/deployments/saigon-deployer-preflight.json`. Both are ignored by Git.

After deployment, the `0xF799` admin must grant the recorded roles, configure the definition pools and
prices, authorize Crystal minting, distribute test MATT, and then unpause the four gameplay contracts.
