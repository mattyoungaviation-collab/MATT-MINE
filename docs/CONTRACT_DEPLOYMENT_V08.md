# MATT Mine v0.8 deployment checklist

## Release boundary

Version 0.8 prepares production contracts and a guarded Ronin Mainnet deployment workflow. It does not authorize a deployment by itself and it does not turn on paid runs or MATT claims in the game server.

## Required approvals

- Independent smart-contract review completed with no unresolved critical or high-severity findings.
- Three-owner contract-admin Safe deployed, tested, and backed up; current operator-approved threshold is 1-of-3.
- Treasury destinations confirmed by at least two owners.
- Price and configuration roles assigned to the bounded operational wallet.
- Pauser assigned to a separate emergency wallet.
- Reward publisher and treasury manager assigned to the Treasury Safe unless a separately reviewed Safe is used.
- Launch pass price confirmed at 95 RON with immutable 55-155 RON bounds.
- Paid-run price confirmed at 10 RON with immutable 5-20 RON bounds.
- Both price managers are contract-limited to one update every seven days.
- Operations and legal review completed for paid skill competition and token rewards in supported jurisdictions.
- Final commit hash recorded before compiling and deploying.

## Pre-deployment evidence

- `npm ci`
- `npm test`
- `npm run contracts:compile`
- `npm run contracts:validate:ronin`
- `MATT_MINE_EXPECTED_DEPLOYER_ADDRESS=0x... npm run contracts:check-deployer:ronin`
- Dependency audit reviewed and production-relevant findings resolved or documented.
- Compiler fixed to Solidity 0.8.28, optimizer enabled, IR pipeline enabled, London EVM target.
- MATT, WRON, Katana router, Katana factory, and MATT/WRON pair validated on Ronin Mainnet.
- Admin Safe code, exact three-owner set, and configured 1-of-3 threshold validated on Ronin Mainnet.
- Encrypted deployment key resolves to the approved public address, is not a configured role or treasury, and holds at least a 3x gas buffer.

## Recommended minimum role map

- Admin Safe: contract admin, reward publisher, treasury manager, and initial treasury destinations.
- Operational wallet: price manager and configuration manager only.
- Emergency wallet: pauser only.
- Temporary deployer: low-balance signer whose executor administration is removed before deployment completes.

## Deployment sequence

1. Deploy `MattMinePass` with final role and treasury addresses.
2. Deploy `MattMineSwapExecutor` with the temporary deployer as bootstrap admin.
3. Deploy `MattMineRewards` with final role and reserve addresses.
4. Deploy `MattMineRuns` with `MattMineRewards` as the current reward vault.
5. Grant the executor's `RUNS_ROLE` only to `MattMineRuns`.
6. Grant executor administration to the Treasury Safe.
7. Renounce the temporary deployer's executor admin role.
8. Re-read every role, fixed address, price bound, and destination from chain.
9. Publish all four exact-match sources through Ronin Explorer/Blockscout.
10. Run `npm run contracts:check-deployment:ronin`.
11. Back up the deployment manifest and verification links.

The deployment script checkpoints each step and validates the final executor
roles before marking the deployment complete. The post-deployment readiness
check is read-only: it validates the deployed addresses, roles, treasuries,
prices, limits, pause state, empty pre-funding balances, and removal of the
temporary deployer administrator without broadcasting a transaction.

## Funding sequence

1. Fund no contract during deployment.
2. Verify sources and constructor arguments.
3. Run a small pass purchase and paid-run purchase only after the application points to the approved addresses.
4. Confirm the exact 50/30/20 RON and 70/20/10 MATT routes.
5. Fund only the first approved reward epoch.
6. Publish a reviewed Merkle root and test a small claim.
7. Increase funding only after reconciliation.

## Emergency response

- Pauser stops the affected purchase, swap, or claim path immediately.
- Pausing never transfers funds.
- Active reward allocations remain unavailable to treasury recovery.
- Treasury destinations change only while paused.
- A compromised routine-role key is revoked by the admin multisig.
- A contract issue requires a new reviewed deployment; these contracts are intentionally non-upgradeable.

## Explicit exclusions

- No vanity deployment address or CREATE2 salt.
- No proxy or hidden implementation replacement.
- No MATT minting or burning.
- No score calculation or reward authorization in the browser.
- No direct treasury key used as the deployment key.
- No automatic funding as part of deployment.
