# MATT Mine v0.8 deployment checklist

## Release boundary

Version 0.8 prepares production contracts and a guarded Ronin Mainnet deployment workflow. It does not authorize a deployment by itself and it does not turn on paid runs or MATT claims in the game server.

## Required approvals

- Independent smart-contract review completed with no unresolved critical or high-severity findings.
- 2-of-3 contract-admin multisig deployed, tested, and backed up.
- Treasury destinations confirmed by at least two owners.
- Price, configuration, pauser, publisher, and treasury roles assigned to the intended separate addresses.
- Pass price recalculated against the current RON market price.
- Operations and legal review completed for paid skill competition and token rewards in supported jurisdictions.
- Final commit hash recorded before compiling and deploying.

## Pre-deployment evidence

- `npm ci`
- `npm test`
- `npm run contracts:compile`
- `npm run contracts:validate:ronin`
- Dependency audit reviewed and production-relevant findings resolved or documented.
- Compiler fixed to Solidity 0.8.28, optimizer enabled, IR pipeline enabled, London EVM target.
- MATT, WRON, Katana router, Katana factory, and MATT/WRON pair validated on Ronin Mainnet.

## Deployment sequence

1. Deploy `MattMinePass` with final role and treasury addresses.
2. Deploy `MattMineSwapExecutor` with the temporary deployer as bootstrap admin.
3. Deploy `MattMineRewards` with final role and reserve addresses.
4. Deploy `MattMineRuns` with `MattMineRewards` as the current reward vault.
5. Grant the executor's `RUNS_ROLE` only to `MattMineRuns`.
6. Grant executor administration to the 2-of-3 multisig.
7. Renounce the temporary deployer's executor admin role.
8. Re-read every role, fixed address, price bound, and destination from chain.
9. Submit all four contracts to Sourcify v2 on Ronin chain 2020.
10. Back up the deployment manifest and verification links.

The script checkpoints each step and validates the final executor roles before marking the deployment complete.

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
