# Production deployment checklist

This checklist deliberately separates schema change, application cutover and financial activation. No step authorizes a contract deployment, transaction broadcast, production database access or Render change by Codex.

## Gate A: authority and evidence

- [ ] Change approved by engineering, security, finance/treasury and operations.
- [ ] Counsel approved eligibility/rules; version recorded.
- [ ] Exact 2-of-3 Safe owner set independently confirmed.
- [ ] All CI checks green on Node 22.16 and Node 24.
- [ ] No high dependency vulnerabilities without a documented accepted-risk decision.
- [ ] Restore drill meets RPO five minutes and RTO two hours.

## Gate B: schema only

- [ ] Pause new paid entries, purchases, revives and reward publication; leave reconciliation running.
- [ ] Record legacy row hash/counts and outstanding economic obligations.
- [ ] Create and verify encrypted off-platform backup.
- [ ] Run versioned migrations.
- [ ] Run repeatable backfill twice; results stable.
- [ ] Run validation; zero balance, ledger, receipt, entitlement, run, snapshot or reward discrepancies.
- [ ] Run rollback dry run.
- [ ] Stop if any unknown COMMIT outcome exists.

## Gate C: application compatibility deploy

- [ ] Deploy exact reviewed commit with legacy reads and dual writes.
- [ ] `/api/live` returns exact version/commit.
- [ ] `/api/ready` confirms PostgreSQL, replay, RPC/verifiers and live Safe exactly 2-of-3.
- [ ] Admin wallet cookie, CSRF, revocation and step-up tested.
- [ ] Active pre-deploy runs resume using their original snapshot/engine.
- [ ] Keep financial controls paused during observation.

## Gate D: observation and rollback decision

- [ ] Reconciliation has no paid-not-credited, credited-not-finalized, duplicate or unknown-COMMIT records.
- [ ] Arena entry conservation and revive resume reports clean.
- [ ] Browser/server replay, map/depth, permanent-upgrade and Pass 2x parity sampled.
- [ ] Alerts and on-call coverage active.
- [ ] If failed: apply lossless legacy-read rollback, preserve normalized history, reconcile chain payments.

## Gate E: financial activation (separate approval window)

- [ ] Eligibility configuration present and counsel-approved.
- [ ] Treasury balances and obligations independently reconciled.
- [ ] Server pause state and each contract pause state reviewed separately.
- [ ] Activate one financial surface at a time with a canary cap.
- [ ] Never broadcast automatically; Safe actions remain unsigned JSON until two owners approve.
- [ ] Record activation actor, reason, exact resulting state and rollback trigger.

## Gate F: later normalized-read cutover

- [ ] Dedicated PR removes global-row mutation from all financial/run/Admin paths.
- [ ] Row-lock, unknown-COMMIT and concurrency fault tests green.
- [ ] Dual-read comparison clean for a full retention window.
- [ ] Cutover approved separately; legacy row retained through rollback window.
