# MATT Mine Admin Command Center

The private command center is available at:

```text
https://matt-mine.onrender.com/admin.html
```

It is not linked from the public game and search engines are told not to index it. Access still depends on the production `MATT_MINE_ADMIN_KEY`; knowing the URL is not authorization.

## What it controls

- Production overview, player counts, run counts, payments, reward status, and deployed addresses
- Immediate server maintenance, Free ranked, Pass ranked, paid purchase, and claim pauses
- Player search, suspension, restoration, session revocation, stuck-run expiry, and restoration of a legitimate daily free attempt
- Reward draft creation from finalized weekly snapshots, independent approval, Safe transaction output, and Ronin publication sync
- Prepared Ronin transactions for contract pauses, unpauses, price updates, treasury destinations, swap executor changes, and expired/unallocated reward recovery
- Searchable audit history with a required written reason for every mutation

## Intentionally protected

The command center cannot:

- Edit a completed score or finalized leaderboard snapshot
- Invent a paid-run credit or modify a confirmed payment
- Change a published Merkle root or reduce a published player claim
- Change the deployed MATT or MATT Mine contract addresses
- Exceed the hard 5,000,000 MATT per-board reward ceiling
- Store a private key, sign a Ronin transaction, or bypass a contract role

Contract controls that require the Treasury Safe produce a downloadable Safe Transaction Builder `.json` file. Download it, open the Transaction Builder in the MATT Mine Treasury Safe, and drag the file into the builder. The file includes Ronin chain ID 2020, the Treasury Safe address, the destination, value, calldata, metadata, and checksum. Review every field before creating and signing the Safe transaction.

Actions assigned to a separate role wallet do not produce a Safe file. The command center labels those actions with the exact required signer and provides their raw transaction JSON instead.

## Key handling

- The primary key is kept in browser `sessionStorage`, so it disappears when the tab session ends or when **Lock** is pressed.
- The independent reward approver key is requested only for approval and is never stored.
- Never paste a seed phrase or private key into the command center.
- Rotate `MATT_MINE_ADMIN_KEY` in Render immediately if it is exposed.

## Emergency order

1. Use server controls to stop the affected production surface immediately.
2. If the problem is on-chain, prepare the matching pause transaction.
3. Have the emergency pauser sign the pause.
4. Record the incident and investigation in the admin reason.
5. Unpause only after the server and contract states are both verified.
