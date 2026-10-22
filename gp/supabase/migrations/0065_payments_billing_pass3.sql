-- ============================================================
-- 0065 — Payments & billing close-out (audit section 3, round 3)
-- ============================================================
-- 1. orders.mismatch_alerted_at: a payment that does not match its order used
--    to e-mail the admin on EVERY look (each verify call, each hourly reconcile
--    for 3 days). The alert now fires once per order.
-- 2. Disputes: orders.dispute_status gains 'lost' (the dispute went against us
--    and the proportional bandwidth was taken back) and 'won'. Previously every
--    resolution was recorded as plain 'resolved' and nothing was clawed back.
-- 3. order_refunds records what was refunded in the currency the customer paid
--    in (charged_amount / charged_currency — M-Pesa credit notes can now state
--    the shillings) and where the refund came from (source: 'refund' | 'dispute').
-- 4. refund_requests: a customer asks for a refund from Billing; the admin sees
--    it (Admin -> Orders), then refunds it or declines it. The row closes itself
--    when the refund is applied.
-- 5. apply_order_refund() takes the extra arguments above (all optional, so the
--    three-argument call keeps working) and closes the customer's open request.
-- 6. protect_order_columns() pins mismatch_alerted_at against customer writes.
--
-- Run this BEFORE deploying the matching app code (the Paystack webhook now
-- passes the new apply_order_refund arguments).

-- ── 1. orders ───────────────────────────────────────────────
alter table public.orders add column if not exists mismatch_alerted_at timestamptz;

-- ── 2. dispute outcomes ─────────────────────────────────────
alter table public.orders drop constraint if exists orders_dispute_status_check;
alter table public.orders add constraint orders_dispute_status_check
  check (dispute_status is null or dispute_status in ('open', 'resolved', 'lost', 'won'));

-- ── 3. order_refunds ────────────────────────────────────────
alter table public.order_refunds add column if not exists charged_currency text;
alter table public.order_refunds add column if not exists charged_amount numeric;
alter table public.order_refunds add column if not exists source text not null default 'refund';

alter table public.order_refunds drop constraint if exists order_refunds_source_check;
alter table public.order_refunds add constraint order_refunds_source_check check (source in ('refund', 'dispute'));

