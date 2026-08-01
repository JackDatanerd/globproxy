-- ============================================================
-- 0009 — Stop double-subtracting used_gb from available_gb
-- ============================================================
-- available_gb was: total_gb - used_gb - allocated_gb
--
-- allocated_gb reserves a credential's FULL gb_allocated the moment it's
-- created (migration 0007) and only gives it back in full when the
-- credential is deleted. used_gb (cron-owned, runUsageSync in
-- app/api/cron/[task]/route.ts) is the live sum of gb_used across a user's
-- currently-active credentials — which, by construction, is always a
-- subset of what's already sitting in allocated_gb for those same
-- credentials (Geonode enforces gb_allocated as the hard cap per sub-user).
-- Subtracting both double-counts the same GB. Concretely: buy 20GB,
-- create one credential with gb_allocated=10 (available correctly reads
-- 10), use 6GB of it -> available reads 20-6-10=4 instead of the correct
-- 10, and keeps sliding negative as more of that already-reserved 10GB
-- gets used. app/dashboard/proxies/new/page.tsx redirects to
-- /dashboard/buy whenever available<=0, so paying customers actively
-- using their bandwidth get told they have none and are pushed to buy
-- more. Same allocated_gb mechanism means resellers hit the identical
-- false "insufficient bandwidth" error when allocating to clients.
--
-- Fix: available_gb is just "how much of total_gb isn't committed to
-- something yet" — total_gb - allocated_gb. used_gb remains tracked and
-- reported (it's still useful as "how much of what you've committed have
-- you actually consumed"), it just isn't subtracted a second time.
--
-- Known follow-up, not addressed here: deleting a partially-used
-- credential currently releases its FULL gb_allocated back via
-- release_credential_bandwidth regardless of how much of it was actually
-- consumed (gb_used). That means delete+recreate can currently let a user
-- reclaim GB they already consumed. That's a separate, pre-existing
-- design question (how consumption should be treated on deletion) and
-- is intentionally out of scope for this fix, which only addresses the
-- double-subtraction.

alter table public.bandwidth_accounts drop column if exists available_gb;
alter table public.bandwidth_accounts add column available_gb numeric
  generated always as (total_gb - allocated_gb) stored;

-- Update both functions that inline this same balance-check expression so
-- they stay consistent with the column above.

create or replace function public.reserve_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void
language plpgsql
security definer
as $$
declare
  v_updated numeric;
begin
  if p_gb is null or p_gb <= 0 then
    raise exception 'gb_allocated must be greater than 0';
  end if;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_user_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;

  if v_updated is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.allocate_reseller_bandwidth(
  p_reseller_id uuid,
  p_recipient_id uuid,
  p_gb numeric
)
returns table(new_reseller_allocated_gb numeric)
language plpgsql
security definer
as $$
declare
  v_updated_allocated numeric;
begin
  if p_gb is null or p_gb <= 0 then
    raise exception 'gb_allocated must be greater than 0';
  end if;

  if p_reseller_id = p_recipient_id then
    raise exception 'Cannot allocate bandwidth to yourself';
  end if;

  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id
    and (total_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated_allocated;

  if v_updated_allocated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
  values (p_recipient_id, p_gb, 0, 0)
  on conflict (user_id) do update
    set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;

  return query select v_updated_allocated;
end;
$$;
