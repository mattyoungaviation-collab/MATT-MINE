# MATT Mine v0.9 live-payment runbook

## Safety boundary

Live Ronin transactions are disabled by default. The server enables them only
when `MATT_MINE_MAINNET_TRANSACTIONS_ENABLED` is exactly `true`. Enabling the
server does not broadcast a transaction: the connected player must click a
purchase button, confirm the displayed amount, and approve the transaction in
Ronin Wallet.

MATT reward claims remain disabled.

## Approved Ronin Mainnet contracts

- MATT Mine Pass: `0x56a6d4Cf4Fbd1C7aA1572028556657CbC0fB5855`
- MATT Mine Paid Runs: `0x4B5D10f6DA960436c5E3c23F40C52d36E2225555`
- MATT Mine Rewards: `0x6ba468EE15cb3634F4Ea340407E9FD7A75267619`
- MATT Mine Swap Executor: `0x9f700037e9C8B3FfB5eDA15CDcf5a76bce235Af0`
- MATT token: `0xa5450417BDCa0BDfB058ffE41205400FfDA1174d`

## Local live-mode start

In PowerShell:

```powershell
$env:MATT_MINE_MAINNET_TRANSACTIONS_ENABLED = "true"
$env:MATT_MINE_PAYMENT_CONFIRMATIONS = "3"
npm.cmd run dev
```

Clear the switch after stopping the server:

```powershell
Remove-Item Env:MATT_MINE_MAINNET_TRANSACTIONS_ENABLED -ErrorAction SilentlyContinue
Remove-Item Env:MATT_MINE_PAYMENT_CONFIRMATIONS -ErrorAction SilentlyContinue
```

## Purchase flow

1. The player signs in with Ronin Wallet on chain 2020.
2. The server reads Pass status, prices, pauses, and daily purchases from Ronin.
3. A Pass purchase sends the current exact contract price to `MattMinePass`.
4. A paid-run purchase requests a fresh Katana quote from the server.
5. The server applies 5% minimum-output protection and a five-minute deadline.
6. Ronin Wallet displays the prepared transaction for explicit player approval.
7. The server waits for the configured confirmation count.
8. The server verifies the transaction sender, approved Runs contract, function
   call, successful receipt, and matching `PaidRunPurchased` event.
9. The confirmed event becomes one server-side paid-run credit.
10. Starting a paid run atomically consumes that credit once.

Re-submitting the same transaction is idempotent and never creates a second
credit. A transaction from another wallet, to another contract, with a reverted
receipt, or without the expected event is rejected.

## First controlled smoke test

At the deployed prices, a new player needs exactly 95 RON for the 30-day Pass
and 10 RON for one paid run, plus transaction gas. Use one approved test wallet
and reconcile:

1. Pass expiry increased by 30 days.
2. Pass RON reached the configured 50/30/20 destinations.
3. Paid-run RON swapped to MATT.
4. Purchased MATT reached the 70/20/10 destinations.
5. The server issued exactly one credit.
6. Starting the paid run consumed exactly one credit.
7. A second start without another purchase was rejected.

Do not fund a reward epoch as part of this smoke test.
