# MATT Mine Nugget Economy

## Production model

Persistent nugget balances are owned by the MATT Mine server. The browser displays the balance returned by authenticated APIs but does not calculate or persist authoritative credits.

All balance changes use the canonical nugget ledger. Existing legacy balances migrate once through a `MIGRATION` entry. The production economy adds verified `NUGGET_PURCHASE` entries and exact paid `PRACTICE_CLAIM` entries. Knockout rewards receive a canonical `RUN_DEATH_RETENTION` credit using an append-only correction so the earlier compatibility entry is never edited or deleted.

The following pathways are covered:

| Pathway | Persistent treatment |
| --- | --- |
| Successful ranked extraction | `RUN_EXTRACTION` |
| Ranked knockout retention | Append-only reversal plus `RUN_DEATH_RETENTION` |
| Practice run | Pending only; no automatic banking |
| Verified paid Practice claim | `PRACTICE_CLAIM` |
| Pass chest | `CHEST_REWARD` |
| Admin balance change or reset | `ADMIN_ADJUSTMENT` |
| Verified package purchase | `NUGGET_PURCHASE` |
| Permanent upgrade purchase | Audited ledger debit |
| Pass rewards | Cosmetics and chests remain server-owned; any future direct nugget reward must use `PASS_REWARD` |
| Advertisement bonus | Disabled until a signed provider/server-to-server completion verifier exists; future credits must use `ADVERTISEMENT_BONUS` |
| Enemy and boss drops | Run-local projected loot only; they become persistent through the final run entry, not separate browser-controlled credits |

No MATT is burned by this system.

## Persistence

JSON deployments use:

- Main server state: `data/matt-mine-store.json`
- Nugget economy state: `data/matt-mine-nugget-economy.json`

PostgreSQL deployments use the existing main state transaction and a dedicated single-row JSONB table:

- `matt_mine_nugget_economy`

The economy store serializes quote creation, transaction-hash reservation, daily-cap checks, and purchase confirmation. The main database transaction then credits the canonical player ledger.

## Default configuration

All paid nugget features are disabled by default.

- Package: 1,000,000 nuggets
- Displayed reference: $5.00
- Default exact price: 5,000 MATT
- Daily purchase cap: 1,000,000 nuggets per wallet per UTC day
- Quote lifetime: 5 minutes
- Practice claim default: 5,000 MATT
- MATT payments allowed
- RON payments disabled
- Recipient: approved MATT Mine Treasury Safe

USD is display-only. It is never used to settle or recalculate a quote.

## Required environment variables

The general production payment verifier must be enabled:

```text
MATT_MINE_MAINNET_TRANSACTIONS_ENABLED=true
```

The nugget verifier has a second independent release switch:

```text
MATT_MINE_NUGGET_PAYMENTS_ENABLED=true
```

Recommended production values:

```text
RONIN_RPC_URL=<approved Ronin Mainnet RPC>
MATT_MINE_PAYMENT_CONFIRMATIONS=3
MATT_MINE_NUGGET_ECONOMY_FILE=data/matt-mine-nugget-economy.json
```

On PostgreSQL, `MATT_MINE_NUGGET_ECONOMY_FILE` is unused.

Both release switches and the exact verifier must be present before the Admin Command Center will allow purchases or paid Practice claims to be enabled.

## Exact payment verification

Every quote binds:

- Wallet address
- Purpose
- Package or Practice run
- Nugget amount
- Asset
- Exact atomic payment amount
- Approved recipient
- Official MATT token address when applicable
- UTC day
- Creation and expiration timestamps

RON payments must be a direct transfer with the exact value and no calldata.

MATT payments must:

- Target the official MATT token contract
- Include zero RON
- Call the exact ERC-20 `transfer(recipient, amount)` function
- Emit a matching successful `Transfer` event from the signed-in wallet

The server verifies receipt success, confirmations, sender, recipient, chain client, token, amount, transaction shape, and event. Underpayment and overpayment both fail. A transaction hash is globally reserved before RPC verification and cannot be used for another quote or wallet.

## Daily cap

The purchase cap uses UTC date boundaries. It is checked:

1. When the quote is created
2. When the transaction hash is reserved for confirmation

Confirmed purchases and currently verifying quotes count toward the cap. A new allowance begins at 00:00 UTC.

## Admin workflow

Open **Nugget Economy** in the private Admin Command Center.

Admins can configure:

- Purchases enabled
- Paid Practice claims enabled
- Advertisement rewards enabled flag
- MATT and RON payment eligibility
- Nuggets per MATT
- Derived MATT per nugget
- Displayed USD reference
- UTC daily cap
- Quote lifetime
- Approved recipient
- Practice price and asset
- Structured purchase packages
- Character unlock nugget prices

Every save requires a written reason and produces both economy and main server audit entries.

## Player workflow

The main menu contains **NUGGET SHOP**.

1. Sign in with Ronin Wallet.
2. Open the Nugget Shop.
3. Choose an enabled package and asset.
4. Review the exact server quote and expiration.
5. Confirm the prepared transaction in Ronin Wallet.
6. Wait for the wallet receipt.
7. The server independently verifies the receipt and credits the ledger.

Purchase history is shown with the exact asset, amount, UTC time, package, nuggets, and Ronin transaction link.

For Practice claims, the player no longer pastes a transaction hash. When the verified feature is enabled, the claim button obtains the exact server quote, opens Ronin Wallet, and submits the mined hash to the server.

## Release checklist

1. Deploy the code with both paid feature flags unset or false.
2. Confirm the application starts and the Admin release blocker is visible.
3. Confirm existing balances, upgrades, Pass state, and leaderboards are unchanged.
4. Confirm JSON or PostgreSQL economy persistence is healthy.
5. Set and verify the approved payment recipient.
6. Review every package exact atomic price.
7. Confirm the MATT token address is the official contract.
8. Run the full automated workflow.
9. Enable `MATT_MINE_MAINNET_TRANSACTIONS_ENABLED=true`.
10. Enable `MATT_MINE_NUGGET_PAYMENTS_ENABLED=true`.
11. Restart and verify the Admin page reports the exact verifier ready.
12. Enable one package in Admin with a written reason.
13. Perform one low-risk controlled wallet purchase and inspect the ledger, purchase history, transaction, recipient, and balance.
14. Only then enable paid Practice claims.

## Emergency pause

Fastest pause:

- Turn off **Enable nugget purchases** and **Enable paid Practice claims** in Admin.
- The existing global **Pause purchase confirmation** operation remains available as a second server-wide control.

Hard release pause:

```text
MATT_MINE_NUGGET_PAYMENTS_ENABLED=false
```

Restarting with that value blocks quote creation and confirmation even if an old Admin configuration says enabled.

## Rollback

1. Disable the two paid features in Admin.
2. Set `MATT_MINE_NUGGET_PAYMENTS_ENABLED=false` and restart.
3. Roll back the application commit if required.
4. Do not delete the economy JSON file or PostgreSQL row.
5. Do not edit confirmed purchase records or ledger entries.
6. Reconcile any payment that was mined before the pause from its transaction hash and server audit trail.

The economy store is additive and separate from leaderboard custody, reward drafts, finished scores, and on-chain assets. Rolling back the UI or quote endpoints does not erase confirmed nugget ledger history.
