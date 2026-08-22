# MATT Mine NFT V2 player guide

Status: product guide for final copy review. Contract state and the values shown in the game are authoritative. Rewards, token value, network availability, and marketplace liquidity are not guaranteed.

## Start here

MATT Mine has three player routes:

| Mine | Wallet | Miner NFT | What persists |
| --- | --- | --- | --- |
| Practice Mine | Not required | Not required | No Miner XP and no MATT Crystals |
| MATT Arena | Required | Required | Configured Miner XP and MATT Crystals; separate Arena score and prize rules may apply |
| Pass Mine | Required | Required | Configured Miner XP and MATT Crystals; Mine Pass progression is separate |

The exact live values appear before a rewarded run. A mine being visible does not guarantee that entries, results, payments, rewards, or withdrawals are currently open.

## The normal player journey

1. Open Home.
2. Choose Practice or connect a Ronin Mainnet wallet.
3. Select a Miner owned by that wallet.
4. Review or change the Miner's loadout.
5. Choose MATT Arena or Pass Mine.
6. Approve the Miner run message when requested.
7. Mine, fight, defeat the Guardian, and decide whether to extract or descend.
8. Wait for the confirmed result.
9. Review XP, banked gameplay Crystals, equipment consequences, and transaction status.
10. Open the Crystal Bank to withdraw when eligible, or choose the next run.

A sign-in message does not transfer tokens. A run authorization is also a signature, not a token payment. Ronin Wallet shows a transaction separately whenever an action spends MATT, RON, or network gas.

## Miner ownership and selection

There are at most 1,000 Miner NFTs. A rewarded run can use only a Miner owned by the connected wallet.

If a wallet owns several Miners, check the exact token number before entering. The run binds:

- player wallet;
- Miner ID;
- selected loadout;
- mine map version;
- one-time nonce;
- approval deadline.

Changing wallet, Miner, loadout, map, or nonce invalidates an old approval. Approve the new values instead of retrying a stale signature.

## Miner progression

Miner XP is permanent on the Miner NFT and cannot be reduced through ordinary gameplay.

- Level begins at 1.
- Level 100 requires 360,000 total banked XP.
- Health, attacks, healing, carry capacity, and death retention follow the fixed level curve.
- Evolution artwork changes at approved level milestones.
- Miner XP and Mine Pass XP are different systems.

Rewarded maps configure five per-phase XP values. Extraction banks the sum for every completed phase. Death or force-abandon banks zero session XP.

The results screen should show the exact XP applied. If the result is uncertain, do not start a second run with the same Miner; refresh and use the recovery status first.

## Traits

The selected Miner supplies:

- Base Health;
- Pickaxe Attack;
- Blaster Attack;
- Dynamite Attack;
- Heal amount;
- base carry capacity;
- Crystal death-retention percentage;
- level, evolution, and passive-reward state.

Equipped gear modifies the effective values. The game's Admin-controlled map and combat settings may also change future runs, but a run already started keeps its pinned rules.

## Equipment and loadout

The six slots are:

1. Armor
2. Pickaxe
3. Blaster
4. Dynamite
5. Helmet
6. Backpack

Equipment is an NFT. An item cannot be equipped to two Miners at once. Loadout changes are unavailable while the Miner is locked in a run.

### Armor

Healthy Armor supplies a separate shield. Damage reaches that shield before Base Health.

- Extraction preserves Armor.
- Death changes equipped Armor to Damaged.
- Damaged Armor remains an NFT and may remain equipped or be traded, but it provides zero shield.
- Repair transfers the displayed MATT amount to Treasury and restores the shield.
- Ronin network gas may also be required.

Always inspect Armor State before entering a rewarded mine.

### Backpack

A Backpack increases effective Crystal carry capacity.

- Extraction preserves the Backpack.
- Death or approved force-abandon permanently burns the equipped Backpack.
- A burned NFT cannot be repaired, restored, equipped, or sold.
- Pickaxe, Blaster, Dynamite, and Helmet are not burned by an ordinary death.

The confirmation shown before ending a locked run is important: ending it applies death consequences.

