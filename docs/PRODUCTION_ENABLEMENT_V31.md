# MATT Mine production enablement v3.1

## What is authoritative

- Free, Pass, Weekly, Endless, and Daily Arena use fixed 20 ms simulation steps.
- Competitive clients send changed raw controls and game commands, never score totals.
- The server stores ordered events, signs each checkpoint, replays the exact immutable run snapshot, and derives the accepted result.
- Weekly is one mine per open day. Endless uses one immutable season snapshot shared by the season.
- Browser profile data is presentation/cache data only. Server ledgers, identities, purchases, rewards, competition results, and entitlements remain authoritative.

## Paid revive safety

Paid revive payments use an exact direct-RON transfer:

- sender must equal the signed-in wallet;
- recipient must equal `0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc`;
- value must exactly equal the server quote;
- calldata must be empty;
- the receipt must succeed and reach the configured confirmation count;
- a transaction hash can be consumed only once;
- death eligibility comes from the stored replay transcript, not browser health data.

The feature remains controlled by both `MATT_MINE_REVIVE_PAYMENTS_ENABLED` and the Admin expansion switch.

## Advertisement safety

Advertisement rewards remain disabled in the production Blueprint until a real provider is selected. A provider must return a server-verifiable HMAC completion token bound to:

- provider name;
- unique completion identifier;
- wallet address;
- run identifier;
- reward percentage;
- short expiration.

Set all three values before enabling the Admin switch:

```text
MATT_MINE_ADVERTISEMENT_REWARDS_ENABLED=true
MATT_MINE_ADVERTISEMENT_PROVIDER=<reviewed-provider-id>
MATT_MINE_ADVERTISEMENT_HMAC_SECRET=<provider-shared-secret-at-least-32-characters>
```

No token means no reward. Client callbacks alone never award nuggets.

## Treasury Safe policy

The Treasury Safe has three independent owners and an operator-approved threshold of 1. Preflight scripts now verify the live Safe against that exact policy. This is intentionally fast but provides less compromise resistance than 2-of-3. The server never stores a Safe owner key and never signs or broadcasts Treasury transactions.

The immutable deployment manifests retain the configuration hash created when the Safe was 2-of-3. Read-only checks accept that exact historical hash, then independently require the current live 1-of-3 Safe owner/threshold state. Other manifest or configuration mismatches still fail.

## Render

Blueprint sync creates the competitive replay secret and configures the exact revive recipient. After merge:

1. Let Render finish the automatic deploy from `main`.
2. Confirm `/api/health` is healthy.
3. Open the Admin Command Center and confirm Competitive Replay is configured.
4. Play one Free run through extraction or knockout and verify it appears on the leaderboard.
5. Play Weekly and Endless once and confirm both results say server verified.
6. Keep advertisement rewards disabled until the provider integration has been reviewed end to end.

## Rollback

- Disable Weekly and Endless in Admin.
- Pause Free/Pass ranked runs if replay errors appear.
- Set `MATT_MINE_REVIVE_PAYMENTS_ENABLED=false` to remove paid revive quotes.
- Set `MATT_MINE_ADVERTISEMENT_REWARDS_ENABLED=false` to reject every ad completion.
- Roll Render back to the prior healthy deployment. Persisted transcripts are isolated from core player and reward tables.
