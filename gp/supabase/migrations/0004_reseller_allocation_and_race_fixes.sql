-- ============================================================
-- 0004 — Reseller allocation/usage conflict + race conditions
-- Safe to run against the live DB: idempotent throughout.
-- ============================================================

-- ── 1. Split "allocated to clients" from "actually consumed" ───────
-- bandwidth_accounts.used_gb was doing double duty:
--   - reseller/allocate/route.ts incremented it to mean "GB I've
--     handed out to clients" (a stock commitment)
--   - cron runUsageSync overwrote it every ~15 min with "GB actually
--     consumed by proxy_credentials I personally own"
-- Every cron run erased the allocation commitment, letting a
-- reseller re-allocate the same stock repeatedly. Splitting these
-- into two columns so each has exactly one writer and one meaning:
--   used_gb       = actual bytes consumed (cron-owned, unchanged)
--   allocated_gb  = GB committed to clients via reseller transfers
alter table public.bandwidth_accounts add column if not exists allocated_gb numeric not null default 0;

-- available_gb must now account for both commitments. Postgres can't
-- ALTER a generated column's expression in place — drop and recreate.
alter table public.bandwidth_accounts drop column if exists available_gb;
alter table public.bandwidth_accounts add column available_gb numeric
  generated always as (total_gb - used_gb - allocated_gb) stored;

-- ── 2. Atomic, race-safe reseller allocation ────────────────────────
-- Previously: app code read total_gb/used_gb, computed in JS, then
-- wrote back — a classic check-then-act race. Two concurrent requests
-- (double-click, retry, two tabs) could both pass the balance check
-- before either write landed, over-allocating stock. Doing the whole
-- transfer as one atomic function closes that window and replaces the
-- old manual "rollback by resetting to a previously-read value" logic,
-- which could itself stomp a legitimate concurrent write.
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

  -- Lock the reseller's row for the duration of this transaction so a
  -- concurrent call can't read a stale balance.
  perform 1 from public.bandwidth_accounts where user_id = p_reseller_id for update;

  update public.bandwidth_accounts
  set allocated_gb = allocated_gb + p_gb
  where user_id = p_reseller_id
    and (total_gb - used_gb - allocated_gb) >= p_gb
  returning allocated_gb into v_updated_allocated;

  if v_updated_allocated is null then
    raise exception 'Not enough bandwidth in your stock.' using errcode = 'P0001';
  end if;

  -- Credit the recipient — insert their account if this is the first
  -- allocation they've ever received.
  insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
  values (p_recipient_id, p_gb, 0, 0)
  on conflict (user_id) do update
    set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;

  return query select v_updated_allocated;
end;
$$;

-- ── 3. Guard the payment-credit read-modify-write in activateBandwidth ──
-- The order claim itself was already atomic (bandwidth_credited guard),
-- but crediting total_gb read-then-wrote in JS, so two orders paid for
-- the same user at nearly the same instant could still lose a credit.
create or replace function public.credit_bandwidth(p_user_id uuid, p_gb numeric)
returns void
language sql
security definer
as $$
  insert into public.bandwidth_accounts (user_id, total_gb, used_gb, allocated_gb)
  values (p_user_id, p_gb, 0, 0)
  on conflict (user_id) do update
    set total_gb = public.bandwidth_accounts.total_gb + excluded.total_gb;
$$;

-- ── 4. Unique constraint required for the ON CONFLICT clauses above ──
alter table public.bandwidth_accounts
  drop constraint if exists bandwidth_accounts_user_id_key;
alter table public.bandwidth_accounts
  add constraint bandwidth_accounts_user_id_key unique (user_id);
