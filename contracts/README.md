# Contract integration boundary

The v0.4 game contains a local economy adapter and contract-facing interfaces, but no deployable production contract implementation. This is deliberate.

Before real funds are enabled, the contract track must provide:

1. `MattMinePass` — accepts RON, records nontransferable 30-day access, supports immediate emergency pause, and uses separate admin roles.
2. `MattMineRuns` — requires an active pass, accepts the configured RON price, buys MATT through a verified swap executor, applies the 70/20/10 split, burns zero MATT, and emits one entitlement event per purchase.
3. `MattMineRewards` — stores immutable weekly Free and Pass reward roots, prevents duplicate claims, supports immediate claim pause, and returns expired rewards only under approved treasury controls.
4. `MattMineSwapExecutor` — contains the chain-specific router integration, minimum-output protection, deadline validation, and approved path configuration.
5. 2-of-3 multisig ownership for treasury and major contract administration. No timelock.

The router address, ABI, path, slippage policy, and testnet deployments must be verified before implementation is considered deployable. Never copy browser-calculated scores, reward amounts, or swap output into production as trusted values.
