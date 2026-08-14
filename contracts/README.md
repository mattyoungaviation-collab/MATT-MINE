# MATT Mine contracts

This directory contains the non-upgradeable Ronin Mainnet contracts for the MATT Mine pass, paid runs, swaps, and weekly claims.

The namespaced `src/nft` directory additionally contains the paused-by-default MATT Mine NFT v1 suite for Miners, Equipment, loadouts, chests, run settlement, Crystal redemption, and a dedicated VRF adapter. Its guarded deployment procedure is documented in `docs/NFT_V1_DEPLOYMENT.md`.

The separate `src/nftv2` namespace contains the approved clean V2 redesign. Miner, Equipment, Loadout custody, and the 48-hour Upgrade Timelock are non-upgradeable. Settlement, Crystal Bank, Chest, and Passive Rewards are UUPS modules whose upgrades can only be executed by that timelock. V2 rules and deployment gates are documented in `docs/NFT_V2_SPEC.md`, `docs/NFT_V2_ARCHITECTURE.md`, and `docs/NFT_V2_DEPLOYMENT.md`.

The legacy Mainnet suite uses normal contract creation and no replacement MATT token. V2 uses named ERC-1967 proxies only for Settlement, Crystal Bank, Chest, and Passive Rewards; Miner ownership, Equipment ownership, Loadout custody, and the Upgrade Timelock remain non-upgradeable. Every production source must be submitted to Ronin's current verification service.

## Contracts

- `MattMinePass` sells a nontransferable 30-day pass for an exact RON price and routes revenue 50/30/20.
- `MattMineRuns` requires an active pass, limits purchases to ten per UTC day, and routes purchased MATT 70/20/10 with zero burn.
- `MattMineSwapExecutor` fixes the Katana route to WRON → MATT and enforces minimum output and a short deadline.
- `MattMineRewards` publishes separate immutable Free and Pass Merkle roots, protects active allocations, blocks duplicate claims, and returns only expired or unallocated MATT.

The game server still decides whether a paid-run entitlement has been consumed and which verified scores qualify for a reward. The browser never decides reward amounts.

## Fixed Ronin addresses

- MATT: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`
- WRON: `0xe514d9deb7966c8be0ca922de8a064264ea6bcd4`
- Katana V2 router: `0x7d0556d55ca1a92708681e2e231733ebd922597d`
- Katana factory: `0xb255d6a720bb7c39fee173ce22113397119cb930`
- MATT/WRON pair: `0x92804d10806aaf51b82e8feeedadbb8218e2c2f9`

The preflight script checks all five addresses and the pair composition directly on Ronin before deployment.

## Security model

- Contract administration uses the deployed three-owner Safe with an exact 2-of-3 threshold.
- The same Safe may protect contract administration, reward publishing, treasury management, and the initial treasury destinations.
- A bounded operational wallet may share price and configuration management.
- Emergency pause authority must remain separate from the operational wallet and the admin Safe.
- Mainnet preflight verifies the configured Safe's exact owner set and exact 2-of-3 threshold directly on Ronin.
- Pass pricing launches at 95 RON within immutable 55-155 RON bounds; paid runs launch at 10 RON within immutable 5-20 RON bounds.
- Each price can change at most once every seven days.
- There is no timelock, per the approved MATT Mine control model.
- Treasury destinations can only change while the affected contract is paused.
- The temporary deployer is removed from `MattMineSwapExecutor` immediately after `MattMineRuns` is authorized.
- The deployer key is stored in Hardhat's encrypted keystore, never in source control.
- The deployment script checkpoints each address so an interrupted deployment can resume without silently creating duplicates.
- Contracts are not funded until all addresses and roles are verified.

These controls reduce avoidable deployment risk. They do not replace an independent smart-contract audit, treasury review, or legal review before real-money launch.

## Local validation

From the repository root:

```powershell
npm.cmd install
npm.cmd run contracts:compile
npm.cmd run test:contracts
```

## Mainnet preparation

Create the untracked production configuration:

```powershell
Copy-Item ".\contracts\config\ronin.example.json" ".\contracts\config\ronin.json"
```

Fill every zero address with the approved role or treasury address. Confirm the current RON price before choosing the pass price. The paid-run example remains 10 RON.

Run the read-only preflight:

```powershell
npm.cmd run contracts:validate:ronin
```

Store a new low-balance deployment key in the encrypted Hardhat keystore. Enter it only into the local prompt:

```powershell
cd ".\contracts"
npx.cmd hardhat keystore set RONIN_DEPLOYER_PRIVATE_KEY
cd ".."
```

Fund that deployer with only enough RON for contract creation and setup transactions.

## Deploy and verify

Only after the config, test report, audit, and multisig are approved:

```powershell
$env:MATT_MINE_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_TO_RONIN_MAINNET"
npm.cmd run contracts:deploy:ronin
Remove-Item Env:MATT_MINE_MAINNET_CONFIRMATION
npm.cmd run contracts:verify:ronin
```

The generated deployment record is stored at `contracts/deployments/ronin.json` and is ignored by Git. Back it up securely after deployment. It contains public deployment data, not the key.

After verification, compare all constructor arguments and role assignments against the approved config, revoke any obsolete operational roles, and only then fund `MattMineRewards`.

The current public verification record for each address is available at:

```text
https://repo.sourcify.dev/2020/DEPLOYED_CONTRACT_ADDRESS
```

If the Ronin explorer does not immediately ingest that public record, upload the matching production build-info file from `contracts/artifacts/build-info` through Ronin's Sourcify UI. Do not recompile with different settings.
