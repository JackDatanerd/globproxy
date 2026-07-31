-- ============================================================
-- 0007 — Reserve bandwidth at credential-creation time
-- ============================================================
-- Previously, creating a proxy credential (app/api/dashboard/proxies,
-- app/api/v1/sub-users) only *soft-checked* available_gb against the
-- requested gb_allocated — nothing was actually deducted. available_gb only
-- drops once the ~15-minute cron usage-sync job pulls real consumption back
-- from Geonode. That left a window where a user could burst-create many
-- credentials in quick succession, each individually passing the balance
-- check (since nothing had been reserved yet) and each hard-capped at
-- Geonode by its own gb_allocated — meaning actual provider consumption
-- could run to (credentials created before the next cron tick) × (their
-- individual caps), far beyond what was ever purchased.
--
-- Fix: reuse the allocated_gb column (already used for reseller→client
-- commitments) to also represent "committed via my own credentials", and
-- reserve it atomically at creation time via the same locked-update pattern
-- allocate_reseller_bandwidth() already uses. available_gb was always
-- total_gb - used_gb - allocated_gb, so this closes the gap for regular
-- users the same way it already worked for resellers.

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
    and (total_gb - used_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated;

  if v_updated is null then
    raise exception 'Insufficient bandwidth in your account.' using errcode = 'P0001';
  end if;
end;
$$;

-- Releases a reservation made above. Called when a self-owned credential
-- (created_by is null) is deleted, so gb_allocated genuinely comes back to
-- the account instead of just being a cap that was never actually reserved.
create or replace function public.release_credential_bandwidth(p_user_id uuid, p_gb numeric)
returns void
language plpgsql
security definer
as $$
begin
  if p_gb is null or p_gb <= 0 then
    return;
  end if;
  update public.bandwidth_accounts
  set allocated_gb = greatest(0, allocated_gb - p_gb)
  where user_id = p_user_id;
end;
$$;
