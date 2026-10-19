-- ============================================================
-- 0043 — Admin hardening
-- ============================================================
-- Closes the database-side half of the Admin & Verified Operators audit:
--
--  1. admin_audit_log — who did what to whom. Every /api/admin/* route
--     that changes state now writes a row (best-effort, lib/adminAudit.ts).
--
--  2. run_affiliate_payout_cycle — commissions held for "no payout
--     method" / "held_recent_method" / "below_minimum" used to be
--     stranded forever: the selector only looked at commissions created
--     INSIDE the cycle window, so a later cycle never saw them even
--     though the email to the affiliate promised they would carry over.
--     It now selects every unbatched pending commission created on or
--     before the cycle end. It also (a) skips deleted / suspended /
--     non-approved affiliates ('ineligible'), and (b) claims commissions
--     FIRST and sizes the payout from what was actually claimed, so a
--     commission inserted between the SUM and the claim can never be
--     paid without being counted.
--
--  3. mark_affiliate_payout_paid — now records who paid it and a payment
--     reference (txn hash / M-Pesa code), and only flips commissions
--     that are still 'pending'.
--
--  4. Refund handling for affiliate commissions: when an order's
--     refunded_usd grows, the linked commission is reduced pro-rata
--     (or voided on a full refund) and, if already batched into a
--     still-pending payout, that payout shrinks by the same amount. A
--     commission that was ALREADY PAID cannot be recovered
--     automatically — it is written to admin_audit_log for manual
--     follow-up.
--
--     A refund that lands before the commission is created (post-credit
--     retries can delay it) is applied to the commission at insert time.
--
--  5. admin_order_stats() — server-side aggregate so the admin pages stop
--     summing unpaginated order lists (PostgREST caps those at 1000 rows)
--     and so every page agrees on "revenue" (net of refunds).
--
--  6. Verified Operator remembers the rates an affiliate had BEFORE the
--     grant so a revoke restores them instead of hard-resetting to the
--     30%/15% defaults. protect_privileged_profile_columns covers the
--     two new columns.
--
--  7. wipe_mfa gets the missing search_path on a security-definer fn.
--     (Every function created here is also explicitly revoked from
--     public/anon/authenticated: Supabase's default privileges grant anon and
--     authenticated EXECUTE directly, which `revoke ... from public` alone
--     does not remove — see 0042_api_integrations_hardening.sql §1b.)
--
--  8. admin_affiliate_earnings() — per-affiliate accruing / awaiting / paid
--     totals computed in SQL for /admin/affiliates.
--
-- Safe to run against the live DB: idempotent.

-- ── 1. Audit log ─────────────────────────────────────────────
create table if not exists public.admin_audit_log (
  id              uuid default uuid_generate_v4() primary key,
  admin_id        uuid references public.profiles(id) on delete set null,
  action          text not null,
  target_user_id  uuid references public.profiles(id) on delete set null,
  target_ref      text,
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamp with time zone not null default now()
);

create index if not exists idx_admin_audit_log_created on public.admin_audit_log(created_at desc);
create index if not exists idx_admin_audit_log_target on public.admin_audit_log(target_user_id, created_at desc);

alter table public.admin_audit_log enable row level security;

drop policy if exists "Admins can read audit log" on public.admin_audit_log;
create policy "Admins can read audit log" on public.admin_audit_log for select
  using (public.is_admin(auth.uid()));
-- No client insert/update/delete policy: only service-role code (admin
-- routes and the refund trigger below) ever writes here, and rows are
-- append-only by convention.

-- ── 6. Verified Operator: remember prior rates ────────────────
alter table public.profiles
  add column if not exists verified_operator_prev_rate numeric
    check (verified_operator_prev_rate is null or (verified_operator_prev_rate >= 0 and verified_operator_prev_rate <= 1));
alter table public.profiles
  add column if not exists verified_operator_prev_rate_lifetime numeric
    check (verified_operator_prev_rate_lifetime is null or (verified_operator_prev_rate_lifetime >= 0 and verified_operator_prev_rate_lifetime <= 1));

create or replace function public.protect_privileged_profile_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return new; -- service-role client; app code already gates this
  end if;

  if public.is_admin(auth.uid()) then
    return new;
  end if;

  new.role                               := old.role;
  new.is_suspended                       := old.is_suspended;
  new.suspended_at                       := old.suspended_at;
  new.suspension_reason                  := old.suspension_reason;
  new.reseller_status                    := old.reseller_status;
  new.api_access                         := old.api_access;
  new.api_access_status                  := old.api_access_status;
  new.is_deleted                         := old.is_deleted;
  new.deleted_at                         := old.deleted_at;
  new.email                              := old.email; -- see migration 0011
  new.affiliate_status                   := old.affiliate_status; -- see migration 0031
  new.affiliate_commission_rate          := old.affiliate_commission_rate;
  new.affiliate_commission_rate_lifetime := old.affiliate_commission_rate_lifetime;
  new.payout_method                      := old.payout_method; -- see migration 0034, extended by 0035
  new.payout_wallet_address              := old.payout_wallet_address;
  new.payout_wallet_network              := old.payout_wallet_network;
  new.payout_bank_details                := old.payout_bank_details;
  new.payout_mpesa_phone                 := old.payout_mpesa_phone;
  new.payout_method_updated_at           := old.payout_method_updated_at;
  new.is_verified_operator               := old.is_verified_operator; -- see migration 0037
  new.verified_operator_since            := old.verified_operator_since;
  new.verified_operator_prev_rate        := old.verified_operator_prev_rate; -- see migration 0043
  new.verified_operator_prev_rate_lifetime := old.verified_operator_prev_rate_lifetime;
  new.mfa_enabled                        := old.mfa_enabled; -- see migration 0039_auth_mfa_hardening

  return new;
end;
$$;

-- ── 2/3. Payout cycle: carry-over, eligibility, claim-then-size ──
alter table public.affiliate_payouts add column if not exists paid_by uuid references public.profiles(id) on delete set null;
alter table public.affiliate_payouts add column if not exists payment_reference text;

create or replace function public.run_affiliate_payout_cycle(
  p_cycle_start date,
  p_cycle_end date,
  p_min_payout_usd numeric default 20,
  p_hold_hours integer default 48
)
returns table (
  out_referrer_id uuid,
  out_status text,
  out_amount_usd numeric,
  out_payout_id uuid
) language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_status text;
  v_new_payout_id uuid;
  v_method text;
  v_method_updated timestamptz;
  v_wallet_address text;
  v_wallet_network text;
  v_bank jsonb;
  v_mpesa_phone text;
  v_affiliate_status text;
  v_deleted boolean;
  v_suspended boolean;
  v_claimed_total numeric;
begin
  -- No lower bound on created_at: anything unbatched and pending that was
  -- earned on or before the cycle end is payable now. This is what makes
  -- "rolls over to the next payout automatically" actually true.
  for r in
    select ac.referrer_id as rid, sum(ac.commission_amount_usd) as total
    from public.affiliate_commissions ac
    where ac.payout_id is null
      and ac.status = 'pending'
      and ac.created_at::date <= p_cycle_end
    group by ac.referrer_id
  loop
    select payout_method, payout_method_updated_at, payout_wallet_address, payout_wallet_network,
           payout_bank_details, payout_mpesa_phone, affiliate_status, is_deleted, is_suspended
      into v_method, v_method_updated, v_wallet_address, v_wallet_network,
           v_bank, v_mpesa_phone, v_affiliate_status, v_deleted, v_suspended
    from public.profiles where id = r.rid;

    if coalesce(v_deleted, false) or coalesce(v_suspended, false) or v_affiliate_status is distinct from 'approved' then
      v_status := 'ineligible';
    elsif v_method is null then
      v_status := 'no_payout_method';
    elsif v_method_updated is null or v_method_updated > (now() - (p_hold_hours || ' hours')::interval) then
      v_status := 'held_recent_method';
    elsif r.total < p_min_payout_usd then
      v_status := 'below_minimum';
    else
      v_status := 'created';
    end if;

    v_new_payout_id := null;
    out_amount_usd := r.total;

    if v_status = 'created' then
      insert into public.affiliate_payouts
        (referrer_id, cycle_start, cycle_end, amount_usd, status,
         payout_method, payout_wallet_address, payout_wallet_network, payout_bank_details, payout_mpesa_phone)
      values
        (r.rid, p_cycle_start, p_cycle_end, r.total, 'pending',
         v_method, v_wallet_address, v_wallet_network, v_bank, v_mpesa_phone)
      on conflict (referrer_id, cycle_start, cycle_end) do nothing
      returning id into v_new_payout_id;

      if v_new_payout_id is not null then
        -- Claim first, then size the payout from what was really claimed.
        with claimed as (
          update public.affiliate_commissions
          set payout_id = v_new_payout_id
          where referrer_id = r.rid
            and payout_id is null
            and status = 'pending'
            and created_at::date <= p_cycle_end
          returning commission_amount_usd
        )
        select coalesce(sum(commission_amount_usd), 0) into v_claimed_total from claimed;

        if v_claimed_total is distinct from r.total then
          update public.affiliate_payouts set amount_usd = v_claimed_total where id = v_new_payout_id;
        end if;
        out_amount_usd := v_claimed_total;
      else
        -- This referrer already has a payout row for this exact cycle.
        -- Leave the commissions unclaimed; the next cycle picks them up.
        v_status := 'already_run';
      end if;
    end if;

    out_referrer_id := r.rid;
    out_status := v_status;
    out_payout_id := v_new_payout_id;
    return next;
  end loop;
end;
$$;

revoke all on function public.run_affiliate_payout_cycle(date, date, numeric, integer) from public, anon, authenticated;
grant execute on function public.run_affiliate_payout_cycle(date, date, numeric, integer) to service_role;

drop function if exists public.mark_affiliate_payout_paid(uuid);

create or replace function public.mark_affiliate_payout_paid(
  p_payout_id uuid,
  p_paid_by uuid default null,
  p_reference text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_claimed uuid;
begin
  update public.affiliate_payouts
  set status = 'paid', paid_at = now(), paid_by = p_paid_by, payment_reference = nullif(btrim(p_reference), '')
  where id = p_payout_id and status = 'pending'
  returning id into v_claimed;

  if v_claimed is null then
    return false;
  end if;

  update public.affiliate_commissions
  set status = 'paid', paid_at = now()
  where payout_id = v_claimed and status = 'pending';

  return true;
end;
$$;

revoke all on function public.mark_affiliate_payout_paid(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_affiliate_payout_paid(uuid, uuid, text) to service_role;

-- ── 4. Refund → commission ───────────────────────────────────
create or replace function public.reduce_commission_on_refund()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c record;
  v_ratio numeric;
  v_new numeric;
  v_delta numeric;
begin
  if coalesce(new.refunded_usd, 0) <= coalesce(old.refunded_usd, 0) or coalesce(new.amount_usd, 0) <= 0 then
    return new;
  end if;

  v_ratio := least(new.refunded_usd / new.amount_usd, 1);

  select * into c from public.affiliate_commissions where order_id = new.id for update;
  if not found then
    return new;
  end if;

  if c.status = 'paid' then
    -- Already paid out — cannot be clawed back automatically. Leave a
    -- trail so an admin can follow up with the affiliate.
    insert into public.admin_audit_log (admin_id, action, target_user_id, target_ref, details)
    values (null, 'commission_refund_after_paid', c.referrer_id, new.id::text,
            jsonb_build_object('commission_id', c.id, 'commission_amount_usd', c.commission_amount_usd,
                               'order_refunded_usd', new.refunded_usd, 'order_amount_usd', new.amount_usd));
    return new;
  end if;

  if c.status <> 'pending' then
    return new; -- void already
  end if;

  v_new := case when v_ratio >= 1 then 0
                else round(c.gross_amount_usd * (1 - v_ratio) * c.commission_rate, 2) end;
  v_delta := c.commission_amount_usd - v_new;
  if v_delta <= 0 then
    return new;
  end if;

  update public.affiliate_commissions
  set commission_amount_usd = v_new,
      status = case when v_new = 0 then 'void' else status end
  where id = c.id;

  if c.payout_id is not null then
    update public.affiliate_payouts
    set amount_usd = greatest(amount_usd - v_delta, 0)
    where id = c.payout_id and status = 'pending';
  end if;

  return new;
end;
$$;

revoke all on function public.reduce_commission_on_refund() from public, anon, authenticated;

drop trigger if exists trg_reduce_commission_on_refund on public.orders;
create trigger trg_reduce_commission_on_refund
  after update of refunded_usd on public.orders
  for each row execute function public.reduce_commission_on_refund();

-- ── 4b. Refund that landed BEFORE the commission existed ─────
-- Post-credit steps (including recording the commission) are retried by the
-- reconcile cron for days (migration 0041). If a refund arrives first, the
-- trigger above finds no commission to reduce, and the retry would then
-- create one at full value. This trigger applies any existing refund to a
-- commission at insert time.
create or replace function public.apply_refund_to_new_commission()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_amount numeric;
  v_refunded numeric;
  v_ratio numeric;
begin
  select amount_usd, coalesce(refunded_usd, 0) into v_amount, v_refunded
  from public.orders where id = new.order_id;

  if coalesce(v_refunded, 0) > 0 and coalesce(v_amount, 0) > 0 then
    v_ratio := least(v_refunded / v_amount, 1);
    if v_ratio >= 1 then
      new.commission_amount_usd := 0;
      new.status := 'void';
    else
      new.commission_amount_usd := round(new.gross_amount_usd * (1 - v_ratio) * new.commission_rate, 2);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.apply_refund_to_new_commission() from public, anon, authenticated;

drop trigger if exists trg_apply_refund_to_new_commission on public.affiliate_commissions;
create trigger trg_apply_refund_to_new_commission
  before insert on public.affiliate_commissions
  for each row execute function public.apply_refund_to_new_commission();

-- ── 5. Admin order stats ─────────────────────────────────────
create or replace function public.admin_order_stats(
  p_start timestamptz default null,
  p_end   timestamptz default null
)
returns table (revenue_usd numeric, gb_sold numeric, order_count bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    coalesce(sum(o.amount_usd - coalesce(o.refunded_usd, 0)), 0),
    coalesce(sum(o.gb_amount * (1 - least(coalesce(coalesce(o.refunded_usd, 0) / nullif(o.amount_usd, 0), 0), 1))), 0),
    count(*)
  from public.orders o
  where o.payment_status = 'paid'
    and o.is_canary = false
    and (p_start is null or o.created_at >= p_start)
    and (p_end   is null or o.created_at <  p_end);
$$;

revoke all on function public.admin_order_stats(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_order_stats(timestamptz, timestamptz) to service_role;

-- ── 7. wipe_mfa search_path ──────────────────────────────────
alter function public.wipe_mfa(uuid) set search_path = public, pg_temp;

-- ── 8. Affiliate earnings aggregate ──────────────────────────
-- Per-affiliate totals for /admin/affiliates, computed in SQL. The page
-- used to pull every commission row for every affiliate through an
-- `.in(referrer_id, [...])` filter (URL length + the 1000-row cap).
--   accruing = pending and not yet batched into a payout
--   awaiting = batched into a payout that hasn't been marked paid yet
create or replace function public.admin_affiliate_earnings()
returns table (referrer_id uuid, accruing_usd numeric, awaiting_usd numeric, paid_usd numeric)
language sql stable security definer set search_path = public, pg_temp as $$
  select
    ac.referrer_id,
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'pending' and ac.payout_id is not null), 0),
    coalesce(sum(ac.commission_amount_usd) filter (where ac.status = 'paid'), 0)
  from public.affiliate_commissions ac
  group by ac.referrer_id;
$$;

revoke all on function public.admin_affiliate_earnings() from public, anon, authenticated;
grant execute on function public.admin_affiliate_earnings() to service_role;

insert into public.schema_migrations (filename) values
  ('0043_admin_hardening.sql')
on conflict do nothing;
