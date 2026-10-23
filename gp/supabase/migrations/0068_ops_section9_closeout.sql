-- ============================================================
-- 0068 — Cron, account deletion & ops: independent audit pass 1
-- ============================================================
-- Idempotent: safe to re-run. Apply BEFORE deploying the code that ships with it.
--
--  * support_reports: admin_note and resolved_by are staff-internal, but the
--    row-level policy "User can view own reports" exposes every COLUMN of the
--    customer's own rows to anyone holding a session token (PostgREST, not just
--    the dashboard page, which happens to select explicit columns). Table-level
--    SELECT is replaced with a column list that leaves the internal ones out. The
--    admin panel and the export read through the service role and are unaffected.
--  * idx_support_reports_user_created: backs the per-account daily cap on
--    /api/support/report (a count of the caller's reports in the last 24h).

revoke select on table public.support_reports from anon, authenticated;
grant select (id, user_id, email, page_url, message, status, created_at, resolved_at)
  on table public.support_reports to authenticated;

create index if not exists idx_support_reports_user_created
  on public.support_reports (user_id, created_at desc);

insert into public.schema_migrations (filename) values
  ('0068_ops_section9_closeout.sql')
on conflict do nothing;
