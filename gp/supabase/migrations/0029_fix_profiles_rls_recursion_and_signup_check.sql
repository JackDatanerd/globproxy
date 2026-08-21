-- ============================================================
-- 0029 — Fix profiles RLS infinite recursion + signup dedupe bypass
-- ============================================================
--
-- BUG 1 — "infinite recursion detected in policy for relation 'profiles'"
-- on every profile save (Settings → Save changes).
--
-- "Admins can update any profile" (see schema.sql) checks admin-ness with
--   exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin')
-- That subquery is itself a SELECT against profiles, which is itself
-- subject to profiles' own RLS. Postgres has to fully resolve that inner
-- policy set to answer the outer UPDATE policy's USING/WITH CHECK clause —
-- a table's RLS policy querying its own table is the textbook trigger for
-- "infinite recursion detected in policy for relation X", and it fires
-- for every UPDATE to profiles, not just admin-initiated ones, because all
-- permissive policies attached to the command are evaluated. This is why
-- an ordinary user hitting "Save changes" on their own name/company saw it
-- too, even though "Update own profile" (auth.uid() = id) alone would have
-- been enough to allow their edit.
--
-- Fix: move the admin check into a SECURITY DEFINER function. Functions
-- run as their owner (postgres), which bypasses RLS entirely, so the
-- lookup no longer re-enters profiles' policy set.
--
-- BUG 2 — deleted accounts can be "re-signed-up" without email confirmation
--
-- app/api/auth/signup's dedupe check queries profiles.email to decide
-- whether an account already exists. Account deletion (both
-- app/api/user/delete-account and app/api/admin/delete-user) intentionally
-- overwrites profiles.email with the literal '[deleted]' placeholder —
-- which means that check now returns no match for the real address, and
-- signup falls through to calling supabase.auth.signUp() again against an
-- auth.users row that still exists (banned, not deleted — see the comment
-- in delete-account/route.ts on why it's a ban rather than a hard delete).
--
-- Fix: a SECURITY DEFINER function the signup route can call to check
-- auth.users directly (the real source of truth for "does this email have
-- an identity", unaffected by the app-level profile scrub).

create or replace function public.is_admin(check_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = check_uid and role = 'admin'
  );
$$;

revoke all on function public.is_admin(uuid) from public, anon, authenticated;
grant execute on function public.is_admin(uuid) to authenticated;

drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile" on public.profiles for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- ── auth.users email existence check, for signup's dedupe ──────
create or replace function public.auth_email_exists(check_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from auth.users where lower(email) = lower(check_email)
  );
$$;

-- Deliberately no grant to anon/authenticated — this is only ever called
-- from app/api/auth/signup/route.ts via the service-role admin client,
-- same trust boundary as the banned_emails/profiles lookups already in
-- that route. Exposing it to anon would recreate the exact enumeration
-- oracle app/api/auth/signup/route.ts's genericResponse()/RESPONSE_FLOOR_MS
-- exist to close.
revoke all on function public.auth_email_exists(text) from public, anon, authenticated;

insert into public.schema_migrations (filename) values
  ('0029_fix_profiles_rls_recursion_and_signup_check.sql')
on conflict do nothing;
