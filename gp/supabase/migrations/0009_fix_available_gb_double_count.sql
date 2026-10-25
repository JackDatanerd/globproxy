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
-- credentials (upstream enforces gb_allocated as the hard cap per sub-user).
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
-- Previously noted here as a known, unaddressed follow-up: deleting a
-- partially-used credential released its FULL gb_allocated back via
-- release_credential_bandwidth regardless of gb_used, letting delete then
-- recreate reclaim already-consumed GB. Fixed in
-- app/api/dashboard/proxies/[id]/route.ts, which now releases only the
-- unused portion (gb_allocated minus a live upstream usage check, falling
-- back to the synced gb_used column). No further schema change needed —
-- release_credential_bandwidth already took the release amount as a
-- caller-supplied parameter, so the fix lives entirely in the caller.

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
