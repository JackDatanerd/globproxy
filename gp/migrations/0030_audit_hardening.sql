-- ============================================================
-- 0030 — Database/RLS audit follow-up
-- ============================================================
-- Three independent hardening items found doing a full pass over
-- schema.sql after 0029. None of these were exploitable together with
-- 0029's bug — each stands on its own.

-- ── 1. Deleted-account API keys still worked ───────────────────
-- lib/apiAuth.ts's requireApiAccess() (gates every app/api/v1/* route)
-- and requireActiveUser() (gates checkout, dashboard/proxies POST,
-- dashboard/sessions) both checked profiles.is_suspended but never
-- profiles.is_deleted — the exact gap middleware.ts had for page routes
-- before migration 0029, except here there's no signup-bypass
-- precondition needed: neither delete-account nor delete-user ever
-- revoked a user's existing api_keys rows, so a previously-generated key
-- kept authenticating against the v1 API indefinitely after the account
-- it belonged to was deleted. Revoking every unrevoked key at deletion
-- time (below) closes the hole immediately for existing rows; the app
-- code check (lib/apiAuth.ts, this same deploy) is what stops it from
-- reopening for any key generated before deletion that this backfill
-- somehow missed, or for is_suspended-style regressions in general.
update public.api_keys
set revoked_at = now()
where revoked_at is null
  and user_id in (select id from public.profiles where is_deleted = true);

-- Belt-and-suspenders alongside the app-layer is_deleted check going in
-- with this same deploy — same posture as api_keys above.
update public.webhook_endpoints
set enabled = false
where enabled = true
  and user_id in (select id from public.profiles where is_deleted = true);

-- ── 2. Search-path pinning on every SECURITY DEFINER function ──
-- None of these had `set search_path` — Supabase's database linter flags
-- this as a security advisory on every project. Every body here already
-- fully-qualifies its own table references (public.foo), so this is a
-- config-only change with no behavioral difference; it closes the
-- theoretical class of bug where a role with CREATE on a schema earlier
-- in the resolution order than `public` could shadow an unqualified
-- identifier. anon/authenticated don't have CREATE on public in this
-- project, so the practical exposure was already low — this is
-- defense-in-depth for that changing later without anyone noticing.
alter function public.handle_new_user() set search_path = public, pg_temp;
alter function public.handle_new_profile() set search_path = public, pg_temp;
alter function public.allocate_reseller_bandwidth(uuid, uuid, numeric) set search_path = public, pg_temp;
alter function public.credit_bandwidth(uuid, numeric) set search_path = public, pg_temp;
alter function public.claim_and_credit_order(uuid, uuid, numeric, text) set search_path = public, pg_temp;
alter function public.reserve_credential_bandwidth(uuid, numeric) set search_path = public, pg_temp;
alter function public.release_credential_bandwidth(uuid, numeric) set search_path = public, pg_temp;
alter function public.topup_credential(uuid, uuid, numeric) set search_path = public, pg_temp;
alter function public.set_auto_topup(uuid, uuid, boolean, numeric, numeric) set search_path = public, pg_temp;
alter function public.set_default_auto_topup(uuid, boolean, numeric, numeric) set search_path = public, pg_temp;
alter function public.bulk_update_credential_usage(jsonb) set search_path = public, pg_temp;
alter function public.recalculate_bandwidth_accounts() set search_path = public, pg_temp;
alter function public.archive_credential_used_gb(uuid, numeric) set search_path = public, pg_temp;
alter function public.cleanup_expired_mfa_sessions() set search_path = public, pg_temp;
alter function public.wipe_mfa(uuid) set search_path = public, pg_temp;
alter function public.confirm_totp_enrollment(uuid, integer) set search_path = public, pg_temp;
alter function public.protect_privileged_profile_columns() set search_path = public, pg_temp;
alter function public.sync_profile_email() set search_path = public, pg_temp;
alter function public.protect_order_columns() set search_path = public, pg_temp;
-- is_admin / auth_email_exists already had it (migration 0029).

-- ── 3. Admin-check consistency on platform_settings / banned_emails ──
-- Both still had their own inline `exists (select 1 from public.profiles
-- where id = auth.uid() and role = 'admin')` rather than the is_admin()
-- helper migration 0029 introduced. Not a recursion risk (neither policy
-- is on profiles itself), so this was never broken — just two more
-- places that would each need updating by hand if the definition of
-- "admin" ever changes, instead of one function every admin-gated policy
-- calls through.
drop policy if exists "Admin settings" on public.platform_settings;
create policy "Admin settings" on public.platform_settings
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists "Admin can read banned emails" on public.banned_emails;
create policy "Admin can read banned emails" on public.banned_emails for select
  using (public.is_admin(auth.uid()));

insert into public.schema_migrations (filename) values
  ('0030_audit_hardening.sql')
on conflict do nothing;