## Extraction, death, and descent

At an extraction decision:

- Extract to settle the run with completed-phase XP and the full eligible carried Crystal value.
- Descend to pursue a deeper result under the same pinned run.
- If the Miner dies, session XP is zero, the Miner's death-retention percentage applies to eligible carried Crystals, Armor is damaged, and the Backpack is burned.

The displayed payout is subject to:

- replay-verified mined units;
- the Miner's effective carry capacity;
- the map's conversion rate;
- the map's maximum payout;
- deterministic rounding;
- the Miner's death-retention percentage for a death.

Maximum payout is a ceiling, not a promised result.

## Three different Crystal concepts

The word Crystal can describe three different states:

1. Mined units: in-run units collected during gameplay.
2. Banked gameplay Crystals: wallet-owned credit held inside the V2 Crystal Bank after a verified settlement.
3. MATT CRYSTALS token: the existing token minted to the wallet only after a successful withdrawal.

Mined units are converted by the active map. One mined unit does not necessarily equal one token.

The result screen should identify mined units and banked MATT Crystals separately.

## Crystal Bank and withdrawal

Verified settlements credit the connected player's Crystal Bank. Banked gameplay Crystals belong to the wallet, not to the Miner NFT.

To withdraw:

1. Open the selected Miner's command center.
2. Review the bank balance and minimum withdrawal.
3. Enter an amount no greater than the bank balance.
4. Confirm the Crystal Bank transaction in Ronin Wallet.
5. Wait for a successful receipt.
6. Refresh balances.

A withdrawal:

- deducts the same amount from the gameplay bank;
- mints that amount of the MATT CRYSTALS token to the wallet;
- can happen only once for that transaction;
- must meet the active minimum;
- cannot exceed the active wallet-daily or global-daily limit;
- may require RON network gas.

If a daily limit is reached, the remaining gameplay-bank balance stays in the contract. It does not disappear; wait for a later limit window unless the game reports a separate incident.

Do not confuse the gameplay-bank balance with the wallet token balance.

## Equipment chests

There is one chest category for each equipment slot. Chest prices are shown in MATT.

The normal flow may require:

1. an exact MATT allowance transaction;
2. the chest purchase transaction;
3. a Ronin VRF request;
4. later fulfillment and NFT mint.

Randomness is pinned to the original request. A retry must not reroll the result. If the request remains unfulfilled past the contract's refund delay, use only the original approved refund path shown by the game. Do not pay a support agent to “unstick” randomness.

Chest odds, available definitions, price, and network fees can change for future purchases through approved governance. Review the current disclosure before buying.

## Level 100 passive rewards

The first successful transition to Level 100 requests one permanent random rate.

- The rate is a whole number from 5 to 50 Crystals per Hour under the current specification.
- It is assigned once and cannot be rerolled.
- The rate stays with the Miner.
- A Miner accrues only while active.
- A verified extraction or death renews activity for seven rolling days.
- Inactive time does not earn retroactive credit after activity resumes.
- Payout depends on the approved daily Keeper process and contract availability.

The rate is not a guarantee of continuous payment, token value, liquidity, or profit.

## Mine Pass XP and Arena prizes

Mine Pass XP, Miner XP, gameplay-bank Crystals, and Arena MATT prizes are separate:

- Miner XP advances the selected NFT.
- Mine Pass XP advances the premium pass reward track.
- Gameplay-bank Crystals can later be withdrawn as MATT CRYSTALS.
- Arena leaderboard prizes follow the published Arena rules and settlement process.

A displayed projection is not a final prize. Arena results remain subject to replay verification, eligibility, moderation, and the published settlement rules.

## Transfers and marketplace sales

When a Miner transfers:

- banked Miner XP, level, evolution, fixed passive rate, and Miner traits stay with it;
- equipment currently held in the Miner's loadout custody follows the Miner;
- Armor damage state follows the Armor NFT;
- wallet-owned gameplay-bank Crystals do not transfer;
- wallet token balances do not transfer;
- unequipped equipment owned directly by the seller does not transfer with the Miner.

