# Fix package — Section 9: cron, account deletion & ops

Apply order: **run `supabase/migrations/0075_cron_deletion_ops.sql` in Supabase FIRST**, then push
(deploy.yml's migration gate refuses to deploy until it is recorded). It is idempotent and already
folded into `schema.sql`.

## Bugs fixed
| | What | Where |
|---|---|---|
| B1 | "Report an issue" answered 401 for every customer (route only read a Bearer header; the button sends the session cookie). Now cookie-or-Bearer, cross-site guard, text-only message, and a refused staff e-mail is logged instead of dropped. | `app/api/support/report/route.ts` |
| B2 | The wholesale price was a literal in the source. Now `UPSTREAM_COST_PER_GB_USD` (Worker secret, pushed by deploy.yml); admin pages show "not set" and no profit figure when it is missing. Neutral labels. New ratchet `npm run check:supplier` stops the supplier name spreading through the source; README / .gitignore cleaned. | `lib/constants.ts`, `app/admin/*`, `scripts/check-supplier-leak.mjs` |
| B4 | Self-service deletion was not claim-first: two concurrent requests both released, purged and e-mailed. One shared claim → ban → release → purge flow (`performAccountDeletion`) now backs the customer route, the admin route and the scheduled run; a failed release rolls claim AND ban back. | `lib/accountDeletion.ts` |
| B5 | Released credentials were tombstoned without settling bandwidth: `allocated_gb` stayed inflated, usage double counted, also on an admin-aborted deletion. New `settle_released_credential()` (+ back-fill of earlier deletions). | migration 0075 |
| B6 | `security` task: a failed notice read/send or audit-log retention looked like success. Now reported through the heartbeat. | `lib/securityEvents.ts`, cron route |
| B7 | `cleanup`: per-row UPDATE loop (subrequest budget) and step failures never surfaced. One conditional UPDATE; failures returned as `error`. | cron route |
| B8 | `summary`: capped at 1000 rows, ignored a refused e-mail, `ADMIN_EMAIL!`, re-sent on re-runs. Uses `admin_order_stats`, checks delivery, once per day marker. | cron route |
| B9 | `alerts`: read a profile for every account every day and ignored the customer's low-bandwidth opt-out. Decides from the row first; honours the opt-out; Settings copy now describes what is sent. | cron route, settings page |
| B10 | `canary` could charge the test card twice a day (re-fire / manual GET); its alert e-mail result was ignored. | cron route |
| B11 | Generators wrote into the wrong directory or accepted a truncated/error-body export; a curated country missing from the source silently deleted its page. Shared guards, collapse check, atomic writes. | `scripts/_guard.py`, `generate-*.py` |
| B12 | deploy.yml only ran two cheap checks before shipping. Now the full `npm run check` (schema, cron wiring, API docs, supplier ratchet, tests, types). | `.github/workflows/deploy.yml`, `ci.yml` |
| B14 | IndexNow re-submitted the whole sitemap on every deploy. Now only pages with a recent `<lastmod>`; `--all` for everything. | `scripts/indexnow-submit.mjs` |

## Gaps closed
- **Deletion cool-off** — `DELETE /api/user/delete-account` now *schedules* deletion 7 days out (e-mail now + reminder 24 h before, cancel in Settings or from the e-mail link; `{ immediate: true }` / the "delete immediately" checkbox keeps the old behaviour). New `POST /api/user/delete-account/cancel` (no step-up needed to cancel). New hourly **`deletions`** cron task executes due deletions, sends reminders, retries leftovers and settles stragglers; alerts the admin after 3 failed attempts.
- **Leftovers are persisted** — purge warnings are stored (`deletion_cleanup_pending/notes`), the admin is e-mailed, and the sweep retries them.
- **Tests** — `npm test` (14 unit tests over the pure modules), `npm run check` / `check:fast`.
- **Pre-push hook** — `npm run hooks:install` once per clone.
- **`npm run fold:migration`** — folds new migrations into `schema.sql` and bumps the manifest.
- **Targeting data** — `npm run pull:targeting` + weekly `targeting-drift.yml` (no-op until `UPSTREAM_TARGETING_URL` is set; the endpoint is not verified from here).

## After pushing
1. GitHub → Settings → Secrets: add `UPSTREAM_COST_PER_GB_USD` (your wholesale price). Optional: `UPSTREAM_TARGETING_URL`.
2. `cd gp && npm run hooks:install`.
3. Make the repository **private again**.
4. Check Admin → Settings → Scheduled tasks shows `deletions` after the next hour.

## Not changed on purpose
- Admin-only route `app/api/admin/debug-*` and ~45 other files still name the supplier internally (other sections; baseline-ratcheted so it can only shrink). Git history cannot be rewritten — keep the repo private.
- Security-notice retry has no back-off column: a notice undeliverable for 24 h is dropped, as before.
