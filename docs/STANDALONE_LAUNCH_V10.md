# MATT Mine v1.0 — Standalone Launch

MATT Mine now runs as its own website and service. It does not need to be hosted inside MATT Hub.

## What ships

- Original standalone launch page and MATT Mine identity
- Playable desktop and mobile browser game
- One Free ranked run per wallet per UTC day
- Separate Free and Pass leaderboards
- Ronin Wallet sign-in
- Live 95 RON Mine Pass purchase
- Live 10 RON paid-run purchase and RON-to-MATT swap
- One-time, receipt-backed paid-run credits
- Verified Ronin contract links
- PostgreSQL production persistence
- JSON-file local-development persistence
- Production health check at `/api/health`
- Render Blueprint and Docker deployment paths

MATT reward claims remain disabled. Do not fund a public reward epoch until score moderation and the claim publication workflow are complete.

## Render deployment

1. Merge the v1.0 pull request into the protected development branch.
2. In Render, create a new Blueprint from this repository.
3. Render will read `render.yaml` and propose:
   - `matt-mine` web service
   - `matt-mine-db` PostgreSQL database
4. Set `MATT_MINE_PUBLIC_ORIGIN` to the final HTTPS origin:

   ```text
   https://your-matt-mine-domain.example
   ```

   Use the exact scheme and host with no trailing slash.

5. Deploy.
6. Open:

   ```text
   https://your-matt-mine-domain.example/api/health
   ```

7. Confirm the response includes:

   ```json
   {
     "ok": true,
     "version": 11,
     "database": {
       "ok": true,
       "kind": "postgresql"
     },
     "chainId": 2020,
     "paymentsEnabled": true
   }
   ```

## Required production environment

| Variable | Required value |
|---|---|
| `DATABASE_URL` | Supplied by the PostgreSQL service |
| `MATT_MINE_PUBLIC_ORIGIN` | Exact public HTTPS origin |
| `MATT_MINE_MAINNET_TRANSACTIONS_ENABLED` | `true` only for the production payment service |
| `MATT_MINE_PAYMENT_CONFIRMATIONS` | `3` |
| `MATT_MINE_ADMIN_KEY` | Long generated secret; never expose in browser code |
| `PORT` | Supplied by the host |

Optional:

| Variable | Default |
|---|---|
| `RONIN_RPC_URL` | `https://api.roninchain.com/rpc` |
| `MATT_MINE_DATABASE_POOL_SIZE` | `10` |
| `MATT_MINE_DATABASE_SSL` | `false` for Render internal connections |
| `MATT_MINE_DATABASE_SSL_REJECT_UNAUTHORIZED` | `false` |

## Data safety

When `DATABASE_URL` is present, MATT Mine stores its normalized server state in PostgreSQL. Every mutation:

1. Begins a database transaction.
2. Locks the state row.
3. Applies the server-side entitlement or run mutation.
4. Writes the normalized state.
5. Commits atomically.

This protects confirmed transaction receipts and paid-run credit consumption across process restarts and multiple web instances. It is a launch architecture intended for a controlled early audience. A future scale phase should split wallets, runs, scores, and entitlements into dedicated relational tables.

Enable automated PostgreSQL backups before public rewards begin.

## Controlled live-payment check

Use a test wallet with only the RON needed for the check.

1. Sign in with Ronin Wallet.
2. Confirm the site displays the onchain 95 RON Pass price.
3. Purchase one Pass and record the transaction hash.
4. Confirm the Pass is active on the site and in Ronin Explorer.
5. Purchase one 10 RON paid run and record the transaction hash.
6. Confirm exactly one server credit appears.
7. Start one Pass ranked run.
8. Confirm the credit immediately changes from one to zero.
9. Restart the web service.
10. Confirm the spent transaction cannot create another credit.
11. Reconcile the RON destinations and 70/20/10 MATT split against the transaction receipt.

## Domain checklist

- Point the chosen domain to the new MATT Mine web service.
- Wait for HTTPS to become active.
- Update `MATT_MINE_PUBLIC_ORIGIN` to the custom domain.
- Redeploy after the environment change.
- Test wallet sign-in again because the signed login message is bound to the website origin.
- Do not reuse the MATT Hub origin or session.

## Public-launch boundary

Safe to enable:

- Free ranked runs
- Practice runs
- Wallet sign-in
- Pass purchase
- Paid-run purchase
- Pass leaderboard scoring

Keep disabled until the next reward release:

- Onchain MATT claims
- Automatic reward-root publication
- Unmoderated token payouts
- Large reward-vault funding

## Incident response

If a payment, wallet, or contract issue appears:

1. Pause Pass or paid-run purchases through the existing contract role.
2. Set `MATT_MINE_MAINNET_TRANSACTIONS_ENABLED=false` and redeploy the web service.
3. Preserve PostgreSQL and server logs.
4. Record the affected wallet and transaction hashes.
5. Reconcile the receipt before manually issuing any credit.

Never request or accept a player seed phrase or private key.
