# MATT Mine Operations Runbook

Open the private Command Center at:

```text
https://matt-mine.onrender.com/admin.html
```

Choose **Mine Operations**. This is the daily operator page for Practice Mine, MATT Arena, Daily Mine, Pass Mine, and Seven-Day Mine.

## The mine switches

- **New runs**: blocks new entries. Existing active runs are preserved.
- **Finish runs**: blocks result processing. Use this only after active runs reach zero, unless result processing itself is unsafe.
- **Payments**: stops new payment quotes or confirmations for that mine. Confirmed payment records remain stored.
- **Rewards**: stops reward creation, approval, synchronization, and player claims for that mine. Existing obligations remain stored.

Controls that do not exist for a mine are visibly marked **NOT USED** instead of pretending to pause something. Every applicable switch takes effect immediately, requires a written reason, and is written to the server audit log.

## Safely close one mine

1. Write the reason for closing it.
2. Pause **New runs**.
3. Watch the card until **active** reaches zero.
4. Pause **Finish runs**.
5. Verify the final leaderboard or Arena results.
6. Leave **Payments** and **Rewards** open unless they are affected by the incident.

To reopen, verify the payment and replay systems first, resume **Finish runs**, then resume **New runs**.

## Publish Free and Pass ranked rewards

Free ranked is the **Daily Mine** board. Pass ranked is the **Pass Mine** board. They are published separately.

1. In **Free + Pass Payout Desk**, choose the Monday UTC that began the finished competition week.
2. Press **Load Free + Pass**.
3. Confirm Step 1 says **Leaderboard closed**. If it does not, the server has not finalized the immutable weekly snapshot yet.
4. Enter the total MATT pool and claim-window length for each board, then press **Create exact obligation**.
5. Verify the pool, claim deadline, winner count, and every wallet amount.
6. Press **Approve + create Safe JSON** and enter the separate reward approver key.
7. Download the generated Safe JSON.
8. Open the MATT Mine Treasury Safe, drag the JSON into Transaction Builder, and review the destination, MATT amount, Merkle root, claim deadline, and Ronin chain ID 2020.
9. Obtain the required 2-of-3 Safe approvals and execute.
10. Return to the Payout Desk and press **Check Ronin + synchronize**.
11. Confirm Step 5 says **Players can claim**.

The browser does not decide winners or payouts. The server uses the finalized leaderboard snapshot, creates an immutable obligation, and checks the exact epoch on Ronin before claims are exposed.

## Track unpaid rewards

Each board displays:

- Total pool
- Claim deadline
- MATT already claimed
- MATT still owed
- Every winner wallet, rank, score, amount, and paid/unpaid status

Press **Refresh live status** to reconcile claim status from Ronin. “Unpaid” means the wallet still has a valid on-chain claim; it does not mean the server should send a manual transfer.

## Correct a failed current-week score

Use this only when support has verified that a Daily or Pass run ended in the client but failed before its replay result reached the leaderboard.

1. Find the wallet in the Admin player search and open **Complete player editor**.
2. Under **Leaderboard score correction**, choose Daily Mine or Pass Mine.
3. Enter the exact current-week score reported in the support evidence.
4. Leave **End active run for the selected mine** checked when the player is locked out by a stale run.
5. Enter the support reason and confirm the replay bypass.
6. Reopen the leaderboard and verify the exact score and wallet.

The action changes only the selected wallet and mine, records the previous and replacement scores, and closes only matching active runs. It cannot alter a finalized payout week.

Do not recover expired or unallocated MATT until:

1. The claim deadline has passed.
2. The epoch is closed on Ronin.
3. The unpaid list has been reviewed.
4. The recovery transaction has been independently checked.

## MATT Arena

MATT Arena uses the same server switches for entries, results, and payments, but its player-funded pool is settled through the separate **Daily Arena** contract workflow.

1. Pause Arena **New runs**.
2. Let active runs reach zero.
3. Pause Arena **Finish runs**.
4. Open **Daily Arena**.
5. Verify the UTC day, pool, entrants, and winners.
6. Prepare and execute the full-pool settlement Safe file.

Never use the Free + Pass Payout Desk to settle MATT Arena.

## Incident rule

Pause only the affected mine and surface first. Use whole-site emergency controls only when more than one mine is affected. Pausing never deletes a confirmed payment, finished score, immutable reward obligation, or player claim.
