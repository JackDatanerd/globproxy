-- ============================================================
-- 0003 — RLS + integrity fixes
-- Safe to run against the live DB: every statement is idempotent
-- (IF NOT EXISTS / DROP ... IF EXISTS before CREATE), so it will
-- not error even if some of this was already applied by hand.
-- ============================================================

-- ── 1. Bring schema.sql in line with what's actually live ──────
-- These columns already exist in production per direct inspection;
-- they were just never committed as a migration. Adding them here
-- with IF NOT EXISTS so this file is safe to run anywhere, and so
-- a fresh `schema.sql` install ends up matching production.
alter table public.profiles add column if not exists is_deleted boolean default false;
alter table public.profiles add column if not exists deleted_at timestamp with time zone;
alter table public.profiles add column if not exists api_access boolean default false;
alter table public.profiles add column if not exists reseller_application jsonb;

create table if not exists public.banned_emails (
  id         uuid default uuid_generate_v4() primary key,
  email      text not null unique,
  reason     text,
  banned_at  timestamp with time zone default now(),
  banned_by  uuid references public.profiles(id)
);
alter table public.banned_emails enable row level security;

drop policy if exists "Admin can read banned emails" on public.banned_emails;
create policy "Admin can read banned emails" on public.banned_emails for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- ── 2. Check constraints were missing values the app code writes ──
-- checkout/route.ts and dashboard/billing/page.tsx both set
-- payment_status = 'cancelled', which the original constraint
-- rejected outright.
alter table public.orders drop constraint if exists orders_payment_status_check;
alter table public.orders add constraint orders_payment_status_check
  check (payment_status in ('pending','paid','failed','refunded','cancelled'));

-- reject-reseller/route.ts and AdminResellerActions.tsx both set
-- reseller_status = 'rejected', which the original constraint
-- rejected outright (ironic, but real).
alter table public.profiles drop constraint if exists profiles_reseller_status_check;
alter table public.profiles add constraint profiles_reseller_status_check
  check (reseller_status in ('pending','approved','suspended','rejected'));

-- ── 3. Close the self-escalation hole on profiles ───────────────
-- "Update own profile" previously had no WITH CHECK and no column
-- restriction, so any logged-in user could PATCH their own row via
-- the REST API and set role='admin', reseller_status='approved',
-- is_suspended=false, api_access=true, etc.
--
-- Fix: a BEFORE UPDATE trigger that reverts privileged columns to
-- their old values unless the caller is either (a) an admin acting
-- through their own session, or (b) the service-role key (auth.uid()
-- is null in that context — trusted, since those call sites already
-- do their own role checks in application code).
create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer as $$
declare
  caller_is_admin boolean;
begin
  -- service-role / admin-client calls have no JWT subject — trusted
  if auth.uid() is null then
    return new;
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  -- non-admin acting on any row (including their own): privileged
  -- columns cannot move via this path
  new.role                  := old.role;
  new.is_suspended          := old.is_suspended;
  new.suspended_at          := old.suspended_at;
  new.suspension_reason     := old.suspension_reason;
  new.reseller_status       := old.reseller_status;
  new.api_access            := old.api_access;
  new.is_deleted            := old.is_deleted;
  new.deleted_at            := old.deleted_at;

  return new;
end;
$$;

drop trigger if exists protect_privileged_profile_columns on public.profiles;
create trigger protect_privileged_profile_columns
  before update on public.profiles
  for each row execute procedure public.protect_privileged_profile_columns();

-- Allow admins to update any profile (previously only "auth.uid() = id"
-- existed, so AdminUserControls.tsx / AdminResellerActions.tsx were
-- silently updating 0 rows whenever an admin acted on someone else's
-- profile — false "success" toasts, nothing actually changed).
drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile" on public.profiles for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'));

-- ── 4. proxy_credentials had SELECT only — no way for a user's own ──
-- session to create or delete their own proxy credential.
drop policy if exists "Create own credentials" on public.proxy_credentials;
create policy "Create own credentials" on public.proxy_credentials for insert
  with check (auth.uid() = user_id and created_by is null);

drop policy if exists "Delete own unassigned credentials" on public.proxy_credentials;
create policy "Delete own unassigned credentials" on public.proxy_credentials for delete
  using (auth.uid() = user_id and created_by is null);

-- ── 5. orders — let a user cancel their own still-pending order ────
-- Scoped tightly: only pending -> cancelled, only your own row.
drop policy if exists "Cancel own pending order" on public.orders;
create policy "Cancel own pending order" on public.orders for update
  using (auth.uid() = user_id and payment_status = 'pending')
  with check (auth.uid() = user_id and payment_status = 'cancelled');

-- Note: bandwidth_accounts intentionally gets no new user-facing
-- write policy. All legitimate writes to it (activateBandwidth,
-- reseller allocate, cron usage-sync) already go through the
-- service-role client. The one place that tried to write to it
-- from the user's own session (proxy delete "return GB" logic) was
-- calculating the wrong number anyway and has been removed in the
-- accompanying code fix — see app/api/dashboard/proxies/[id]/route.ts.

-- ── 6. Bandwidth alert de-dupe ───────────────────────────────────
-- runBandwidthAlerts (cron) had no record of whether it already
-- emailed a user at a given threshold, so anyone sitting above 80%
-- or 95% got a fresh email every cron run indefinitely.
alter table public.bandwidth_accounts add column if not exists alerted_80_at timestamp with time zone;
alter table public.bandwidth_accounts add column if not exists alerted_95_at timestamp with time zone;