-- ── 4. refund_requests ──────────────────────────────────────
create table if not exists public.refund_requests (
  id             uuid default uuid_generate_v4() primary key,
  order_id       uuid not null references public.orders(id) on delete cascade,
  user_id        uuid not null references public.profiles(id) on delete cascade,
  reason         text not null check (char_length(reason) between 3 and 500),
  -- Computed by the server when the request is made: inside the 72-hour window
  -- of the refund policy with nothing used. Informational — an admin decides.
  within_policy  boolean not null default false,
  status         text not null default 'open' check (status in ('open', 'declined', 'refunded')),
  decline_note   text,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create unique index if not exists refund_requests_one_open_per_order
  on public.refund_requests (order_id) where status = 'open';
create index if not exists refund_requests_user_idx on public.refund_requests (user_id, created_at desc);
create index if not exists refund_requests_open_idx on public.refund_requests (created_at) where status = 'open';

alter table public.refund_requests enable row level security;
-- Customers read their own requests; every write goes through the service role.
drop policy if exists "Own refund requests" on public.refund_requests;
create policy "Own refund requests" on public.refund_requests for select
  using (auth.uid() = user_id);

-- ── 6. protect_order_columns ────────────────────────────────
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

  new.user_id                      := old.user_id;
  new.plan_id                      := old.plan_id;
  new.gb_amount                    := old.gb_amount;
  new.amount_usd                   := old.amount_usd;
  new.payment_method               := old.payment_method;
  new.paystack_reference           := old.paystack_reference;
  new.bandwidth_credited           := old.bandwidth_credited;
  new.paid_at                      := old.paid_at;
  new.created_at                   := old.created_at;
  new.invoice_number               := old.invoice_number;
  new.failure_reason               := old.failure_reason;
  new.failed_at                    := old.failed_at;
  new.is_canary                    := old.is_canary;
  new.refunded_usd                 := old.refunded_usd;
  new.refunded_at                  := old.refunded_at;
  new.reconcile_checked_at         := old.reconcile_checked_at;
  new.post_credit_done_at          := old.post_credit_done_at;
  new.billing_details              := old.billing_details;
  new.dispute_status               := old.dispute_status;
  new.dispute_opened_at            := old.dispute_opened_at;
  new.dispute_resolution           := old.dispute_resolution;
  new.pay_currency                 := old.pay_currency;
  new.pay_amount                   := old.pay_amount;
  new.fx_rate                      := old.fx_rate;
  new.plan_slug                    := old.plan_slug;
  new.refund_requested_at          := old.refund_requested_at;
  new.billing_details_revision     := old.billing_details_revision;
  new.billing_details_updated_at   := old.billing_details_updated_at;
  new.mismatch_alerted_at          := old.mismatch_alerted_at;

  return new;
end;
$$;

-- ── 5. apply_order_refund ───────────────────────────────────
-- The old three-argument signature is replaced (a second overload would make a
-- named-argument call ambiguous).
drop function if exists public.apply_order_refund(uuid, text, numeric);

create or replace function public.apply_order_refund(
  p_order_id uuid,
  p_refund_reference text,
  p_refund_usd numeric,
  p_charged_amount numeric default null,
  p_charged_currency text default null,
  p_source text default 'refund'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_credited  boolean;
  v_refund    numeric;
  v_gb        numeric;
  v_avail     numeric;
  v_claw      numeric;
  v_inserted  text;
  v_total     numeric;
  v_note      text;
  v_charged   numeric;
  v_source    text := case when p_source = 'dispute' then 'dispute' else 'refund' end;
begin
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then
    return jsonb_build_object('applied', false, 'reason', 'order_not_found');
  end if;

  -- Serialised by the order lock above, so a redelivered refund event is a
  -- clean no-op that does not burn a credit-note number.
  if exists (select 1 from public.order_refunds where refund_reference = p_refund_reference) then
    return jsonb_build_object('applied', false, 'reason', 'duplicate');
  end if;

  v_credited := v_order.bandwidth_credited is true;
  -- An uncredited order can still have been paid (webhook delayed): refunds
  -- against it are recorded. Anything else uncredited is not a real payment.
  if not v_credited and v_order.payment_status not in ('pending', 'cancelled', 'failed') then
    return jsonb_build_object('applied', false, 'reason', 'order_never_credited');
  end if;

  v_refund := least(p_refund_usd, v_order.amount_usd - v_order.refunded_usd);
  if v_refund is null or v_refund <= 0 then
    return jsonb_build_object('applied', false, 'reason', 'nothing_to_refund');
  end if;

  if v_credited then
    v_gb := round(v_order.gb_amount * v_refund / v_order.amount_usd, 6);
    select available_gb into v_avail
    from public.bandwidth_accounts where user_id = v_order.user_id for update;
    v_claw := least(v_gb, greatest(coalesce(v_avail, 0), 0));
  else
    v_gb := 0;
    v_claw := 0;
  end if;

  -- What was refunded in the customer's own currency, for the credit note. A
  -- refund capped above (it asked for more than was left) is scaled down with it.
  v_charged := case
    when p_charged_amount is null or p_charged_amount <= 0 then null
    when p_refund_usd > 0 and v_refund < p_refund_usd then round(p_charged_amount * v_refund / p_refund_usd, 2)
    else p_charged_amount
  end;

  v_note := 'CN-' || to_char(now() at time zone 'UTC', 'YYYY')
            || '-' || lpad(nextval('public.credit_note_seq')::text, 6, '0');

  insert into public.order_refunds (refund_reference, order_id, amount_usd, gb_clawed, gb_shortfall, credit_note_number, charged_amount, charged_currency, source)
  values (p_refund_reference, p_order_id, v_refund, v_claw, v_gb - v_claw, v_note,
          v_charged, case when v_charged is null then null else upper(p_charged_currency) end, v_source)
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
  set refunded_usd         = v_total,
      refunded_at          = now(),
      refund_requested_at  = null,
      payment_status       = case when v_total >= amount_usd then 'refunded' else payment_status end
  where id = p_order_id;

  -- The customer's open refund request (if any) is answered by this refund.
  update public.refund_requests
  set status = 'refunded', resolved_at = now()
  where order_id = p_order_id and status = 'open';

  return jsonb_build_object(
    'applied', true,
    'credited', v_credited,
    'refund_usd', v_refund,
    'gb_clawed', v_claw,
    'gb_shortfall', v_gb - v_claw,
    'fully_refunded', v_total >= v_order.amount_usd,
    'credit_note', v_note
  );
end;
$$;

revoke all on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) from public, anon, authenticated;
grant execute on function public.apply_order_refund(uuid, text, numeric, numeric, text, text) to service_role;

insert into public.schema_migrations (filename) values
  ('0065_payments_billing_pass3.sql')
on conflict do nothing;
