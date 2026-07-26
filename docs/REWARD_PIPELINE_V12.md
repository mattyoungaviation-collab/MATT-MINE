# MATT Mine v1.2 reward pipeline

MATT Mine v1.2 completes the path from an immutable weekly leaderboard snapshot to a player-signed MATT claim. Production deploys in **dry-run mode**. Merging this release cannot publish an epoch, transfer treasury MATT, or create a claimable reward by itself.

## Safety boundary

- `MATT_MINE_REWARD_PUBLISHING_ENABLED=false` is the production default.
- The configured and non-adjustable code ceiling prevents any board draft above 5,000,000 MATT.
- First place receives at most 30%, so its maximum payout is 1,500,000 MATT.
- A finalized weekly snapshot is mandatory.
- One primary admin creates the immutable allocation draft.
- A different secret is required for independent approval.
- The web server holds no treasury or reward-publisher private key.
- Publication is performed through the existing 2-of-3 MATT Mine Safe.
- Players submit their own claim transactions through Ronin Wallet.
- The on-chain `MattMineRewards` contract remains authoritative for publication, deadlines, pauses, duplicate-claim protection, and transfers.

## Pilot allocation

| Placement | Share of configured board pool |
|---|---:|
| 1st | 30% |
| 2nd | 18% |
| 3rd | 12% |
| 4th | 8% |
| 5th | 7% |
| 6th | 6% |
| 7th | 5.5% |
| 8th | 5% |
| 9th | 4.5% |
| 10th | 4% |

The complete approved board pool is funded and published. If fewer than ten wallets qualify, the same placement weights are normalized across the eligible wallets so the allocation still equals exactly 100% of the approved pool.

## Lifecycle

1. The UTC week ends.
2. The existing 24-hour moderation window passes.
3. The permanent Free or Pass leaderboard snapshot finalizes.
4. The primary admin creates a capped reward draft.
5. The server creates contract-compatible OpenZeppelin Merkle proofs.
6. The independent approver reviews and approves the exact root and totals.
7. In dry-run mode, the API returns a clearly marked Safe transaction preview.
8. When pilot publication is deliberately enabled, the same package is marked broadcast-ready.
9. The 2-of-3 Safe approves MATT, funds the reward vault, and publishes the immutable epoch.
10. The admin sync endpoint verifies the exact root, allocation, and deadline on Ronin.
11. Included players see their MATT reward in the leaderboard screen.
12. Each player signs their own `claim` transaction in Ronin Wallet.

## Environment settings

Render creates the independent approval secret automatically:

```text
MATT_MINE_REWARD_APPROVER_KEY=<generated Render secret>
MATT_MINE_REWARD_PUBLISHING_ENABLED=false
MATT_MINE_REWARD_MAX_BOARD_MATT=5000000
```

Keep publication disabled for the first full dry run. The code cap remains active even if the Render maximum is accidentally configured above 5,000,000 MATT.

## Operator API

Create an immutable draft with the primary admin key:

```http
POST /api/admin/rewards/drafts
X-Matt-Admin-Key: <primary key>
Content-Type: application/json

{
  "week": "2026-07-20",
  "mode": "free",
  "poolMatt": 10000,
  "claimDays": 30
}
```

Approve it with the separately generated approver key:

```http
POST /api/admin/rewards/drafts/reward_2026-07-20_free/approve
X-Matt-Reward-Approver-Key: <independent key>
Content-Type: application/json

{}
```

The result contains either `safeTransactionPreview` while dry-run mode is active or `safeTransactions` when deliberate pilot publication is enabled. The server reads the vault’s current MATT balance and active reservations first, so it never funds more than the exact shortfall. When funding is required, the Safe transactions are ordered:

1. Approve the exact MATT allocation.
2. Fund `MattMineRewards` with the exact allocation.
3. Publish the immutable Merkle root.

If paid-run routing has already left enough unreserved MATT in the vault, only the publication transaction is prepared.

After Safe execution, verify and activate the player-facing claim:

```http
POST /api/admin/rewards/drafts/reward_2026-07-20_free/sync
X-Matt-Admin-Key: <primary key>
Content-Type: application/json

{
  "transactionHash": "0x..."
}
```

The sync fails unless Ronin contains the exact approved epoch.

## Player API

Authenticated wallets use:

```text
GET  /api/rewards/claims
POST /api/rewards/claims/{draftId}/prepare
```

The prepare endpoint returns a zero-RON transaction to the verified `MattMineRewards` contract. Ronin gas still applies. The browser never chooses an amount, root, proof, contract address, or epoch.

## First production exercise

1. Merge and deploy with publication disabled.
2. Let one weekly leaderboard snapshot finalize.
3. Create a 10,000 MATT Free draft.
4. Independently approve it.
5. Compare every allocation and the Safe preview.
6. Do not execute the Safe transactions.
7. Confirm the dry-run report and database records.
8. Enable pilot publication only after the review is accepted.

Large payouts remain disabled throughout this release.
