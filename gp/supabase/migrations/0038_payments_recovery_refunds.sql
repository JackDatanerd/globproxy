-- ============================================================
-- 0038 — Payments: late-payment recovery, refunds, reconciliation
-- ============================================================
-- Payments & billing audit, pass 1.
--
-- 1. claim_and_credit_order() now also claims orders in 'cancelled' or
--    'failed'. Previously the webhook / verify-payment refused any order
--    that wasn't 'pending', so a customer who really paid (stale checkout
--    tab after a newer checkout auto-cancelled the order, the Cancel
--    button, a declined first card then a successful retry on the same
--    Paystack session, the 24h cleanup) got charged and never credited.
--    The app verifies the payment with Paystack (status, amount, currency,
--    reference) before calling this, so an order's local status is not a
--    reason to withhold bandwidth that was paid for. 'refunded' and
--    'paid' are still never claimable. The claim is also pinned to the
--    order's own user_id.
-- 2. Canary orders no longer consume the shared invoice number sequence
--    (real customers' numbers stay gap-free). Existing canary invoice
--    numbers are cleared.
-- 3. Refund support: orders.refunded_usd / refunded_at, an order_refunds
--    ledger (idempotent per Paystack refund reference) and
--    apply_order_refund(), which claws back the proportional GB (never
--    below what is already allocated to credentials) and flips the order
--    to 'refunded' once fully refunded.
-- 4. orders.reconcile_checked_at backs the 'reconcile' cron task, which
--    re-verifies uncredited orders against Paystack so a lost/failed
--    webhook self-heals.
-- 5. A unique index on paystack_reference (lookups assume one row per
--    reference).
-- 6. protect_order_columns() now pins the columns added since 0006, so a
--    customer cancelling their own pending order can't also rewrite
--    is_canary / invoice_number / refund / failure bookkeeping.

alter table public.orders add column if not exists refunded_usd numeric not null default 0;
alter table public.orders add column if not exists refunded_at timestamptz;
alter table public.orders add column if not exists reconcile_checked_at timestamptz;

create unique index if not exists orders_paystack_reference_key
  on public.orders (paystack_reference) where paystack_reference is not null;

create index if not exists orders_reconcile_idx
  on public.orders (created_at)
  where bandwidth_credited = false and payment_status in ('pending','cancelled','failed');

-- Canary orders never had a legitimate invoice.
update public.orders set invoice_number = null where is_canary and invoice_number is not null;

create or replace function public.claim_and_credit_order(
  p_order_id uuid,
  p_user_id uuid,
  p_gb numeric,
  p_paystack_reference text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed uuid;
begin
  update public.orders
  set payment_status     = 'paid',
      paystack_reference = p_paystack_reference,
      bandwidth_credited = true,
      paid_at            = now(),
      failure_reason     = null,
      failed_at          = null,
      invoice_number     = case
        when is_canary then null
        else 'INV-' || to_char(now() at time zone 'UTC', 'YYYY')
             || '-' || lpad(nextval('public.invoice_number_seq')::text, 6, '0')
      end
  where id = p_order_id
    and user_id = p_user_id
    and bandwidth_credited = false
    and payment_status in ('pending', 'cancelled', 'failed')
  returning id into v_claimed;

  if v_claimed is null then
    return false; -- already credited, refunded, or not this user's order
  end if;

  perform public.credit_bandwidth(p_user_id, p_gb); -- uncaught error rolls the claim back too

  return true;
end;
$$;

revoke all on function public.claim_and_credit_order(uuid, uuid, numeric, text) from public;
grant execute on function public.claim_and_credit_order(uuid, uuid, numeric, text) to service_role;

create table if not exists public.order_refunds (
  refund_reference text primary key,
  order_id         uuid not null references public.orders(id) on delete cascade,
  amount_usd       numeric not null,
  gb_clawed        numeric not null default 0,
  gb_shortfall     numeric not null default 0,
  created_at       timestamptz not null default now()
);
create index if not exists idx_order_refunds_order on public.order_refunds(order_id);
alter table public.order_refunds enable row level security;
-- No policies: service-role (webhook) only.

create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;
  if v_order.bandwidth_credited is not true then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);

  select available_gb into v_avail
  from public.bandwidth_accounts where user_id = v_order.user_id for update;
  v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw)
  on conflict (refund_reference) do nothing
  returning refund_reference into v_inserted;

  if v_inserted is null then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  if v_claw > 0 then
    update public.bandwidth_accounts
    set total_gb = total_gb - v_claw
    where user_id = v_order.user_id;
  end if;

  v_total := v_order.refunded_usd + v_refund;
  update public.orders
  set refunded_usd   = v_total,
      refunded_at    = now(),
      payment_status = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  return jsonb_build_object(
    'applied', true,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd
  );
end;
$$;

revoke all on function public.apply_order_refund(uuid, text, numeric) from public;
grant execute on function public.apply_order_refund(uuid, text, numeric) to service_role;

create or replace function public.protect_order_columns()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  caller_is_admin boolean;
begin
  if auth.uid() is null then
    return new; -- service-role client (webhook, cron, activateBandwidth)
  end if;

  select (role = 'admin') into caller_is_admin
  from public.profiles where id = auth.uid();

  if coalesce(caller_is_admin, false) then
    return new;
  end if;

  new.user_id               := old.user_id;
  new.plan_id               := old.plan_id;
  new.gb_amount             := old.gb_amount;
  new.amount_usd            := old.amount_usd;
  new.payment_method        := old.payment_method;
  new.paystack_reference    := old.paystack_reference;
  new.bandwidth_credited    := old.bandwidth_credited;
  new.paid_at               := old.paid_at;
  new.created_at            := old.created_at;
  new.invoice_number        := old.invoice_number;
  new.failure_reason        := old.failure_reason;
  new.failed_at             := old.failed_at;
  new.is_canary             := old.is_canary;
  new.refunded_usd          := old.refunded_usd;
  new.refunded_at           := old.refunded_at;
  new.reconcile_checked_at  := old.reconcile_checked_at;

  return new;
end;
$$;

insert into public.schema_migrations (filename) values
  ('0038_payments_recovery_refunds.sql')
on conflict do nothing;
