# Edge & request pipeline — audit pass 3

Apply `supabase/migrations/0056_edge_pipeline_pass3.sql` (also folded into `schema.sql`) BEFORE/with the deploy.
Until it is applied the cron lock fails open (tasks run unlocked, as before).

## Bugs
- **B1 deploy.yml** — auto-rollback went back one version, which after the optional `wrangler secret put` step is the same broken build. Now records the live version before deploying and rolls back to that id.
- **B2 middleware.ts** — forced sign-out (suspended/deleted) now also deletes the account's `mfa_verified_sessions` rows and clears `gp_mfa`.
- **B3** — `GET /api/dashboard/api-keys/activity` and `GET /api/dashboard/webhooks/[id]/deliveries/[deliveryId]` now call `requireActiveUser`.
- **B4 middleware.ts** — during an auth-backend outage the 503 / public page no longer carries session-cookie deletions.

## Feature gaps
- **G1** `/api/health` reports `checks.rate_limiters`; a missing binding is a failure on Workers and logs once per binding.
- **G2** smoke test also fetches `/` and `/auth/login` (5xx on any => rollback).
- **G3** health `warnings` (secret-gated, neutral labels) for unset MFA encryption key / bot-check secret; shown as workflow warnings.
- **G4** CSP: set repo variable `CSP_MODE=enforce` and redeploy to enforce; unset = report-only.
- **G5** `cron_task_locks` lease (10 min) per task; overlapping run returns `{skipped:'already_running'}`.
- **G6** webhook port rule enforced at delivery; legacy odd-port endpoints are disabled on next delivery.
