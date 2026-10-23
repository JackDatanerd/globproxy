# Cron, account deletion & ops — independent audit pass 1

Base: 876d00b. **Migration 0068 — apply it BEFORE pushing** (the new deploy gate checks).

## Order of operations
1. Apply `supabase/migrations/0068_ops_section9_closeout.sql` in the Supabase SQL editor
   (also confirm 0067_admin_section8_closeout.sql is applied — it shipped in the previous push).
2. Extract the package from the repo ROOT (it touches `.github/`), commit, push.
3. deploy.yml now runs `check-migrations-applied.mjs` before building and FAILS the deploy if a
   migration on disk is not recorded in the live database. If it ever blocks you in an emergency:
   Actions → Deploy → Run workflow → tick `skip_migration_gate`.

## Already fixed by another session (not repeated here)
`KNOWN` allow-list (invites/resellers), daily-chain independence, bandwidth-alert isolation,
`check-cron-sync.mjs`. This package builds on them.

## Bugs
- B1  hourly chain is now independent too: a failing `resellers` can no longer stop `stock`
      (which carries the stopped-task and usage-sync watchdogs). check-cron-sync also checks CRON_MAX_AGE_SECONDS.
- B3  admin alerts count as sent only when the mail provider ACCEPTED them (usage-stale, stock/exposure,
      upstream-API failure, cron-failing, cron-stopped, affiliate payout reminder). A refused send re-arms the alert.
- B4  deletion tombstone clears provision_username/password, pending_reason, last_provision_error, and
      releases a sub-user reserved by a pending credential (looked up by username; incomplete listing = abort).
- B5  schema.sql was not a faithful roll-up: 0053 was missing and 0054's fold was truncated. Restored.
      check-schema-sync.mjs now verifies CONTENT (tables, functions, columns, indexes, triggers, policies)
      and migration numbering, not just a filename string.
- B6  daily summary "new users" is bounded to yesterday.
- B7  bandwidth alerts skip scrubbed ('[deleted]') addresses.
- B8  reconcile: orders that error every time back off ~10 min instead of starving the queue.
- B9  delete-account refuses (409) while a payment is in flight; activateBandwidth refuses to credit a
      deleted account (admin alerted once for a manual refund).
- B10 purge releases the supplier side a second time (credentials activated mid-deletion); an unreleasable
      sub-user keeps its id and is reported in warnings instead of being orphaned.
- B11 self-service deletion revokes every session (admin.signOut global) before the ban; wrong comment fixed.
- B12 optional Worker secrets pushed with ONE `wrangler secret bulk` (no window with the new MFA key and no previous key).
- B13 timeout-minutes on every job/step; IndexNow requests time out (a hang no longer blocks the deploy queue).
- B14 workflows: `permissions: contents: read`; actions pinned to commit SHAs.
- B15 geo/ASN/location generators: no hard-coded 210 countries, stale files pruned, no KeyError, consistent ASN count.
- B16 support report: invalid JSON -> 400; stored and emailed page_url identical.
- Also: NaN stock threshold no longer silently disables the low-stock alert; admin-facing wording neutral.
- Also (0068): `admin_note` / `resolved_by` on support_reports were readable by the customer through PostgREST.

## Gaps closed
1. check-cron-sync covers heartbeat windows.
2. Watchdog for the watchdog: `security` (*/5) checks that `stock` and the usage sync are alive.
3. Deploy gate on migrations applied; `npm run check:migrations`; stronger schema check.
4. `GET /api/user/export` + "Download my data" (password/TOTP step-up); deletion panel lists forfeited affiliate earnings.
   Support-report free text is removed on deletion.
5. Support: daily cap (20/24h), Reply-To the customer, report id in the email, resolved-report email to the customer.
6. ci.yml (PRs: schema, cron, typecheck), dependabot.yml, `npm run typecheck`.
7. delete-account rate limited.

## Not built (decisions for you)
- A cooling-off delay before deletion (typed DELETE + password/TOTP step-up already gate it).
- Support categories/severity (needs a UI field + column).
