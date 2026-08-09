-- ============================================================
-- 0017 — Auto-allocate (auto top-up) for proxy credentials
-- ============================================================
-- Problem: once a credential's gb_used reaches gb_allocated, it stops
-- working (Geonode's own trafficLimitMB cap on the sub-user), and the
-- only recovery was migration 0016's manual topup_credential — someone
-- has to notice it's running low (or has already died) and top it up
-- themselves. This lets a customer opt a credential into topping itself
-- up automatically once its remaining GB drops to a threshold they pick,
-- by an amount they pick, using their existing account balance.
--
-- Deliberately reuses topup_credential() (0016) as the actual top-up
-- mechanism rather than duplicating its atomic reserve+bump logic — the
-- cron-driven auto-topup path and the user-initiated manual top-up
-- button call the exact same RPC, so there is exactly one place that
-- decides how a top-up is applied. This migration only adds: (1) the
-- per-credential configuration columns, and (2) set_auto_topup() for a
-- user to manage that configuration on a credential they own — the
-- actual "check usage, decide to trigger" loop lives in application code
-- (lib/autoTopup.ts), run from the existing usage-sync cron cycle, not
-- in the database.

alter table public.proxy_credentials
  add column if not exists auto_topup_enabled boolean not null default false,
  add column if not exists auto_topup_threshold_gb numeric,
  add column if not exists auto_topup_amount_gb numeric,
  add column if not exists auto_topup_last_triggered_at timestamptz,
  -- Set when an auto-topup attempt fails for insufficient account balance,
  -- so lib/autoTopup.ts can alert once and go quiet rather than re-sending
  -- the same email every ~5 minutes on every subsequent cron tick. Cleared
  -- automatically once the credential is topped up (by any means) or
  -- auto-topup is reconfigured. See lib/autoTopup.ts for the full flow.
  add column if not exists auto_topup_insufficient_alerted_at timestamptz;

-- Config sanity, independent of the RPC below — belt-and-suspenders in
-- case a row is ever touched by something other than set_auto_topup.
alter table public.proxy_credentials
  add constraint auto_topup_threshold_nonneg
    check (auto_topup_threshold_gb is null or auto_topup_threshold_gb >= 0);
alter table public.proxy_credentials
  add constraint auto_topup_amount_positive
    check (auto_topup_amount_gb is null or auto_topup_amount_gb > 0);
alter table public.proxy_credentials
  add constraint auto_topup_requires_config
    check (
      not auto_topup_enabled
      or (auto_topup_threshold_gb is not null and auto_topup_amount_gb is not null)
    );

-- Partial index — the cron scan (lib/autoTopup.ts) filters on this, and
-- almost every row will have it false, so a full index would carry a lot
-- of dead weight for a query that only ever wants the true rows.
create index if not exists proxy_credentials_auto_topup_idx
  on public.proxy_credentials (auto_topup_enabled)
  where auto_topup_enabled = true;

-- Lets a user (or admin, via the same dashboard route later if ever
-- needed) turn auto-topup on/off and set its threshold/amount for a
-- credential they own. Mirrors topup_credential()'s ownership model
-- exactly: created_by must be null (self-owned — a reseller-allocated
-- credential is the reseller's commitment to the client, not the
-- client's own balance to configure draws against), and status must be
-- 'active' or 'pending'.
create or replace function public.set_auto_topup(
  p_credential_id uuid,
  p_user_id uuid,
  p_enabled boolean,
  p_threshold_gb numeric,
  p_amount_gb numeric
)
returns void
language plpgsql
security definer
as $$
declare
  v_status text;
  v_created_by uuid;
begin
  select status, created_by into v_status, v_created_by
  from public.proxy_credentials
  where id = p_credential_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'Credential not found' using errcode = 'P0002';
  end if;

  if v_created_by is not null then
    raise exception 'This credential was allocated by your reseller — auto-allocate can only be configured on credentials you purchased yourself. Contact them.';
  end if;

  if v_status not in ('active', 'pending') then
    raise exception 'Auto-allocate can only be enabled on an active or pending credential.';
  end if;

  if p_enabled then
    if p_threshold_gb is null or p_threshold_gb < 0 then
      raise exception 'threshold_gb must be 0 or greater';
    end if;
    if p_amount_gb is null or p_amount_gb <= 0 then
      raise exception 'amount_gb must be greater than 0';
    end if;
  end if;

  update public.proxy_credentials
  set auto_topup_enabled = p_enabled,
      -- Disabling clears the threshold/amount rather than leaving stale
      -- numbers behind that a future re-enable might silently inherit.
      auto_topup_threshold_gb = case when p_enabled then p_threshold_gb else null end,
      auto_topup_amount_gb = case when p_enabled then p_amount_gb else null end,
      -- Any change here (on, off, or reconfigured while already on) is a
      -- deliberate fresh start — clear a stale insufficient-balance alert
      -- flag so the next real dip re-alerts instead of inheriting old
      -- suppressed state.
      auto_topup_insufficient_alerted_at = null
  where id = p_credential_id;
end;
$$;

revoke all on function public.set_auto_topup(uuid, uuid, boolean, numeric, numeric) from public;
grant execute on function public.set_auto_topup(uuid, uuid, boolean, numeric, numeric) to service_role;
