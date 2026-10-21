# Edge & request pipeline — audit pass 4

Apply `supabase/migrations/0061_edge_pipeline_pass4.sql` (also folded into `schema.sql`) BEFORE/with the deploy.
Until it is applied the CSP table keeps its old drop-when-full behaviour and never-ran tasks stay unwatched; nothing breaks.

## Bugs
- **B1 `app/api/cron/[task]/route.ts`** — the usage-sync watchdog had already been moved ahead of the provider read; the stopped-task watchdog (`checkCronFreshness`) still ran only after `runStockCheck()` returned, so any throw there silenced it. It now runs first and independently.
- **B2 `app/api/csp-report` + 0061** — the public report endpoint could fill the 500-row cap with fabricated rows and keep real violations out. Reports are now recorded only when `document-uri` is on our own host, and a full table evicts its least-hit / oldest row instead of refusing new ones.

## Feature gaps
- **G1 `lib/supabase/server.ts`** — `createAdminClient()` now has a 25 s ceiling on database requests (time to response headers; caller aborts are honoured).
- **G2 0061 `claim_stale_cron_tasks`** — a task that has never run now gets a row dated "first seen" and alerts once if it never reports within its allowed age.
- **G3 `wrangler.jsonc`** — `upload_source_maps: true`, so persisted Worker log stack traces are readable.

## Not code
- The repository is public, so the supplier name in `lib/geonode.ts`, `app/api/admin/debug-geonode/`, the `GEONODE_*` secret names in `deploy.yml` and many comments is readable by anyone. Making the repo private is the fix (renaming files would not remove git history).