Check marketplace metadata immediately before buying. Metadata may update after level, equipment, damage, repair, activity, or passive-rate changes.

Marketplace price, offers, currency, fees, royalties, order execution, and disputes are governed by the marketplace and applicable project terms. A listing does not guarantee resale or liquidity.

## Active-run lock and recovery

A Miner is locked while its on-chain run is active. During the lock, it cannot safely start another run or change loadout.

If the browser refreshes:

1. reconnect the same wallet;
2. select the same Miner;
3. wait for the active-run check;
4. use the explicit locked-run recovery action if the Miner remains locked.

The current public client does not reconstruct a rewarded run after a full browser refresh. The recovery action is a death settlement, not a resume button.

Ending a locked run is a death settlement:

- zero session XP;
- zero new session Crystal value for an orphan recovery;
- Armor damage if Armor is equipped;
- Backpack burn if a Backpack is equipped;
- Miner unlock after confirmation.

The contract also has a timeout-protected owner force-abandon path. Use only the official interface and verify the Miner ID and consequences.

Never start a replacement paid attempt while the original chain outcome is unknown.

## Fees and failed transactions

Players may pay Ronin gas for:

- MATT approvals;
- chest purchases;
- Armor repair;
- loadout changes;
- Crystal withdrawal;
- marketplace actions.

The server currently pays gas for approved run start and settlement transactions. This behavior can change in a later release.

A failed or replaced transaction can still consume network gas. A wallet prompt, submitted hash, and confirmed successful receipt are different states. Wait for confirmation before retrying.

## Security

- Use only the official MATT Mine site and verified contract links.
- Verify the connected chain is Ronin Mainnet, chain ID 2020.
- Read the wallet transaction before approving it.
- Never share a seed phrase, private key, session token, or recovery code.
- MATT Mine support will never need a seed phrase.
- Ignore direct messages offering manual reward recovery, guaranteed chest results, or private sales.
- Disconnect an unfamiliar site and revoke unwanted token approvals through trusted wallet tools.

## Support evidence

For a run, payment, withdrawal, chest, or metadata problem, provide:

- wallet address;
- Miner ID;
- equipment IDs if relevant;
- mine name;
- approximate UTC time;
- server run ID and on-chain run ID if shown;
- transaction hash;
- screenshot of the visible error with secrets removed;
- browser, device, and wallet connection method.

Do not send a seed phrase, private key, signature, cookie, or full session token.

Support should not mark a run resolved until the server record and on-chain Miner lock agree.

## Frequently asked questions

### Can I play without buying anything?

Yes. Practice is public and does not require a wallet or Miner. It awards no Miner XP or MATT Crystals.

### Does buying a Miner guarantee rewards?

No. Gameplay results, configured limits, eligibility, contract availability, token conditions, and player decisions all affect outcomes. Value and rewards are not guaranteed.

### Why is my Crystal Bank balance different from my wallet?

The Bank is internal gameplay credit. A successful withdrawal is required before the MATT CRYSTALS token appears in the wallet.

### Why did I receive no XP after death?

NFT V2 banks session XP only on extraction. Death and force-abandon bank zero session XP.

### Why does my Armor show zero shield?

It may be Damaged after a death. Repair it for the displayed MATT price or replace it before the next run.

### Can support restore a burned Backpack?

No. The Backpack burn is a permanent on-chain death consequence. Support can investigate an incorrect transaction but cannot privately recreate the same NFT.

### Why can I not withdraw my full balance?

The amount may be below the minimum, above the wallet's remaining daily limit, or blocked by the global daily limit. Unwithdrawn balance remains banked.

### Does passive earning continue forever without playing?

No. Activity expires after seven rolling days under the current rules. A later verified settlement renews activity without paying the inactive gap retroactively.

### What happens if I sell my Miner?

The new owner receives the Miner with its progression, status, and equipment held in its active loadout. Your wallet's gameplay-bank Crystals and token balances stay with your wallet.

### Where are the final legal terms?

Use only the effective Terms, Privacy Policy, NFT/token disclosures, and competition rules linked by the live site. Repository files marked draft or counsel review required are not effective public terms.
