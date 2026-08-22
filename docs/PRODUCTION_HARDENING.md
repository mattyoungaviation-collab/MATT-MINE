# Production Hardening

The active system keeps authentication, replay validation, NFT settlement, payments, and Admin mutations server-authoritative.

The retired browser-currency ledger and its purchase, claim, advertisement, character-store, and profile-power paths have been removed. Database migration `006_remove_legacy_browser_currency.up.sql` drops its obsolete normalized tables.

Current gameplay authority:

- The selected Miner NFT supplies persistent stats and progression.
- Equipped NFT gear supplies its defined on-chain effects.
- Temporary choices last only for the current run.
- Ordinary ore contributes score.
- Reward-bearing mines settle MATT Crystals through NFT V2.
- Active runs retain their pinned server rules for deterministic replay.
