# MATT Mine v0.7 Mainnet Safety Boundary

v0.7 authenticates wallets on Ronin Mainnet chain `2020` only. The runtime no longer exposes a network-selection environment variable or an alternate network path.

## Mainnet authentication

- The client reads the current chain from the injected Ronin Wallet provider.
- If necessary, it requests `wallet_switchEthereumChain` for chain `0x7e4`.
- The server accepts challenges only for chain `2020`.
- The one-use login challenge remains bound to the wallet, origin, nonce, issued time, and expiry.
- The wallet signs a message only. Login does not request or submit a transaction.
- Account and chain changes invalidate the browser session.

## Mainnet transaction lock

The server reports all of the following as disabled:

- `paidRunsEnabled`
- `realPaymentsEnabled`
- `mattClaimsEnabled`
- `mainnetTransactionsEnabled`

No v0.7 API accepts RON, activates a paid Pass, executes a swap, or publishes a MATT claim. Local Pass and administration screens remain product-flow sandboxes.

## Before enabling transactions

Mainnet payments must remain disabled until the exact contracts, router, token addresses, slippage rules, deadlines, treasury limits, pause controls, receipt verification, monitoring, and recovery process have been independently reviewed and tested with tightly capped transactions.
