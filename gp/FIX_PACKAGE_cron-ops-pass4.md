# Section 9 (cron, deletion, ops) - pass 4 fixes

- B1 lib/autoRecharge.ts: no automatic charge while an account's deletion is scheduled (deferred; resumes on cancel).
- B2 api/cron/[task]: canary reports a configured-but-unreadable test account as an error instead of a silent skip.
- B3 api/cron/[task]: cleanup reports the auto top-up sweep failure and counts the orders it closes.
- B4 .github/workflows/deploy.yml: deploy job runs only from main.
- B5 lib/cronHealth.ts: usage-sync stale alert is claimed atomically before mailing, re-armed if refused.
- B6 .githooks/pre-push is executable; scripts/install-hooks.mjs chmods it.
- tests/ops-section9-pass4.test.mjs
