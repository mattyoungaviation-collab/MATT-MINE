# MATT Mine v0.6 Security Boundary

v0.6 moved ranked identity, entitlements, profiles, scores, and suspensions out of browser storage and into a same-origin server.

## Authentication

- The client requests a five-minute, single-use sign-in challenge.
- The message is bound to the requested wallet, Ronin chain, website origin, nonce, issued time, and expiration time.
- The server verifies the exact signed message with `viem`.
- Successful verification consumes the challenge and returns a 24-hour bearer session.
- Only a SHA-256 session-token hash is stored on the server.
- The browser keeps the raw token in `sessionStorage`, so it is cleared when the browser session closes.
- Account and chain changes invalidate the client session.

## Run validation

- The server issues opaque, single-use run tokens.
- Free ranked runs are limited to one wallet entitlement per UTC day.
- Run tokens expire and are bound to the authenticated wallet, mode, date, and mine seed.
- Completed run tokens cannot be replayed.
- Result payloads use allow-listed fields, numeric bounds, duration checks, and cross-field telemetry checks.
- Knockout submissions credit exactly the secured banked amount.
- Suspended wallets cannot start or submit ranked runs, but Practice remains available.

## HTTP protections

- JSON request bodies are limited to 64 KB.
- Authentication and challenge endpoints are rate limited.
- State-changing requests are restricted to the configured website origin.
- Static file paths are resolved within the repository root.
- Responses include content-type, frame, referrer, permissions, and content-security-policy headers.

## Persistence and recovery

- Server writes use a temporary file followed by an atomic rename.
- Loaded data is normalized before use.
- A malformed JSON store is moved to a timestamped `.corrupt-*` file, and the server starts with validated defaults.
- For production, replace the single JSON file with a managed transactional database, encrypted backups, monitoring, and shared rate limiting.

## Explicitly disabled

v0.6 does not accept paid-run RON, activate real passes, swap RON for MATT, or publish real MATT claims. Local Pass and administration screens remain product-flow sandboxes. No token rewards should be funded until gameplay validation, contracts, infrastructure, monitoring, legal review, and security review are complete.
