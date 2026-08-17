-- ============================================================
-- 0027 — Real migration tracking
-- ============================================================
-- check-schema-sync.mjs (CI) only ever compares two *text files* to each
-- other — schema.sql's manifest line against the newest filename in
-- supabase/migrations/. It has no way to know whether a migration was
-- ever actually run against the live database, because nothing has ever
-- recorded that. That gap is exactly how 0022 sat unapplied in
-- production for as long as it did: it was correctly committed, correctly
-- reflected in schema.sql, CI was green — and simply never executed
-- against the real database. Every signal that existed said "this is
-- fine" while the live schema silently disagreed.
--
-- This table is the missing signal: every migration from here on records
-- its own filename here as its last statement. "Applied" becomes a fact
-- you can query, not an assumption from a green CI check or a memory of
-- having pasted a file into the SQL Editor.

create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now()
);

alter table public.schema_migrations enable row level security;
-- No policies granted — service_role bypasses RLS, and there's no
-- legitimate reason for any client-side role to read or write this.

-- Backfill: record every migration through this one as already applied.
-- ON CONFLICT DO NOTHING makes this (and every future migration's
-- self-insert) safe to re-run.
insert into public.schema_migrations (filename) values
  ('0001_proxy_credentials_missing_columns.sql'),
  ('0002_proxy_sessions.sql'),
  ('0003_rls_and_integrity_fixes.sql'),
  ('0004_reseller_allocation_and_race_fixes.sql'),
  ('0005_api_keys.sql'),
  ('0006_lock_down_order_columns.sql'),
  ('0007_reserve_credential_bandwidth.sql'),
  ('0008_drop_dead_reserve_reseller_gb.sql'),
  ('0009_fix_available_gb_double_count.sql'),
  ('0010_bulk_usage_sync_functions.sql'),
  ('0011_protect_and_sync_profile_email.sql'),
  ('0012_lock_down_rpc_grants.sql'),
  ('0013_fix_host_default_brand_leak.sql'),
  ('0014_reseller_client_profile_select.sql'),
  ('0015_atomic_claim_and_credit_order.sql'),
  ('0016_topup_credential.sql'),
  ('0017_auto_topup.sql'),
  ('0018_webhook_endpoints.sql'),
  ('0019_default_auto_topup.sql'),
  ('0020_mfa.sql'),
  ('0021_invoice_numbers.sql'),
  ('0022_mfa_totp_replay_protection.sql'),
  ('0023_proxy_sessions_credential_ownership.sql'),
  ('0024_atomic_wipe_mfa.sql'),
  ('0025_archive_used_gb_on_delete.sql'),
  ('0026_atomic_confirm_mfa_enrollment.sql'),
  ('0027_migration_tracking.sql')
on conflict (filename) do nothing;

-- ── Convention for every migration from here on ────────────────
-- End the file with:
--
--   insert into public.schema_migrations (filename) values
--     ('00NN_your_migration_name.sql')
--   on conflict (filename) do nothing;
--
-- scripts/check-migrations-applied.mjs (new) reads this table from the
-- live database and diffs it against supabase/migrations/ on disk — run
-- it any time you want a real answer to "is production actually caught
-- up," not just "does the manifest line match."
